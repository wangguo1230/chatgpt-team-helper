import express from 'express'
import crypto from 'crypto'
import { authenticateToken } from '../middleware/auth.js'
import { requireMenu } from '../middleware/rbac.js'
import { getDatabase, saveDatabase } from '../database/init.js'
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
  acquireAlipayRedpackOrderSupplementExecution,
  releaseAlipayRedpackOrderSupplementExecution,
  AlipayRedpackOrderError,
} from '../services/alipay-redpack-orders.js'
import { performDirectInvite } from '../services/direct-invite.js'
import {
  fetchAccountUsersList,
  fetchAccountInvites,
  syncAccountUserCount,
  syncAccountInviteCount,
  revokeAccountInviteByEmail,
  AccountSyncError,
} from '../services/account-sync.js'
import {
  sendAdminAlertEmail,
  sendVerificationCodeEmail,
  sendAlipayRedpackOrderProcessedEmail,
  sendAlipayRedpackOrderReturnedEmail,
} from '../services/email-service.js'
import { withLocks } from '../utils/locks.js'

const router = express.Router()

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const ADMIN_MENU_KEY = 'alipay_redpack_orders'
const SUPPLEMENT_ADMIN_MENU_KEY = 'alipay_redpack_supplements'
const SUPPLEMENT_AUTH_PURPOSE = 'alipay_redpack_supplement'
const parsePositiveIntWithDefault = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
const PUBLIC_RATE_LIMIT_WINDOW_MS = parsePositiveIntWithDefault(process.env.ALIPAY_REDPACK_PUBLIC_RATE_LIMIT_WINDOW_SEC, 60) * 1000
const PUBLIC_RATE_LIMIT_MAX = parsePositiveIntWithDefault(process.env.ALIPAY_REDPACK_PUBLIC_RATE_LIMIT_MAX, 30)
const SUPPLEMENT_REQUIRE_OTP = String(process.env.ALIPAY_REDPACK_SUPPLEMENT_REQUIRE_OTP || 'true').trim().toLowerCase() !== 'false'
const SUPPLEMENT_OTP_TTL_MINUTES = Math.max(1, Math.ceil(parsePositiveIntWithDefault(process.env.ALIPAY_REDPACK_SUPPLEMENT_OTP_TTL_SEC, 300) / 60))
const SUPPLEMENT_OTP_SEND_COOLDOWN_SEC = parsePositiveIntWithDefault(process.env.ALIPAY_REDPACK_SUPPLEMENT_OTP_SEND_COOLDOWN_SEC, 60)
const SUPPLEMENT_OTP_MAX_VERIFY_FAILS = parsePositiveIntWithDefault(process.env.ALIPAY_REDPACK_SUPPLEMENT_OTP_MAX_VERIFY_FAILS, 6)
const SUPPLEMENT_TICKET_TTL_SEC = parsePositiveIntWithDefault(process.env.ALIPAY_REDPACK_SUPPLEMENT_TICKET_TTL_SEC, 900)
const SUPPLEMENT_TICKET_MAX_USES = parsePositiveIntWithDefault(process.env.ALIPAY_REDPACK_SUPPLEMENT_TICKET_MAX_USES, 8)
const ADMIN_ALERT_SUMMARY_INTERVAL_MS = parsePositiveIntWithDefault(process.env.ALIPAY_REDPACK_ADMIN_ALERT_SUMMARY_INTERVAL_SEC, 600) * 1000
const ADMIN_ALERT_SUMMARY_MAX_EVENTS = parsePositiveIntWithDefault(process.env.ALIPAY_REDPACK_ADMIN_ALERT_SUMMARY_MAX_EVENTS, 500)
const PUBLIC_RATE_LIMIT_STORE = new Map()
const ADMIN_ALERT_SUMMARY_QUEUE = []
let adminAlertSummaryFlushing = false
let adminAlertSummaryTimer = null

