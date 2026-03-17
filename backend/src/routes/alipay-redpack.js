import express from 'express'
import { authenticateToken } from '../middleware/auth.js'
import { requireMenu } from '../middleware/rbac.js'
import {
  createAlipayRedpackOrderPublic,
  listAlipayRedpackOrdersAdmin,
  getAlipayRedpackOrderById,
  listAlipayRedpackSupplementOrdersByEmail,
  getAlipayRedpackSupplementCandidateByOrder,
  prepareAlipayRedpackOrderForAutoSupplement,
  createAlipayRedpackSupplementRecord,
  updateAlipayRedpackSupplementRecord,
  getAlipayRedpackSupplementById,
  listAlipayRedpackSupplementsAdmin,
  getAlipayRedpackRedemptionCodeStockSummary,
  consumeAlipayRedpackOrderRedemptionCode,
  rollbackAlipayRedpackOrderRedemptionCodeConsume,
  markAlipayRedpackOrderInviteFailed,
  markAlipayRedpackOrderInvited,
  markAlipayRedpackOrderRedeemed,
  markAlipayRedpackOrderReturned,
  updateAlipayRedpackOrderInviteResult,
  updateAlipayRedpackOrderNote,
  AlipayRedpackOrderError,
} from '../services/alipay-redpack-orders.js'
import { performDirectInvite } from '../services/direct-invite.js'
import {
  fetchAccountUsersList,
  fetchAccountInvites,
  syncAccountUserCount,
  syncAccountInviteCount,
  AccountSyncError,
} from '../services/account-sync.js'
import { sendAdminAlertEmail } from '../services/email-service.js'

const router = express.Router()

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const ADMIN_MENU_KEY = 'alipay_redpack_orders'
const SUPPLEMENT_ADMIN_MENU_KEY = 'alipay_redpack_supplements'
const parsePositiveIntWithDefault = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
const PUBLIC_RATE_LIMIT_WINDOW_MS = parsePositiveIntWithDefault(process.env.ALIPAY_REDPACK_PUBLIC_RATE_LIMIT_WINDOW_SEC, 60) * 1000
const PUBLIC_RATE_LIMIT_MAX = parsePositiveIntWithDefault(process.env.ALIPAY_REDPACK_PUBLIC_RATE_LIMIT_MAX, 30)
const ADMIN_ALERT_SUMMARY_INTERVAL_MS = parsePositiveIntWithDefault(process.env.ALIPAY_REDPACK_ADMIN_ALERT_SUMMARY_INTERVAL_SEC, 600) * 1000
const ADMIN_ALERT_SUMMARY_MAX_EVENTS = parsePositiveIntWithDefault(process.env.ALIPAY_REDPACK_ADMIN_ALERT_SUMMARY_MAX_EVENTS, 500)
const PUBLIC_RATE_LIMIT_STORE = new Map()
const ADMIN_ALERT_SUMMARY_QUEUE = []
let adminAlertSummaryFlushing = false
let adminAlertSummaryTimer = null

