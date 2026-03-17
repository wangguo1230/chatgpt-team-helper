import express from 'express'
import { getDatabase, saveDatabase } from '../database/init.js'
import { authenticateLinuxDoSession } from '../middleware/linuxdo-session.js'
import { AccountSyncError, fetchAccountInvites, fetchAccountUsersList, syncAccountInviteCount, syncAccountUserCount } from '../services/account-sync.js'
import {
  buildCreditSign,
  createCreditTransferService,
  formatCreditMoney,
  getCreditGatewayConfig,
  queryCreditOrder,
  refundCreditOrder
} from '../services/credit-gateway.js'
import {
  reserveOpenAccountsCode,
  ensureOpenAccountsOrderCode,
  redeemOpenAccountsOrderCode,
  releaseOpenAccountsOrderCode
} from '../services/open-accounts-redemption.js'
import {
  sendOpenAccountsDomainRiskAdminEmail,
  sendOpenAccountsDomainRiskUserEmail
} from '../services/email-service.js'
import { withLocks } from '../utils/locks.js'
import { requireFeatureEnabled } from '../middleware/feature-flags.js'
import { getOpenAccountsCapacityLimit } from '../utils/open-accounts-capacity-settings.js'

const router = express.Router()

router.use(requireFeatureEnabled('openAccounts'))

const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase()
const normalizeUid = (value) => String(value ?? '').trim()
const normalizeUsername = (value) => String(value ?? '').trim()
const normalizeOrderNo = (value) => String(value ?? '').trim()

const loadCreditOrderEmail = (db, orderNo) => {
  if (!db || !orderNo) return ''
  const result = db.exec(`SELECT order_email FROM credit_orders WHERE order_no = ? LIMIT 1`, [orderNo])
  const row = result[0]?.values?.[0]
  return row?.[0] ? normalizeEmail(row[0]) : ''
}

const loadReservedOrderEmail = (db, orderNo) => {
  if (!db || !orderNo) return ''
  const result = db.exec(
    `
      SELECT reserved_for_order_email
      FROM redemption_codes
      WHERE reserved_for_order_no = ?
      ORDER BY reserved_at DESC, updated_at DESC
      LIMIT 1
    `,
    [orderNo]
  )
  const row = result[0]?.values?.[0]
  return row?.[0] ? normalizeEmail(row[0]) : ''
}

const ensureCreditOrderEmail = (db, orderNo, email) => {
  if (!db || !orderNo) return
  const normalized = normalizeEmail(email)
  if (!normalized) return
  db.run(
    `
      UPDATE credit_orders
      SET order_email = COALESCE(NULLIF(order_email, ''), ?),
          updated_at = DATETIME('now', 'localtime')
      WHERE order_no = ?
    `,
    [normalized, orderNo]
  )
}

const resolveCreditOrderEmail = (db, orderNo, fallbackEmail) => {
  const reserved = loadReservedOrderEmail(db, orderNo)
  if (reserved) {
    ensureCreditOrderEmail(db, orderNo, reserved)
    return reserved
  }
  const stored = loadCreditOrderEmail(db, orderNo)
  if (stored) return stored
  return normalizeEmail(fallbackEmail)
}

const calculateDiscountedCredit = (baseCredit, expireAtStr) => {
  if (!expireAtStr) return baseCredit

  const expireDate = new Date(expireAtStr)
  if (isNaN(expireDate.getTime())) return baseCredit

  const now = new Date()
  const diffTime = expireDate.getTime() - now.getTime()
  const diffDays = diffTime / (1000 * 60 * 60 * 24)

  let discount = 1.0
  if (diffDays < 0) {
     return baseCredit
  } else if (diffDays < 7) {
    discount = 0.2
  } else if (diffDays < 14) {
    discount = 0.4
  } else if (diffDays < 20) {
    discount = 0.6
  } else if (diffDays < 25) {
    discount = 0.8
  }

  const baseAmount = Number(baseCredit)
  if (isNaN(baseAmount)) return baseCredit

  return (baseAmount * discount).toFixed(2)
}

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const isEnabledFlag = (value, defaultValue = true) => {
  if (value === undefined || value === null || value === '') return Boolean(defaultValue)
  const raw = String(value).trim().toLowerCase()
  return raw !== '0' && raw !== 'false' && raw !== 'off'
}

const shortRetryEnabled = () => isEnabledFlag(process.env.OPEN_ACCOUNTS_BOARD_SHORT_RETRY_ENABLED, true)
const shortRetryMaxAttempts = () => Math.min(5, Math.max(1, toInt(process.env.OPEN_ACCOUNTS_BOARD_SHORT_RETRY_MAX_ATTEMPTS, 3)))
const shortRetryBaseDelayMs = () => Math.min(5000, Math.max(0, toInt(process.env.OPEN_ACCOUNTS_BOARD_SHORT_RETRY_BASE_DELAY_MS, 800)))

const creditGatewayServerSubmitEnabled = () => isEnabledFlag(process.env.CREDIT_GATEWAY_SERVER_SUBMIT_ENABLED, false)
const OPEN_ACCOUNTS_INVITE_DOMAIN_RISK_CODE = 'OPEN_ACCOUNTS_INVITE_DOMAIN_RISK'
const DEFAULT_OPEN_ACCOUNTS_CODE_CHANNELS = ['linux-do']
const OPEN_ACCOUNTS_ALLOWED_CODE_CHANNELS = new Set(['common', 'linux-do'])
const getOpenAccountsFallbackMaxAttempts = () => Math.min(6, Math.max(1, toInt(process.env.OPEN_ACCOUNTS_DOMAIN_RISK_FALLBACK_MAX_ATTEMPTS, 3)))

const extractEmailDomain = (email) => {
  const normalized = normalizeEmail(email)
  const at = normalized.lastIndexOf('@')
  if (at <= 0 || at >= normalized.length - 1) return ''
  return normalized.slice(at + 1)
}

const normalizeDomainLike = (value) => {
  const raw = String(value || '').trim().toLowerCase().replace(/^@+/, '')
  if (!raw) return ''
  if (raw.includes('@')) return extractEmailDomain(raw)
  return raw
}

const getOpenAccountsCodeChannels = () => {
  const raw = String(process.env.OPEN_ACCOUNTS_CODE_CHANNELS || '').trim()
  const configured = raw
    ? raw.split(',').map(item => item.trim().toLowerCase()).filter(Boolean)
    : []
  const filtered = configured.filter(item => OPEN_ACCOUNTS_ALLOWED_CODE_CHANNELS.has(item))
  return filtered.length ? filtered : DEFAULT_OPEN_ACCOUNTS_CODE_CHANNELS
}

const buildRedeemFailureError = (redeemOutcome) => {
  const codeMessage = redeemOutcome?.error === 'no_code'
    ? '当前账号暂无可用兑换码，请稍后再试'
    : redeemOutcome?.error || '兑换失败'
  const statusCode = redeemOutcome?.statusCode || (redeemOutcome?.error === 'no_code' ? 409 : 500)
  const err = new AccountSyncError(codeMessage, statusCode)
  const payload = redeemOutcome?.payload && typeof redeemOutcome.payload === 'object'
    ? redeemOutcome.payload
    : null
  if (payload) {
    err.details = payload
    if (payload?.domain || payload?.closedAccountCount || payload?.deletedUnusedCodeCount) {
      err.code = OPEN_ACCOUNTS_INVITE_DOMAIN_RISK_CODE
    }
  }
  return err
}

const resolveRefundFailureMessage = (refundResult) => {
  if (!refundResult || typeof refundResult !== 'object') return '自动退款失败'
  if (refundResult.error === 'missing_config') return 'Credit 未配置，请联系管理员'
  if (refundResult.error === 'missing_trade_no') return '缺少 trade_no，无法自动退款'
  if (refundResult.error === 'invalid_money') return '订单金额异常，无法自动退款'
  if (refundResult.error === 'cf_challenge') return 'Credit 通道启用 Cloudflare challenge，服务端无法自动退款'
  if (typeof refundResult.error === 'string' && refundResult.error.startsWith('http_')) {
    return `Credit 通道异常（HTTP ${refundResult.error.slice(5)}）`
  }
  if (refundResult.msg) return String(refundResult.msg)
  if (refundResult.message) return String(refundResult.message)
  return '自动退款失败'
}