const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase()
const sha256 = (value) => crypto.createHash('sha256').update(String(value ?? '')).digest('hex')
const randomVerificationCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0')
const randomTicket = () => crypto.randomBytes(32).toString('hex')
const toPositiveInt = (value) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.floor(parsed)
}
const normalizeUserAgent = (value) => String(value || '').trim().slice(0, 512)
const resolveClientUserAgent = (req) => normalizeUserAgent(req?.headers?.['user-agent'] || 'unknown')
const pad2 = (value) => String(value).padStart(2, '0')
const EXPIRE_AT_PARSE_REGEX = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/
const parseExpireAtToMs = (value) => {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const match = raw.match(EXPIRE_AT_PARSE_REGEX)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = match[6] != null ? Number(match[6]) : 0
  if (![year, month, day, hour, minute, second].every(Number.isFinite)) return null
  if (month < 1 || month > 12) return null
  if (day < 1 || day > 31) return null
  if (hour < 0 || hour > 23) return null
  if (minute < 0 || minute > 59) return null
  if (second < 0 || second > 59) return null

  const iso = `${match[1]}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}+08:00`
  const parsed = Date.parse(iso)
  return Number.isNaN(parsed) ? null : parsed
}
const normalizeIp = (value) => {
  const ip = String(value || '').trim()
  if (!ip) return ''
  if (ip === '::1') return '127.0.0.1'
  const ipv4Mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (ipv4Mapped) return ipv4Mapped[1]
  return ip
}
const isPrivateIpv4 = (ip) => {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) return false
  const parts = ip.split('.').map((item) => Number(item))
  if (parts.length !== 4 || parts.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) {
    return false
  }

  const [a, b] = parts
  if (a === 10 || a === 127) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return false
}
const isTrustedProxySource = (ip) => {
  const normalized = normalizeIp(ip).toLowerCase()
  if (!normalized) return false
  if (isPrivateIpv4(normalized)) return true
  if (normalized === '::1') return true
  return normalized.startsWith('fc') || normalized.startsWith('fd')
}
const resolveClientIp = (req) => {
  const remoteAddress = normalizeIp(req?.socket?.remoteAddress || '')
  const shouldTrustProxyHeaders = isTrustedProxySource(remoteAddress)

  if (shouldTrustProxyHeaders) {
    const xRealIp = normalizeIp(req?.headers?.['x-real-ip'])
    if (xRealIp) return xRealIp

    const forwarded = String(req?.headers?.['x-forwarded-for'] || '').trim()
    if (forwarded) {
      const chain = forwarded.split(',').map(item => normalizeIp(item)).filter(Boolean)
      if (chain.length) return chain[0]
    }
  }

  const fallback = normalizeIp(req?.ip || remoteAddress || '')
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
const loadGptAccountBasicById = async (accountId) => {
  const normalizedAccountId = toPositiveInt(accountId)
  if (!normalizedAccountId) return null
  const db = await getDatabase()
  const result = db.exec(
    `
      SELECT id, email, COALESCE(is_open, 0), COALESCE(is_banned, 0), expire_at
      FROM gpt_accounts
      WHERE id = ?
      LIMIT 1
    `,
    [normalizedAccountId]
  )
  const row = result?.[0]?.values?.[0]
  if (!row) return null
  return {
    id: Number(row[0] || 0),
    email: String(row[1] || '').trim(),
    isOpen: Number(row[2] || 0) === 1,
    isBanned: Number(row[3] || 0) === 1,
    expireAt: row[4] ? String(row[4]) : null,
  }
}
const loadGptAccountIdByEmail = async (email) => {
  const normalizedEmail = normalizeEmail(email)
  if (!EMAIL_REGEX.test(normalizedEmail)) return null
  const db = await getDatabase()
  const result = db.exec(
    `
      SELECT id
      FROM gpt_accounts
      WHERE lower(trim(email)) = ?
      ORDER BY id ASC
      LIMIT 1
    `,
    [normalizedEmail]
  )
  const row = result?.[0]?.values?.[0]
  const id = toPositiveInt(row?.[0])
  return id || null
}
const isGptAccountInvalidForSupplement = (account) => {
  if (!account) return true
  if (account.isBanned) return true
  if (!account.isOpen) return true
  const expireAtMs = parseExpireAtToMs(account.expireAt)
  if (Number.isFinite(expireAtMs) && expireAtMs < Date.now()) return true
  return false
}
const SOURCE_SYNC_ALLOW_AUTO_SUPPLEMENT_KEYWORDS = [
  'account_deactivated',
  'openai 账号已停用',
  '账号已停用',
  'token 已过期',
  'token已过期',
  'token 已失效',
  'token 无效',
  'token无效',
  '请更新账号 token',
  'token 自动刷新失败',
  'refresh token',
  'oauth 刷新返回',
]
const isSourceSyncFailureAllowedForAutoSupplement = (error) => {
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status)
  if (status === 401) return true
  const message = String(error?.message || '').trim().toLowerCase()
  if (!message) return false
  return SOURCE_SYNC_ALLOW_AUTO_SUPPLEMENT_KEYWORDS.some(keyword => message.includes(keyword))
}
const resolveSourceSyncFailureReason = (error) => {
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status)
  const message = String(error?.message || '').trim().replace(/\s+/g, ' ').slice(0, 160)
  if (message) {
    if (Number.isFinite(status) && status > 0) {
      return `${message}（状态码 ${status}）`
    }
    return message
  }
  if (Number.isFinite(status) && status > 0) {
    return `状态码 ${status}`
  }
  return '未知错误'
}
const evaluateOrderPreSupplementEligibility = async ({ order } = {}) => {
  const normalizedStatus = String(order?.status || '').trim().toLowerCase()
  const accountId = toPositiveInt(order?.invitedAccountId)
  if (!accountId) {
    return {
      eligible: normalizedStatus !== 'invited',
      status: 409,
      code: 'alipay_redpack_invited_account_missing',
      message: '原订单处于已邀请状态但未绑定邀请账号，暂不支持自动补录，请联系管理员处理',
      supplementStatus: 'manual_required',
      queueState: { isMember: false, isInvited: false },
      accountInvalid: true,
      account: null,
    }
  }

  const account = await loadGptAccountBasicById(accountId)
  const accountInvalid = isGptAccountInvalidForSupplement(account)
  let queueState = { isMember: false, isInvited: false }

  try {
    queueState = await syncAndDetectEmailQueueState(accountId, order?.email, { retryOnMissing: true })
  } catch (error) {
    const syncFailureReason = resolveSourceSyncFailureReason(error)
    if (isSourceSyncFailureAllowedForAutoSupplement(error)) {
      console.warn('[AlipayRedpack] 原账号状态同步失败但命中可自动补录条件，继续自动补录', {
        orderId: Number(order?.id || 0) || null,
        accountId,
        reason: syncFailureReason,
      })
      return {
        eligible: true,
        queueState: { isMember: false, isInvited: false },
        accountInvalid: true,
        account,
      }
    }
    return {
      eligible: false,
      status: 202,
      code: 'alipay_redpack_supplement_source_sync_failed',
      message: `原账号状态同步失败：${syncFailureReason}。为避免重复邀请，暂不执行自动补录，已转人工处理`,
      supplementStatus: 'manual_required',
      queueState,
      accountInvalid,
      account,
    }
  }

  if (queueState.isMember) {
    return {
      eligible: false,
      status: 409,
      code: 'alipay_redpack_supplement_no_need_member',
      message: '检测到该邮箱已在原账号中，无需补录',
      supplementStatus: 'skipped_no_need',
      queueState,
      accountInvalid,
      account,
    }
  }

  if (queueState.isInvited) {
    return {
      eligible: false,
      status: 409,
      code: 'alipay_redpack_supplement_invite_active',
      message: '检测到原邀请仍有效，暂不支持自动补录',
      supplementStatus: 'skipped_no_need',
      queueState,
      accountInvalid,
      account,
    }
  }

  if (normalizedStatus === 'invited' && !accountInvalid) {
    return {
      eligible: false,
      status: 409,
      code: 'alipay_redpack_supplement_source_account_still_valid',
      message: '原邀请账号仍可用，暂不支持对已邀请订单自动补录',
      supplementStatus: 'skipped_no_need',
      queueState,
      accountInvalid,
      account,
    }
  }

  return {
    eligible: true,
    queueState,
    accountInvalid,
    account,
  }
}
const ensureOrderStillActiveBeforeQueueSync = async ({ orderId, accountId, email } = {}) => {
  const normalizedOrderId = toPositiveInt(orderId)
  const normalizedAccountId = toPositiveInt(accountId)
  const normalizedEmail = normalizeEmail(email)
  if (!normalizedOrderId || !normalizedAccountId || !EMAIL_REGEX.test(normalizedEmail)) {
    return true
  }

  const latestOrder = await getAlipayRedpackOrderById(normalizedOrderId)
  const latestStatus = String(latestOrder?.status || '').trim().toLowerCase()
  if (latestStatus !== 'returned') {
    return true
  }

  try {
    await revokeAccountInviteByEmail(normalizedAccountId, normalizedEmail)
  } catch (error) {
    throw new AlipayRedpackOrderError(
      '订单已退回，自动撤销刚发送的邀请失败，请人工介入处理',
      409,
      'alipay_redpack_invite_revoke_failed'
    )
  }

  throw new AlipayRedpackOrderError(
    '该订单已退回，已自动撤销刚发送的邀请，请让用户重新提交有效口令',
    409,
    'alipay_redpack_order_returned'
  )
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

const notifyOrderProcessedEmailSafely = async ({ orderId, email } = {}) => {
  const normalizedOrderId = toPositiveInt(orderId)
  const normalizedEmail = normalizeEmail(email)
  if (!normalizedOrderId || !EMAIL_REGEX.test(normalizedEmail)) return false
  try {
    return await sendAlipayRedpackOrderProcessedEmail({
      to: normalizedEmail,
      orderId: normalizedOrderId,
    })
  } catch (error) {
    console.warn('[AlipayRedpack] 发送订单处理通知邮件失败:', error?.message || error)
    return false
  }
}
const notifyOrderReturnedEmailSafely = async ({ orderId, email, reason } = {}) => {
  const normalizedOrderId = toPositiveInt(orderId)
  const normalizedEmail = normalizeEmail(email)
  if (!normalizedOrderId || !EMAIL_REGEX.test(normalizedEmail)) return false
  try {
    return await sendAlipayRedpackOrderReturnedEmail({
      to: normalizedEmail,
      orderId: normalizedOrderId,
      reason: String(reason || '').trim(),
    })
  } catch (error) {
    console.warn('[AlipayRedpack] 发送订单退回通知邮件失败:', error?.message || error)
    return false
  }
}

const PUBLIC_SUPPLEMENT_AUTH_ERROR = {
  status: 403,
  body: {
    error: '补录认证已失效，请重新完成邮箱验证',
    code: 'alipay_redpack_supplement_auth_required',
  },
}

const sanitizePublicOrder = (order) => {
  if (!order || typeof order !== 'object') return null
  return {
    id: Number(order.id || 0) || null,
    email: String(order.email || '').trim(),
    status: String(order.status || '').trim() || 'pending',
    inviteResult: String(order.inviteResult || '').trim() || '',
    createdAt: order.createdAt || null,
    updatedAt: order.updatedAt || null,
  }
}

const sanitizePublicSupplementRecord = (record) => {
  if (!record || typeof record !== 'object') return null
  return {
    id: Number(record.id || 0) || null,
    orderId: Number(record.orderId || 0) || null,
    status: String(record.status || '').trim() || '',
    detail: String(record.detail || '').trim() || '',
    withinWarranty: Boolean(record.withinWarranty),
    windowEndsAt: record.windowEndsAt || null,
    processedAt: record.processedAt || null,
    createdAt: record.createdAt || null,
    updatedAt: record.updatedAt || null,
  }
}

const sanitizePublicSupplementBody = (body = {}) => ({
  ...(body?.message ? { message: body.message } : {}),
  ...(body?.error ? { error: body.error } : {}),
  ...(body?.code ? { code: body.code } : {}),
  ...(body?.manualInterventionRequired ? { manualInterventionRequired: true } : {}),
  ...(body?.windowEndsAt ? { windowEndsAt: body.windowEndsAt } : {}),
  ...(body?.order ? { order: sanitizePublicOrder(body.order) } : {}),
  ...(body?.supplement ? { supplement: sanitizePublicSupplementRecord(body.supplement) } : {}),
})

const sendSupplementOtpCode = async ({
  email,
} = {}) => {
  const normalizedEmail = normalizeEmail(email)
  if (!EMAIL_REGEX.test(normalizedEmail)) {
    throw new AlipayRedpackOrderError('请输入有效邮箱地址', 400, 'alipay_redpack_invalid_email')
  }

  const db = await getDatabase()
  const recent = db.exec(
    `
      SELECT 1
      FROM email_verification_codes
      WHERE email = ? AND purpose = ?
        AND created_at >= DATETIME('now', 'localtime', ?)
      LIMIT 1
    `,
    [normalizedEmail, SUPPLEMENT_AUTH_PURPOSE, `-${SUPPLEMENT_OTP_SEND_COOLDOWN_SEC} seconds`]
  )
  if (recent?.[0]?.values?.length) {
    throw new AlipayRedpackOrderError('验证码发送过于频繁，请稍后再试', 429, 'alipay_redpack_supplement_otp_rate_limited')
  }

  const code = randomVerificationCode()
  const subject = '支付宝口令红包补录验证码'
  const sent = await sendVerificationCodeEmail(normalizedEmail, code, {
    expiresMinutes: SUPPLEMENT_OTP_TTL_MINUTES,
    subject,
  })
  if (!sent) {
    throw new AlipayRedpackOrderError('验证码发送失败，请稍后重试', 500, 'alipay_redpack_supplement_otp_send_failed')
  }

  db.run(
    `
      INSERT INTO email_verification_codes (email, purpose, code_hash, expires_at, created_at)
      VALUES (?, ?, ?, DATETIME('now', 'localtime', ?), DATETIME('now', 'localtime'))
    `,
    [normalizedEmail, SUPPLEMENT_AUTH_PURPOSE, sha256(code), `+${SUPPLEMENT_OTP_TTL_MINUTES} minutes`]
  )
  await saveDatabase()

  return {
    email: normalizedEmail,
    expiresInSeconds: SUPPLEMENT_OTP_TTL_MINUTES * 60,
  }
}

const verifySupplementOtpAndIssueTicket = async ({
  email,
  code,
  ip,
  ua,
} = {}) => {
  const normalizedEmail = normalizeEmail(email)
  const normalizedCode = String(code || '').trim()
  if (!EMAIL_REGEX.test(normalizedEmail)) {
    throw new AlipayRedpackOrderError('补录认证失败，请重新验证邮箱', 403, 'alipay_redpack_supplement_auth_invalid')
  }
  if (!/^[0-9]{6}$/.test(normalizedCode)) {
    throw new AlipayRedpackOrderError('补录认证失败，请重新验证邮箱', 403, 'alipay_redpack_supplement_auth_invalid')
  }

  const db = await getDatabase()
  let transactionFinished = false
  db.run('BEGIN IMMEDIATE TRANSACTION')
  try {
    const codeResult = db.exec(
      `
        SELECT id, code_hash, COALESCE(failed_attempt_count, 0)
        FROM email_verification_codes
        WHERE email = ? AND purpose = ?
          AND consumed_at IS NULL
          AND expires_at >= DATETIME('now', 'localtime')
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [normalizedEmail, SUPPLEMENT_AUTH_PURPOSE]
    )
    if (!codeResult?.[0]?.values?.length) {
      throw new AlipayRedpackOrderError('补录认证失败，请重新验证邮箱', 403, 'alipay_redpack_supplement_auth_invalid')
    }

    const [codeId, expectedHash, failedAttemptCountRaw] = codeResult[0].values[0]
    const failedAttemptCount = Math.max(0, Number(failedAttemptCountRaw || 0))
    if (failedAttemptCount >= SUPPLEMENT_OTP_MAX_VERIFY_FAILS) {
      throw new AlipayRedpackOrderError('补录认证失败，请重新验证邮箱', 403, 'alipay_redpack_supplement_auth_invalid')
    }
    if (sha256(normalizedCode) !== expectedHash) {
      db.run(
        `
          UPDATE email_verification_codes
          SET failed_attempt_count = COALESCE(failed_attempt_count, 0) + 1,
              consumed_at = CASE
                WHEN COALESCE(failed_attempt_count, 0) + 1 >= ? THEN DATETIME('now', 'localtime')
                ELSE consumed_at
              END
          WHERE id = ?
            AND consumed_at IS NULL
            AND expires_at >= DATETIME('now', 'localtime')
        `,
        [SUPPLEMENT_OTP_MAX_VERIFY_FAILS, codeId]
      )
      db.run('COMMIT')
      transactionFinished = true
      await saveDatabase()
      throw new AlipayRedpackOrderError('补录认证失败，请重新验证邮箱', 403, 'alipay_redpack_supplement_auth_invalid')
    }

    db.run(
      `
        UPDATE email_verification_codes
        SET consumed_at = DATETIME('now', 'localtime')
        WHERE id = ?
          AND consumed_at IS NULL
          AND expires_at >= DATETIME('now', 'localtime')
      `,
      [codeId]
    )
    const codeConsumed = Number(db.getRowsModified?.() || 0) > 0
    if (!codeConsumed) {
      throw new AlipayRedpackOrderError('补录认证失败，请重新验证邮箱', 403, 'alipay_redpack_supplement_auth_invalid')
    }

    const ticket = randomTicket()
    const ticketHash = sha256(ticket)
    db.run(
      `
        INSERT INTO alipay_redpack_supplement_tickets (
          email, ticket_hash, bind_ip, bind_ua, use_count, max_uses, expires_at, created_at
        ) VALUES (
          ?, ?, ?, ?, 0, ?, DATETIME('now', 'localtime', ?), DATETIME('now', 'localtime')
        )
      `,
      [
        normalizedEmail,
        ticketHash,
        String(ip || 'unknown'),
        normalizeUserAgent(ua || 'unknown'),
        SUPPLEMENT_TICKET_MAX_USES,
        `+${SUPPLEMENT_TICKET_TTL_SEC} seconds`,
      ]
    )
    db.run('COMMIT')
    transactionFinished = true
    await saveDatabase()
    return {
      ticket,
      expiresAt: new Date(Date.now() + SUPPLEMENT_TICKET_TTL_SEC * 1000).toISOString(),
    }
  } catch (error) {
    if (!transactionFinished) {
      try {
        db.run('ROLLBACK')
      } catch {
        // ignore rollback errors
      }
    }
    throw error
  }
}

const consumeSupplementTicket = async ({
  email,
  ticket,
  ip,
  ua,
} = {}) => {
  const normalizedEmail = normalizeEmail(email)
  const normalizedTicket = String(ticket || '').trim()
  const normalizedIp = String(ip || 'unknown').trim() || 'unknown'
  const normalizedUa = normalizeUserAgent(ua || 'unknown')
  if (!normalizedEmail || !normalizedTicket || !normalizedIp || !normalizedUa) return false

  const db = await getDatabase()
  db.run(
    `
      UPDATE alipay_redpack_supplement_tickets
      SET use_count = use_count + 1,
          last_used_at = DATETIME('now', 'localtime')
      WHERE ticket_hash = ?
        AND email = ?
        AND bind_ip = ?
        AND bind_ua = ?
        AND revoked_at IS NULL
        AND expires_at >= DATETIME('now', 'localtime')
        AND use_count < CASE
          WHEN COALESCE(max_uses, 0) > 0 THEN max_uses
          ELSE 1
        END
    `,
    [sha256(normalizedTicket), normalizedEmail, normalizedIp, normalizedUa]
  )
  const consumed = Number(db.getRowsModified?.() || 0) > 0
  if (consumed) {
    await saveDatabase()
  }
  return consumed
}

const enforceSupplementTicket = async (req, res, email) => {
  if (!SUPPLEMENT_REQUIRE_OTP) return true

  const ticket = String(req?.headers?.['x-alipay-redpack-ticket'] || '').trim()
  const normalizedEmail = normalizeEmail(email)
  const ip = resolveClientIp(req)
  const ua = resolveClientUserAgent(req)
  if (!EMAIL_REGEX.test(normalizedEmail) || !ticket) {
    res.status(PUBLIC_SUPPLEMENT_AUTH_ERROR.status).json(PUBLIC_SUPPLEMENT_AUTH_ERROR.body)
    return false
  }

  const valid = await consumeSupplementTicket({
    email: normalizedEmail,
    ticket,
    ip,
    ua,
  })
  if (!valid) {
    res.status(PUBLIC_SUPPLEMENT_AUTH_ERROR.status).json(PUBLIC_SUPPLEMENT_AUTH_ERROR.body)
    return false
  }

  return true
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
  const lock = await acquireAlipayRedpackOrderSupplementExecution(normalizedOrderId)
  let supplement = null

  try {
    supplement = await createAlipayRedpackSupplementRecord({
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

    const eligibility = await evaluateOrderPreSupplementEligibility({ order: candidate.order })
    if (!eligibility.eligible) {
      const detail = `自动补录前置校验未通过：${eligibility.message}`
      supplement = await updateAlipayRedpackSupplementRecord(supplement.id, {
        status: eligibility.supplementStatus || 'manual_required',
        detail,
        inviteAccountId: candidate?.order?.invitedAccountId || null,
        inviteAccountEmail: candidate?.order?.invitedAccountEmail || null,
        queueIsMember: Boolean(eligibility?.queueState?.isMember),
        queueIsInvited: Boolean(eligibility?.queueState?.isInvited),
        withinWarranty: candidate.withinWarranty,
        windowEndsAt: candidate.windowEndsAt,
      })
      return {
        ok: false,
        status: Number(eligibility.status || 409),
        body: {
          error: String(eligibility.message || '当前订单不满足自动补录条件'),
          code: String(eligibility.code || 'alipay_redpack_supplement_precheck_failed'),
          ...(eligibility.supplementStatus === 'manual_required' ? { manualInterventionRequired: true } : {}),
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
    let inviteAccountId = null
    let inviteAccountEmail = null
    try {
      consumeResult = await consumeAlipayRedpackOrderRedemptionCode(normalizedOrderId, {
        redeemedBy: `alipay_redpack_supplement:${supplement.id} | order:${normalizedOrderId} | email:${normalizedEmail}`,
      })

      const linkedCodeAccountEmail = normalizeEmail(consumeResult?.code?.accountEmail || '')
      if (!EMAIL_REGEX.test(linkedCodeAccountEmail)) {
        throw new AlipayRedpackOrderError(
          '订单绑定兑换码账号无效，请补充可用兑换码后再处理',
          409,
          'alipay_redpack_code_account_invalid'
        )
      }
      const linkedAccountId = await loadGptAccountIdByEmail(linkedCodeAccountEmail)
      if (!linkedAccountId) {
        throw new AlipayRedpackOrderError(
          '订单绑定兑换码账号不存在，请补充可用兑换码后再处理',
          409,
          'alipay_redpack_code_account_missing'
        )
      }

      const invite = await performDirectInvite({
        email: normalizedEmail,
        accountId: linkedAccountId,
        consumeCode: false,
      })
      inviteSent = true
      inviteAccountId = invite.accountId
      inviteAccountEmail = invite.accountEmail

      await ensureOrderStillActiveBeforeQueueSync({
        orderId: normalizedOrderId,
        accountId: invite.accountId,
        email: normalizedEmail,
      })

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
      let updatedOrder = null
      let supplementStatus = 'auto_failed'
      let responseStatus = 500
      let responseCode = null
      let responseMessage = inviteErrorMessage
      let manualInterventionRequired = false

      const isReturnedConflict = error instanceof AlipayRedpackOrderError
        && (
          error.code === 'alipay_redpack_order_returned'
          || error.code === 'alipay_redpack_invite_revoke_failed'
        )

      if (isReturnedConflict) {
        updatedOrder = await getAlipayRedpackOrderById(normalizedOrderId)
        supplementStatus = error.code === 'alipay_redpack_order_returned' ? 'skipped_no_need' : 'manual_required'
        responseStatus = Number(error.statusCode || 409)
        responseCode = error.code || null
        responseMessage = String(error.message || inviteErrorMessage)
        manualInterventionRequired = error.code === 'alipay_redpack_invite_revoke_failed'
      } else if (
        error instanceof AlipayRedpackOrderError
        && new Set([
          'alipay_redpack_out_of_stock',
          'alipay_redpack_code_missing',
          'alipay_redpack_code_reservation_lost',
          'alipay_redpack_code_account_invalid',
          'alipay_redpack_code_account_missing',
        ]).has(String(error.code || ''))
      ) {
        updatedOrder = await markAlipayRedpackOrderInviteFailed(normalizedOrderId, {
          inviteResult: `自动补录绑定兑换码失败：${inviteErrorMessage}`,
          ...(operator || {}),
        })
        supplementStatus = 'manual_required'
        responseStatus = 409
        responseCode = 'alipay_redpack_code_bind_failed'
        responseMessage = '订单绑定兑换码失败，请先补充可用兑换码后再处理'
        manualInterventionRequired = true
      } else if (inviteSent) {
        updatedOrder = await markAlipayRedpackOrderInvited(normalizedOrderId, {
          inviteResult: `自动补录：邀请请求已提交，状态同步失败（${inviteErrorMessage}）`,
          invitedAccountId: inviteAccountId,
          invitedAccountEmail: inviteAccountEmail,
          ...(operator || {}),
        })
        supplementStatus = 'manual_required'
        responseStatus = 202
        responseCode = 'alipay_redpack_invite_sync_pending'
        responseMessage = '邀请请求已提交，但状态同步失败，请稍后重试同步'
        manualInterventionRequired = true
      } else {
        updatedOrder = await markAlipayRedpackOrderInviteFailed(normalizedOrderId, {
          inviteResult: `自动补录失败：${inviteErrorMessage}`,
          ...(operator || {}),
        })
        const resolved = resolveRouteError(error, inviteErrorMessage)
        responseStatus = resolved.status
        responseCode = resolved.body?.code || null
        responseMessage = resolved.body?.error || inviteErrorMessage
      }

      if (supplement?.id) {
        const supplementDetail = supplementStatus === 'skipped_no_need'
          ? `自动补录终止：${responseMessage}`
          : `自动补录失败：${inviteErrorMessage}`
        supplement = await updateAlipayRedpackSupplementRecord(supplement.id, {
          status: supplementStatus,
          detail: supplementDetail,
          redemptionCodeId: consumeResult?.code?.id || updatedOrder?.redemptionCodeId || null,
          redemptionCode: consumeResult?.code?.code || null,
          inviteAccountId: inviteAccountId || null,
          inviteAccountEmail: inviteAccountEmail || null,
          withinWarranty: candidate.withinWarranty,
          windowEndsAt: candidate.windowEndsAt,
        })
      }

      return {
        ok: false,
        status: responseStatus,
        body: {
          error: responseMessage,
          ...(responseCode ? { code: responseCode } : {}),
          ...(manualInterventionRequired ? { manualInterventionRequired: true } : {}),
          order: updatedOrder,
          supplement,
          windowEndsAt: candidate.windowEndsAt,
        },
      }
    }
  } finally {
    if (lock?.lockToken) {
      await releaseAlipayRedpackOrderSupplementExecution(normalizedOrderId, lock.lockToken).catch((error) => {
        console.warn('[AlipayRedpack] 释放补录锁失败:', error?.message || error)
      })
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
      order: sanitizePublicOrder(order),
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

router.post('/orders/supplement/auth/send-code', async (req, res) => {
  try {
    if (enforcePublicRateLimit(req, res)) return
    const email = req.body?.email
    if (!SUPPLEMENT_REQUIRE_OTP) {
      return res.json({
        message: '当前补录无需验证码，可直接查询与提交',
        otpRequired: false,
      })
    }

    const result = await sendSupplementOtpCode({
      email,
    })
    res.json({
      message: '验证码已发送，请检查邮箱',
      otpRequired: true,
      ...result,
    })
  } catch (error) {
    console.error('[AlipayRedpack] 发送补录验证码失败:', error)
    const resolved = resolveRouteError(error, '验证码发送失败，请稍后重试')
    res.status(resolved.status).json(resolved.body)
  }
})

router.post('/orders/supplement/auth/verify-code', async (req, res) => {
  try {
    if (enforcePublicRateLimit(req, res)) return
    const email = req.body?.email
    const code = req.body?.code
    if (!SUPPLEMENT_REQUIRE_OTP) {
      return res.json({
        message: '当前补录无需验证码，可直接查询与提交',
        otpRequired: false,
      })
    }

    const issued = await verifySupplementOtpAndIssueTicket({
      email,
      code,
      ip: resolveClientIp(req),
      ua: resolveClientUserAgent(req),
    })
    res.json({
      message: '邮箱验证成功',
      otpRequired: true,
      ticket: issued.ticket,
      expiresAt: issued.expiresAt,
    })
  } catch (error) {
    console.error('[AlipayRedpack] 校验补录验证码失败:', error)
    const resolved = resolveRouteError(error, '补录认证失败，请重试')
    res.status(resolved.status).json(resolved.body)
  }
})

router.get('/orders/supplement/candidates', async (req, res) => {
  try {
    if (enforcePublicRateLimit(req, res)) return
    const { email } = req.query || {}
    const authPass = await enforceSupplementTicket(req, res, email)
    if (!authPass) return
    const data = await listAlipayRedpackSupplementOrdersByEmail(email, {
      limit: 30,
      onlyPublicSupplementable: true,
    })
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
    const authPass = await enforceSupplementTicket(req, res, email)
    if (!authPass) return

    const result = await executeAlipayRedpackOrderSupplement({
      email,
      orderId,
      note,
      requestedBy: 'public',
    })
    res.status(result.status).json(sanitizePublicSupplementBody(result.body))
  } catch (error) {
    console.error('[AlipayRedpack] 订单补录失败:', error)
    const resolved = resolveRouteError(error, '补录失败，请稍后重试')
    res.status(resolved.status).json(resolved.body)
  }
})

router.get('/admin/orders', authenticateToken, requireMenu(ADMIN_MENU_KEY), async (req, res) => {
  try {
    const { search = '', status = 'all', startDate = '', endDate = '', limit = 200, offset = 0 } = req.query || {}
    const data = await listAlipayRedpackOrdersAdmin({
      search,
      status,
      startDate,
      endDate,
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

    return await withLocks([`alipay-redpack:order:${orderId}`], async () => {
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
    let inviteAccountId = null
    let inviteAccountEmail = null
    try {
      consumeResult = await consumeAlipayRedpackOrderRedemptionCode(orderId, {
        redeemedBy: `alipay_redpack_order:${orderId} | email:${order.email}`,
      })

      const linkedCodeAccountEmail = normalizeEmail(consumeResult?.code?.accountEmail || '')
      if (!EMAIL_REGEX.test(linkedCodeAccountEmail)) {
        throw new AlipayRedpackOrderError(
          '订单绑定兑换码账号无效，请补充可用兑换码后再处理',
          409,
          'alipay_redpack_code_account_invalid'
        )
      }
      const linkedAccountId = await loadGptAccountIdByEmail(linkedCodeAccountEmail)
      if (!linkedAccountId) {
        throw new AlipayRedpackOrderError(
          '订单绑定兑换码账号不存在，请补充可用兑换码后再处理',
          409,
          'alipay_redpack_code_account_missing'
        )
      }

      const invite = await performDirectInvite({
        email: order.email,
        accountId: linkedAccountId,
        consumeCode: false,
      })
      inviteSent = true
      inviteAccountId = invite.accountId
      inviteAccountEmail = invite.accountEmail

      await ensureOrderStillActiveBeforeQueueSync({
        orderId,
        accountId: invite.accountId,
        email: order.email,
      })

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

	      await notifyOrderProcessedEmailSafely({
	        orderId,
	        email: updatedOrder?.email || order?.email,
	      })
	
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
      const isReturnedConflict = error instanceof AlipayRedpackOrderError
        && (
          error.code === 'alipay_redpack_order_returned'
          || error.code === 'alipay_redpack_invite_revoke_failed'
        )
      if (isReturnedConflict) {
        const latestOrder = await getAlipayRedpackOrderById(orderId)
        return res.status(Number(error.statusCode || 409)).json({
          error: String(error.message || inviteErrorMessage),
          code: error.code || 'alipay_redpack_order_returned',
          ...(error.code === 'alipay_redpack_invite_revoke_failed' ? { manualInterventionRequired: true } : {}),
          order: latestOrder || order,
        })
      }
      if (inviteSent) {
        const updatedOrder = await markAlipayRedpackOrderInvited(orderId, {
          inviteResult: `邀请请求已提交，状态同步失败（${inviteErrorMessage}）`,
          invitedAccountId: inviteAccountId,
          invitedAccountEmail: inviteAccountEmail,
          ...operator,
        })
        await notifyOrderProcessedEmailSafely({
          orderId,
          email: updatedOrder?.email || order?.email,
        })
        return res.status(202).json({
          error: '邀请请求已提交，但状态同步失败，请稍后重试同步',
          code: 'alipay_redpack_invite_sync_pending',
          manualInterventionRequired: true,
          order: updatedOrder,
        })
      }

      const bindFailedErrorCodes = new Set([
        'alipay_redpack_out_of_stock',
        'alipay_redpack_code_missing',
        'alipay_redpack_code_reservation_lost',
        'alipay_redpack_code_account_invalid',
        'alipay_redpack_code_account_missing',
      ])
      if (error instanceof AlipayRedpackOrderError && bindFailedErrorCodes.has(String(error.code || ''))) {
        const updatedOrder = await markAlipayRedpackOrderInviteFailed(orderId, {
          inviteResult: `订单绑定兑换码失败：${inviteErrorMessage}`,
          ...operator,
        })
        return res.status(409).json({
          error: '订单绑定兑换码失败，请先补充可用兑换码后再处理',
          code: 'alipay_redpack_code_bind_failed',
          manualInterventionRequired: true,
          order: updatedOrder,
        })
      }

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
    })
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
    if (order.status === 'redeemed') {
      return res.status(409).json({ error: '该订单已兑换，无需同步状态', order })
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

    const invitedAccountId = toPositiveInt(order.invitedAccountId)
    const normalizedOrderEmail = normalizeEmail(order.email)
    if (invitedAccountId && EMAIL_REGEX.test(normalizedOrderEmail)) {
      let invites = null
      try {
        invites = await fetchAccountInvites(invitedAccountId, {
          inviteListParams: { offset: 0, limit: 25, query: normalizedOrderEmail },
        })
      } catch (error) {
        const resolved = resolveRouteError(error, '撤销外部邀请前校验失败')
        return res.status(409).json({
          error: resolved.body?.error || '撤销外部邀请前校验失败，请人工介入处理',
          code: 'alipay_redpack_invite_revoke_check_failed',
          manualInterventionRequired: true,
          order,
        })
      }
      const hasActiveInvite = (invites?.items || []).some(
        (item) => normalizeEmail(item?.email_address) === normalizedOrderEmail
      )

      if (hasActiveInvite) {
        try {
          await revokeAccountInviteByEmail(invitedAccountId, normalizedOrderEmail)
        } catch (error) {
          const resolved = resolveRouteError(error, '撤销外部邀请失败')
          return res.status(409).json({
            error: resolved.body?.error || '撤销外部邀请失败，请人工介入处理',
            code: 'alipay_redpack_invite_revoke_failed',
            manualInterventionRequired: true,
            order,
          })
        }
      }
    }

    const operator = resolveOperator(req)
    const wasAlreadyReturned = String(order.status || '').trim().toLowerCase() === 'returned'
    const returned = await markAlipayRedpackOrderReturned(orderId, {
      reason: req.body?.reason,
      ...operator,
    })
    if (!wasAlreadyReturned) {
      await notifyOrderReturnedEmailSafely({
        orderId,
        email: returned?.email || order?.email,
        reason: String(req.body?.reason || '').trim() || '口令不可用',
      })
    }
	
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