const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase()
const toPositiveInt = (value) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.floor(parsed)
}
const normalizeIp = (value) => {
  const ip = String(value || '').trim()
  if (!ip) return ''
  if (ip === '::1') return '127.0.0.1'
  const ipv4Mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (ipv4Mapped) return ipv4Mapped[1]
  return ip
}
const resolveClientIp = (req) => {
  const xRealIp = normalizeIp(req?.headers?.['x-real-ip'])
  if (xRealIp) return xRealIp

  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').trim()
  if (forwarded) {
    const chain = forwarded.split(',').map(item => normalizeIp(item)).filter(Boolean)
    if (chain.length) return chain[chain.length - 1]
  }

  const fallback = normalizeIp(req?.ip || req?.socket?.remoteAddress || '')
  return fallback || 'unknown'
}
const cleanupPublicRateLimitStore = (now = Date.now()) => {
  const staleMs = Math.max(PUBLIC_RATE_LIMIT_WINDOW_MS * 3, 5 * 60 * 1000)
  for (const [key, bucket] of PUBLIC_RATE_LIMIT_STORE.entries()) {
    if (!bucket?.windowStart || now - bucket.windowStart >= staleMs) {
      PUBLIC_RATE_LIMIT_STORE.delete(key)
    }
  }
}
const enforcePublicRateLimit = (req, res) => {
  const now = Date.now()
  cleanupPublicRateLimitStore(now)

  const ip = resolveClientIp(req)
  const bucket = PUBLIC_RATE_LIMIT_STORE.get(ip)
  if (!bucket || now - bucket.windowStart >= PUBLIC_RATE_LIMIT_WINDOW_MS) {
    PUBLIC_RATE_LIMIT_STORE.set(ip, { count: 1, windowStart: now })
    return false
  }

  if (bucket.count >= PUBLIC_RATE_LIMIT_MAX) {
    const retryAfterSeconds = Math.max(1, Math.ceil((PUBLIC_RATE_LIMIT_WINDOW_MS - (now - bucket.windowStart)) / 1000))
    res.set('Retry-After', String(retryAfterSeconds))
    res.status(429).json({
      error: `提交过于频繁，请 ${retryAfterSeconds} 秒后再试`
    })
    return true
  }

  bucket.count += 1
  PUBLIC_RATE_LIMIT_STORE.set(ip, bucket)
  return false
}
const formatOrderAlertTime = (value) => {
  const date = value ? new Date(value) : new Date()
  if (Number.isNaN(date.getTime())) {
    return new Date().toLocaleString('zh-CN', { hour12: false })
  }
  return date.toLocaleString('zh-CN', { hour12: false })
}
const trimQueueToMax = () => {
  if (ADMIN_ALERT_SUMMARY_QUEUE.length <= ADMIN_ALERT_SUMMARY_MAX_EVENTS) return
  const overflow = ADMIN_ALERT_SUMMARY_QUEUE.length - ADMIN_ALERT_SUMMARY_MAX_EVENTS
  ADMIN_ALERT_SUMMARY_QUEUE.splice(0, overflow)
}
const buildSummaryText = (batch) => {
  const startedAt = batch[0]?.eventTime || formatOrderAlertTime()
  const endedAt = batch[batch.length - 1]?.eventTime || startedAt
  const lines = [
    `汇总条数：${batch.length}`,
    `时间范围：${startedAt} - ${endedAt}`,
    '',
  ]

  batch.forEach((item, index) => {
    lines.push(`${index + 1}. [${item.eventTime}] ${item.action}`)
    lines.push(`订单ID：${item.orderId || '-'} | 邮箱：${item.email || '-'}`)
    lines.push(`口令：${item.alipayPassphrase || '-'}`)
    lines.push(`状态：${item.status || '-'} | 备注：${item.note || '-'}`)
    lines.push('')
  })

  return lines.join('\n')
}
const flushOrderAlertSummary = async () => {
  if (adminAlertSummaryFlushing) return false
  if (!ADMIN_ALERT_SUMMARY_QUEUE.length) return false

  adminAlertSummaryFlushing = true
  const batch = ADMIN_ALERT_SUMMARY_QUEUE.splice(0, ADMIN_ALERT_SUMMARY_QUEUE.length)

  try {
    const subject = `支付宝口令红包订单汇总通知（${batch.length}条）`
    const text = buildSummaryText(batch)
    await sendAdminAlertEmail({ subject, text })
    return true
  } catch (error) {
    console.warn('[AlipayRedpack] 汇总通知邮件发送失败:', error?.message || error)
    ADMIN_ALERT_SUMMARY_QUEUE.unshift(...batch)
    trimQueueToMax()
    return false
  } finally {
    adminAlertSummaryFlushing = false
  }
}
const ensureSummaryTimer = () => {
  if (adminAlertSummaryTimer) return
  adminAlertSummaryTimer = setInterval(() => {
    flushOrderAlertSummary().catch((error) => {
      console.warn('[AlipayRedpack] 汇总通知任务执行异常:', error?.message || error)
    })
  }, ADMIN_ALERT_SUMMARY_INTERVAL_MS)
  if (typeof adminAlertSummaryTimer.unref === 'function') {
    adminAlertSummaryTimer.unref()
  }
}