const tryAutoRefundPaidOrder = async (db, orderNo, options = {}) => {
  const normalizedOrderNo = normalizeOrderNo(orderNo)
  if (!db || !normalizedOrderNo) {
    return { attempted: false, refunded: false, reason: 'invalid_order_no' }
  }

  return withLocks([`credit:${normalizedOrderNo}`], async () => {
    const row = db.exec(
      `
        SELECT scene, status, trade_no, amount, refunded_at
        FROM credit_orders
        WHERE order_no = ?
        LIMIT 1
      `,
      [normalizedOrderNo]
    )?.[0]?.values?.[0]

    if (!row) {
      return { attempted: false, refunded: false, reason: 'order_not_found' }
    }

    const scene = String(row[0] || '')
    const status = String(row[1] || '')
    const refundedAt = row[4] ? String(row[4]) : ''
    if (scene !== 'open_accounts_board') {
      return { attempted: false, refunded: false, reason: 'unsupported_scene' }
    }
    if (status === 'refunded' || refundedAt) {
      return { attempted: true, refunded: true, reason: 'already_refunded' }
    }
    if (status !== 'paid') {
      return { attempted: false, refunded: false, reason: 'status_not_paid' }
    }

    let tradeNo = String(row[2] || '').trim()
    const amount = formatCreditMoney(row[3])
    if (!amount) {
      const message = '订单金额异常，无法自动退款'
      db.run(
        `UPDATE credit_orders SET refund_message = ?, updated_at = DATETIME('now', 'localtime') WHERE order_no = ?`,
        [message, normalizedOrderNo]
      )
      saveDatabase()
      return { attempted: true, refunded: false, reason: 'invalid_money', message }
    }

    if (!tradeNo) {
      const query = await queryCreditOrder({ tradeNo: '', outTradeNo: normalizedOrderNo })
      if (query?.ok) {
        const data = query.data || {}
        const queriedTradeNo = String(data.trade_no || data.tradeNo || '').trim()
        if (queriedTradeNo) {
          tradeNo = queriedTradeNo
          db.run(
            `
              UPDATE credit_orders
              SET trade_no = ?,
                  query_payload = ?,
                  query_at = DATETIME('now', 'localtime'),
                  query_status = ?,
                  updated_at = DATETIME('now', 'localtime')
              WHERE order_no = ?
            `,
            [tradeNo, JSON.stringify(data), Number(data.status || 0), normalizedOrderNo]
          )
          saveDatabase()
        }
      }
    }

    if (!tradeNo) {
      const message = '缺少 trade_no，无法自动退款'
      db.run(
        `UPDATE credit_orders SET refund_message = ?, updated_at = DATETIME('now', 'localtime') WHERE order_no = ?`,
        [message, normalizedOrderNo]
      )
      saveDatabase()
      return { attempted: true, refunded: false, reason: 'missing_trade_no', message }
    }

    const refundResult = await refundCreditOrder({ tradeNo, outTradeNo: normalizedOrderNo, money: amount })
    if (!refundResult.ok) {
      const message = resolveRefundFailureMessage(refundResult)
      db.run(
        `UPDATE credit_orders SET refund_message = ?, updated_at = DATETIME('now', 'localtime') WHERE order_no = ?`,
        [message, normalizedOrderNo]
      )
      saveDatabase()
      return { attempted: true, refunded: false, reason: 'refund_failed', message }
    }

    const successMessage = refundResult?.data?.msg
      ? String(refundResult.data.msg)
      : '自动退款成功'
    const note = String(options?.note || '').trim()
    const persistedMessage = note ? `${successMessage}（${note}）` : successMessage
    db.run(
      `
        UPDATE credit_orders
        SET status = 'refunded',
            refunded_at = DATETIME('now', 'localtime'),
            refund_message = ?,
            updated_at = DATETIME('now', 'localtime')
        WHERE order_no = ?
      `,
      [persistedMessage, normalizedOrderNo]
    )
    releaseOpenAccountsOrderCode(db, normalizedOrderNo)
    saveDatabase()

    return { attempted: true, refunded: true, reason: 'refunded', message: successMessage }
  })
}

const isOpenAccountsEnabled = () => isEnabledFlag(process.env.OPEN_ACCOUNTS_ENABLED, true)

const parseUidList = (value) =>
  String(value || '')
    .split(',')
    .map(item => String(item || '').trim())
    .filter(Boolean)

const openAccountsMaintenanceBypassUidSet = () =>
  new Set(parseUidList(process.env.OPEN_ACCOUNTS_MAINTENANCE_ADMIN_UIDS || process.env.OPEN_ACCOUNTS_MAINTENANCE_BYPASS_UIDS || ''))

const isOpenAccountsMaintenanceBypass = (uid) => {
  const normalized = normalizeUid(uid)
  if (!normalized) return false
  return openAccountsMaintenanceBypassUidSet().has(normalized)
}

const getOpenAccountsMaintenanceMessage = () => {
  const message = String(process.env.OPEN_ACCOUNTS_MAINTENANCE_MESSAGE || '平台维护中').trim()
  return message || '平台维护中'
}

const isShortRetryableError = (error) => {
  const status = error instanceof AccountSyncError ? Number(error.status || 0) : Number(error?.status || 0)
  if (status === 429) return true
  if (status === 403) return true
  if (status === 503) return true
  if (status >= 500 && status <= 599) return true
  return false
}

const withShortRetry = async ({ enabled, label, uid, accountId, creditOrderNo }, task) => {
  const attempts = enabled ? shortRetryMaxAttempts() : 1
  const baseDelayMs = shortRetryBaseDelayMs()

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task()
    } catch (error) {
      const retryable = enabled && attempt < attempts && isShortRetryableError(error)
      if (!retryable) throw error

      const status = error instanceof AccountSyncError ? error.status : (error?.status || null)
      const message = error instanceof AccountSyncError ? error.message : (error?.message || String(error))
      const delayMs = Math.min(5000, baseDelayMs * Math.pow(2, attempt - 1))
      console.warn('[OpenAccounts] short retry', {
        label: label || 'unknown',
        uid,
        targetAccountId: accountId,
        creditOrderNo: creditOrderNo || null,
        attempt,
        attempts,
        status,
        delayMs,
        message
      })
      await sleep(delayMs)
    }
  }
}

const getPublicBaseUrl = (req) => {
  const configured = String(process.env.PUBLIC_BASE_URL || '').trim()
  if (configured) return configured.replace(/\/+$/, '')
  const protoHeader = req.headers['x-forwarded-proto']
  const protocol = typeof protoHeader === 'string' && protoHeader.trim() ? protoHeader.split(',')[0].trim() : req.protocol
  const host = req.get('host')
  return `https://${host}`
}

const extractPayingOrderNo = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try {
    const url = new URL(raw)
    return String(url.searchParams.get('order_no') || '').trim()
  } catch {
    return ''
  }
}

const buildCreditPayingUrl = (creditBaseUrl, payingOrderNo) => {
  const raw = String(payingOrderNo || '').trim()
  if (!raw) return ''
  try {
    const origin = new URL(String(creditBaseUrl || '')).origin
    return `${origin}/paying?order_no=${encodeURIComponent(raw)}`
  } catch {
    return ''
  }
}

const generateCreditOrderNo = () => {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const rand = Math.floor(Math.random() * 1e6).toString().padStart(6, '0')
  return `C${stamp}${rand}`
}

const loadOrCreateLinuxDoUser = async (db, { uid, username }) => {
  const result = db.exec(
    'SELECT uid, username, email, current_open_account_id, current_open_account_email FROM linuxdo_users WHERE uid = ? LIMIT 1',
    [uid]
  )
  if (result.length > 0 && result[0].values.length > 0) {
    const row = result[0].values[0]
    return {
      uid: row[0],
      username: row[1],
      email: row[2] || '',
      currentOpenAccountId: row[3] ?? null,
      currentOpenAccountEmail: row[4] || ''
    }
  }

  db.run(
    `INSERT INTO linuxdo_users (uid, username, email, current_open_account_id, current_open_account_email, created_at, updated_at) VALUES (?, ?, NULL, NULL, NULL, DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))`,
    [uid, username]
  )
  saveDatabase()
  return {
    uid,
    username,
    email: '',
    currentOpenAccountId: null,
    currentOpenAccountEmail: ''
  }
}

const updateLinuxDoUserCurrentAccount = (db, uid, username, accountId, openAccountEmail) => {
  const normalizedOpenAccountEmail = normalizeEmail(openAccountEmail)
  const storedOpenAccountEmail = accountId ? (normalizedOpenAccountEmail || null) : null
  db.run(
    `UPDATE linuxdo_users SET current_open_account_id = ?, current_open_account_email = ?, username = COALESCE(?, username), updated_at = DATETIME('now', 'localtime') WHERE uid = ?`,
    [accountId, storedOpenAccountEmail, username || null, uid]
  )
}

