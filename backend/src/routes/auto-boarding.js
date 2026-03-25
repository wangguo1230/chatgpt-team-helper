import express from 'express'
import { getDatabase, saveDatabase } from '../database/init.js'
import { apiKeyAuth } from '../middleware/api-key-auth.js'
import { syncAccountUserCount } from '../services/account-sync.js'
import { extractOpenAiAccountPayload } from '../utils/openai-account-payload.js'
import { getChannels, normalizeChannelKey } from '../utils/channels.js'
import { getOpenAccountsCapacityLimit } from '../utils/open-accounts-capacity-settings.js'
import { withLocks } from '../utils/locks.js'
import { encryptSensitiveText } from '../utils/sensitive-crypto.js'

const router = express.Router()

const EXPIRE_AT_REGEX = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/

const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase()

const normalizeSensitivePasswordInput = (value) => {
  if (value == null) return null
  const normalized = String(value).trim()
  if (!normalized) return ''
  return normalized.slice(0, 500)
}

const resolveSensitivePasswordPayload = (body, camelKey, snakeKey) => {
  const hasValue = Object.prototype.hasOwnProperty.call(body, camelKey)
    || Object.prototype.hasOwnProperty.call(body, snakeKey)
  if (!hasValue) return { hasValue: false, cipherValue: null }

  const normalized = normalizeSensitivePasswordInput(
    Object.prototype.hasOwnProperty.call(body, camelKey) ? body[camelKey] : body[snakeKey]
  )
  if (normalized === null) return { hasValue: true, cipherValue: null }
  if (!normalized) return { hasValue: true, cipherValue: null }
  return { hasValue: true, cipherValue: encryptSensitiveText(normalized) }
}

const normalizeBoolean = (value) => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (value === 1) return true
    if (value === 0) return false
    return null
  }
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw) return null
  if (['1', 'true', 'yes'].includes(raw)) return true
  if (['0', 'false', 'no'].includes(raw)) return false
  return null
}

const formatExpireAt = (date) => {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(date)
  } catch {
    const pad = (value) => String(value).padStart(2, '0')
    return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }
}

const normalizeExpireAt = (value) => {
  if (value == null) return null
  const raw = String(value).trim()
  if (!raw) return null
  if (EXPIRE_AT_REGEX.test(raw)) return raw

  const match = raw.match(/^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2})(?::\d{2})?$/)
  if (match) {
    return `${match[1]}/${match[2]}/${match[3]} ${match[4]}:${match[5]}`
  }

  const asNumber = Number(raw)
  if (Number.isFinite(asNumber) && asNumber > 0) {
    const date = new Date(asNumber)
    if (!Number.isNaN(date.getTime())) {
      return formatExpireAt(date)
    }
  }

  const parsedMs = Date.parse(raw)
  if (!Number.isNaN(parsedMs)) {
    return formatExpireAt(new Date(parsedMs))
  }

  return null
}

const decodeJwtPayload = (token) => {
  const raw = String(token || '').trim()
  if (!raw) return null
  const parts = raw.split('.')
  if (parts.length < 2) return null
  const payload = parts[1]
  if (!payload) return null
  try {
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=')
    const decoded = Buffer.from(padded, 'base64').toString('utf8')
    return JSON.parse(decoded)
  } catch {
    return null
  }
}

const deriveExpireAtFromToken = (token) => {
  const payload = decodeJwtPayload(token)
  if (!payload || typeof payload !== 'object') return null
  const exp = Number(payload.exp)
  if (!Number.isFinite(exp) || exp <= 0) return null
  const date = new Date(exp * 1000)
  if (Number.isNaN(date.getTime())) return null
  return formatExpireAt(date)
}

const ORDER_TYPE_WARRANTY = 'warranty'
const ORDER_TYPE_NO_WARRANTY = 'no_warranty'
const ORDER_TYPE_ANTI_BAN = 'anti_ban'
const ORDER_TYPE_SET = new Set([ORDER_TYPE_WARRANTY, ORDER_TYPE_NO_WARRANTY, ORDER_TYPE_ANTI_BAN])
const CODE_COUNT_MODE_FIXED = 'fixed'
const CODE_COUNT_MODE_MAX_MINUS = 'max_minus'
const CODE_COUNT_MODE_SET = new Set([CODE_COUNT_MODE_FIXED, CODE_COUNT_MODE_MAX_MINUS])