const resolveOperator = (req) => {
  const userId = toPositiveInt(req?.user?.id)
  const username = String(req?.user?.username ?? '').trim() || null
  return {
    operatorUserId: userId,
    operatorUsername: username,
  }
}

const enqueueOrderAlertSummary = ({ action, order }) => {
  if (!order) return false
  ensureSummaryTimer()

  ADMIN_ALERT_SUMMARY_QUEUE.push({
    action: String(action || '').trim() || '未知动作',
    orderId: Number(order.id || 0) || null,
    email: String(order.email || '').trim(),
    alipayPassphrase: String(order.alipayPassphrase || '').trim(),
    note: String(order.note || '').trim(),
    status: String(order.status || '').trim(),
    eventTime: formatOrderAlertTime(order.updatedAt || order.createdAt),
  })
  trimQueueToMax()

  return true
}

const detectEmailInAccountQueues = async (accountId, email) => {
  const normalizedEmail = normalizeEmail(email)
  if (!normalizedEmail) {
    return { isMember: false, isInvited: false }
  }

  const [users, invites] = await Promise.all([
    fetchAccountUsersList(accountId, { userListParams: { offset: 0, limit: 25, query: normalizedEmail } }),
    fetchAccountInvites(accountId, { inviteListParams: { offset: 0, limit: 25, query: normalizedEmail } }),
  ])

  const isMember = (users?.items || []).some((item) => normalizeEmail(item?.email) === normalizedEmail)
  const isInvited = (invites?.items || []).some((item) => normalizeEmail(item?.email_address) === normalizedEmail)

  return { isMember, isInvited }
}
const sleep = async (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const syncAndDetectEmailQueueState = async (accountId, email, { retryOnMissing = false } = {}) => {
  await Promise.allSettled([
    syncAccountUserCount(accountId, { userListParams: { offset: 0, limit: 1, query: '' } }),
    syncAccountInviteCount(accountId, { inviteListParams: { offset: 0, limit: 1, query: '' } }),
  ])

  let queueState = await detectEmailInAccountQueues(accountId, email)
  if (retryOnMissing && !queueState.isMember && !queueState.isInvited) {
    await sleep(1200)
    await Promise.allSettled([
      syncAccountUserCount(accountId, { userListParams: { offset: 0, limit: 1, query: '' } }),
      syncAccountInviteCount(accountId, { inviteListParams: { offset: 0, limit: 1, query: '' } }),
    ])
    queueState = await detectEmailInAccountQueues(accountId, email)
  }

  return queueState
}

const resolveRouteError = (error, fallback = '服务器错误，请稍后再试') => {
  if (error instanceof AlipayRedpackOrderError) {
    return {
      status: error.statusCode || 400,
      body: {
        error: error.message,
        code: error.code,
      },
    }
  }

  if (error instanceof AccountSyncError || error?.status) {
    return {
      status: Number(error.status || 500),
      body: {
        error: error.message || fallback,
      },
    }
  }

  return {
    status: 500,
    body: { error: fallback },
  }
}

const executeAlipayRedpackOrderSupplement = async ({
  email,
  orderId,
  note,
  requestedBy = 'public',
  operator = null,
} = {}) => {
  const requestLabel = String(requestedBy || 'public').trim() || 'public'
  const allowPending = requestLabel !== 'public'
  const candidate = await getAlipayRedpackSupplementCandidateByOrder({
    email,
    orderId,
    allowPending,
  })
  const normalizedOrderId = Number(candidate?.order?.id || orderId || 0)
  const normalizedEmail = normalizeEmail(candidate?.order?.email || email)

  let supplement = await createAlipayRedpackSupplementRecord({
    orderId: normalizedOrderId,
    email: normalizedEmail,
    status: 'processing',
    requestedBy: requestLabel,
    detail: '补录任务已创建，准备自动处理',
    withinWarranty: candidate.withinWarranty,
    windowEndsAt: candidate.windowEndsAt,
  })

  if (!candidate.withinWarranty) {
    supplement = await updateAlipayRedpackSupplementRecord(supplement.id, {
      status: 'rejected_out_of_warranty',
      detail: '已超过质保天数，拒绝自动补录',
    })
    return {
      ok: false,
      status: 403,
      body: {
        error: '已超过质保天数，无法自动补录，请联系客服',
        code: 'alipay_redpack_out_of_warranty',
        order: candidate.order,
        windowEndsAt: candidate.windowEndsAt,
        supplement,
      },
    }
  }

  try {
    await prepareAlipayRedpackOrderForAutoSupplement(normalizedOrderId, {
      note,
      inviteResult: '自动补录：重新分配兑换码并开始邀请',
    })
  } catch (error) {
    if (error instanceof AlipayRedpackOrderError && error.code === 'alipay_redpack_out_of_stock') {
      supplement = await updateAlipayRedpackSupplementRecord(supplement.id, {
        status: 'manual_required',
        detail: '自动补录失败：补录库存不足，需要人工介入',
      })
      return {
        ok: false,
        status: 409,
        body: {
          error: '当前补录库存不足，已转人工处理',
          code: 'alipay_redpack_out_of_stock',
          manualInterventionRequired: true,
          order: candidate.order,
          windowEndsAt: candidate.windowEndsAt,
          supplement,
        },
      }
    }

    if (error instanceof AlipayRedpackOrderError && error.code === 'alipay_redpack_order_returned') {
      supplement = await updateAlipayRedpackSupplementRecord(supplement.id, {
        status: 'skipped_no_need',
        detail: '订单已退回，跳过自动补录',
      })
      return {
        ok: false,
        status: 409,
        body: {
          error: '该订单已退回，无法补录，请让用户重新提交有效口令',
          code: error.code,
          order: candidate.order,
          windowEndsAt: candidate.windowEndsAt,
          supplement,
        },
      }
    }

    const resolved = resolveRouteError(error, '自动补录准备失败')
    supplement = await updateAlipayRedpackSupplementRecord(supplement.id, {
      status: 'auto_failed',
      detail: `自动补录准备失败：${resolved.body?.error || error?.message || '未知错误'}`,
    })
    return {
      ok: false,
      status: resolved.status,
      body: {
        ...resolved.body,
        order: candidate.order,
        windowEndsAt: candidate.windowEndsAt,
        supplement,
      },
    }
  }

  const orderForInvite = await getAlipayRedpackOrderById(normalizedOrderId)
  if (!orderForInvite) {
    throw new AlipayRedpackOrderError('订单不存在', 404, 'alipay_redpack_not_found')
  }

  let inviteSent = false
  let consumeResult = null
  try {
    consumeResult = await consumeAlipayRedpackOrderRedemptionCode(normalizedOrderId, {
      redeemedBy: `alipay_redpack_supplement:${supplement.id} | order:${normalizedOrderId} | email:${normalizedEmail}`,
    })

    const invite = await performDirectInvite({
      email: normalizedEmail,
      consumeCode: false,
    })
    inviteSent = true

    const queueState = await syncAndDetectEmailQueueState(invite.accountId, normalizedEmail, { retryOnMissing: true })

    let updatedOrder = null
    if (queueState.isMember) {
      updatedOrder = await markAlipayRedpackOrderRedeemed(normalizedOrderId, {
        inviteResult: `自动补录成功，用户已入组（账号：${invite.accountEmail}）`,
        invitedAccountId: invite.accountId,
        invitedAccountEmail: invite.accountEmail,
        ...(operator || {}),
      })
    } else if (queueState.isInvited) {
      updatedOrder = await markAlipayRedpackOrderInvited(normalizedOrderId, {
        inviteResult: `自动补录成功，邀请已发送（账号：${invite.accountEmail}）`,
        invitedAccountId: invite.accountId,
        invitedAccountEmail: invite.accountEmail,
        ...(operator || {}),
      })
    } else {
      updatedOrder = await markAlipayRedpackOrderInvited(normalizedOrderId, {
        inviteResult: `自动补录成功，邀请请求已提交但暂未检索到记录（账号：${invite.accountEmail}）`,
        invitedAccountId: invite.accountId,
        invitedAccountEmail: invite.accountEmail,
        ...(operator || {}),
      })
    }

    supplement = await updateAlipayRedpackSupplementRecord(supplement.id, {
      status: 'auto_success',
      detail: '自动补录成功',
      redemptionCodeId: consumeResult?.code?.id || updatedOrder?.redemptionCodeId || null,
      redemptionCode: consumeResult?.code?.code || null,
      inviteAccountId: invite.accountId,
      inviteAccountEmail: invite.accountEmail,
      queueIsMember: queueState.isMember,
      queueIsInvited: queueState.isInvited,
      withinWarranty: candidate.withinWarranty,
      windowEndsAt: candidate.windowEndsAt,
    })

    enqueueOrderAlertSummary({
      action: requestLabel === 'public' ? '公开补录（订单自动补录）' : '后台补录（订单自动补录）',
      order: updatedOrder,
    })

    return {
      ok: true,
      status: 200,
      body: {
        message: '补录成功，已自动完成处理',
        order: updatedOrder,
        windowEndsAt: candidate.windowEndsAt,
        supplement,
        queueState,
        redemptionCode: consumeResult?.code || null,
      },
    }
  } catch (error) {
    if (!inviteSent && consumeResult?.consumedNow) {
      const codeId = Number(consumeResult?.code?.id || orderForInvite.redemptionCodeId || 0)
      if (codeId > 0) {
        await rollbackAlipayRedpackOrderRedemptionCodeConsume({
          orderId: normalizedOrderId,
          codeId,
        }).catch((rollbackError) => {
          console.warn('[AlipayRedpack] 自动补录失败后回滚兑换码失败:', rollbackError?.message || rollbackError)
        })
      }
    }

    const inviteErrorMessage = String(error?.message || '自动补录失败').trim() || '自动补录失败'
    const updatedOrder = await markAlipayRedpackOrderInviteFailed(normalizedOrderId, {
      inviteResult: `自动补录失败：${inviteErrorMessage}`,
      ...(operator || {}),
    })

    supplement = await updateAlipayRedpackSupplementRecord(supplement.id, {
      status: 'auto_failed',
      detail: `自动补录失败：${inviteErrorMessage}`,
      redemptionCodeId: consumeResult?.code?.id || updatedOrder?.redemptionCodeId || null,
      redemptionCode: consumeResult?.code?.code || null,
      withinWarranty: candidate.withinWarranty,
      windowEndsAt: candidate.windowEndsAt,
    })

    const resolved = resolveRouteError(error, inviteErrorMessage)
    return {
      ok: false,
      status: resolved.status,
      body: {
        ...resolved.body,
        order: updatedOrder,
        supplement,
        windowEndsAt: candidate.windowEndsAt,
      },
    }
  }
}

router.post('/orders', async (req, res) => {
  try {
    if (enforcePublicRateLimit(req, res)) return

    const { email, alipayPassphrase, note } = req.body || {}
    const order = await createAlipayRedpackOrderPublic({
      email,
      alipayPassphrase,
      note,
    })

    enqueueOrderAlertSummary({ action: '公开提交', order })

    res.json({
      message: '提交成功',
      order,
    })
  } catch (error) {
    console.error('[AlipayRedpack] 创建订单失败:', error)
    const resolved = resolveRouteError(error, '提交失败，请稍后重试')
    res.status(resolved.status).json(resolved.body)
  }
})

router.get('/stock', async (_req, res) => {
  try {
    const stock = await getAlipayRedpackRedemptionCodeStockSummary()
    const availableCount = Number.isFinite(Number(stock?.availableCount))
      ? Math.max(0, Number(stock.availableCount))
      : 0
    const reservedCount = Number.isFinite(Number(stock?.reservedCount))
      ? Math.max(0, Number(stock.reservedCount))
      : 0
    const totalUnusedCount = Number.isFinite(Number(stock?.totalUnusedCount))
      ? Math.max(0, Number(stock.totalUnusedCount))
      : availableCount + reservedCount

    res.json({
      availableCount,
      rawAvailableCount: availableCount,
      pendingReservationCount: reservedCount,
      reservedCount,
      totalUnusedCount,
      updatedAt: new Date().toISOString(),
    })
  } catch (error) {
    console.error('[AlipayRedpack] 获取库存失败:', error)
    const resolved = resolveRouteError(error, '库存加载失败，请稍后重试')
    res.status(resolved.status).json(resolved.body)
  }
})

router.get('/orders/supplement/candidates', async (req, res) => {
  try {
    const { email } = req.query || {}
    const data = await listAlipayRedpackSupplementOrdersByEmail(email, { limit: 30 })
    res.json(data)
  } catch (error) {
    console.error('[AlipayRedpack] 查询补录候选订单失败:', error)
    const resolved = resolveRouteError(error, '查询补录候选订单失败')
    res.status(resolved.status).json(resolved.body)
  }
})

router.post('/orders/supplement', async (req, res) => {
  try {
    if (enforcePublicRateLimit(req, res)) return

    const { email, orderId, note } = req.body || {}
    const result = await executeAlipayRedpackOrderSupplement({
      email,
      orderId,
      note,
      requestedBy: 'public',
    })
    res.status(result.status).json(result.body)
  } catch (error) {
    console.error('[AlipayRedpack] 订单补录失败:', error)
    const resolved = resolveRouteError(error, '补录失败，请稍后重试')
    res.status(resolved.status).json(resolved.body)
  }
})

router.get('/admin/orders', authenticateToken, requireMenu(ADMIN_MENU_KEY), async (req, res) => {
  try {
    const { search = '', status = 'all', limit = 200, offset = 0 } = req.query || {}
    const data = await listAlipayRedpackOrdersAdmin({
      search,
      status,
      limit,
      offset,
    })

    res.json(data)
  } catch (error) {
    console.error('[AlipayRedpack] 查询订单失败:', error)
    const resolved = resolveRouteError(error, '获取订单列表失败')
    res.status(resolved.status).json(resolved.body)
  }
})

router.get('/admin/supplements', authenticateToken, requireMenu(SUPPLEMENT_ADMIN_MENU_KEY), async (req, res) => {
  try {
    const { search = '', status = 'all', limit = 200, offset = 0 } = req.query || {}
    const data = await listAlipayRedpackSupplementsAdmin({
      search,
      status,
      limit,
      offset,
    })
    res.json(data)
  } catch (error) {
    console.error('[AlipayRedpack] 查询补录记录失败:', error)
    const resolved = resolveRouteError(error, '获取补录记录失败')
    res.status(resolved.status).json(resolved.body)
  }
})

router.post('/admin/supplements/:id/retry', authenticateToken, requireMenu(SUPPLEMENT_ADMIN_MENU_KEY), async (req, res) => {
  try {
    const supplementId = toPositiveInt(req.params.id)
    if (!supplementId) {
      return res.status(400).json({ error: '无效补录记录ID' })
    }

    const supplement = await getAlipayRedpackSupplementById(supplementId)
    if (!supplement) {
      return res.status(404).json({ error: '补录记录不存在' })
    }

    const operator = resolveOperator(req)
    const result = await executeAlipayRedpackOrderSupplement({
      email: supplement.email,
      orderId: supplement.orderId,
      note: req.body?.note,
      requestedBy: 'admin_retry',
      operator,
    })

    res.status(result.status).json({
      ...result.body,
      retryFromSupplementId: supplementId,
    })
  } catch (error) {
    console.error('[AlipayRedpack] 重试补录失败:', error)
    const resolved = resolveRouteError(error, '重试补录失败，请稍后重试')
    res.status(resolved.status).json(resolved.body)
  }
})

router.patch('/admin/supplements/:id/manual-close', authenticateToken, requireMenu(SUPPLEMENT_ADMIN_MENU_KEY), async (req, res) => {
  try {
    const supplementId = toPositiveInt(req.params.id)
    if (!supplementId) {
      return res.status(400).json({ error: '无效补录记录ID' })
    }

    const detail = String(req.body?.detail || '').trim() || '已人工介入处理'
    const updated = await updateAlipayRedpackSupplementRecord(supplementId, {
      status: 'manual_done',
      detail,
    })

    res.json({
      message: '补录记录已标记为人工处理完成',
      record: updated,
    })
  } catch (error) {
    console.error('[AlipayRedpack] 标记人工处理失败:', error)
    const resolved = resolveRouteError(error, '标记人工处理失败')
    res.status(resolved.status).json(resolved.body)
  }
})

router.post('/admin/orders/:id/quick-invite', authenticateToken, requireMenu(ADMIN_MENU_KEY), async (req, res) => {
  try {
    const orderId = toPositiveInt(req.params.id)
    if (!orderId) {
      return res.status(400).json({ error: '无效订单ID' })
    }

    const order = await getAlipayRedpackOrderById(orderId)
    if (!order) {
      return res.status(404).json({ error: '订单不存在' })
    }
    if (!EMAIL_REGEX.test(String(order.email || ''))) {
      return res.status(400).json({ error: '订单邮箱格式无效，无法发起邀请' })
    }
    if (order.status === 'returned') {
      return res.status(409).json({ error: '该订单已退回，无法邀请，请让用户重新提交有效口令', order })
    }
    if (order.status === 'redeemed') {
      return res.status(409).json({ error: '该订单已兑换，无需重复邀请', order })
    }

    const operator = resolveOperator(req)

    let inviteSent = false
    let consumeResult = null
    try {
      consumeResult = await consumeAlipayRedpackOrderRedemptionCode(orderId, {
        redeemedBy: `alipay_redpack_order:${orderId} | email:${order.email}`,
      })

      const invite = await performDirectInvite({
        email: order.email,
        accountId: req.body?.accountId,
        consumeCode: false,
      })
      inviteSent = true

      const queueState = await syncAndDetectEmailQueueState(invite.accountId, order.email, { retryOnMissing: true })

      let updatedOrder = null
      if (queueState.isMember) {
        updatedOrder = await markAlipayRedpackOrderRedeemed(orderId, {
          inviteResult: `邀请成功，用户已入组（账号：${invite.accountEmail}）`,
          invitedAccountId: invite.accountId,
          invitedAccountEmail: invite.accountEmail,
          ...operator,
        })
      } else if (queueState.isInvited) {
        updatedOrder = await markAlipayRedpackOrderInvited(orderId, {
          inviteResult: `邀请已发送，等待用户接受（账号：${invite.accountEmail}）`,
          invitedAccountId: invite.accountId,
          invitedAccountEmail: invite.accountEmail,
          ...operator,
        })
      } else {
        updatedOrder = await markAlipayRedpackOrderInvited(orderId, {
          inviteResult: `邀请请求成功，但暂未检索到邀请记录（账号：${invite.accountEmail}）`,
          invitedAccountId: invite.accountId,
          invitedAccountEmail: invite.accountEmail,
          ...operator,
        })
      }

      return res.json({
        message: '快速邀请执行完成',
        invite,
        queueState,
        order: updatedOrder,
        redemptionCode: consumeResult?.code || null,
      })
    } catch (error) {
      if (!inviteSent && consumeResult?.consumedNow) {
        const codeId = Number(consumeResult?.code?.id || order.redemptionCodeId || 0)
        if (codeId > 0) {
          await rollbackAlipayRedpackOrderRedemptionCodeConsume({
            orderId,
            codeId,
          }).catch((rollbackError) => {
            console.warn('[AlipayRedpack] 快速邀请失败后回滚兑换码失败:', rollbackError?.message || rollbackError)
          })
        }
      }

      const inviteErrorMessage = String(error?.message || '邀请失败').trim() || '邀请失败'
      const updatedOrder = await markAlipayRedpackOrderInviteFailed(orderId, {
        inviteResult: `邀请失败：${inviteErrorMessage}`,
        ...operator,
      })

      const resolved = resolveRouteError(error, inviteErrorMessage)
      return res.status(resolved.status).json({
        ...resolved.body,
        order: updatedOrder,
      })
    }
  } catch (error) {
    console.error('[AlipayRedpack] 快速邀请异常:', error)
    const resolved = resolveRouteError(error, '快速邀请失败，请稍后重试')
    res.status(resolved.status).json(resolved.body)
  }
})

router.post('/admin/orders/:id/sync-status', authenticateToken, requireMenu(ADMIN_MENU_KEY), async (req, res) => {
  try {
    const orderId = toPositiveInt(req.params.id)
    if (!orderId) {
      return res.status(400).json({ error: '无效订单ID' })
    }

    const order = await getAlipayRedpackOrderById(orderId)
    if (!order) {
      return res.status(404).json({ error: '订单不存在' })
    }
    if (order.status === 'returned') {
      return res.status(409).json({ error: '该订单已退回，无需同步状态', order })
    }

    const accountId = toPositiveInt(order.invitedAccountId)
    if (!accountId) {
      return res.status(400).json({ error: '该订单未关联邀请账号，无法同步状态', order })
    }

    const operator = resolveOperator(req)

    const queueState = await syncAndDetectEmailQueueState(accountId, order.email, { retryOnMissing: true })

    let updatedOrder
    if (queueState.isMember) {
      updatedOrder = await markAlipayRedpackOrderRedeemed(orderId, {
        inviteResult: '同步完成：用户已入组，订单已兑换',
        invitedAccountId: accountId,
        invitedAccountEmail: order.invitedAccountEmail,
        ...operator,
      })
    } else if (queueState.isInvited) {
      updatedOrder = await markAlipayRedpackOrderInvited(orderId, {
        inviteResult: '同步完成：邀请仍有效，等待用户接受',
        invitedAccountId: accountId,
        invitedAccountEmail: order.invitedAccountEmail,
        ...operator,
      })
    } else {
      updatedOrder = await updateAlipayRedpackOrderInviteResult(orderId, {
        inviteResult: '同步完成：未检索到邀请或成员，请在账号管理执行同步自查',
        ...operator,
      })
    }

    res.json({
      message: '状态同步完成',
      queueState,
      order: updatedOrder,
    })
  } catch (error) {
    console.error('[AlipayRedpack] 同步状态失败:', error)
    const resolved = resolveRouteError(error, '同步状态失败，请稍后重试')
    res.status(resolved.status).json(resolved.body)
  }
})

router.post('/admin/orders/:id/return', authenticateToken, requireMenu(ADMIN_MENU_KEY), async (req, res) => {
  try {
    const orderId = toPositiveInt(req.params.id)
    if (!orderId) {
      return res.status(400).json({ error: '无效订单ID' })
    }

    const order = await getAlipayRedpackOrderById(orderId)
    if (!order) {
      return res.status(404).json({ error: '订单不存在' })
    }

    const operator = resolveOperator(req)
    const returned = await markAlipayRedpackOrderReturned(orderId, {
      reason: req.body?.reason,
      ...operator,
    })

    res.json({
      message: '订单已退回并释放占用',
      order: returned,
    })
  } catch (error) {
    console.error('[AlipayRedpack] 退回订单失败:', error)
    const resolved = resolveRouteError(error, '退回订单失败，请稍后重试')
    res.status(resolved.status).json(resolved.body)
  }
})

router.patch('/admin/orders/:id/note', authenticateToken, requireMenu(ADMIN_MENU_KEY), async (req, res) => {
  try {
    const orderId = toPositiveInt(req.params.id)
    if (!orderId) {
      return res.status(400).json({ error: '无效订单ID' })
    }

    const note = req.body?.note
    const operator = resolveOperator(req)
    const order = await updateAlipayRedpackOrderNote(orderId, {
      note,
      ...operator,
    })

    res.json({
      message: '备注已更新',
      order,
    })
  } catch (error) {
    console.error('[AlipayRedpack] 更新备注失败:', error)
    const resolved = resolveRouteError(error, '更新备注失败，请稍后重试')
    res.status(resolved.status).json(resolved.body)
  }
})

export default router