const ensureOpenAccount = (db, accountId) => {
  const result = db.exec(
    `
      SELECT id
	      FROM gpt_accounts
	      WHERE id = ?
	        AND is_open = 1
	        AND COALESCE(is_banned, 0) = 0
	      LIMIT 1
	    `,
	    [accountId]
	  )
  return result.length > 0 && result[0].values.length > 0
}

const syncAccountState = async (accountId) => {
  await syncAccountInviteCount(accountId, { inviteListParams: { offset: 0, limit: 1, query: '' } })
  const { account } = await syncAccountUserCount(accountId)
  return account
}

const syncCardCounts = async (accountId) => {
  await syncAccountUserCount(accountId, { userListParams: { offset: 0, limit: 1, query: '' } })
  const synced = await syncAccountInviteCount(accountId, { inviteListParams: { offset: 0, limit: 1, query: '' } })
  return synced.account
}

const detectEmailInAccountQueues = async (accountId, email) => {
  const normalized = normalizeEmail(email)
  if (!normalized) return { isMember: false, isInvited: false }

  const [users, invites] = await Promise.all([
    fetchAccountUsersList(accountId, { userListParams: { offset: 0, limit: 25, query: normalized } }),
    fetchAccountInvites(accountId, { inviteListParams: { offset: 0, limit: 25, query: normalized } })
  ])

  const isMember = (users.items || []).some(item => normalizeEmail(item.email) === normalized)
  const isInvited = (invites.items || []).some(item => normalizeEmail(item.email_address) === normalized)

  return { isMember, isInvited }
}

const loadOpenAccountsFallbackCandidates = (db, options = {}) => {
  if (!db) return []
  const channels = getOpenAccountsCodeChannels()
  const channelPlaceholders = channels.map(() => '?').join(',')
  const excludedAccountIds = Array.from(new Set((options?.excludeAccountIds || [])
    .map(item => Number(item))
    .filter(item => Number.isFinite(item) && item > 0)))
  const excludedDomains = new Set((options?.excludeDomains || [])
    .map(item => normalizeDomainLike(item))
    .filter(Boolean))
  const resolvedCapacityLimit = Number.isFinite(Number(options?.capacityLimit)) && Number(options?.capacityLimit) > 0
    ? Number(options.capacityLimit)
    : getOpenAccountsCapacityLimit(db)
  const fetchLimit = Math.max(1, Number(options?.limit || 3))
  const params = [...channels, resolvedCapacityLimit]

  const excludeAccountSql = excludedAccountIds.length > 0
    ? ` AND ga.id NOT IN (${excludedAccountIds.map(() => '?').join(',')})`
    : ''
  if (excludedAccountIds.length > 0) {
    params.push(...excludedAccountIds)
  }
  params.push(Math.max(fetchLimit * 2, fetchLimit))

  const result = db.exec(
    `
      SELECT ga.id,
             ga.email,
             COALESCE(ga.user_count, 0) AS user_count,
             COALESCE(ga.invite_count, 0) AS invite_count,
             code_stats.remaining_codes
      FROM gpt_accounts ga
      JOIN (
        SELECT lower(trim(account_email)) AS account_email_lower,
               COUNT(*) AS remaining_codes
        FROM redemption_codes
        WHERE is_redeemed = 0
          AND account_email IS NOT NULL
          AND trim(account_email) != ''
          AND channel IN (${channelPlaceholders})
          AND (reserved_for_order_no IS NULL OR reserved_for_order_no = '')
          AND (reserved_for_entry_id IS NULL OR reserved_for_entry_id = 0)
          AND (reserved_for_uid IS NULL OR reserved_for_uid = '')
        GROUP BY lower(trim(account_email))
      ) code_stats ON lower(trim(ga.email)) = code_stats.account_email_lower
      WHERE ga.is_open = 1
        AND COALESCE(ga.is_banned, 0) = 0
        AND COALESCE(ga.user_count, 0) + COALESCE(ga.invite_count, 0) < ?
        ${excludeAccountSql}
      ORDER BY
        CASE WHEN COALESCE(ga.invite_count, 0) > 0 THEN 0 ELSE 1 END ASC,
        COALESCE(ga.invite_count, 0) DESC,
        COALESCE(ga.user_count, 0) + COALESCE(ga.invite_count, 0) ASC,
        code_stats.remaining_codes DESC,
        ga.created_at ASC
      LIMIT ?
    `,
    params
  )

  const rows = result[0]?.values || []
  const mapped = rows.map(row => {
    const id = Number(row?.[0] || 0)
    const email = String(row?.[1] || '').trim()
    return {
      id,
      email,
      domain: extractEmailDomain(email),
      userCount: Number(row?.[2] || 0),
      inviteCount: Number(row?.[3] || 0),
      remainingCodes: Number(row?.[4] || 0)
    }
  }).filter(item => item.id > 0 && item.email)

  const deduped = []
  const seenEmails = new Set()
  for (const item of mapped) {
    const emailKey = normalizeEmail(item.email)
    if (!emailKey || seenEmails.has(emailKey)) continue
    seenEmails.add(emailKey)
    if (item.domain && excludedDomains.has(item.domain)) continue
    deduped.push(item)
    if (deduped.length >= fetchLimit) break
  }
  return deduped
}

const trySendDomainRiskOutcomeEmails = async (payload = {}) => {
  const userEmail = normalizeEmail(payload?.userEmail)
  const action = String(payload?.action || '').trim().toLowerCase()
  const tasks = []
  if (userEmail && (action === 'refunded' || action === 'refund_failed')) {
    tasks.push(sendOpenAccountsDomainRiskUserEmail({
      to: userEmail,
      action,
      orderNo: payload?.orderNo,
      refundMessage: payload?.refundMessage
    }))
  }
  tasks.push(sendOpenAccountsDomainRiskAdminEmail({
    action,
    orderNo: payload?.orderNo,
    uid: payload?.uid,
    username: payload?.username,
    userEmail,
    triggerDomain: payload?.triggerDomain,
    triggerAccountId: payload?.triggerAccountId,
    triggerAccountEmail: payload?.triggerAccountEmail,
    transferAccountId: payload?.transferAccountId,
    transferAccountEmail: payload?.transferAccountEmail,
    closedAccountCount: payload?.closedAccountCount,
    deletedUnusedCodeCount: payload?.deletedUnusedCodeCount,
    fallbackAttempted: payload?.fallbackAttempted,
    refundMessage: payload?.refundMessage,
    attempts: payload?.attempts
  }))
  const results = await Promise.allSettled(tasks)
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      console.warn('[OpenAccounts] domain-risk outcome email failed', {
        index,
        message: result.reason?.message || String(result.reason)
      })
    }
  })
}