const parseIntStrict = (value) => {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10)
  return Number.isFinite(parsed) ? parsed : null
}

const normalizeOrderType = (value) => {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (normalized === 'no-warranty' || normalized === 'nowarranty') return ORDER_TYPE_NO_WARRANTY
  if (normalized === 'anti-ban') return ORDER_TYPE_ANTI_BAN
  if (!normalized) return ORDER_TYPE_WARRANTY
  return ORDER_TYPE_SET.has(normalized) ? normalized : null
}

const normalizeCountMode = (value) => {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (!normalized) return null
  if (normalized === 'maxminus' || normalized === 'max-minus') return CODE_COUNT_MODE_MAX_MINUS
  return CODE_COUNT_MODE_SET.has(normalized) ? normalized : null
}

// 生成随机兑换码
const generateRedemptionCode = (length = 12) => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < length; i += 1) {
    code += chars.charAt(Math.floor(Math.random() * chars.length))
    if ((i + 1) % 4 === 0 && i < length - 1) {
      code += '-'
    }
  }
  return code
}

const normalizeCodePlans = (value) => {
  if (value == null) return []
  if (!Array.isArray(value)) {
    throw new Error('codePlans 必须是数组')
  }

  return value.map((rawPlan, index) => {
    const plan = rawPlan && typeof rawPlan === 'object' ? rawPlan : null
    if (!plan) {
      throw new Error(`codePlans[${index}] 格式不正确`)
    }

    const channel = normalizeChannelKey(plan.channel ?? plan.channelKey ?? plan.channel_key, '')
    if (!channel) {
      throw new Error(`codePlans[${index}] 缺少渠道`)
    }

    const explicitMode = plan.countMode ?? plan.count_mode ?? null
    const hasMinusInput = (plan.minus ?? plan.maxMinus ?? plan.max_minus) != null
    const modeInput = explicitMode || (hasMinusInput ? CODE_COUNT_MODE_MAX_MINUS : CODE_COUNT_MODE_FIXED)
    const countMode = normalizeCountMode(modeInput)
    if (!countMode) {
      throw new Error(`codePlans[${index}] countMode 不合法（fixed/max_minus）`)
    }

    let count = null
    let minus = null
    if (countMode === CODE_COUNT_MODE_FIXED) {
      count = parseIntStrict(plan.count)
      if (count == null || count < 1 || count > 1000) {
        throw new Error(`codePlans[${index}] count 不合法（1-1000）`)
      }
    } else {
      const minusInput = plan.minus ?? plan.maxMinus ?? plan.max_minus ?? 0
      minus = parseIntStrict(minusInput)
      if (minus == null || minus < 0 || minus > 1000) {
        throw new Error(`codePlans[${index}] minus 不合法（0-1000）`)
      }
    }

    const rawOrderType = plan.orderType ?? plan.order_type
    const orderType = normalizeOrderType(rawOrderType)
    if (!orderType) {
      throw new Error(`codePlans[${index}] orderType 不合法（warranty/no_warranty/anti_ban）`)
    }

    const serviceDaysInput = plan.serviceDays ?? plan.service_days
    const hasServiceDays = serviceDaysInput !== undefined && serviceDaysInput !== null && String(serviceDaysInput).trim() !== ''
    if (orderType === ORDER_TYPE_WARRANTY && !hasServiceDays) {
      throw new Error(`codePlans[${index}] warranty 订单必须设置 serviceDays`)
    }

    let serviceDays = null
    if (orderType !== ORDER_TYPE_NO_WARRANTY && hasServiceDays) {
      serviceDays = parseIntStrict(serviceDaysInput)
      if (serviceDays == null || serviceDays < 1 || serviceDays > 3650) {
        throw new Error(`codePlans[${index}] serviceDays 不合法（1-3650）`)
      }
    }

    return {
      channel,
      countMode,
      count,
      minus,
      orderType,
      serviceDays
    }
  })
}

