import TelegramBot from 'node-telegram-bot-api'
import axios from 'axios'
import { redeemCodeInternal, RedemptionError } from '../routes/redemption-codes.js'
import { getDatabase, saveDatabase } from '../database/init.js'
import { getExpectedApiKey } from '../middleware/api-key-auth.js'
import { userHasRoleKey } from './rbac.js'
import { getTelegramSettings } from '../utils/telegram-settings.js'

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const CODE_REGEX = /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/

const buildCommandRegex = command => new RegExp(`^\\/${command}(?:@[\\w_]+)?\\b`, 'i')

const COMMAND_REGEX = {
  start: buildCommandRegex('start'),
  help: buildCommandRegex('help'),
  stock: buildCommandRegex('stock'),
  buy: buildCommandRegex('buy'),
  redeem: buildCommandRegex('redeem'),
  cancel: buildCommandRegex('cancel'),
  randomActivate: buildCommandRegex('random_activate'),
  activate: buildCommandRegex('activate')
}

const ADMIN_AUTH_REGEX = /^\/admin(?:@[\w_]+)?\s+auth\s+(\S+)\s+(\S+)\s*$/i

const parseAllowedUserIds = value =>
  value
    .split(',')
    .map(id => id.trim())
    .filter(Boolean)

const normalizeBaseUrl = value => String(value || '').trim().replace(/\/+$/, '')

const resolveInternalApiBaseUrl = () => {
  const configured = normalizeBaseUrl(process.env.TELEGRAM_INTERNAL_API_BASE_URL)
  const port = process.env.PORT || 3000
  const fallback = `http://127.0.0.1:${port}`
  const base = configured || fallback
  return base.endsWith('/api') ? base : `${base}/api`
}

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const normalizeIdentifier = value => String(value ?? '').trim()
const SSE_PROGRESS_THROTTLE_MS = 1500

const safeJsonParse = value => {
  if (value == null) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

const findUserByIdentifier = (db, identifier) => {
  const normalized = normalizeIdentifier(identifier)
  if (!normalized) return null

  const usernameResult = db.exec(
    'SELECT id, username, email, telegram_id FROM users WHERE lower(username) = lower(?) LIMIT 1',
    [normalized]
  )
  if (usernameResult[0]?.values?.length) {
    const row = usernameResult[0].values[0]
    return { id: row[0], username: row[1], email: row[2], telegramId: row[3] }
  }

  const emailResult = db.exec(
    'SELECT id, username, email, telegram_id FROM users WHERE lower(email) = lower(?) LIMIT 1',
    [normalized]
  )
  if (emailResult[0]?.values?.length) {
    const row = emailResult[0].values[0]
    return { id: row[0], username: row[1], email: row[2], telegramId: row[3] }
  }

  return null
}

const readStreamText = (stream, maxBytes = 8192) =>
  new Promise((resolve, reject) => {
    let buffer = ''
    let size = 0

    const cleanup = () => {
      stream.removeAllListeners('data')
      stream.removeAllListeners('end')
      stream.removeAllListeners('error')
    }

    stream.on('data', chunk => {
      const text = chunk.toString('utf8')
      size += Buffer.byteLength(text)
      if (size <= maxBytes) {
        buffer += text
      }
      if (size >= maxBytes) {
        cleanup()
        stream.destroy()
        resolve(buffer.trim())
      }
    })

    stream.on('end', () => {
      cleanup()
      resolve(buffer.trim())
    })

    stream.on('error', error => {
      cleanup()
      reject(error)
    })
  })

const parseSseStream = (stream, onEvent) =>
  new Promise((resolve, reject) => {
    let buffer = ''
    let eventName = 'message'
    let dataBuffer = ''
    let pendingError = null

    const dispatchEvent = () => {
      if (!dataBuffer) {
        eventName = 'message'
        return
      }
      const payload = dataBuffer.endsWith('\n') ? dataBuffer.slice(0, -1) : dataBuffer
      const event = { event: eventName || 'message', data: payload }
      dataBuffer = ''
      eventName = 'message'
      Promise.resolve(onEvent(event)).catch(error => {
        pendingError = error
        stream.destroy(error)
      })
    }

    const cleanup = () => {
      stream.removeAllListeners('data')
      stream.removeAllListeners('end')
      stream.removeAllListeners('error')
      stream.removeAllListeners('close')
    }

    stream.on('data', chunk => {
      buffer += chunk.toString('utf8')
      let index = buffer.indexOf('\n')
      while (index !== -1) {
        let line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line.endsWith('\r')) {
          line = line.slice(0, -1)
        }
        if (!line) {
          dispatchEvent()
        } else if (line.startsWith('event:')) {
          eventName = line.slice(6).trim()
        } else if (line.startsWith('data:')) {
          dataBuffer += `${line.slice(5).trimStart()}\n`
        }
        index = buffer.indexOf('\n')
      }
    })

    stream.on('end', () => {
      dispatchEvent()
      cleanup()
      if (pendingError) {
        reject(pendingError)
      } else {
        resolve()
      }
    })

    stream.on('close', () => {
      cleanup()
      if (pendingError) {
        reject(pendingError)
      } else {
        resolve()
      }
    })

    stream.on('error', error => {
      cleanup()
      reject(error)
    })
  })