const tryAutoTransferPaidOrderOnDomainRisk = async (db, options = {}) => {
  const orderNo = normalizeOrderNo(options?.orderNo)
  const uid = normalizeUid(options?.uid)
  const username = normalizeUsername(options?.username)
  const orderEmail = normalizeEmail(options?.orderEmail)
  const triggerAccountId = Number(options?.triggerAccountId || 0)
  const triggerAccountEmail = String(options?.triggerAccountEmail || '').trim()
  if (!db || !orderNo || !uid || !orderEmail) {
    return { transferred: false, attempts: [], reason: 'invalid_arguments' }
  }

  const attemptLimit = getOpenAccountsFallbackMaxAttempts()
  const resolvedCapacityLimit = Number.isFinite(Number(options?.capacityLimit)) && Number(options?.capacityLimit) > 0
    ? Number(options.capacityLimit)
    : getOpenAccountsCapacityLimit(db)
  const excludedAccountIds = new Set()
  if (triggerAccountId > 0) {
    excludedAccountIds.add(triggerAccountId)
  }
  const excludedDomains = new Set()
  const triggerDomain = normalizeDomainLike(options?.triggerDomain || '')
  if (triggerDomain) excludedDomains.add(triggerDomain)
  const triggerAccountDomain = normalizeDomainLike(triggerAccountEmail)
  if (triggerAccountDomain) excludedDomains.add(triggerAccountDomain)

  const attempts = []

  while (attempts.length < attemptLimit) {
    const remain = attemptLimit - attempts.length
    const candidates = loadOpenAccountsFallbackCandidates(db, {
      capacityLimit: resolvedCapacityLimit,
      excludeAccountIds: [...excludedAccountIds],
      excludeDomains: [...excludedDomains],
      limit: remain
    })
    if (!candidates.length) break

    for (const candidate of candidates) {
      if (attempts.length >= attemptLimit) break
      excludedAccountIds.add(candidate.id)

      const attempt = {
        accountId: candidate.id,
        accountEmail: candidate.email,
        status: 'failed',
        reason: '未知错误'
      }
      attempts.push(attempt)

      try {
        if (!ensureOpenAccount(db, candidate.id)) {
          attempt.status = 'skipped'
          attempt.reason = '账号已关闭或不可用'
          continue
        }

        const synced = await syncCardCounts(candidate.id)
        const userCount = Number(synced?.userCount ?? candidate.userCount ?? 0)
        const inviteCount = Number(synced?.inviteCount ?? candidate.inviteCount ?? 0)
        const queueState = await detectEmailInAccountQueues(candidate.id, orderEmail)
        const isMember = Boolean(queueState.isMember)
        const isInvited = Boolean(queueState.isInvited)

        if (!isMember && !isInvited && (userCount + inviteCount) >= resolvedCapacityLimit) {
          attempt.status = 'skipped'
          attempt.reason = '账号满员'
          continue
        }

        releaseOpenAccountsOrderCode(db, orderNo)
        const reservedCode = reserveOpenAccountsCode(db, {
          orderNo,
          accountEmail: candidate.email,
          email: orderEmail
        })
        if (!reservedCode) {
          attempt.status = 'failed'
          attempt.reason = '账号无可用兑换码'
          continue
        }
        ensureOpenAccountsOrderCode(db, { orderNo, accountEmail: candidate.email, email: orderEmail })
        db.run(
          `
            UPDATE credit_orders
            SET target_account_id = ?,
                updated_at = DATETIME('now', 'localtime')
            WHERE order_no = ?
          `,
          [candidate.id, orderNo]
        )
        saveDatabase()

        const redeemCapacity = isMember || isInvited ? resolvedCapacityLimit + 1 : resolvedCapacityLimit
        const redeemOutcome = await redeemOpenAccountsOrderCode(db, {
          orderNo,
          uid,
          email: orderEmail,
          accountEmail: candidate.email,
          capacityLimit: redeemCapacity
        })

        if (!redeemOutcome.ok) {
          const payload = redeemOutcome?.payload && typeof redeemOutcome.payload === 'object'
            ? redeemOutcome.payload
            : null
          const payloadDomain = normalizeDomainLike(payload?.domain || '')
          if (payloadDomain) excludedDomains.add(payloadDomain)
          attempt.status = 'failed'
          attempt.reason = redeemOutcome.error || '兑换失败'
          continue
        }

        updateLinuxDoUserCurrentAccount(db, uid, username, candidate.id, orderEmail)
        const redeemedData = redeemOutcome.redemption?.data || {}
        const resolvedInviteCount = typeof redeemedData.inviteCount === 'number'
          ? redeemedData.inviteCount
          : inviteCount
        const body = {
          message: redeemedData.inviteStatus === '邀请已发送'
            ? '原账号域名疑似风控，已自动切换到可用账号并发送邀请'
            : '原账号域名疑似风控，已自动切换到可用账号，邀请未发送（需要手动添加）',
          currentOpenAccountId: candidate.id,
          account: {
            id: candidate.id,
            userCount: redeemedData.userCount ?? userCount,
            inviteCount: resolvedInviteCount
          },
          autoTransferred: true
        }
        db.run(
          `
            UPDATE credit_orders
            SET target_account_id = ?,
                action_status = 'fulfilled',
                action_message = ?,
                action_result = ?,
                updated_at = DATETIME('now', 'localtime')
            WHERE order_no = ?
          `,
          [candidate.id, body.message, JSON.stringify(body), orderNo]
        )
        saveDatabase()

        attempt.status = 'success'
        attempt.reason = '自动转移成功'
        return {
          transferred: true,
          body,
          transferAccountId: candidate.id,
          transferAccountEmail: candidate.email,
          attempts
        }
      } catch (attemptError) {
        attempt.status = 'failed'
        attempt.reason = attemptError?.message || String(attemptError)
      }
    }
  }

  return { transferred: false, attempts, reason: 'no_fallback_available' }
}

// 获取每日上车限制配置
const getDailyBoardLimit = () => {
  const limit = toInt(process.env.OPEN_ACCOUNTS_DAILY_BOARD_LIMIT, 0)
  return limit > 0 ? limit : 0 // 0 表示不限制
}

// 获取用户每日上车次数限制配置（全局 env）
const isUserDailyBoardLimitEnabled = () => isEnabledFlag(process.env.OPEN_ACCOUNTS_USER_DAILY_BOARD_LIMIT_ENABLED, false)
const getUserDailyBoardLimit = () => {
  const limit = toInt(process.env.OPEN_ACCOUNTS_USER_DAILY_BOARD_LIMIT, 0)
  return limit > 0 ? limit : 0 // 0 表示不限制
}

const getOpenAccountsVisibleCreatedWithinDays = () => {
  const days = toInt(process.env.OPEN_ACCOUNTS_VISIBLE_CREATED_WITHIN_DAYS, 30)
  return days > 0 ? days : 0 // 0 表示不限制
}

const OPEN_ACCOUNTS_REDEEM_BLOCK_START_HOUR = 0
const OPEN_ACCOUNTS_REDEEM_BLOCK_END_HOUR = 0
const ORDER_TYPE_WARRANTY = 'warranty'
const ORDER_TYPE_NO_WARRANTY = 'no_warranty'
const ORDER_TYPE_SET = new Set([ORDER_TYPE_WARRANTY, ORDER_TYPE_NO_WARRANTY])
const normalizeOrderType = (value) => {
  const normalized = String(value || '').trim().toLowerCase()
  return ORDER_TYPE_SET.has(normalized) ? normalized : ORDER_TYPE_WARRANTY
}

const getOpenAccountsRedeemBlockedHours = () => ({
  start: OPEN_ACCOUNTS_REDEEM_BLOCK_START_HOUR,
  end: OPEN_ACCOUNTS_REDEEM_BLOCK_END_HOUR
})

const isOpenAccountsRedeemBlockedNow = (date = new Date()) => {
  const hour = date.getHours()
  return hour >= OPEN_ACCOUNTS_REDEEM_BLOCK_START_HOUR && hour < OPEN_ACCOUNTS_REDEEM_BLOCK_END_HOUR
}

const buildOpenAccountsRedeemBlockedMessage = () => '当前时段暂不可兑换，请稍后再试'

// 查询今日已占用名额（包含已上车 + 未过期的未完成订单 + 已支付未上车）
const getTodayBoardCount = (db) => {
  const expireMinutes = Math.max(5, toInt(process.env.CREDIT_ORDER_EXPIRE_MINUTES, 15))
  const threshold = `-${expireMinutes} minutes`
  const result = db.exec(
    `
      SELECT COUNT(DISTINCT uid)
      FROM credit_orders
      WHERE scene = 'open_accounts_board'
        AND (
          (
            action_status = 'fulfilled'
            AND DATE(updated_at) = DATE('now', 'localtime')
          )
          OR (
            DATE(created_at) = DATE('now', 'localtime')
            AND status IN ('created', 'pending_payment', 'paid')
            AND (
              status = 'paid'
              OR paid_at IS NOT NULL
              OR created_at >= DATETIME('now', 'localtime', ?)
            )
          )
        )
    `,
    [threshold]
  )
  return Number(result[0]?.values?.[0]?.[0] || 0)
}

// 查询用户今日已上车/占用次数（包含已上车 + 未过期的未完成订单 + 已支付未上车）
const getUserTodayBoardOrderCount = (db, uid) => {
  if (!db || !uid) return 0
  const expireMinutes = Math.max(5, toInt(process.env.CREDIT_ORDER_EXPIRE_MINUTES, 15))
  const threshold = `-${expireMinutes} minutes`
  const result = db.exec(
    `
      SELECT COUNT(1)
      FROM credit_orders
      WHERE uid = ?
        AND scene = 'open_accounts_board'
        AND (
          (
            action_status = 'fulfilled'
            AND DATE(updated_at) = DATE('now', 'localtime')
          )
          OR (
            DATE(created_at) = DATE('now', 'localtime')
            AND status IN ('created', 'pending_payment', 'paid')
            AND (
              status = 'paid'
              OR paid_at IS NOT NULL
              OR created_at >= DATETIME('now', 'localtime', ?)
            )
          )
        )
    `,
    [uid, threshold]
  )
  return Number(result[0]?.values?.[0]?.[0] || 0)
}