const buildSingleCodePlanFromPayload = (body = {}) => {
  const channelInput = body.channel ?? body.channelKey ?? body.channel_key
  const hasChannelInput = channelInput !== undefined && channelInput !== null && String(channelInput).trim() !== ''
  if (!hasChannelInput) return null

  const countModeInput = body.countMode ?? body.count_mode
  const codeCountInput = body.codeCount ?? body.code_count ?? body.count
  const orderTypeInput = body.orderType ?? body.order_type
  const serviceDaysInput = body.serviceDays ?? body.service_days
  const hasServiceDaysInput = serviceDaysInput != null && String(serviceDaysInput).trim() !== ''
  const singlePlan = {
    channel: channelInput,
    countMode: countModeInput,
    count: codeCountInput != null && String(codeCountInput).trim() !== '' ? codeCountInput : 1,
    minus: body.minus ?? body.maxMinus ?? body.max_minus,
    orderType: orderTypeInput ?? (hasServiceDaysInput ? ORDER_TYPE_WARRANTY : ORDER_TYPE_NO_WARRANTY),
    serviceDays: serviceDaysInput,
  }

  return normalizeCodePlans([singlePlan])[0]
}

const resolveCodePlansFromPayload = (body = {}) => {
  const plans = normalizeCodePlans(body.codePlans ?? body.code_plans)
  if (plans.length > 0) return plans

  const singlePlan = buildSingleCodePlanFromPayload(body)
  return singlePlan ? [singlePlan] : []
}

const runTransaction = async (db, callback) => {
  db.run('BEGIN IMMEDIATE TRANSACTION')
  try {
    const result = await callback()
    db.run('COMMIT')
    return result
  } catch (error) {
    try {
      db.run('ROLLBACK')
    } catch {
    }
    throw error
  }
}

const loadAccountUsage = (db, accountEmail) => {
  const accountResult = db.exec(
    `
      SELECT id,
             email,
             COALESCE(user_count, 0) AS user_count,
             COALESCE(invite_count, 0) AS invite_count,
             COALESCE(is_banned, 0) AS is_banned
      FROM gpt_accounts
      WHERE lower(trim(email)) = ?
      LIMIT 1
    `,
    [normalizeEmail(accountEmail)]
  )
  const accountRow = accountResult?.[0]?.values?.[0]
  if (!accountRow) return null

  const unusedCodesResult = db.exec(
    `
      SELECT COUNT(*)
      FROM redemption_codes
      WHERE lower(trim(account_email)) = ?
        AND is_redeemed = 0
    `,
    [normalizeEmail(accountEmail)]
  )
  const unusedCodes = Number(unusedCodesResult?.[0]?.values?.[0]?.[0] || 0)

  return {
    id: Number(accountRow[0]),
    email: String(accountRow[1] || ''),
    userCount: Number(accountRow[2] || 0),
    inviteCount: Number(accountRow[3] || 0),
    isBanned: Number(accountRow[4] || 0) === 1,
    unusedCodes
  }
}

const createCodesByPlans = async (db, { accountEmail, codePlans }) => {
  if (!Array.isArray(codePlans) || codePlans.length === 0) {
    return {
      generatedCodes: [],
      generatedCodesByChannel: {},
      capacityLimit: getOpenAccountsCapacityLimit(db),
      remainingSlots: null
    }
  }

  const { byKey: channelsByKey } = await getChannels(db, { forceRefresh: true })
  const accountUsage = loadAccountUsage(db, accountEmail)
  if (!accountUsage) {
    throw new Error('账号不存在，无法创建兑换码')
  }

  const capacityLimit = getOpenAccountsCapacityLimit(db)
  let remainingSlots = Math.max(0, capacityLimit - (accountUsage.userCount + accountUsage.inviteCount + accountUsage.unusedCodes))
  const generatedCodes = []
  const generatedCodesByChannel = {}

  for (const plan of codePlans) {
    const channelConfig = channelsByKey.get(plan.channel) || null
    if (!channelConfig || !channelConfig.isActive) {
      throw new Error(`渠道不存在或已停用：${plan.channel}`)
    }

    let targetCount = 0
    if (plan.countMode === CODE_COUNT_MODE_MAX_MINUS) {
      targetCount = Math.max(0, remainingSlots - Number(plan.minus || 0))
    } else {
      targetCount = Number(plan.count || 0)
    }

    if (targetCount > remainingSlots) {
      throw new Error(`渠道 ${plan.channel} 计划创建 ${targetCount} 个兑换码，但可用名额仅剩 ${remainingSlots}`)
    }

    if (targetCount <= 0) {
      if (!generatedCodesByChannel[plan.channel]) {
        generatedCodesByChannel[plan.channel] = []
      }
      continue
    }

    const resolvedChannelName = String(channelConfig.name || '').trim() || plan.channel
    const channelGenerated = []
    for (let i = 0; i < targetCount; i += 1) {
      let code = generateRedemptionCode()
      let attempts = 0
      let inserted = false
      while (attempts < 8 && !inserted) {
        try {
          db.run(
            `INSERT INTO redemption_codes (code, account_email, channel, channel_name, order_type, service_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))`,
            [code, accountEmail, plan.channel, resolvedChannelName, plan.orderType, plan.serviceDays]
          )
          const row = db.exec(
            `
              SELECT id, created_at, updated_at
              FROM redemption_codes
              WHERE code = ?
              LIMIT 1
            `,
            [code]
          )?.[0]?.values?.[0]
          const mapped = {
            id: Number(row?.[0] || 0),
            code,
            accountEmail,
            channel: plan.channel,
            channelName: resolvedChannelName,
            orderType: plan.orderType,
            serviceDays: plan.serviceDays,
            createdAt: row?.[1] || null,
            updatedAt: row?.[2] || null
          }
          channelGenerated.push(mapped)
          generatedCodes.push(mapped)
          inserted = true
        } catch (error) {
          if (String(error?.message || '').includes('UNIQUE')) {
            code = generateRedemptionCode()
            attempts += 1
            continue
          }
          throw error
        }
      }
      if (!inserted) {
        throw new Error(`渠道 ${plan.channel} 生成兑换码失败（多次冲突）`)
      }
    }

    generatedCodesByChannel[plan.channel] = channelGenerated
    remainingSlots -= targetCount
  }

  return { generatedCodes, generatedCodesByChannel, capacityLimit, remainingSlots }
}