const findUserByTelegramId = (db, telegramId) => {
  const normalized = normalizeIdentifier(telegramId)
  if (!normalized) return null
  const result = db.exec(
    'SELECT id, username, email, telegram_id FROM users WHERE telegram_id = ? LIMIT 1',
    [normalized]
  )
  if (!result[0]?.values?.length) {
    return null
  }
  const row = result[0].values[0]
  return { id: row[0], username: row[1], email: row[2], telegramId: row[3] }
}

const resolveSuperAdminUserByTelegramId = async telegramUserId => {
  const normalizedTelegramId = normalizeIdentifier(telegramUserId)
  if (!normalizedTelegramId) return null
  const db = await getDatabase()
  const user = findUserByTelegramId(db, normalizedTelegramId)
  if (!user) return null
  const isSuperAdmin = await userHasRoleKey(user.id, 'super_admin', db)
  return isSuperAdmin ? user : null
}

export async function startTelegramBot() {
  const settings = await getTelegramSettings(null, { forceRefresh: true })
  const token = String(settings.token || '').trim()

  if (!token) {
    console.log('[Telegram Bot] Bot Token 未配置，跳过启动')
    return null
  }

  const bot = new TelegramBot(token, { polling: true })
  const internalApiBaseUrl = resolveInternalApiBaseUrl()
  const internalApiTimeoutMs = Math.max(1000, toInt(process.env.TELEGRAM_INTERNAL_API_TIMEOUT_MS, 12000))
  const buyPollIntervalMs = Math.max(1500, toInt(process.env.TELEGRAM_BUY_POLL_INTERVAL_MS, 5000))
  const buyPollTimeoutMs = Math.max(30_000, toInt(process.env.TELEGRAM_BUY_POLL_TIMEOUT_MS, 35 * 60 * 1000))
  const purchaseExpireMinutes = Math.max(5, toInt(process.env.PURCHASE_ORDER_EXPIRE_MINUTES, 15))
  const derivedActivateUrl = (() => {
    const randomUrl = normalizeIdentifier(process.env.TELEGRAM_RANDOM_ACTIVATE_SSE_URL)
    if (!randomUrl) return ''
    try {
      const parsed = new URL(randomUrl)
      const pathname = parsed.pathname || ''
      const apiIndex = pathname.toLowerCase().indexOf('/api/')
      const basePath = apiIndex >= 0 ? pathname.slice(0, apiIndex) : ''
      const normalizedBase = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath
      return `${parsed.origin}${normalizedBase}/api/payments/checkout`
    } catch {
      return ''
    }
  })()
  const activateUrl = String(
    process.env.TELEGRAM_ACTIVATE_SSE_URL ||
      derivedActivateUrl ||
      'http://127.0.0.1:8000/api/payments/checkout'
  ).trim()
  const activateApiKey = (
    process.env.TELEGRAM_ACTIVATE_API_KEY ||
    process.env.TELEGRAM_RANDOM_ACTIVATE_API_KEY ||
    ''
  ).trim()
  const activateTimeoutMs = Math.max(
    1000,
    toInt(
      process.env.TELEGRAM_ACTIVATE_TIMEOUT_MS,
      toInt(process.env.TELEGRAM_RANDOM_ACTIVATE_TIMEOUT_MS, 120000)
    )
  )
  const randomActivateUrl = String(
    process.env.TELEGRAM_RANDOM_ACTIVATE_SSE_URL ||
      'http://127.0.0.1:8000/api/team/accounts/random/checkout/sse'
  ).trim()
  const randomActivateApiKey = (process.env.TELEGRAM_RANDOM_ACTIVATE_API_KEY || '').trim()
  const randomActivateTimeoutMs = Math.max(1000, toInt(process.env.TELEGRAM_RANDOM_ACTIVATE_TIMEOUT_MS, 120000))
  const internalApi = axios.create({
    baseURL: internalApiBaseUrl,
    timeout: internalApiTimeoutMs,
    validateStatus: () => true
  })
  const allowedUserIds = parseAllowedUserIds(settings.allowedUserIds || '')
  const restrictByUser = allowedUserIds.length > 0
  const allowedUserIdSet = new Set(allowedUserIds)
  const sessions = new Map()

  const ensureAuthorized = (msg, { requirePrivate = true } = {}) => {
    const chatId = msg.chat?.id
    const userId = msg.from?.id

    if (!chatId) {
      return false
    }

    if (restrictByUser && !userId) {
      bot.sendMessage(chatId, '无法识别你的身份，已拒绝请求。')
      return false
    }

    if (restrictByUser && userId && !allowedUserIdSet.has(String(userId))) {
      bot.sendMessage(chatId, '你没有权限使用这个机器人。')
      return false
    }

    if (requirePrivate && msg.chat?.type !== 'private') {
      bot.sendMessage(chatId, '为保护隐私，请在私聊中使用该命令。')
      return false
    }

    return true
  }

  const getPurchaseMessage = () => {
    const purchaseUrl =
      (process.env.PURCHASE_URL ||
        process.env.PURCHASE_LINK ||
        '').trim()
    const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '')
    const fallbackUrl = purchaseUrl || (publicBaseUrl ? `${publicBaseUrl}/purchase` : '')

    if (!fallbackUrl) {
      return '暂未配置购买地址，请联系管理员。'
    }

    return `购买链接：${fallbackUrl}`
  }

  const baseCommandLines = [
    '• /stock - 查看今日剩余库存',
    '• /buy - 购买（默认支付宝）',
    '• /redeem - 开始兑换',
    '• /cancel - 取消当前兑换流程',
    '• /help - 查看帮助说明'
  ]

  const buildStartMessage = async msg => {
    const lines = [
      '你好！我可以帮你完成 ChatGPT Team 账号的兑换。',
      '',
      '可用指令：',
      ...baseCommandLines
    ]
    const superAdmin = await resolveSuperAdminUserByTelegramId(msg.from?.id)
    if (superAdmin) {
      lines.push('• /random_activate - 随机激活账号')
      lines.push('• /activate <checkout_url> [activate_code] - 指定激活账号')
    }
    return lines.join('\n')
  }

  bot.onText(ADMIN_AUTH_REGEX, async (msg, match) => {
    const chatId = msg.chat?.id
    if (!chatId) return

    if (msg.chat?.type !== 'private') {
      await bot.sendMessage(chatId, '为保护隐私，请在私聊中使用该命令。')
      return
    }

    const telegramUserId = msg.from?.id
    if (!telegramUserId) {
      await bot.sendMessage(chatId, '无法识别你的身份，已拒绝请求。')
      return
    }

    const identifier = normalizeIdentifier(match?.[1])
    const inputKey = normalizeIdentifier(match?.[2])
    if (!identifier || !inputKey) {
      return
    }

    try {
      const expectedKey = normalizeIdentifier(await getExpectedApiKey())
      if (!expectedKey || inputKey !== expectedKey) {
        await bot.sendMessage(chatId, '❌ 认证失败：API key 不正确。')
        console.warn('[Telegram Bot] Admin auth failed', {
          identifier,
          telegramId: telegramUserId
        })
        return
      }

      const db = await getDatabase()
      const user = findUserByIdentifier(db, identifier)
      if (!user) {
        await bot.sendMessage(chatId, '❌ 未找到对应用户。')
        return
      }

      const normalizedTelegramId = String(telegramUserId)
      const boundResult = db.exec('SELECT id FROM users WHERE telegram_id = ? LIMIT 1', [normalizedTelegramId])
      const boundId = boundResult[0]?.values?.[0]?.[0]
      if (boundId && Number(boundId) !== Number(user.id)) {
        await bot.sendMessage(chatId, '❌ 当前 Telegram 账号已绑定其他用户，请联系管理员。')
        return
      }

      if (user.telegramId && String(user.telegramId) === normalizedTelegramId) {
        await bot.sendMessage(chatId, '✅ 已绑定，无需重复操作。')
        return
      }

      db.run('UPDATE users SET telegram_id = ? WHERE id = ?', [normalizedTelegramId, user.id])
      saveDatabase()
      await bot.sendMessage(chatId, `✅ 绑定成功：${user.username || user.email || identifier}`)
      console.log('[Telegram Bot] Admin auth binding updated', {
        userId: user.id,
        telegramId: normalizedTelegramId
      })
    } catch (error) {
      console.error('[Telegram Bot] Admin auth error', error)
      await bot.sendMessage(chatId, '❌ 绑定失败，请稍后重试或联系管理员。')
    }
  })

  const clearSession = chatId => {
    const session = sessions.get(chatId)
    if (!session) return
    if (session.buyPollTimer) {
      clearInterval(session.buyPollTimer)
    }
    sessions.delete(chatId)
  }

  const handleRedeemSubmission = async (chatId, email, code) => {
    try {
      await bot.sendChatAction(chatId, 'typing')
      const result = await redeemCodeInternal({
        email,
        code,
        channel: 'common'
      })
      const { data, metadata } = result || {}
      const inviteStatus = data?.inviteStatus || '邀请状态未知'
      const lines = [
        '✅ 兑换成功！',
        `兑换邮箱：${email}`,
        inviteStatus ? `邀请状态：${inviteStatus}` : null,
        '',
        data?.message || '请前往邮箱查收邀请邮件，如未收到请联系管理员。'
      ].filter(Boolean)
      await bot.sendMessage(chatId, lines.join('\n'))
      console.log('[Telegram Bot] 兑换成功', {
        email,
        code: metadata?.code,
        accountEmail: metadata?.accountEmail
      })
    } catch (error) {
      const isKnownError = error instanceof RedemptionError
      const message =
        (isKnownError && error.message) || '服务器错误，请稍后重试或联系管理员。'
      await bot.sendMessage(chatId, `❌ 兑换失败：${message}`)
      if (!isKnownError) {
        console.error('[Telegram Bot] 兑换失败', error)
      }
    } finally {
      clearSession(chatId)
    }
  }

  const fetchPurchaseMeta = async () => {
    const response = await internalApi.get('/purchase/meta')
    if (response.status !== 200) {
      const msg = response.data?.error ? String(response.data.error) : `HTTP ${response.status}`
      throw new Error(msg)
    }
    return response.data
  }

  const createPurchaseOrder = async email => {
    const response = await internalApi.post('/purchase/orders', { email, type: 'alipay' })
    if (response.status !== 200) {
      const msg = response.data?.error ? String(response.data.error) : `HTTP ${response.status}`
      throw new Error(msg)
    }
    return response.data
  }

  const fetchPurchaseOrder = async ({ orderNo, email, sync = false }) => {
    const response = await internalApi.get(`/purchase/orders/${encodeURIComponent(orderNo)}`, {
      params: { email, sync: sync ? 'true' : 'false' }
    })
    if (response.status !== 200) {
      const msg = response.data?.error ? String(response.data.error) : `HTTP ${response.status}`
      throw new Error(msg)
    }
    return response.data
  }

  const getOrderPaidHint = detail => {
    const order = detail?.order
    if (!order || order.status !== 'paid') return ''
    if (order.redeemError) return `支付成功，但自动开通失败：${order.redeemError}`
    if (order.inviteStatus) return `支付成功，${order.inviteStatus}`
    if (order.emailSentAt) return '支付成功，订单信息已发送至邮箱。'
    return '支付成功，处理中（如未生效请稍后在查询页查看）。'
  }

  const startBuyPolling = ({ chatId, orderNo, email }) => {
    const session = sessions.get(chatId)
    if (!session || session.stage !== 'buyPending') return

    const startedAt = Date.now()
    let inFlight = false
    let consecutiveErrors = 0

    session.buyPollTimer = setInterval(async () => {
      if (!sessions.has(chatId)) {
        clearInterval(session.buyPollTimer)
        return
      }

      if (Date.now() - startedAt > buyPollTimeoutMs) {
        try {
          await bot.sendMessage(
            chatId,
            '⏳ 已超时仍未确认支付状态，请稍后在网页“查询订单”页查看，或重新下单。'
          )
        } finally {
          clearSession(chatId)
        }
        return
      }

      if (inFlight) return
      inFlight = true
      try {
        const detail = await fetchPurchaseOrder({ orderNo, email })
        consecutiveErrors = 0
        const status = detail?.order?.status || ''
        if (!status) return

        if (status === 'paid') {
          const hint = getOrderPaidHint(detail)
          const lines = [
            '✅ 购买完成！',
            `订单号：${orderNo}`,
            `邮箱：${email}`,
            hint || '支付成功，正在为你处理订单',
            '',
            '如未收到邮件请检查垃圾箱，或使用网页“查询订单”页查看详情。'
          ].filter(Boolean)
          await bot.sendMessage(chatId, lines.join('\n'))
          clearSession(chatId)
          return
        }

        if (status === 'expired') {
          await bot.sendMessage(chatId, `⚠️ 订单已过期（订单号：${orderNo}），请重新下单。`)
          clearSession(chatId)
          return
        }

        if (status === 'failed') {
          await bot.sendMessage(chatId, `⚠️ 订单状态异常（订单号：${orderNo}），请稍后重试或联系管理员。`)
          clearSession(chatId)
          return
        }

        if (status === 'refunded') {
          await bot.sendMessage(chatId, `ℹ️ 订单已退款（订单号：${orderNo}）。`)
          clearSession(chatId)
        }
      } catch (error) {
        consecutiveErrors += 1
        if (consecutiveErrors >= 5) {
          try {
            await bot.sendMessage(
              chatId,
              `⚠️ 查询订单状态失败（订单号：${orderNo}）：${error?.message || String(error)}\n请稍后在网页“查询订单”页查看。`
            )
          } finally {
            clearSession(chatId)
          }
        }
      } finally {
        inFlight = false
      }
    }, buyPollIntervalMs)
  }

  bot.onText(COMMAND_REGEX.start, async msg => {
    if (!ensureAuthorized(msg, { requirePrivate: false })) {
      return
    }
    const startMessage = await buildStartMessage(msg)
    bot.sendMessage(msg.chat.id, startMessage)
  })

  bot.onText(COMMAND_REGEX.help, async msg => {
    if (!ensureAuthorized(msg, { requirePrivate: false })) {
      return
    }
    const helpMessage = await buildStartMessage(msg)
    bot.sendMessage(msg.chat.id, helpMessage)
  })

  bot.onText(COMMAND_REGEX.stock, async msg => {
    if (!ensureAuthorized(msg, { requirePrivate: false })) {
      return
    }
    const chatId = msg.chat.id
    try {
      await bot.sendChatAction(chatId, 'typing')
      const meta = await fetchPurchaseMeta()
      const lines = [
        `📦 今日剩余库存：${meta.availableCount ?? '未知'} 个`,
        meta.productName ? `商品：${meta.productName}` : null,
        meta.amount ? `价格：¥ ${meta.amount}` : null,
        meta.serviceDays ? `有效期：${meta.serviceDays} 天` : null,
        `订单有效期：${purchaseExpireMinutes} 分钟`
      ].filter(Boolean)
      await bot.sendMessage(chatId, lines.join('\n'))
    } catch (error) {
      await bot.sendMessage(chatId, `❌ 查询库存失败：${error?.message || String(error)}`)
    }
  })

  bot.onText(COMMAND_REGEX.buy, async msg => {
    if (!ensureAuthorized(msg, { requirePrivate: false })) {
      return
    }
    const chatId = msg.chat.id

    if (msg.chat?.type !== 'private') {
      bot.sendMessage(chatId, '为保护隐私，请在私聊中使用 /buy 进行购买。')
      return
    }

    clearSession(chatId)

    try {
      await bot.sendChatAction(chatId, 'typing')
      const meta = await fetchPurchaseMeta()
      if (typeof meta?.availableCount === 'number' && meta.availableCount <= 0) {
        await bot.sendMessage(chatId, '⚠️ 今日库存不足，请稍后再试。你也可以使用 /stock 查看库存。')
        return
      }

      const lines = [
        `📦 今日剩余库存：${meta.availableCount ?? '未知'} 个`,
        meta.productName ? `商品：${meta.productName}` : null,
        meta.amount ? `价格：¥ ${meta.amount}` : null,
        `订单有效期：${purchaseExpireMinutes} 分钟（超时自动过期）`,
        '',
        '请回复要接收订单信息的邮箱地址（格式：name@example.com）。',
        '（默认支付宝支付）'
      ].filter(Boolean)
      sessions.set(chatId, { stage: 'awaitingBuyEmail' })
      await bot.sendMessage(chatId, lines.join('\n'))
    } catch (error) {
      const fallback = getPurchaseMessage()
      await bot.sendMessage(
        chatId,
        `❌ 无法发起购买流程：${error?.message || String(error)}\n\n可改用网页购买：\n${fallback}`
      )
      clearSession(chatId)
    }
  })

  bot.onText(COMMAND_REGEX.redeem, msg => {
    if (!ensureAuthorized(msg, { requirePrivate: true })) {
      return
    }
    clearSession(msg.chat.id)
    sessions.set(msg.chat.id, { stage: 'awaitingEmail' })
    bot.sendMessage(
      msg.chat.id,
      '请回复要接收邀请的邮箱地址（格式：name@example.com）。'
    )
  })

  bot.onText(COMMAND_REGEX.cancel, msg => {
    if (!ensureAuthorized(msg, { requirePrivate: true })) {
      return
    }
    const chatId = msg.chat.id
    if (sessions.has(chatId)) {
      clearSession(chatId)
      bot.sendMessage(chatId, '已取消当前流程。')
    } else {
      bot.sendMessage(chatId, '当前没有正在进行的流程。')
    }
  })

  bot.onText(COMMAND_REGEX.randomActivate, async msg => {
    const chatId = msg.chat?.id
    if (!chatId) return

    if (msg.chat?.type !== 'private') {
      await bot.sendMessage(chatId, '为保护隐私，请在私聊中使用该命令。')
      return
    }

    const superAdmin = await resolveSuperAdminUserByTelegramId(msg.from?.id)
    if (!superAdmin) {
      await bot.sendMessage(chatId, '你没有权限使用这个指令。')
      return
    }

    if (!randomActivateApiKey) {
      await bot.sendMessage(chatId, '未配置 TELEGRAM_RANDOM_ACTIVATE_API_KEY，无法调用随机激活服务。')
      return
    }

    let progressMessageId = null
    let lastProgressText = ''
    let lastProgressUpdateAt = 0
    let selectedInfo = null
    let resultInfo = null

    const updateProgressMessage = async (text, { force = false } = {}) => {
      const now = Date.now()
      if (!force && now - lastProgressUpdateAt < SSE_PROGRESS_THROTTLE_MS) {
        return
      }
      if (text === lastProgressText) return
      lastProgressText = text
      lastProgressUpdateAt = now
      try {
        if (progressMessageId) {
          await bot.editMessageText(text, { chat_id: chatId, message_id: progressMessageId })
        } else {
          const message = await bot.sendMessage(chatId, text)
          progressMessageId = message.message_id
        }
      } catch (error) {
        if (!progressMessageId) {
          try {
            const message = await bot.sendMessage(chatId, text)
            progressMessageId = message.message_id
          } catch {
            return
          }
        }
      }
    }

    const formatProgressText = payload => {
      const lines = ['⏳ 自动激活中']
      if (selectedInfo?.email) {
        lines.push(`账号：${selectedInfo.email}`)
      }
      if (payload?.step_name) {
        const progressText =
          Number.isFinite(payload?.progress) ? `（${payload.progress}%）` : ''
        lines.push(`步骤：${payload.step_name}${progressText}`)
      }
      if (payload?.status) {
        lines.push(`状态：${payload.status}`)
      }
      if (payload?.message) {
        lines.push(payload.message)
      }
      if (payload?.timestamp) {
        lines.push(`时间：${payload.timestamp}`)
      }
      return lines.join('\n')
    }

    try {
      await bot.sendChatAction(chatId, 'typing')
      await updateProgressMessage('⏳ 正在连接随机激活服务...', { force: true })

      const response = await axios.get(randomActivateUrl, {
        timeout: randomActivateTimeoutMs,
        headers: {
          'x-api-key': randomActivateApiKey
        },
        responseType: 'stream',
        validateStatus: () => true
      })

      if (response.status !== 200) {
        const errorText = await readStreamText(response.data).catch(() => '')
        const message = errorText || `HTTP ${response.status}`
        throw new Error(message)
      }

      const stream = response.data
      await parseSseStream(stream, async ({ event, data }) => {
        const payload = safeJsonParse(data) || {}

        if (event === 'selected') {
          selectedInfo = payload
          await updateProgressMessage(formatProgressText(payload), { force: true })
          return
        }

        if (event === 'progress') {
          await updateProgressMessage(formatProgressText(payload))
          return
        }

        if (event === 'result') {
          resultInfo = payload
          stream.destroy()
        }
      })

      if (!resultInfo) {
        throw new Error('未收到最终结果，请稍后重试。')
      }

      if (!resultInfo.success) {
        const msgText = resultInfo.error || resultInfo.message || '未知错误'
        await updateProgressMessage(`❌ 随机激活失败：${msgText}`, { force: true })
        return
      }

      const card = resultInfo.card || {}
      const lines = [
        '✅ 随机激活成功',
        resultInfo.token_id != null ? `Token ID：${resultInfo.token_id}` : null,
        resultInfo.email ? `邮箱：${resultInfo.email}` : null,
        card.code ? `卡密：${card.code}` : null,
        Number.isFinite(card.use_count) ? `使用次数：${card.use_count}` : null,
        card.message ? `卡密状态：${card.message}` : null,
        typeof card.activated === 'boolean' ? `已激活：${card.activated ? '是' : '否'}` : null
      ].filter(Boolean)
      await updateProgressMessage('✅ 自动激活已完成', { force: true })
      await bot.sendMessage(chatId, lines.join('\n'))
    } catch (error) {
      await updateProgressMessage(`❌ 随机激活失败：${error?.message || String(error)}`, { force: true })
    }
  })

  bot.onText(COMMAND_REGEX.activate, async msg => {
    const chatId = msg.chat?.id
    if (!chatId) return

    if (msg.chat?.type !== 'private') {
      await bot.sendMessage(chatId, '为保护隐私，请在私聊中使用该命令。')
      return
    }

    const superAdmin = await resolveSuperAdminUserByTelegramId(msg.from?.id)
    if (!superAdmin) {
      await bot.sendMessage(chatId, '你没有权限使用这个指令。')
      return
    }

    if (!activateApiKey) {
      await bot.sendMessage(chatId, '未配置 TELEGRAM_ACTIVATE_API_KEY/TELEGRAM_RANDOM_ACTIVATE_API_KEY，无法调用激活服务。')
      return
    }

    const text = (msg.text || '').trim()
    const parts = text.split(/\s+/)
    const checkoutUrl = normalizeIdentifier(parts[1])
    const activateCode = normalizeIdentifier(parts[2])

    if (!checkoutUrl) {
      await bot.sendMessage(chatId, '用法：/activate <checkout_url> [activate_code]')
      return
    }

    let progressMessageId = null
    let lastProgressText = ''
    let lastProgressUpdateAt = 0
    let selectedInfo = null
    let resultInfo = null

    const updateProgressMessage = async (text, { force = false } = {}) => {
      const now = Date.now()
      if (!force && now - lastProgressUpdateAt < SSE_PROGRESS_THROTTLE_MS) {
        return
      }
      if (text === lastProgressText) return
      lastProgressText = text
      lastProgressUpdateAt = now
      try {
        if (progressMessageId) {
          await bot.editMessageText(text, { chat_id: chatId, message_id: progressMessageId })
        } else {
          const message = await bot.sendMessage(chatId, text)
          progressMessageId = message.message_id
        }
      } catch (error) {
        if (!progressMessageId) {
          try {
            const message = await bot.sendMessage(chatId, text)
            progressMessageId = message.message_id
          } catch {
            return
          }
        }
      }
    }

    const formatProgressText = payload => {
      const lines = ['⏳ 自动激活中']
      if (selectedInfo?.email) {
        lines.push(`账号：${selectedInfo.email}`)
      }
      if (payload?.step_name) {
        const progressText = Number.isFinite(payload?.progress) ? `（${payload.progress}%）` : ''
        lines.push(`步骤：${payload.step_name}${progressText}`)
      }
      if (payload?.status) {
        lines.push(`状态：${payload.status}`)
      }
      if (payload?.message) {
        lines.push(payload.message)
      }
      if (payload?.timestamp) {
        lines.push(`时间：${payload.timestamp}`)
      }
      return lines.join('\n')
    }

    try {
      await bot.sendChatAction(chatId, 'typing')
      await updateProgressMessage('⏳ 正在连接激活服务...', { force: true })

      const requestBody = {
        checkout_url: checkoutUrl,
        ...(activateCode ? { activate_code: activateCode } : {})
      }

      const response = await axios.post(activateUrl, requestBody, {
        timeout: activateTimeoutMs,
        headers: {
          'x-api-key': activateApiKey,
          'Content-Type': 'application/json'
        },
        responseType: 'stream',
        validateStatus: () => true
      })

      if (response.status < 200 || response.status >= 300) {
        const errorText = await readStreamText(response.data).catch(() => '')
        const message = errorText || `HTTP ${response.status}`
        throw new Error(message)
      }

      const stream = response.data
      const contentType = String(response.headers?.['content-type'] || '').toLowerCase()
      const isEventStream = contentType.includes('text/event-stream')

      if (!isEventStream) {
        const rawText = await readStreamText(stream, 65536).catch(() => '')
        resultInfo = safeJsonParse(rawText) || { success: false, message: rawText || '响应格式不支持' }
      } else {
        await parseSseStream(stream, async ({ event, data }) => {
          const payload = safeJsonParse(data) || {}

          if (event === 'selected') {
            selectedInfo = payload
            await updateProgressMessage(formatProgressText(payload), { force: true })
            return
          }

          if (event === 'progress' || event === 'message') {
            await updateProgressMessage(formatProgressText(payload))
            return
          }

          if (event === 'result' || event === 'done') {
            resultInfo = payload
            stream.destroy()
          }
        })
      }

      if (!resultInfo) {
        throw new Error('未收到最终结果，请稍后重试。')
      }

      if (!resultInfo.success) {
        const msgText = resultInfo.error || resultInfo.message || '未知错误'
        await updateProgressMessage(`❌ 激活失败：${msgText}`, { force: true })
        return
      }

      const card = resultInfo.card || {}
      const lines = [
        '✅ 激活成功',
        resultInfo.token_id != null ? `Token ID：${resultInfo.token_id}` : null,
        resultInfo.email ? `邮箱：${resultInfo.email}` : null,
        card.code ? `卡密：${card.code}` : null,
        Number.isFinite(card.use_count) ? `使用次数：${card.use_count}` : null,
        card.message ? `卡密状态：${card.message}` : null,
        typeof card.activated === 'boolean' ? `已激活：${card.activated ? '是' : '否'}` : null
      ].filter(Boolean)
      await updateProgressMessage('✅ 自动激活已完成', { force: true })
      await bot.sendMessage(chatId, lines.join('\n'))
    } catch (error) {
      await updateProgressMessage(`❌ 激活失败：${error?.message || String(error)}`, { force: true })
    }
  })

  bot.on('message', async msg => {
    const text = (msg.text || '').trim()
    const chatId = msg.chat?.id

    if (!chatId || !text || text.startsWith('/')) {
      return
    }

    const session = sessions.get(chatId)
    if (!session) {
      return
    }

    if (!ensureAuthorized(msg, { requirePrivate: true })) {
      return
    }

    if (session.stage === 'awaitingBuyEmail') {
      if (!EMAIL_REGEX.test(text)) {
        await bot.sendMessage(chatId, '邮箱格式不正确，请重新输入。')
        return
      }

      const email = text
      session.stage = 'creatingOrder'
      session.email = email

      try {
        await bot.sendChatAction(chatId, 'typing')
        const order = await createPurchaseOrder(email)
        session.stage = 'buyPending'
        session.orderNo = order.orderNo

        const lines = [
          '✅ 订单已创建，请使用支付宝扫码完成付款。',
          `订单号：${order.orderNo}`,
          `邮箱：${email}`,
          order.amount ? `金额：¥ ${order.amount}` : null,
          order.productName ? `商品：${order.productName}` : null,
          `订单有效期：${purchaseExpireMinutes} 分钟（超时自动过期）`,
          order.payUrl ? `支付链接：${order.payUrl}` : null,
          '',
          '付款完成后我会自动通知你。'
        ].filter(Boolean)

        await bot.sendMessage(chatId, lines.join('\n'))

        if (order.img) {
          try {
            await bot.sendPhoto(chatId, order.img, { caption: '支付宝付款码' })
          } catch (photoError) {
            console.warn('[Telegram Bot] send photo failed', {
              orderNo: order.orderNo,
              message: photoError?.message || String(photoError)
            })
          }
        }

        startBuyPolling({ chatId, orderNo: order.orderNo, email })
      } catch (error) {
        await bot.sendMessage(chatId, `❌ 创建订单失败：${error?.message || String(error)}`)
        clearSession(chatId)
      }
      return
    }

    if (session.stage === 'awaitingEmail') {
      if (!EMAIL_REGEX.test(text)) {
        await bot.sendMessage(chatId, '邮箱格式不正确，请重新输入。')
        return
      }
      session.email = text
      session.stage = 'awaitingCode'
      await bot.sendMessage(
        chatId,
        '收到 ✅ 请继续回复兑换码（格式：XXXX-XXXX-XXXX）。'
      )
      return
    }

    if (session.stage === 'awaitingCode') {
      const normalizedCode = text
        .toUpperCase()
        .replace(/[^A-Z0-9-]/g, '')
        .trim()
      if (!CODE_REGEX.test(normalizedCode)) {
        await bot.sendMessage(
          chatId,
          '兑换码格式不正确，请按 XXXX-XXXX-XXXX 的格式输入。'
        )
        return
      }
      const email = session.email
      session.stage = 'processing'
      await handleRedeemSubmission(chatId, email, normalizedCode)
    }
  })

  bot.on('polling_error', error => {
    console.error('[Telegram Bot] Polling error:', error?.message || error)
  })

  bot
    .getMe()
    .then(info => {
      const username = info.username ? `@${info.username}` : info.first_name || ''
      console.log(`[Telegram Bot] 已启动 ${username}`)
    })
    .catch(() => {
      console.log('[Telegram Bot] 已启动')
    })

  return bot
}