// 获取已开放账号（卡片页展示用）
router.get('/', authenticateLinuxDoSession, async (req, res) => {
  const uid = normalizeUid(req.linuxdo?.uid)
  const username = normalizeUsername(req.linuxdo?.username)
  const bypass = isOpenAccountsMaintenanceBypass(uid)
  if (!isOpenAccountsEnabled() && !bypass) {
    return res.status(503).json({ error: getOpenAccountsMaintenanceMessage(), code: 'OPEN_ACCOUNTS_MAINTENANCE' })
  }
  try {
    const db = await getDatabase()
    const openAccountsCapacityLimit = getOpenAccountsCapacityLimit(db)
    const user = uid ? await loadOrCreateLinuxDoUser(db, { uid, username: username || uid }) : null
    const currentAccountId = user?.currentOpenAccountId ? Number(user.currentOpenAccountId) : null

    // 获取规则配置
    const dailyLimit = getDailyBoardLimit()
    const creditCost = formatCreditMoney(process.env.OPEN_ACCOUNTS_CREDIT_COST || process.env.LINUXDO_OPEN_ACCOUNTS_CREDIT_COST || '10')
    const userDailyLimitEnabled = isUserDailyBoardLimitEnabled() && getUserDailyBoardLimit() > 0
    const userDailyLimit = userDailyLimitEnabled ? getUserDailyBoardLimit() : 0

    // 获取今日已上车人数
    const todayBoardCount = getTodayBoardCount(db)

    const userTodayBoardCount = uid ? getUserTodayBoardOrderCount(db, uid) : 0
    const userDailyLimitRemaining =
      userDailyLimitEnabled && userDailyLimit > 0 ? Math.max(0, userDailyLimit - userTodayBoardCount) : null
    const redeemBlockedHours = getOpenAccountsRedeemBlockedHours()

    const visibleWithinDays = getOpenAccountsVisibleCreatedWithinDays()
    const threshold = visibleWithinDays > 0 ? `-${visibleWithinDays} days` : null

    const result = db.exec(
      `
	        SELECT ga.id,
	               ga.email,
	               COALESCE(ga.user_count, 0) AS user_count,
	               COALESCE(ga.invite_count, 0) AS invite_count,
	               ga.expire_at,
	               code_stats.remaining_codes
	        FROM gpt_accounts ga
	        JOIN (
	          SELECT lower(trim(account_email)) AS account_email_lower,
	                 COUNT(*) AS remaining_codes
	          FROM redemption_codes
	          WHERE is_redeemed = 0
	            AND channel = 'linux-do'
            AND account_email IS NOT NULL
            AND (reserved_for_order_no IS NULL OR reserved_for_order_no = '')
            AND (reserved_for_entry_id IS NULL OR reserved_for_entry_id = 0)
            AND (reserved_for_uid IS NULL OR reserved_for_uid = '')
	          GROUP BY lower(trim(account_email))
	        ) code_stats ON lower(trim(ga.email)) = code_stats.account_email_lower
		        WHERE ga.is_open = 1
		          AND COALESCE(ga.is_banned, 0) = 0
		          AND (COALESCE(ga.user_count, 0) + COALESCE(ga.invite_count, 0)) < ?
		          ${threshold ? "AND ga.created_at >= DATETIME('now', 'localtime', ?)" : ''}
		        ORDER BY ga.created_at DESC
		      `,
	      threshold ? [openAccountsCapacityLimit, threshold] : [openAccountsCapacityLimit]
	    )

	    const rows = result[0]?.values || []
	    const items = rows.map(row => {
	      const email = row[1]
	      const emailPrefix = String(email || '').split('@')[0] || ''
	      const expireAt = row[4] ? String(row[4]) : null
	      const remainingCodes = Number(row[5] || 0)
	      const orderType = ORDER_TYPE_WARRANTY
	      const discounted = formatCreditMoney(calculateDiscountedCredit(creditCost, expireAt))
	      return {
	        id: row[0],
	        emailPrefix,
	        joinedCount: Number(row[2]) || 0,
	        pendingCount: Number(row[3]) || 0,
	        expireAt,
	        remainingCodes,
	        orderType,
	        creditCost: discounted || creditCost || null
	      }
	    })

    if (currentAccountId && !items.some(item => Number(item.id) === currentAccountId)) {
	      const currentRow = db.exec(
	        `
	          SELECT id,
	                 email,
	                 COALESCE(user_count, 0) AS user_count,
	                 COALESCE(invite_count, 0) AS invite_count,
	                 expire_at
	          FROM gpt_accounts
	          WHERE id = ?
	          LIMIT 1
	        `,
        [currentAccountId]
      )[0]?.values?.[0]

	      if (currentRow) {
	        const email = currentRow[1]
	        const emailPrefix = String(email || '').split('@')[0] || ''
	        const expireAt = currentRow[4] ? String(currentRow[4]) : null
	        const remainingResult = db.exec(
	          `
	            SELECT COUNT(*)
	            FROM redemption_codes
	            WHERE is_redeemed = 0
	              AND channel = 'linux-do'
	              AND account_email IS NOT NULL
	              AND lower(trim(account_email)) = ?
	              AND (reserved_for_order_no IS NULL OR reserved_for_order_no = '')
	              AND (reserved_for_entry_id IS NULL OR reserved_for_entry_id = 0)
	              AND (reserved_for_uid IS NULL OR reserved_for_uid = '')
	          `,
          [String(email || '').trim().toLowerCase()]
	        )
	        const remainingCodes = Number(remainingResult[0]?.values?.[0]?.[0] || 0)
	        const orderType = ORDER_TYPE_WARRANTY
	        const discounted = formatCreditMoney(calculateDiscountedCredit(creditCost, expireAt))

	        items.unshift({
	          id: currentRow[0],
	          emailPrefix,
	          joinedCount: Number(currentRow[2]) || 0,
	          pendingCount: Number(currentRow[3]) || 0,
	          expireAt,
	          remainingCodes,
	          orderType,
	          creditCost: discounted || creditCost || null
	        })
	      }
	    }

    res.json({
      items,
      total: items.length,
      rules: {
        creditCost,
        dailyLimit: dailyLimit || null,
	        todayBoardCount,
        capacityLimit: openAccountsCapacityLimit,
	        userDailyLimitEnabled,
        userDailyLimit: userDailyLimitEnabled && userDailyLimit > 0 ? userDailyLimit : null,
        userTodayBoardCount,
        userDailyLimitRemaining,
        redeemBlockedHours,
        redeemBlockedNow: isOpenAccountsRedeemBlockedNow(),
        redeemBlockedMessage: buildOpenAccountsRedeemBlockedMessage()
      }
    })
  } catch (error) {
    console.error('Get open accounts error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// 上车
router.post('/:accountId/board', authenticateLinuxDoSession, async (req, res) => {
  const uid = normalizeUid(req.linuxdo?.uid)
  const bypass = isOpenAccountsMaintenanceBypass(uid)
  if (!isOpenAccountsEnabled() && !bypass) {
    return res.status(503).json({ error: getOpenAccountsMaintenanceMessage(), code: 'OPEN_ACCOUNTS_MAINTENANCE' })
  }
  const username = normalizeUsername(req.linuxdo?.username)
  const accountId = Number.parseInt(String(req.params.accountId), 10)
  const creditOrderNo = normalizeOrderNo(req.body?.creditOrderNo)

  if (!uid) {
    return res.status(400).json({ error: '缺少 uid' })
  }
  if (!Number.isFinite(accountId) || accountId <= 0) {
    return res.status(400).json({ error: 'accountId 无效' })
  }

  try {
    if (isOpenAccountsRedeemBlockedNow()) {
      return res.status(403).json({ error: buildOpenAccountsRedeemBlockedMessage() })
    }

    const db = await getDatabase()
    const openAccountsCapacityLimit = getOpenAccountsCapacityLimit(db)
    const user = await loadOrCreateLinuxDoUser(db, { uid, username: username || uid })
    const profileEmail = normalizeEmail(user.email)

    const { pid: creditPid, key: creditKey, baseUrl: creditBaseUrl } = await getCreditGatewayConfig()
    const creditCost = formatCreditMoney(process.env.OPEN_ACCOUNTS_CREDIT_COST || process.env.LINUXDO_OPEN_ACCOUNTS_CREDIT_COST || '10')
    const baseTitle = String(process.env.OPEN_ACCOUNTS_CREDIT_TITLE || '开放账号上车').trim() || '开放账号上车'
    const creditTitle = `${baseTitle} ${accountId}`

    const oldAccountId = user.currentOpenAccountId ? Number(user.currentOpenAccountId) : null
    const lockKeys = [`uid:${uid}`, `acct:${accountId}`]
    if (oldAccountId && oldAccountId !== accountId) lockKeys.push(`acct:${oldAccountId}`)

    const decision = await withLocks(lockKeys, async () => {
      const freshUser = await loadOrCreateLinuxDoUser(db, { uid, username: username || uid })
      const currentId = freshUser.currentOpenAccountId ? Number(freshUser.currentOpenAccountId) : null
      const onboardedEmailForExitCheck = normalizeEmail(freshUser.currentOpenAccountEmail || freshUser.email || profileEmail)

	      const accountRow = db.exec(
	        `
	          SELECT id, email, expire_at
	          FROM gpt_accounts
	          WHERE id = ?
	            AND is_open = 1
	            AND COALESCE(is_banned, 0) = 0
          LIMIT 1
        `,
        [accountId]
      )[0]?.values?.[0]
      if (!accountRow) {
        return { type: 'error', status: 404, error: '开放账号不存在或已隐藏' }
	      }
	      const accountEmail = accountRow[1] ? String(accountRow[1]) : ''
	      const accountExpireAt = accountRow[2] ? String(accountRow[2]) : null
	      const discounted = formatCreditMoney(calculateDiscountedCredit(creditCost, accountExpireAt))
	      const actualCreditCost = discounted || creditCost || null
	      if (!accountEmail) {
	        return { type: 'error', status: 500, error: '开放账号缺少邮箱配置' }
	      }

      let verifiedCreditOrderNo = null
      let orderEmail = normalizeEmail(freshUser.email || profileEmail)
      if (creditOrderNo) {
        const creditRow = db.exec(
          `
            SELECT order_no, uid, scene, status, amount, target_account_id, action_status, action_result, action_payload, order_email
            FROM credit_orders
            WHERE order_no = ?
            LIMIT 1
          `,
          [creditOrderNo]
        )[0]?.values?.[0]

        if (!creditRow) return { type: 'error', status: 404, error: 'Credit 订单不存在' }
        const [orderNo, orderUid, scene, status, amount, targetAccountId, actionStatus, actionResult, actionPayload, orderEmailRaw] = creditRow
        if (String(orderUid) !== uid) return { type: 'error', status: 403, error: 'Credit 订单信息不匹配' }
        if (String(scene) !== 'open_accounts_board') return { type: 'error', status: 400, error: 'Credit 订单场景不匹配' }
        if (String(status) !== 'paid') return { type: 'error', status: 400, error: 'Credit 订单未完成授权' }
        if (Number(targetAccountId) !== accountId) return { type: 'error', status: 400, error: 'Credit 订单账号不匹配' }

	        verifiedCreditOrderNo = creditOrderNo
	        orderEmail = resolveCreditOrderEmail(db, creditOrderNo, orderEmailRaw || freshUser.email || profileEmail)

	        if (actionStatus && String(actionStatus) === 'fulfilled' && actionResult) {
	          try {
	            const parsed = JSON.parse(String(actionResult))
            if (parsed && typeof parsed === 'object') {
              return { type: 'success', body: parsed }
            }
          } catch {
          }
        }

        db.run(
          `
            UPDATE credit_orders
            SET action_status = 'processing',
                updated_at = DATETIME('now', 'localtime')
            WHERE order_no = ?
              AND (action_status IS NULL OR action_status = '' OR action_status != 'fulfilled')
          `,
          [String(orderNo)]
        )
        saveDatabase()
      }

      try {
        const shortRetryContext = Boolean(verifiedCreditOrderNo) && shortRetryEnabled()
        if (!orderEmail) {
          return { type: 'error', status: 400, error: '请先配置邮箱再上车' }
        }

        const account = await withShortRetry(
          { enabled: shortRetryContext, label: 'syncCardCounts', uid, accountId, creditOrderNo: verifiedCreditOrderNo },
          () => syncCardCounts(accountId)
        )

        const members = await withShortRetry(
          { enabled: shortRetryContext, label: 'fetchAccountUsersList', uid, accountId, creditOrderNo: verifiedCreditOrderNo },
          () => fetchAccountUsersList(accountId, { userListParams: { offset: 0, limit: 25, query: orderEmail } })
        )
        const isMember = (members.items || []).some(item => normalizeEmail(item.email) === orderEmail)

        const invites = await withShortRetry(
          { enabled: shortRetryContext, label: 'fetchAccountInvites', uid, accountId, creditOrderNo: verifiedCreditOrderNo },
          () => fetchAccountInvites(accountId, { inviteListParams: { offset: 0, limit: 25, query: orderEmail } })
        )
        const isInvited = (invites.items || []).some(item => normalizeEmail(item.email_address) === orderEmail)
        const isCurrentAccountBound = Boolean(currentId && currentId === accountId)

        if (isCurrentAccountBound && (isMember || isInvited)) {
	          if (verifiedCreditOrderNo) {
	            const redeemOutcome = await redeemOpenAccountsOrderCode(db, {
	              orderNo: verifiedCreditOrderNo,
	              uid,
	              email: orderEmail,
	              accountEmail,
	              capacityLimit: openAccountsCapacityLimit + 1
	            })
	            if (!redeemOutcome.ok) {
	              throw buildRedeemFailureError(redeemOutcome)
	            }
	          }

          const body = {
            message: '已在该账号上车',
            currentOpenAccountId: accountId,
            account: {
              id: accountId,
              userCount: account.userCount,
              inviteCount: account.inviteCount
            }
          }

          if (verifiedCreditOrderNo) {
            db.run(
              `
                UPDATE credit_orders
                SET action_status = 'fulfilled',
                    action_message = ?,
                    action_result = ?,
                    updated_at = DATETIME('now', 'localtime')
                WHERE order_no = ?
              `,
              [body.message, JSON.stringify(body), verifiedCreditOrderNo]
            )
            saveDatabase()
          }

          return { type: 'success', body }
        }

        if (isCurrentAccountBound && !isMember && !isInvited && onboardedEmailForExitCheck && onboardedEmailForExitCheck !== orderEmail) {
          console.info('[OpenAccounts] onboard email changed, continue board flow', {
            uid,
            accountId,
            previousEmail: onboardedEmailForExitCheck,
            currentEmail: orderEmail
          })
        }

        // 上车必须先消耗 Credit：首次点击上车先创建/复用 Credit 订单，授权成功后再携带 creditOrderNo 继续上车。
        if (!creditOrderNo) {
          if (!creditPid || !creditKey) {
            return { type: 'error', status: 500, error: '未配置 Linux DO Credit 凭据' }
          }
	          if (!actualCreditCost) {
	            return { type: 'error', status: 500, error: '未配置上车所需积分' }
	          }

		          const baseCapacity = openAccountsCapacityLimit
		          // 若用户尚未在目标账号的成员/邀请列表中，且账号已满员，则不创建订单，避免授权后无法上车。
		          if (!isMember && !isInvited) {
	            const seatsUsed = Number(account.userCount || 0) + Number(account.inviteCount || 0)
	            if (seatsUsed >= baseCapacity) {
              return { type: 'error', status: 409, error: '该账号已满员，无法上车' }
            }
          }

          const expireMinutes = Math.max(5, toInt(process.env.CREDIT_ORDER_EXPIRE_MINUTES, 15))
          const threshold = `-${expireMinutes} minutes`
          const existingCandidates = db.exec(
            `
              SELECT order_no, amount, pay_url, status, order_email
              FROM credit_orders
              WHERE uid = ?
                AND scene = 'open_accounts_board'
                AND target_account_id = ?
                AND status IN ('created', 'pending_payment')
                AND created_at >= DATETIME('now', 'localtime', ?)
              ORDER BY created_at DESC
              LIMIT 5
            `,
            [uid, accountId, threshold]
          )[0]?.values || []

          const resolvedExisting = (() => {
            for (const candidate of existingCandidates) {
              const orderNo = normalizeOrderNo(candidate?.[0])
              if (!orderNo) continue
              const candidateEmail = resolveCreditOrderEmail(db, orderNo, candidate?.[4])
              if (!candidateEmail) continue
              if (candidateEmail === orderEmail) return candidate
            }
            return null
          })()

          if (resolvedExisting) {
            const existingOrderNo = String(resolvedExisting[0])
            ensureCreditOrderEmail(db, existingOrderNo, orderEmail)
            const reservedCode = ensureOpenAccountsOrderCode(db, {
              orderNo: existingOrderNo,
              accountEmail,
              email: orderEmail
            })
            if (!reservedCode) {
              return { type: 'error', status: 409, error: '当前账号暂无可用兑换码，请稍后再试' }
            }
            saveDatabase()
            console.info('[OpenAccounts] reuse credit order', {
              uid,
              targetAccountId: accountId,
              creditOrderNo: existingOrderNo,
              amount: String(resolvedExisting[1] || actualCreditCost),
              status: String(resolvedExisting[3] || 'created'),
              expireMinutes
            })
            return {
              type: 'credit_required',
              creditOrder: {
                orderNo: existingOrderNo,
                amount: String(resolvedExisting[1] || actualCreditCost),
                payUrl: resolvedExisting[2] ? String(resolvedExisting[2]) : null,
                status: String(resolvedExisting[3] || 'created')
              }
            }
          }

          // 检查用户每日上车次数限制（包含未完成订单，避免高并发时超额）
          const userDailyLimitEnabled = isUserDailyBoardLimitEnabled()
          const userDailyLimit = userDailyLimitEnabled ? getUserDailyBoardLimit() : 0
          if (userDailyLimitEnabled && userDailyLimit > 0) {
            const userTodayCount = getUserTodayBoardOrderCount(db, uid)
            if (userTodayCount >= userDailyLimit) {
              return { type: 'error', status: 429, error: `今日购买次数已达上限（${userDailyLimit}次），请明天再试` }
            }
          }

          // 检查今日全局上车人数限制（包含未完成订单，避免高并发时超额）
          const dailyLimit = getDailyBoardLimit()
          if (dailyLimit > 0) {
            const todayCount = getTodayBoardCount(db)
            if (todayCount >= dailyLimit) {
              return { type: 'error', status: 429, error: `今日上车名额已满（${dailyLimit}人），请明天再试` }
            }
          }

          const newOrderNo = generateCreditOrderNo()
          const reservedCode = reserveOpenAccountsCode(db, {
            orderNo: newOrderNo,
            accountEmail,
            email: orderEmail
          })
          if (!reservedCode) {
            return { type: 'error', status: 409, error: '当前账号暂无可用兑换码，请稍后再试' }
          }
          db.run(
            `
              INSERT INTO credit_orders (
                order_no, uid, username, order_email, scene, title, amount, status, target_account_id,
                code_id, code, code_account_email,
                action_payload, created_at, updated_at
              ) VALUES (?, ?, ?, ?, 'open_accounts_board', ?, ?, 'created', ?, ?, ?, ?, ?, DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))
            `,
            [
              newOrderNo,
              uid,
              username || null,
              orderEmail,
              creditTitle,
              actualCreditCost,
              accountId,
              reservedCode.id,
              reservedCode.code,
              reservedCode.accountEmail || null,
              JSON.stringify({ accountId, orderEmail })
            ]
          )
          saveDatabase()

          console.info('[OpenAccounts] created credit order', {
            uid,
            targetAccountId: accountId,
            creditOrderNo: newOrderNo,
            title: creditTitle,
            amount: actualCreditCost,
            expireMinutes
          })

          return {
            type: 'credit_required',
            creditOrder: { orderNo: newOrderNo, amount: actualCreditCost, payUrl: null, status: 'created' }
          }
        }

		        const baseCapacity = openAccountsCapacityLimit
		        const redeemCapacity = isMember || isInvited ? baseCapacity + 1 : baseCapacity
	        const redeemOutcome = await redeemOpenAccountsOrderCode(db, {
	          orderNo: verifiedCreditOrderNo,
	          uid,
	          email: orderEmail,
          accountEmail,
          capacityLimit: redeemCapacity
        })

	        if (!redeemOutcome.ok) {
	          throw buildRedeemFailureError(redeemOutcome)
	        }

        updateLinuxDoUserCurrentAccount(db, uid, username, accountId, orderEmail)
        saveDatabase()

        const redeemedData = redeemOutcome.redemption?.data || {}
        const resolvedInviteCount = typeof redeemedData.inviteCount === 'number'
          ? redeemedData.inviteCount
          : account.inviteCount
        const body = {
          message: redeemedData.inviteStatus === '邀请已发送'
            ? '上车成功，邀请已发送'
            : '上车成功，邀请未发送（需要手动添加）',
          currentOpenAccountId: accountId,
          account: {
            id: accountId,
            userCount: redeemedData.userCount ?? account.userCount,
            inviteCount: resolvedInviteCount
          }
        }

        if (verifiedCreditOrderNo) {
          db.run(
            `
              UPDATE credit_orders
              SET action_status = 'fulfilled',
                  action_message = ?,
                  action_result = ?,
                  updated_at = DATETIME('now', 'localtime')
              WHERE order_no = ?
            `,
            [body.message, JSON.stringify(body), verifiedCreditOrderNo]
          )
          saveDatabase()
        }

        return { type: 'success', body }
      } catch (error) {
        if (verifiedCreditOrderNo) {
          let message = error instanceof AccountSyncError
            ? error.message
            : error?.message || String(error)

          if (error instanceof AccountSyncError && error.code === OPEN_ACCOUNTS_INVITE_DOMAIN_RISK_CODE) {
            const details = error?.details && typeof error.details === 'object' ? error.details : {}
            const triggerDomain = normalizeDomainLike(details?.domain || accountEmail || '')
            const closedAccountCount = Number(details?.closedAccountCount || 0)
            const deletedUnusedCodeCount = Number(details?.deletedUnusedCodeCount || 0)

            let transferResult = { transferred: false, attempts: [] }
            try {
              transferResult = await tryAutoTransferPaidOrderOnDomainRisk(db, {
                orderNo: verifiedCreditOrderNo,
                uid,
                username,
                orderEmail,
                triggerAccountId: accountId,
                triggerAccountEmail: accountEmail,
                triggerDomain,
                capacityLimit: openAccountsCapacityLimit
              })
            } catch (transferError) {
              console.warn('[OpenAccounts] auto transfer after domain-risk failed', {
                orderNo: verifiedCreditOrderNo,
                message: transferError?.message || String(transferError)
              })
            }

            if (transferResult?.transferred && transferResult?.body) {
              await trySendDomainRiskOutcomeEmails({
                action: 'transfer',
                orderNo: verifiedCreditOrderNo,
                uid,
                username,
                userEmail: orderEmail,
                triggerDomain,
                triggerAccountId: accountId,
                triggerAccountEmail: accountEmail,
                transferAccountId: transferResult.transferAccountId,
                transferAccountEmail: transferResult.transferAccountEmail,
                closedAccountCount,
                deletedUnusedCodeCount,
                fallbackAttempted: Array.isArray(transferResult.attempts) ? transferResult.attempts.length : 0,
                attempts: transferResult.attempts || []
              })
              return { type: 'success', body: transferResult.body }
            }

            const fallbackAttempted = Array.isArray(transferResult?.attempts) ? transferResult.attempts.length : 0
            message = fallbackAttempted > 0
              ? `${message}；已尝试 ${fallbackAttempted} 个后备账号，均未转移成功`
              : `${message}；未找到可用后备账号`

            let refundMessage = ''
            try {
              const refundResult = await tryAutoRefundPaidOrder(db, verifiedCreditOrderNo, {
                note: '因账号域名疑似风控且无可用后备账号自动退款'
              })
              if (refundResult?.refunded) {
                message = `${message}；订单积分已自动退回，请重新选择账号上车`
                refundMessage = refundResult?.message || '自动退款成功'
                error.message = message
                error.autoRefunded = true
              } else if (refundResult?.attempted) {
                refundMessage = refundResult?.message || ''
                const detail = refundMessage ? `（${refundMessage}）` : ''
                message = `${message}；自动退款未完成，请联系管理员手动退款${detail}`
                error.message = message
                error.autoRefunded = false
              } else {
                refundMessage = refundResult?.reason || '订单状态异常，未执行自动退款'
                message = `${message}；自动退款未执行（${refundMessage}）`
                error.message = message
                error.autoRefunded = false
              }

              await trySendDomainRiskOutcomeEmails({
                action: error.autoRefunded ? 'refunded' : 'refund_failed',
                orderNo: verifiedCreditOrderNo,
                uid,
                username,
                userEmail: orderEmail,
                triggerDomain,
                triggerAccountId: accountId,
                triggerAccountEmail: accountEmail,
                closedAccountCount,
                deletedUnusedCodeCount,
                fallbackAttempted,
                refundMessage,
                attempts: transferResult?.attempts || []
              })
            } catch (refundError) {
              message = `${message}；自动退款执行异常，请联系管理员手动退款`
              error.message = message
              error.autoRefunded = false
              console.warn('[OpenAccounts] auto refund after domain-risk failed', {
                orderNo: verifiedCreditOrderNo,
                message: refundError?.message || String(refundError)
              })
              await trySendDomainRiskOutcomeEmails({
                action: 'refund_failed',
                orderNo: verifiedCreditOrderNo,
                uid,
                username,
                userEmail: orderEmail,
                triggerDomain,
                triggerAccountId: accountId,
                triggerAccountEmail: accountEmail,
                closedAccountCount,
                deletedUnusedCodeCount,
                fallbackAttempted,
                refundMessage: refundError?.message || '自动退款执行异常',
                attempts: transferResult?.attempts || []
              })
            }
          }
          try {
            db.run(
              `
                UPDATE credit_orders
                SET action_status = 'failed',
                    action_message = ?,
                    updated_at = DATETIME('now', 'localtime')
                WHERE order_no = ?
              `,
              [message, verifiedCreditOrderNo]
            )
            saveDatabase()
          } catch {
          }
        }
        throw error
      }
    })

    if (!decision || decision.type === 'error') {
      const payload = { error: decision?.error || '内部服务器错误' }
      if (decision?.code) {
        payload.code = decision.code
      }
      return res.status(decision?.status || 500).json(payload)
    }

    if (decision.type === 'credit_required') {
      const normalizedOrderNo = normalizeOrderNo(decision.creditOrder?.orderNo)
      if (!normalizedOrderNo) {
        return res.status(500).json({ error: '创建 Credit 订单失败' })
      }

      const notifyUrl = `${getPublicBaseUrl(req)}/credit/notify`
      const returnUrl = `${getPublicBaseUrl(req)}/redeem/open-accounts`

      if (!creditPid || !creditKey || !creditBaseUrl) {
        return res.status(500).json({ error: '未配置 Linux DO Credit 凭据' })
      }

      const creditRow = db.exec(
        `SELECT title, amount, status, pay_url, trade_no FROM credit_orders WHERE order_no = ? LIMIT 1`,
        [normalizedOrderNo]
      )[0]?.values?.[0]
      const orderTitle = creditRow?.[0] ? String(creditRow[0]) : creditTitle
      const orderAmountRaw = creditRow?.[1] != null ? String(creditRow[1]) : String(decision.creditOrder?.amount || actualCreditCost || '')
      const orderStatus = creditRow?.[2] ? String(creditRow[2]) : ''
      const storedPayUrl = creditRow?.[3] ? String(creditRow[3]) : ''
      const storedTradeNo = creditRow?.[4] ? String(creditRow[4]).trim() : ''
      const orderAmount = formatCreditMoney(orderAmountRaw) || actualCreditCost
      let payUrl = storedPayUrl || (decision.creditOrder?.payUrl ? String(decision.creditOrder.payUrl) : '')

      if (!orderAmount) {
        return res.status(500).json({ error: '未配置上车所需积分' })
      }

      const canonicalPayUrl = storedTradeNo ? buildCreditPayingUrl(creditBaseUrl, storedTradeNo) : ''
      if (canonicalPayUrl) {
        if (!payUrl || payUrl !== canonicalPayUrl) {
          payUrl = canonicalPayUrl
          try {
            db.run(
              `UPDATE credit_orders SET pay_url = ?, updated_at = DATETIME('now', 'localtime') WHERE order_no = ?`,
              [canonicalPayUrl, normalizedOrderNo]
            )
            saveDatabase()
          } catch (error) {
            console.warn('[OpenAccounts] persist credit pay_url failed', { orderNo: normalizedOrderNo, message: error?.message || String(error) })
          }
        }
      } else if (payUrl) {
        const payUrlOrderNo = extractPayingOrderNo(payUrl)
        if (payUrlOrderNo && payUrlOrderNo === normalizedOrderNo) {
          console.warn('[OpenAccounts] discard suspicious credit pay_url', { orderNo: normalizedOrderNo, payUrl })
          payUrl = ''
          try {
            db.run(`UPDATE credit_orders SET pay_url = NULL, updated_at = DATETIME('now', 'localtime') WHERE order_no = ?`, [normalizedOrderNo])
            saveDatabase()
          } catch (error) {
            console.warn('[OpenAccounts] clear credit pay_url failed', { orderNo: normalizedOrderNo, message: error?.message || String(error) })
          }
        }
      }

      console.info('[OpenAccounts] credit payment request prepared', {
        uid,
        targetAccountId: accountId,
        creditOrderNo: normalizedOrderNo,
        title: orderTitle,
        amount: orderAmount,
        payUrl: payUrl || null,
        notifyUrl
      })

      try {
        db.run(
          `UPDATE credit_orders SET status = 'pending_payment', updated_at = DATETIME('now', 'localtime') WHERE order_no = ? AND status = 'created'`,
          [normalizedOrderNo]
        )
        saveDatabase()
      } catch (error) {
        console.warn('[OpenAccounts] update credit order status failed', { orderNo: normalizedOrderNo, message: error?.message || String(error) })
      }

      // Cloudflare 会拦截服务端直连 /pay/submit.php，改为返回签名参数，让浏览器通过 form POST 打开支付页。
      const submitUrl = `${String(creditBaseUrl).replace(/\/+$/, '')}/pay/submit.php`
      const payParams = {
        pid: creditPid,
        type: 'epay',
        out_trade_no: normalizedOrderNo,
        name: orderTitle,
        money: orderAmount,
        notify_url: notifyUrl,
        return_url: returnUrl,
        device: uid
      }
      const sign = buildCreditSign(payParams, creditKey)

      // 可选：尝试服务端直连创建积分流转服务（成功可拿到 Location=/paying?order_no=...）。
      // 注意：Credit 平台可能开启 Cloudflare challenge，导致服务端请求 403；默认关闭，建议由前端浏览器 form POST 完成。
      if (creditGatewayServerSubmitEnabled() && !payUrl && orderStatus === 'created') {
        try {
          const submitResult = await createCreditTransferService({
            outTradeNo: normalizedOrderNo,
            title: orderTitle,
            money: orderAmount,
            notifyUrl,
            returnUrl,
            device: uid,
            timeoutMs: 4500
          })

          if (submitResult?.ok && submitResult.payUrl) {
            payUrl = String(submitResult.payUrl)
            const payingOrderNo = submitResult.payingOrderNo ? String(submitResult.payingOrderNo) : ''
            try {
              db.run(
                `
                  UPDATE credit_orders
                  SET pay_url = ?,
                      trade_no = CASE
                        WHEN ? IS NOT NULL AND (trade_no IS NULL OR TRIM(trade_no) = '' OR trade_no = order_no) THEN ?
                        ELSE trade_no
                      END,
                      updated_at = DATETIME('now', 'localtime')
                  WHERE order_no = ?
                `,
                [payUrl, payingOrderNo || null, payingOrderNo || null, normalizedOrderNo]
              )
              saveDatabase()
            } catch (error) {
              console.warn('[OpenAccounts] persist credit pay_url failed', { orderNo: normalizedOrderNo, message: error?.message || String(error) })
            }
          } else if (submitResult) {
            console.warn('[OpenAccounts] credit submit failed', {
              orderNo: normalizedOrderNo,
              error: submitResult.error || 'create_failed',
              status: submitResult.status || null,
              message: submitResult.message || null,
              bodySnippet: submitResult.bodySnippet || null
            })
          }
        } catch (error) {
          console.warn('[OpenAccounts] credit submit exception', { orderNo: normalizedOrderNo, message: error?.message || String(error) })
        }
      }

      console.info('[OpenAccounts] credit pay submit form prepared', {
        uid,
        targetAccountId: accountId,
        submitUrl,
        payParams,
        signType: 'MD5',
        signPrefix: sign ? String(sign).slice(0, 8) : null,
        signLength: sign ? String(sign).length : 0
      })

      return res.json({
        requiresCredit: true,
        message: `上车需消耗 ${orderAmount} Credit，请在新窗口完成授权后继续上车`,
        creditOrder: {
          orderNo: normalizedOrderNo,
          amount: orderAmount,
          payUrl: payUrl || null,
          payRequest: {
            method: 'POST',
            url: submitUrl,
            fields: {
              ...payParams,
              sign,
              sign_type: 'MD5'
            }
          }
        }
      })
    }

    return res.json(decision.body)
	  } catch (error) {
	    console.error('Board error:', error)
	    if (error instanceof AccountSyncError || error.status) {
	      const payload = { error: error.message }
	      if (error.code && (
	        String(error.code).startsWith('NO_WARRANTY')
	        || String(error.code).startsWith('OPEN_ACCOUNTS_')
	      )) {
	        payload.code = error.code
	      }
	      if (typeof error?.autoRefunded === 'boolean') {
	        payload.autoRefunded = error.autoRefunded
	      }
	      return res.status(error.status || 500).json(payload)
	    }
	    res.status(500).json({ error: '内部服务器错误' })
	  }
})

// 下车（已移除）
router.post('/unboard', authenticateLinuxDoSession, async (req, res) => {
  res.status(410).json({ error: '下车功能已移除' })
})

export default router