async function syncAccountAndCleanup(account) {
  let syncData = null
  const removedUsers = []

  try {
    console.log('[Auto Boarding] 准备同步账号:', {
      email: account.email,
      chatgptAccountId: account.chatgptAccountId
    })
    syncData = await syncAccountUserCount(account.id, {
      accountRecord: account
    })
    console.log('[Auto Boarding] 同步完成:', {
      email: account.email,
      syncedUserCount: syncData.syncedUserCount,
      fetchedUsers: syncData?.users?.items?.length || 0
    })
  } catch (syncError) {
    console.error('[Auto Boarding] 同步失败:', syncError)
    return {
      account,
      syncResult: null,
      removedUsers
    }
  }

  return {
    account: syncData?.account || account,
    syncResult: syncData
      ? {
        syncedUserCount: syncData.syncedUserCount,
        users: syncData.users
      }
      : null,
    removedUsers
  }
}

// 自动上车接口
router.post('/', apiKeyAuth, async (req, res) => {
  try {
    const body = req.body || {}
    const extracted = extractOpenAiAccountPayload(body)
    if (extracted.parseErrors.length > 0) {
      return res.status(400).json({
        error: extracted.parseErrors[0],
        message: extracted.parseErrors[0]
      })
    }

    const email = String(extracted.email || body.email || '').trim()
    const token = String(extracted.token || '').trim()
    const refreshToken = String(extracted.refreshToken || '').trim()
    const chatgptAccountId = String(extracted.chatgptAccountId || '').trim()
    const oaiDeviceId = String(extracted.oaiDeviceId || body.oaiDeviceId || '').trim()
    const hasIsOpen = Object.prototype.hasOwnProperty.call(body, 'isOpen') || Object.prototype.hasOwnProperty.call(body, 'is_open')
    const isOpenInput = Object.prototype.hasOwnProperty.call(body, 'isOpen') ? body.isOpen : body.is_open
    const normalizedIsOpen = hasIsOpen ? normalizeBoolean(isOpenInput) : true
    if (normalizedIsOpen == null) {
      return res.status(400).json({ error: 'Invalid isOpen format', message: 'isOpen 必须是布尔值' })
    }
    const isOpen = Boolean(normalizedIsOpen)
    const hasExpireAt = extracted.hasExpireAt || Object.prototype.hasOwnProperty.call(body, 'expireAt')
    const expireAtInput = hasExpireAt
      ? (extracted.hasExpireAt ? extracted.expireAtInput : body.expireAt)
      : null
    const normalizedExpireAt = hasExpireAt ? normalizeExpireAt(expireAtInput) : null
    const shouldUpdateExpireAt = hasExpireAt || Boolean(deriveExpireAtFromToken(token))
    const derivedExpireAt = shouldUpdateExpireAt && !hasExpireAt ? deriveExpireAtFromToken(token) : null
    const expireAt = hasExpireAt ? normalizedExpireAt : (derivedExpireAt || null)
    const codePlans = resolveCodePlansFromPayload(body)
    const gptPasswordPatch = resolveSensitivePasswordPayload(body, 'gptPassword', 'gpt_password')
    const emailPasswordPatch = resolveSensitivePasswordPayload(body, 'emailPassword', 'email_password')
    // isDemoted/is_demoted: deprecated (ignored). Keep request compatibility.

    if (hasExpireAt && expireAtInput != null && String(expireAtInput).trim() && !normalizedExpireAt) {
      return res.status(400).json({
        error: 'Invalid expireAt format',
        message: 'expireAt 格式错误，请使用 YYYY/MM/DD HH:mm'
      })
    }

    // 验证必填字段
    if (!email || !token) {
      return res.status(400).json({
        error: 'Email and token are required',
        message: '邮箱和Token是必填项'
      })
    }

    const normalizedEmail = normalizeEmail(email)

    const db = await getDatabase()
    const lockKeys = chatgptAccountId
      ? [`auto-boarding:account:${chatgptAccountId}`, `auto-boarding:email:${normalizedEmail}`]
      : [`auto-boarding:email:${normalizedEmail}`]

    const result = await withLocks(lockKeys, async () => {
      return runTransaction(db, async () => {
        // 检查账号是否已存在（通过email或chatgptAccountId）
        let existingAccount = null

        if (chatgptAccountId) {
          const byIdResult = db.exec(
            'SELECT id, email, COALESCE(is_banned, 0) AS is_banned FROM gpt_accounts WHERE chatgpt_account_id = ?',
            [chatgptAccountId]
          )
          if (byIdResult.length > 0 && byIdResult[0].values.length > 0) {
            existingAccount = {
              id: Number(byIdResult[0].values[0][0]),
              email: String(byIdResult[0].values[0][1] || ''),
              isBanned: Number(byIdResult[0].values[0][2] || 0) === 1
            }
          }
        }

        // 如果chatgptAccountId未找到，再通过email查找
        if (!existingAccount) {
          const byEmailResult = db.exec(
            'SELECT id, email, COALESCE(is_banned, 0) AS is_banned FROM gpt_accounts WHERE lower(trim(email)) = ?',
            [normalizedEmail]
          )
          if (byEmailResult.length > 0 && byEmailResult[0].values.length > 0) {
            existingAccount = {
              id: Number(byEmailResult[0].values[0][0]),
              email: String(byEmailResult[0].values[0][1] || ''),
              isBanned: Number(byEmailResult[0].values[0][2] || 0) === 1
            }
          }
        }

        if (existingAccount && existingAccount.isBanned && isOpen) {
          throw new Error('账号已封号，不能设置为开放账号')
        }
        if (existingAccount && existingAccount.isBanned && codePlans.length > 0) {
          throw new Error('账号已封号，不能创建兑换码')
        }

        let action = 'updated'
        let accountId = existingAccount?.id || 0

        if (existingAccount) {
          db.run(
            `UPDATE gpt_accounts
             SET token = ?,
                 refresh_token = ?,
                 chatgpt_account_id = ?,
                 oai_device_id = ?,
                 is_open = ?,
                 expire_at = CASE WHEN ? = 1 THEN ? ELSE expire_at END,
                 gpt_password_cipher = CASE WHEN ? = 1 THEN ? ELSE gpt_password_cipher END,
                 email_password_cipher = CASE WHEN ? = 1 THEN ? ELSE email_password_cipher END,
                 updated_at = DATETIME('now', 'localtime')
             WHERE id = ?`,
            [
              token,
              refreshToken || null,
              chatgptAccountId || null,
              oaiDeviceId || null,
              isOpen ? 1 : 0,
              shouldUpdateExpireAt ? 1 : 0,
              expireAt,
              gptPasswordPatch.hasValue ? 1 : 0,
              gptPasswordPatch.cipherValue,
              emailPasswordPatch.hasValue ? 1 : 0,
              emailPasswordPatch.cipherValue,
              existingAccount.id
            ]
          )
        } else {
          action = 'created'
          db.run(
            `INSERT INTO gpt_accounts
             (email, token, refresh_token, user_count, chatgpt_account_id, oai_device_id, expire_at, is_open, gpt_password_cipher, email_password_cipher, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))`,
            [
              normalizedEmail,
              token,
              refreshToken || null,
              1,
              chatgptAccountId || null,
              oaiDeviceId || null,
              expireAt,
              isOpen ? 1 : 0,
              gptPasswordPatch.cipherValue,
              emailPasswordPatch.cipherValue
            ]
          )
          accountId = Number(db.exec('SELECT last_insert_rowid()')[0]?.values?.[0]?.[0] || 0)
        }

        const accountResult = db.exec(
          `
            SELECT id, email, token, refresh_token, COALESCE(user_count, 0), COALESCE(invite_count, 0), chatgpt_account_id, oai_device_id, expire_at, COALESCE(is_open, 0), created_at, updated_at, gpt_password_cipher, email_password_cipher
            FROM gpt_accounts
            WHERE id = ?
            LIMIT 1
          `,
          [accountId]
        )
        const accountRow = accountResult?.[0]?.values?.[0]
        if (!accountRow) {
          throw new Error('账号写入失败')
        }

        const account = {
          id: Number(accountRow[0]),
          email: String(accountRow[1] || ''),
          token: String(accountRow[2] || ''),
          refreshToken: accountRow[3] || null,
          userCount: Number(accountRow[4] || 0),
          inviteCount: Number(accountRow[5] || 0),
          chatgptAccountId: String(accountRow[6] || ''),
          oaiDeviceId: accountRow[7] || null,
          expireAt: accountRow[8] || null,
          isOpen: Number(accountRow[9] || 0) === 1,
          isDemoted: false,
          hasGptPassword: Boolean(accountRow[12]),
          hasEmailPassword: Boolean(accountRow[13]),
          createdAt: accountRow[10],
          updatedAt: accountRow[11]
        }

        const codeCreation = await createCodesByPlans(db, {
          accountEmail: account.email,
          codePlans
        })

        return {
          action,
          account,
          codeCreation
        }
      })
    })

    saveDatabase()

    const { account: syncedAccount, syncResult, removedUsers } = await syncAccountAndCleanup(result.account)
    const responseAccount = {
      ...(syncedAccount || result.account),
      hasGptPassword: Boolean(result.account?.hasGptPassword),
      hasEmailPassword: Boolean(result.account?.hasEmailPassword)
    }
    const createdCount = result.codeCreation.generatedCodes.length
    const message = result.action === 'created'
      ? '自动上车成功！账号已添加到系统'
      : '账号信息已更新'

    const payload = {
      success: true,
      message,
      action: result.action,
      account: responseAccount,
      generatedCodes: result.codeCreation.generatedCodes,
      generatedCodesByChannel: result.codeCreation.generatedCodesByChannel,
      generatedCodesCount: createdCount,
      capacityLimit: result.codeCreation.capacityLimit,
      remainingSlots: result.codeCreation.remainingSlots,
      syncResult,
      removedUsers
    }

    if (result.action === 'created') {
      return res.status(201).json(payload)
    }

    return res.json(payload)
  } catch (error) {
    console.error('Auto boarding error:', error)
    if (String(error?.message || '').includes('codePlans') || String(error?.message || '').includes('渠道') || String(error?.message || '').includes('serviceDays') || String(error?.message || '').includes('orderType') || String(error?.message || '').includes('账号已封号')) {
      return res.status(400).json({
        error: error.message,
        message: error.message
      })
    }
    res.status(500).json({
      error: 'Internal server error',
      message: '服务器错误，请稍后重试'
    })
  }
})

// 获取自动上车统计信息（可选）
router.get('/stats', apiKeyAuth, async (req, res) => {
  try {
    const db = await getDatabase()

    // 获取总账号数
    const totalResult = db.exec('SELECT COUNT(*) as count FROM gpt_accounts')
    const total = totalResult[0]?.values[0]?.[0] || 0

    // 获取最近24小时新增的账号数
    const recentResult = db.exec(`
      SELECT COUNT(*) as count
      FROM gpt_accounts
      WHERE created_at >= datetime('now', 'localtime', '-1 day')
    `)
    const recent = recentResult[0]?.values[0]?.[0] || 0

    res.json({
      success: true,
      stats: {
        totalAccounts: total,
        recentAccounts: recent
      }
    })
  } catch (error) {
    console.error('Get stats error:', error)
    res.status(500).json({
      error: 'Internal server error',
      message: '获取统计信息失败'
    })
  }
})

export default router
