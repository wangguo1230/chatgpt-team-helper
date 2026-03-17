import express from 'express'
import { getDatabase, saveDatabase } from '../database/init.js'
import { authenticateToken } from '../middleware/auth.js'
import { requireMenu } from '../middleware/rbac.js'
import { apiKeyAuth } from '../middleware/api-key-auth.js'
import { verifyLinuxDoSessionToken } from '../middleware/linuxdo-session.js'
import {
  fetchAccountInvites,
  fetchAccountUsersList,
  syncAccountInviteCount,
  syncAccountUserCount,
  inviteAccountUser,
  markAccountAsBannedAndCleanup
} from '../services/account-sync.js'
import {
  sendInviteDomainRiskAlertEmail,
  sendRedemptionFlowSummaryEmail,
  sendRedemptionOwnerNotificationEmail
} from '../services/email-service.js'
import {
  getXhsConfig,
  getXhsOrderByNumber,
  markXhsOrderRedeemed,
  normalizeXhsOrderNumber,
  recordXhsSyncResult,
  syncOrdersFromApi,
} from '../services/xhs-orders.js'
import { isXhsSyncing, setXhsSyncing } from '../services/xhs-sync-runner.js'
import {
  getXianyuConfig,
  updateXianyuConfig,
  getXianyuOrderById,
  markXianyuOrderRedeemed,
  normalizeXianyuOrderId,
  recordXianyuSyncResult,
  queryXianyuOrderDetailFromApi,
  transformXianyuApiOrder,
  transformApiOrderForImport as transformXianyuApiOrderForImport,
  importXianyuOrders,
} from '../services/xianyu-orders.js'
import { withLocks } from '../utils/locks.js'
import { requireFeatureEnabled } from '../middleware/feature-flags.js'
import { getChannels, normalizeChannelKey } from '../utils/channels.js'
import { resolveOrderDeadlineMs, selectRecoveryCode } from '../services/account-recovery.js'
import { getAccountRecoverySettings } from '../utils/account-recovery-settings.js'
import { getRedemptionCodeSettings } from '../utils/redemption-settings.js'
import {
  getOpenAccountsCapacityLimit,
  getOpenAccountsCapacityLimitFromEnv,
  OPEN_ACCOUNTS_CAPACITY_LIMIT_KEY,
  OPEN_ACCOUNTS_CAPACITY_LIMIT_MAX,
  OPEN_ACCOUNTS_CAPACITY_LIMIT_MIN
} from '../utils/open-accounts-capacity-settings.js'

const router = express.Router()

const normalizeChannel = (value, fallback = 'common') => normalizeChannelKey(value, fallback)
const toInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}
const parseBoolean = (value, fallback) => {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  const raw = String(value).trim().toLowerCase()
  if (!raw) return fallback
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true
  if (['0', 'false', 'no', 'off'].includes(raw)) return false
  return fallback
}
const HISTORY_CODE_MIN_ACCOUNT_REMAINING_DAYS = 30
const getAccountRecoveryWindowDays = () => Math.max(1, toInt(process.env.ACCOUNT_RECOVERY_WINDOW_DAYS, 30))
const getAccountRecoveryRedeemMaxAttempts = () => Math.min(
  10,
  Math.max(1, toInt(process.env.ACCOUNT_RECOVERY_REDEEM_MAX_ATTEMPTS, 3))
)
const getAccountRecoveryAccessCacheTtlMs = () => Math.max(
  0,
  toInt(process.env.ACCOUNT_RECOVERY_ACCESS_CACHE_TTL_MS, 60_000)
)
const ACCOUNT_RECOVERY_ACCESS_CACHE_MAX_SIZE = 2000
const accountRecoveryAccessCache = new Map()
const getAccountRecoveryAccessCache = (accountId) => {
  const ttlMs = getAccountRecoveryAccessCacheTtlMs()
  if (!accountId || ttlMs <= 0) return null
  const entry = accountRecoveryAccessCache.get(accountId)
  if (!entry) return null
  if (Date.now() - entry.checkedAt > ttlMs) {
    accountRecoveryAccessCache.delete(accountId)
    return null
  }
  return entry
}
const setAccountRecoveryAccessCache = (accountId, entry) => {
  const ttlMs = getAccountRecoveryAccessCacheTtlMs()
  if (!accountId || ttlMs <= 0 || !entry) return
  if (accountRecoveryAccessCache.size > ACCOUNT_RECOVERY_ACCESS_CACHE_MAX_SIZE) {
    const firstKey = accountRecoveryAccessCache.keys().next().value
    if (firstKey != null) accountRecoveryAccessCache.delete(firstKey)
  }
  accountRecoveryAccessCache.set(accountId, { ...entry, checkedAt: Date.now() })
}
const ORDER_TYPE_WARRANTY = 'warranty'
const ORDER_TYPE_NO_WARRANTY = 'no_warranty'
const ORDER_TYPE_ANTI_BAN = 'anti_ban'
const ORDER_TYPE_SET = new Set([ORDER_TYPE_WARRANTY, ORDER_TYPE_NO_WARRANTY, ORDER_TYPE_ANTI_BAN])
const normalizeOrderType = (value) => {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'no-warranty' || normalized === 'nowarranty') return ORDER_TYPE_NO_WARRANTY
  if (normalized === 'anti-ban') return ORDER_TYPE_ANTI_BAN
  return ORDER_TYPE_SET.has(normalized) ? normalized : ORDER_TYPE_WARRANTY
}
const isNoWarrantyOrderType = (value) => normalizeOrderType(value) === ORDER_TYPE_NO_WARRANTY
const isAntiBanOrderType = (value) => normalizeOrderType(value) === ORDER_TYPE_ANTI_BAN

const pad2 = (value) => String(value).padStart(2, '0')
const addDays = (date, days) => {
  const base = date instanceof Date ? date.getTime() : new Date(date).getTime()
  if (Number.isNaN(base)) return new Date(NaN)
  const deltaDays = Number(days || 0)
  if (!Number.isFinite(deltaDays)) return new Date(NaN)
  return new Date(base + deltaDays * 24 * 60 * 60 * 1000)
}
const formatExpireAtComparable = (date) => {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return ''
  try {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(date)
    const get = (type) => parts.find(p => p.type === type)?.value || ''
    return `${get('year')}/${get('month')}/${get('day')} ${get('hour')}:${get('minute')}`
  } catch {
    return `${date.getFullYear()}/${pad2(date.getMonth() + 1)}/${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  }
}
const normalizeStrictToday = (value) => {
  if (value === undefined || value === null) return true
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  const raw = String(value).trim().toLowerCase()
  if (!raw) return true
  if (['0', 'false', 'off', 'no'].includes(raw)) return false
  if (['1', 'true', 'on', 'yes'].includes(raw)) return true
  return true
}

const getStrictTodayDefault = () => normalizeStrictToday(process.env.REDEEM_ORDER_STRICT_TODAY_DEFAULT)
const resolveStrictTodayEnabled = (value) => {
  const strictTodayDefault = getStrictTodayDefault()
  if (value === undefined || value === null) return strictTodayDefault
  if (typeof value === 'string' && !value.trim()) return strictTodayDefault
  return normalizeStrictToday(value)
}

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

  // NOTE: gpt_accounts.expire_at is stored as Asia/Shanghai time.
  const iso = `${match[1]}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}+08:00`
  const parsed = Date.parse(iso)
  return Number.isNaN(parsed) ? null : parsed
}

const getOpenAccountsCapacityLimitSqlExpr = () => {
  const capacityFallback = getOpenAccountsCapacityLimitFromEnv()
  return `
    COALESCE(
      (
        SELECT CAST(TRIM(sc.config_value) AS INTEGER)
        FROM system_config sc
        WHERE sc.config_key = '${OPEN_ACCOUNTS_CAPACITY_LIMIT_KEY}'
          AND TRIM(sc.config_value) != ''
          AND TRIM(sc.config_value) NOT GLOB '*[^0-9]*'
          AND CAST(TRIM(sc.config_value) AS INTEGER) BETWEEN ${OPEN_ACCOUNTS_CAPACITY_LIMIT_MIN} AND ${OPEN_ACCOUNTS_CAPACITY_LIMIT_MAX}
        LIMIT 1
      ),
      ${capacityFallback}
    )
  `
}

const getAccountRedeemableSql = () => `
  COALESCE(ga.is_open, 0) = 1
  AND COALESCE(ga.is_banned, 0) = 0
  AND ga.token IS NOT NULL
  AND trim(ga.token) != ''
  AND ga.chatgpt_account_id IS NOT NULL
  AND trim(ga.chatgpt_account_id) != ''
  AND ga.expire_at IS NOT NULL
  AND trim(ga.expire_at) != ''
  AND trim(ga.expire_at) >= ?
  AND COALESCE(ga.user_count, 0) + COALESCE(ga.invite_count, 0) < ${getOpenAccountsCapacityLimitSqlExpr()}
`

const getCodeAccountRedeemableExistsSql = () => `
  (
    rc.account_email IS NULL
    OR trim(rc.account_email) = ''
    OR EXISTS (
      SELECT 1
      FROM gpt_accounts ga
      WHERE lower(trim(ga.email)) = lower(trim(rc.account_email))
        AND ${getAccountRedeemableSql()}
    )
  )
`

const resolveChannelNameFromRegistry = (channelsByKey, channelKey) => {
  if (!channelsByKey || !channelKey) return ''
  const channel = channelsByKey.get(channelKey)
  const name = channel?.name ? String(channel.name).trim() : ''
  return name || ''
}

const mapCodeRow = (row, channelsByKey) => {
  if (!row) return null
  const channelValue = normalizeChannel(row[6], 'common')
  const storedChannelName = row[7] == null ? '' : String(row[7]).trim()
  const channelName = storedChannelName || resolveChannelNameFromRegistry(channelsByKey, channelValue) || channelValue
  const redeemedBy = row[4]
  const redeemedEmail = extractEmailFromRedeemedBy(redeemedBy) || null
  return {
    id: row[0],
    code: row[1],
    isRedeemed: row[2] === 1,
    redeemedAt: row[3],
    redeemedBy,
    redeemedEmail,
    accountEmail: row[5],
    channel: channelValue,
    channelName,
    createdAt: row[8],
    updatedAt: row[9],
    reservedForUid: row.length > 10 ? row[10] || null : null,
    reservedForUsername: row.length > 11 ? row[11] || null : null,
    reservedForEntryId: row.length > 12 ? row[12] || null : null,
    reservedAt: row.length > 13 ? row[13] || null : null,
    reservedForOrderNo: row.length > 14 ? row[14] || null : null,
    reservedForOrderEmail: row.length > 15 ? row[15] || null : null,
    orderType: row.length > 16 ? row[16] || null : null,
    serviceDays: row.length > 17 ? row[17] || null : null,
    // Optional: may be present when list API joins gpt_accounts.
    accountIsBanned: row.length > 18 ? toInt(row[18], 0) === 1 : undefined
  }
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const CODE_REGEX = /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/
const OUT_OF_STOCK_MESSAGE = '暂无可用兑换码，请联系管理员补货'
const getRedemptionLowStockThresholdFromEnv = () => Math.max(0, toInt(process.env.REDEMPTION_LOW_STOCK_THRESHOLD, 0))
const getRedeemLazyRetryMaxAttempts = () => Math.max(1, toInt(process.env.REDEEM_LAZY_RETRY_MAX_ATTEMPTS, 8))
const REDEEM_ACCOUNT_UNAVAILABLE_ERROR_CODE = 'ACCOUNT_UNAVAILABLE'

const normalizeAlertScopeChannels = (channels) => {
  if (!Array.isArray(channels)) return []
  const deduped = []
  const seen = new Set()
  for (const raw of channels) {
    const normalized = normalizeChannel(raw, '')
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    deduped.push(normalized)
  }
  return deduped
}

export const createRedemptionAlertCollector = (source = 'redeem', options = {}) => ({
  source,
  triggeredAt: new Date(),
  lowStockChannels: [],
  lowStockCollected: false,
  pendingAuthorizationOrderCount: 0,
  pendingAuthorizationCollected: false,
  threshold: getRedemptionLowStockThresholdFromEnv(),
  bannedAccountsById: new Map(),
  scopeChannels: normalizeAlertScopeChannels(options?.scopeChannels)
})

const recordBannedAccountAlert = (collector, payload) => {
  if (!collector || !payload) return
  const accountId = Number(payload.accountId || 0)
  const key = Number.isFinite(accountId) && accountId > 0 ? accountId : `email:${String(payload.accountEmail || '').trim().toLowerCase()}`
  collector.bannedAccountsById.set(key, {
    accountId: Number(payload.accountId || 0),
    accountEmail: String(payload.accountEmail || ''),
    deletedUnusedCodeCount: Number(payload.deletedUnusedCodeCount || 0),
    reason: String(payload.reason || '').trim()
  })
}

const shouldMarkAccountUnavailable = (error) => {
  if (isAccountAccessFailure(error)) return true
  const message = String(error?.message || '').trim().toLowerCase()
  return message.includes('account_deactivated') || message.includes('token 已过期') || message.includes('token已过期')
}

const isLazyRetryableAccountError = (error) => {
  return error instanceof RedemptionError && String(error?.payload?.errorCode || '') === REDEEM_ACCOUNT_UNAVAILABLE_ERROR_CODE
}

const buildExcludeCodeClause = (excludeCodeIds = [], alias = 'rc') => {
  const ids = (excludeCodeIds || [])
    .map(id => Number(id))
    .filter(id => Number.isFinite(id) && id > 0)
  if (ids.length === 0) {
    return { clause: '', params: [] }
  }
  return {
    clause: ` AND ${alias}.id NOT IN (${ids.map(() => '?').join(',')})`,
    params: ids
  }
}

const collectPendingAuthorizationOrderCount = (db, collector) => {
  if (!db || !collector || collector.pendingAuthorizationCollected) return
  collector.pendingAuthorizationCollected = true
  try {
    const result = db.exec(
      `
        SELECT COUNT(*)
        FROM credit_orders
        WHERE scene = 'open_accounts_board'
          AND status IN ('created', 'pending_payment')
      `
    )
    collector.pendingAuthorizationOrderCount = Number(result?.[0]?.values?.[0]?.[0] || 0)
  } catch {
    // 兼容旧测试/历史表结构：缺少 credit_orders 时默认 0。
    collector.pendingAuthorizationOrderCount = 0
  }
}

const collectLowStockAlerts = async (db, collector) => {
  if (!collector || collector.lowStockCollected) return
  collector.lowStockCollected = true
  collectPendingAuthorizationOrderCount(db, collector)
  try {
    const settings = getRedemptionCodeSettings(db)
    const resolvedThreshold = Number(settings?.lowStockThreshold)
    if (Number.isFinite(resolvedThreshold) && resolvedThreshold >= 0) {
      collector.threshold = resolvedThreshold
    }
  } catch {
    // Ignore settings load failures and fallback to collector threshold.
  }
  if (collector.threshold <= 0) return

  const { list: channels = [] } = await getChannels(db)
  const scoped = normalizeAlertScopeChannels(collector.scopeChannels)
  const activeChannels = channels
    .filter(channel => channel?.isActive)
    .filter(channel => scoped.length === 0 || scoped.includes(normalizeChannel(channel?.key, 'common')))
  if (activeChannels.length === 0) return

  const nowComparable = formatExpireAtComparable(new Date())
  if (!nowComparable) return

  const stockResult = db.exec(
    `
      SELECT COALESCE(NULLIF(lower(trim(rc.channel)), ''), 'common') AS channel_key, COUNT(*) AS available_count
      FROM redemption_codes rc
      WHERE rc.is_redeemed = 0
        AND (rc.reserved_for_uid IS NULL OR trim(rc.reserved_for_uid) = '')
        AND (rc.reserved_for_order_no IS NULL OR trim(rc.reserved_for_order_no) = '')
        AND COALESCE(rc.reserved_for_entry_id, 0) = 0
        AND (
          (
            (rc.account_email IS NULL OR trim(rc.account_email) = '')
            AND EXISTS (
              SELECT 1
              FROM gpt_accounts ga
              WHERE ${getAccountRedeemableSql()}
              LIMIT 1
            )
          )
          OR EXISTS (
            SELECT 1
            FROM gpt_accounts ga
            WHERE lower(trim(ga.email)) = lower(trim(rc.account_email))
              AND ${getAccountRedeemableSql()}
          )
        )
      GROUP BY COALESCE(NULLIF(lower(trim(rc.channel)), ''), 'common')
    `,
    [nowComparable, nowComparable]
  )
  const stockMap = new Map()
  for (const row of stockResult?.[0]?.values || []) {
    const key = normalizeChannel(row[0], 'common')
    stockMap.set(key, Number(row[1] || 0))
  }

  collector.lowStockChannels = activeChannels
    .map(channel => {
      const key = normalizeChannel(channel.key, 'common')
      const availableCount = Number(stockMap.get(key) || 0)
      return {
        channel: key,
        channelName: String(channel.name || '').trim() || key,
        availableCount
      }
    })
    .filter(item => item.availableCount < collector.threshold)
}

export const collectRedemptionLowStockAlerts = collectLowStockAlerts

export const flushRedemptionAlertCollector = async (collector) => {
  if (!collector) return
  const bannedAccounts = Array.from(collector.bannedAccountsById.values())
  const lowStockChannels = collector.lowStockChannels || []
  if (bannedAccounts.length === 0 && lowStockChannels.length === 0) return

  await sendRedemptionFlowSummaryEmail({
    source: collector.source,
    threshold: collector.threshold,
    pendingAuthorizationOrderCount: Number(collector.pendingAuthorizationOrderCount || 0),
    lowStockChannels,
    bannedAccounts,
    triggeredAt: collector.triggeredAt
  })
}

export const emitRedemptionLowStockAlerts = async (db, source = 'redeem') => {
  if (!db) return { threshold: 0, lowStockChannels: [], sent: false }
  const collector = createRedemptionAlertCollector(source)
  await collectLowStockAlerts(db, collector)
  const lowStockChannels = collector.lowStockChannels || []
  if (lowStockChannels.length === 0) {
    return {
      threshold: collector.threshold,
      lowStockChannels,
      sent: false
    }
  }
  await flushRedemptionAlertCollector(collector)
  return {
    threshold: collector.threshold,
    lowStockChannels,
    sent: true
  }
}

const extractEmailFromRedeemedBy = (redeemedBy) => {
  const raw = String(redeemedBy ?? '').trim()
  if (!raw) return ''

  const match = raw.match(/email\s*:\s*([^|]+)(?:\||$)/i)
  if (match?.[1]) {
    return String(match[1]).trim()
  }

  return EMAIL_REGEX.test(raw) ? raw : ''
}
export class RedemptionError extends Error {
  constructor(statusCode, message, payload = {}) {
    super(message)
    this.statusCode = statusCode
    this.payload = payload
  }
}

// 生成随机兑换码
function generateRedemptionCode(length = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 排除容易混淆的字符
  let code = ''
  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length))
    // 每4位添加一个分隔符
    if ((i + 1) % 4 === 0 && i < length - 1) {
      code += '-'
    }
  }
  return code
}

const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase()
const extractEmailDomain = (email) => {
  const normalized = normalizeEmail(email)
  const atIndex = normalized.lastIndexOf('@')
  if (atIndex <= 0 || atIndex >= normalized.length - 1) return ''
  return normalized.slice(atIndex + 1)
}

const hasInviteInList = (invites, email) => {
  const normalized = normalizeEmail(email)
  if (!normalized) return false
  return (invites?.items || []).some(item => normalizeEmail(item?.email_address) === normalized)
}

const rollbackRedeemedCodeUsage = async (db, codeId, context = {}) => {
  if (!db || !Number.isFinite(Number(codeId)) || Number(codeId) <= 0) return false
  try {
    db.run(
      `
        UPDATE redemption_codes
        SET is_redeemed = 0,
            redeemed_at = NULL,
            redeemed_by = NULL,
            updated_at = DATETIME('now', 'localtime')
        WHERE id = ?
      `,
      [codeId]
    )
    const rowsModified = typeof db.getRowsModified === 'function' ? Number(db.getRowsModified() || 0) : 0
    if (rowsModified > 0) {
      await saveDatabase()
    }
    return rowsModified > 0
  } catch (error) {
    console.warn('[Redemption] 回滚兑换码状态失败', {
      codeId,
      accountId: context?.accountId || null,
      message: error?.message || String(error)
    })
    return false
  }
}

const syncInviteAndCheckPresence = async ({ accountId, inviteEmail, suppressAlertEmail }) => {
  const inviteSync = await syncAccountInviteCount(accountId, {
    inviteListParams: { offset: 0, limit: 1, query: '' },
    suppressAlertEmail
  })
  const inviteQuery = await fetchAccountInvites(accountId, {
    inviteListParams: { offset: 0, limit: 25, query: normalizeEmail(inviteEmail) },
    suppressAlertEmail
  })

  return {
    account: inviteSync?.account || null,
    inviteCount: Number.isFinite(Number(inviteSync?.inviteCount)) ? Number(inviteSync.inviteCount) : null,
    isInvited: hasInviteInList(inviteQuery, inviteEmail)
  }
}

const handleInviteDomainRiskBySuffix = async ({
  db,
  domain,
  triggerAccountId,
  triggerAccountEmail,
  reason
}) => {
  const normalizedDomain = String(domain || '').trim().toLowerCase()
  if (!db || !normalizedDomain) {
    return {
      domain: normalizedDomain,
      closedAccountCount: 0,
      deletedUnusedCodeCount: 0,
      affectedAccounts: []
    }
  }

  return withLocks([`invite-domain-risk:${normalizedDomain}`], async () => {
    const triggeredAt = new Date()
    const note = `邮箱后缀疑似风控（${normalizedDomain}）：第二人邀请两次后仍未进入邀请列表；触发账号 ${triggerAccountEmail || '-'}；时间 ${triggeredAt.toLocaleString()}`

    const accountsRows = db.exec(
      `
        SELECT id, email, COALESCE(is_open, 0) AS is_open
        FROM gpt_accounts
        WHERE INSTR(email, '@') > 0
          AND LOWER(TRIM(SUBSTR(email, INSTR(email, '@') + 1))) = ?
      `,
      [normalizedDomain]
    )?.[0]?.values || []

    const affectedAccounts = accountsRows
      .map(row => ({
        id: Number(row[0] || 0),
        email: String(row[1] || '').trim(),
        wasOpen: Number(row[2] || 0) === 1
      }))
      .filter(item => item.id > 0 && item.email)

    const accountIds = affectedAccounts.map(item => item.id)
    const closedAccountCount = affectedAccounts.filter(item => item.wasOpen).length

    if (accountIds.length > 0) {
      const placeholders = accountIds.map(() => '?').join(',')
      db.run(
        `
          UPDATE gpt_accounts
          SET is_open = 0,
              risk_note = CASE
                WHEN COALESCE(TRIM(risk_note), '') = '' THEN ?
                ELSE risk_note || '\n' || ?
              END,
              updated_at = DATETIME('now', 'localtime')
          WHERE id IN (${placeholders})
        `,
        [note, note, ...accountIds]
      )
    }

    db.run(
      `
        DELETE FROM redemption_codes
        WHERE is_redeemed = 0
          AND account_email IS NOT NULL
          AND INSTR(account_email, '@') > 0
          AND LOWER(TRIM(SUBSTR(account_email, INSTR(account_email, '@') + 1))) = ?
      `,
      [normalizedDomain]
    )
    const deletedUnusedCodeCount = typeof db.getRowsModified === 'function' ? Number(db.getRowsModified() || 0) : 0
    await saveDatabase()

    try {
      await sendInviteDomainRiskAlertEmail({
        domain: normalizedDomain,
        triggerAccountId,
        triggerAccountEmail,
        closedAccountCount,
        deletedUnusedCodeCount,
        reason,
        affectedAccounts,
        triggeredAt
      })
    } catch (mailError) {
      console.warn('[InviteDomainRisk] 发送域名风控告警失败', mailError?.message || mailError)
    }

    return {
      domain: normalizedDomain,
      closedAccountCount,
      deletedUnusedCodeCount,
      affectedAccounts
    }
  })
}

const buildRecoveryWindowEndsAt = (redeemedAt) => {
  if (!redeemedAt) return null
  const redeemedTime = new Date(redeemedAt).getTime()
  if (Number.isNaN(redeemedTime)) return null
  const windowMs = getAccountRecoveryWindowDays() * 24 * 60 * 60 * 1000
  return new Date(redeemedTime + windowMs).toISOString()
}

const isAccountAccessFailure = (error) => {
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status)
  return status === 400 || status === 401 || status === 403 || status === 404
}

const banAccountForRedemptionFlow = async ({
  db,
  accountId,
  accountEmail,
  reason,
  alertCollector
}) => {
  if (!db || !Number.isFinite(Number(accountId)) || Number(accountId) <= 0) return null
  const shouldSendImmediateAlert = !alertCollector
  const result = await withLocks([`acct:${accountId}`], async () => {
    return markAccountAsBannedAndCleanup(db, accountId, reason, { sendAlertEmail: shouldSendImmediateAlert })
  })

  const payload = {
    accountId: Number(accountId),
    accountEmail: String(result?.accountEmail || accountEmail || ''),
    deletedUnusedCodeCount: Number(result?.deletedUnusedCodeCount || 0),
    reason
  }
  recordBannedAccountAlert(alertCollector, payload)
  return payload
}

const shouldRetryAccountRecoveryRedeem = (error) => {
  if (!(error instanceof RedemptionError)) return false
  const statusCode = Number(error.statusCode)
  const message = String(error.message || '').trim().toLowerCase()

  if (message.includes('已被使用')) return true
  if (message.includes('不存在') || message.includes('已失效')) return true

  if (statusCode === 503) {
    if (message.includes('人数上限')) return true
    if (message.includes('不可用') || message.includes('过期')) return true
    if (message.includes('暂无可用')) return true
  }

  return false
}

const recordAccountRecovery = (db, payload) => {
  if (!db || !payload) return
  db.run(
    `
      INSERT INTO account_recovery_logs (
        email,
        original_code_id,
        original_redeemed_at,
        original_account_email,
        recovery_mode,
        recovery_code_id,
        recovery_code,
        recovery_account_email,
        status,
        error_message,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))
    `,
    [
      payload.email,
      payload.originalCodeId,
      payload.originalRedeemedAt || null,
      payload.originalAccountEmail || null,
      payload.recoveryMode || null,
      payload.recoveryCodeId || null,
      payload.recoveryCode || null,
      payload.recoveryAccountEmail || null,
      payload.status || 'pending',
      payload.errorMessage || null,
    ]
  )
}

export async function redeemCodeInternal({
  email,
  code,
  channel = 'common',
  redeemerUid,
  capacityLimit = null,
  skipCodeFormatValidation = false,
  allowCommonChannelFallback = false,
  allowNonOpenAccount = false,
  alertCollector = null,
}) {
  const normalizedEmail = (email || '').trim()
  if (!normalizedEmail) {
    throw new RedemptionError(400, '请输入邮箱地址')
  }

  if (!EMAIL_REGEX.test(normalizedEmail)) {
    throw new RedemptionError(400, '请输入有效的邮箱地址')
  }

  const sanitizedCode = (code || '').trim().toUpperCase()
  if (!sanitizedCode) {
    throw new RedemptionError(400, '请输入兑换码')
  }

  if (!skipCodeFormatValidation && !CODE_REGEX.test(sanitizedCode)) {
    throw new RedemptionError(400, '兑换码格式不正确（格式：XXXX-XXXX-XXXX）')
  }

  const requestedChannel = normalizeChannel(channel, 'common')
  const normalizedRedeemerUid = redeemerUid != null ? String(redeemerUid).trim() : ''
  const suppressAlertEmail = Boolean(alertCollector)

  const db = await getDatabase()
  const { byKey: channelsByKey } = await getChannels(db)
  const requestedChannelConfig = channelsByKey.get(requestedChannel) || null

  if (!requestedChannelConfig) {
    throw new RedemptionError(400, '渠道不存在或已停用')
  }

  if (!requestedChannelConfig.isActive) {
    throw new RedemptionError(403, '该渠道已停用')
  }

  if (requestedChannelConfig.redeemMode === 'linux-do' && !normalizedRedeemerUid) {
    throw new RedemptionError(400, 'Linux DO 渠道兑换需要填写论坛 UID')
  }
  const codeResult = db.exec(`
      SELECT id, code, is_redeemed, redeemed_at, redeemed_by,
             account_email, channel, channel_name, created_at, updated_at,
             reserved_for_uid, reserved_for_username, reserved_for_entry_id, reserved_at,
             reserved_for_order_no, reserved_for_order_email, order_type, service_days
      FROM redemption_codes
      WHERE code = ?
    `, [sanitizedCode])

  if (codeResult.length === 0 || codeResult[0].values.length === 0) {
    throw new RedemptionError(404, '兑换码不存在或已失效')
  }

  const codeRow = codeResult[0].values[0]
  const codeRecord = mapCodeRow(codeRow, channelsByKey)
  const codeId = codeRecord.id
  const isRedeemed = codeRecord.isRedeemed
  const boundAccountEmail = codeRecord.accountEmail
  const codeChannel = codeRecord.channel
  const storedChannel = codeRow[6] == null ? '' : String(codeRow[6]).trim().toLowerCase()
  const isStoredCommonChannel = storedChannel === '' || storedChannel === 'common'
  const reservedForUid = codeRecord.reservedForUid ? String(codeRecord.reservedForUid).trim() : ''
  const reservedForEntryId = codeRecord.reservedForEntryId
  const reservedForOrderNo = codeRecord.reservedForOrderNo ? String(codeRecord.reservedForOrderNo).trim() : ''
  const reservedForOrderEmail = codeRecord.reservedForOrderEmail ? normalizeEmail(codeRecord.reservedForOrderEmail) : ''
  const redeemerIdentifier = requestedChannelConfig.redeemMode === 'linux-do' && normalizedRedeemerUid
    ? `UID:${normalizedRedeemerUid} | Email:${normalizedEmail}`
    : normalizedEmail

  if (isRedeemed) {
    throw new RedemptionError(400, '该兑换码已被使用')
  }

  const fallbackFromCommonChannelAllowed = Boolean(allowCommonChannelFallback)
    && isStoredCommonChannel
    && requestedChannel !== 'common'
    && Boolean(requestedChannelConfig.allowCommonFallback)

  if (codeChannel !== requestedChannel && !fallbackFromCommonChannelAllowed) {
    throw new RedemptionError(403, '该兑换码仅能在对应渠道的兑换页使用')
  }

  if (requestedChannelConfig.redeemMode === 'linux-do' && reservedForUid && reservedForUid !== normalizedRedeemerUid) {
    throw new RedemptionError(403, '该兑换码已绑定其他 Linux DO 用户')
  }

  if (reservedForOrderNo) {
    const orderResult = db.exec(
      `
        SELECT status, email, refunded_at
        FROM purchase_orders
        WHERE order_no = ?
        LIMIT 1
      `,
      [reservedForOrderNo]
    )

    const orderRow = orderResult[0]?.values?.[0]
    if (orderRow) {
      const orderStatus = String(orderRow[0] || '')
      const orderEmail = normalizeEmail(orderRow[1])
      const refundedAt = orderRow[2]

      if (refundedAt || orderStatus === 'refunded') {
        throw new RedemptionError(403, '该订单已退款，兑换码已失效')
      }

      if (orderStatus !== 'paid') {
        throw new RedemptionError(403, '该兑换码对应订单未完成支付')
      }

      if (reservedForOrderEmail && reservedForOrderEmail !== normalizeEmail(normalizedEmail)) {
        throw new RedemptionError(403, '该兑换码已绑定购买邮箱，请使用下单邮箱兑换')
      }

      if (orderEmail && orderEmail !== normalizeEmail(normalizedEmail)) {
        throw new RedemptionError(403, '该兑换码已绑定购买邮箱，请使用下单邮箱兑换')
      }
    } else {
      const creditOrderResult = db.exec(
        `
          SELECT status, paid_at, refunded_at, scene
          FROM credit_orders
          WHERE order_no = ?
          LIMIT 1
        `,
        [reservedForOrderNo]
      )
      const creditRow = creditOrderResult[0]?.values?.[0]
      if (!creditRow) {
        throw new RedemptionError(403, '该兑换码绑定的订单不存在或已失效')
      }

      const creditStatus = String(creditRow[0] || '')
      const paidAt = creditRow[1]
      const refundedAt = creditRow[2]
      const scene = String(creditRow[3] || '')

      if (scene && scene !== 'open_accounts_board') {
        throw new RedemptionError(403, '该兑换码绑定的订单不可用于兑换')
      }

      if (refundedAt || creditStatus === 'refunded') {
        throw new RedemptionError(403, '该订单已退款，兑换码已失效')
      }

      if (creditStatus !== 'paid' && !paidAt) {
        throw new RedemptionError(403, '该兑换码对应订单未完成支付')
      }

      if (reservedForOrderEmail && reservedForOrderEmail !== normalizeEmail(normalizedEmail)) {
        throw new RedemptionError(403, '该兑换码已绑定购买邮箱，请使用下单邮箱兑换')
      }
    }
  }

  let accountResult

  const configuredCapacity = getOpenAccountsCapacityLimit(db)
  const requestedCapacity = Number.parseInt(String(capacityLimit ?? '').trim(), 10)
  const resolvedCapacity = Number.isFinite(requestedCapacity) && requestedCapacity > 0
    ? requestedCapacity
    : configuredCapacity
  const maxSeats = Math.max(1, resolvedCapacity)
  const nowMs = Date.now()
  const accountCandidatesLimit = 50
  const isAccountUsable = (row) => {
    if (!row) return false
    const token = String(row[2] ?? '').trim()
    const chatgptAccountId = String(row[4] ?? '').trim()
    if (!token || !chatgptAccountId) return false
    const expireAtMs = parseExpireAtToMs(row[6])
    return expireAtMs != null && expireAtMs >= nowMs
  }
  const pickUsableAccount = (rows) => {
    if (!Array.isArray(rows) || rows.length === 0) return null
    return rows.find(isAccountUsable) || null
  }

  if (boundAccountEmail) {
    accountResult = db.exec(
      `
        SELECT id,
               email,
               token,
               COALESCE(user_count, 0) AS user_count,
               chatgpt_account_id,
               oai_device_id,
               expire_at,
               COALESCE(invite_count, 0) AS invite_count,
               COALESCE(is_open, 0) AS is_open,
               COALESCE(is_banned, 0) AS is_banned
        FROM gpt_accounts
        WHERE email = ?
        LIMIT 1
      `,
      [boundAccountEmail]
    )

    const boundRow = accountResult?.[0]?.values?.[0] || null
    if (!boundRow) {
      throw new RedemptionError(503, '该兑换码绑定的账号不存在，请联系管理员')
    }

    const boundUserCount = Number(boundRow[3] || 0)
    const boundInviteCount = Number(boundRow[7] || 0)
    if (boundUserCount + boundInviteCount >= maxSeats) {
      throw new RedemptionError(503, '该兑换码绑定的账号已达到人数上限，请联系管理员')
    }

    const isOpen = Number(boundRow[8] || 0) === 1
    const isBanned = Number(boundRow[9] || 0) === 1
    if (isBanned || (!isOpen && !allowNonOpenAccount)) {
      throw new RedemptionError(503, '该兑换码绑定账号不可用或已过期，请联系管理员')
    }

    const candidate = [boundRow[0], boundRow[1], boundRow[2], boundRow[3], boundRow[4], boundRow[5], boundRow[6]]
    if (!isAccountUsable(candidate)) {
      throw new RedemptionError(503, '该兑换码绑定账号不可用或已过期，请联系管理员')
    }

    accountResult = [{ values: [candidate] }]
  } else {
    accountResult = db.exec(
      `
        SELECT id,
               email,
               token,
               COALESCE(user_count, 0) AS user_count,
               chatgpt_account_id,
               oai_device_id,
               expire_at
        FROM gpt_accounts
        WHERE COALESCE(user_count, 0) + COALESCE(invite_count, 0) < ?
          AND COALESCE(is_open, 0) = 1
          AND COALESCE(is_banned, 0) = 0
          AND token IS NOT NULL
          AND TRIM(token) != ''
          AND chatgpt_account_id IS NOT NULL
          AND TRIM(chatgpt_account_id) != ''
          AND expire_at IS NOT NULL
          AND TRIM(expire_at) != ''
        ORDER BY COALESCE(user_count, 0) + COALESCE(invite_count, 0) ASC, RANDOM()
        LIMIT ?
      `,
      [maxSeats, accountCandidatesLimit]
    )

    const candidates = accountResult?.[0]?.values || []
    const usable = pickUsableAccount(candidates)
    if (!usable) {
      throw new RedemptionError(503, '暂无可用账号，请稍后再试或联系管理员')
    }
    accountResult = [{ values: [usable] }]
  }

  const account = accountResult[0].values[0]
  const accountId = account[0]
  const accountEmail = account[1]
  const accountToken = account[2]
  const currentUserCount = account[3] || 0
  const chatgptAccountId = account[4]
  const currentInviteCountRow = db.exec(
    'SELECT COALESCE(invite_count, 0) FROM gpt_accounts WHERE id = ? LIMIT 1',
    [accountId]
  )
  const currentInviteCount = Number(currentInviteCountRow?.[0]?.values?.[0]?.[0] || 0)
  let preflightUserCount = Number(currentUserCount || 0)
  let preflightInviteCount = Number(currentInviteCount || 0)

  if (chatgptAccountId && accountToken) {
    try {
      const preflightUsers = await fetchAccountUsersList(accountId, {
        userListParams: { offset: 0, limit: 1, query: '' },
        suppressAlertEmail
      })
      if (Number.isFinite(Number(preflightUsers?.total))) {
        preflightUserCount = Number(preflightUsers.total)
      }

      if (preflightUserCount === 1) {
        try {
          const preflightInviteSync = await syncAccountInviteCount(accountId, {
            inviteListParams: { offset: 0, limit: 1, query: '' },
            suppressAlertEmail
          })
          if (Number.isFinite(Number(preflightInviteSync?.inviteCount))) {
            preflightInviteCount = Number(preflightInviteSync.inviteCount)
          }
        } catch (inviteSyncError) {
          console.warn('[Redemption] 兑换前邀请数预同步失败，沿用本地 invite_count', {
            accountId,
            message: inviteSyncError?.message || String(inviteSyncError)
          })
        }
      }
    } catch (error) {
      if (shouldMarkAccountUnavailable(error)) {
        const reason = `兑换前账号校验失败：${error?.message || '未知错误'}`
        const banInfo = await banAccountForRedemptionFlow({
          db,
          accountId,
          accountEmail,
          reason,
          alertCollector
        })
        throw new RedemptionError(503, '该兑换码绑定账号不可用或已过期，请联系管理员', {
          errorCode: REDEEM_ACCOUNT_UNAVAILABLE_ERROR_CODE,
          accountId,
          accountEmail: banInfo?.accountEmail || accountEmail,
          reason
        })
      }
      console.warn('[Redemption] 账号状态预检查失败，忽略并继续兑换', {
        accountId,
        message: error?.message || String(error)
      })
    }
  }

  try {
    // 兑换时仅写入使用信息，不覆盖创建时的 order_type/service_days。
    const updates = [
      'is_redeemed = 1',
      "redeemed_at = DATETIME('now', 'localtime')",
      'redeemed_by = ?',
      "updated_at = DATETIME('now', 'localtime')",
    ]
    const updateParams = [redeemerIdentifier]

    if (fallbackFromCommonChannelAllowed && codeChannel !== requestedChannel) {
      const requestedChannelName = String(requestedChannelConfig?.name || '').trim() || requestedChannel
      updates.push('channel = ?')
      updates.push('channel_name = ?')
      updateParams.push(requestedChannel, requestedChannelName)
    }

    db.run(
      `UPDATE redemption_codes SET ${updates.join(', ')} WHERE id = ? AND is_redeemed = 0`,
      [...updateParams, codeId]
    )
    const rowsModified = typeof db.getRowsModified === 'function' ? db.getRowsModified() : null
    if (rowsModified === 0) {
      throw new RedemptionError(400, '该兑换码已被使用')
    }

    if (requestedChannelConfig?.redeemMode === 'linux-do' && normalizedRedeemerUid) {
      if (reservedForEntryId) {
        db.run(
          `
              UPDATE waiting_room_entries
              SET status = 'boarded',
                  boarded_at = DATETIME('now', 'localtime'),
                  updated_at = DATETIME('now', 'localtime')
              WHERE id = ?
            `,
          [reservedForEntryId]
        )
      } else {
        db.run(
          `
              UPDATE waiting_room_entries
              SET status = 'boarded',
                  boarded_at = DATETIME('now', 'localtime'),
                  updated_at = DATETIME('now', 'localtime')
              WHERE linuxdo_uid = ? AND status = 'waiting'
            `,
          [normalizedRedeemerUid]
        )
      }
    }

    saveDatabase()
  } catch (error) {
    if (error instanceof RedemptionError) {
      throw error
    }
    console.error('更新数据库时出错:', error)
    throw new RedemptionError(500, '兑换过程中出现错误，请重试')
  }

  let inviteResult = { success: false, message: '邀请功能未启用' }
  let syncedAccount = null
  let syncedUserCount = null
  let syncedInviteCount = null

  if (chatgptAccountId && accountToken) {
    try {
      const inviteResp = await inviteAccountUser(accountId, normalizedEmail, { suppressAlertEmail })
      inviteResult = { success: true, response: inviteResp.invite }
      console.log(`成功邀请用户 ${normalizedEmail} 加入账号 ${chatgptAccountId}`)
    } catch (error) {
      if (shouldMarkAccountUnavailable(error)) {
        const reason = `兑换邀请失败：${error?.message || '未知错误'}`
        try {
          db.run(
            `
              UPDATE redemption_codes
              SET is_redeemed = 0,
                  redeemed_at = NULL,
                  redeemed_by = NULL,
                  updated_at = DATETIME('now', 'localtime')
              WHERE id = ?
            `,
            [codeId]
          )
          saveDatabase()
        } catch (rollbackError) {
          console.warn('[Redemption] 回滚兑换码状态失败', {
            codeId,
            accountId,
            message: rollbackError?.message || String(rollbackError)
          })
        }

        const banInfo = await banAccountForRedemptionFlow({
          db,
          accountId,
          accountEmail,
          reason,
          alertCollector
        })
        throw new RedemptionError(503, '该兑换码绑定账号不可用或已过期，请联系管理员', {
          errorCode: REDEEM_ACCOUNT_UNAVAILABLE_ERROR_CODE,
          accountId,
          accountEmail: banInfo?.accountEmail || accountEmail,
          reason
        })
      }
      inviteResult = { success: false, error: error.message || '邀请失败' }
      console.error(`邀请用户 ${normalizedEmail} 失败:`, error.message)
    }

    const shouldVerifySecondSeatInvite =
      Number(preflightUserCount || 0) === 1 &&
      Number(preflightInviteCount || 0) === 0

    if (inviteResult.success && shouldVerifySecondSeatInvite) {
      try {
        const firstCheck = await syncInviteAndCheckPresence({
          accountId,
          inviteEmail: normalizedEmail,
          suppressAlertEmail
        })
        syncedAccount = firstCheck.account || syncedAccount
        if (typeof firstCheck.inviteCount === 'number') {
          syncedInviteCount = firstCheck.inviteCount
        }

        if (!firstCheck.isInvited) {
          let retryInviteSucceeded = false
          try {
            const retryResp = await inviteAccountUser(accountId, normalizedEmail, { suppressAlertEmail })
            inviteResult = { success: true, response: retryResp.invite, retried: true }
            retryInviteSucceeded = true
          } catch (retryError) {
            inviteResult = { success: false, error: retryError?.message || '二次邀请失败' }
            console.warn('[Redemption] 第二次邀请失败', {
              accountId,
              accountEmail,
              email: normalizedEmail,
              message: retryError?.message || String(retryError)
            })
          }

          if (retryInviteSucceeded) {
            const secondCheck = await syncInviteAndCheckPresence({
              accountId,
              inviteEmail: normalizedEmail,
              suppressAlertEmail
            })
            syncedAccount = secondCheck.account || syncedAccount
            if (typeof secondCheck.inviteCount === 'number') {
              syncedInviteCount = secondCheck.inviteCount
            }

            if (!secondCheck.isInvited) {
              const domain = extractEmailDomain(accountEmail)
              const reason = domain
                ? `第二人邀请两次后仍不在邀请列表，账号邮箱后缀 ${domain} 疑似被风控`
                : '第二人邀请两次后仍不在邀请列表，账号邮箱后缀缺失，无法自动域名处置'
              await rollbackRedeemedCodeUsage(db, codeId, { accountId })
              let domainRiskResult = {
                domain: domain || '',
                closedAccountCount: 0,
                deletedUnusedCodeCount: 0
              }
              if (domain) {
                domainRiskResult = await handleInviteDomainRiskBySuffix({
                  db,
                  domain,
                  triggerAccountId: accountId,
                  triggerAccountEmail: accountEmail,
                  reason
                })
              }
              throw new RedemptionError(503, '该账号邮箱后缀疑似被风控，已自动下架同后缀开放账号，请联系管理员', {
                errorCode: REDEEM_ACCOUNT_UNAVAILABLE_ERROR_CODE,
                accountId,
                accountEmail,
                domain: domainRiskResult.domain || null,
                closedAccountCount: Number(domainRiskResult.closedAccountCount || 0),
                deletedUnusedCodeCount: Number(domainRiskResult.deletedUnusedCodeCount || 0),
                reason
              })
            }
          }
        }
      } catch (error) {
        if (error instanceof RedemptionError) {
          throw error
        }
        console.warn('[Redemption] 第二人邀请校验异常，终止本次兑换', {
          accountId,
          accountEmail,
          message: error?.message || String(error)
        })
        throw new RedemptionError(503, '邀请校验异常，请稍后重试')
      }
    }

    if (inviteResult.success) {
      try {
        const userSync = await syncAccountUserCount(accountId, {
          userListParams: { offset: 0, limit: 1, query: '' },
          suppressAlertEmail
        })
        syncedAccount = userSync.account
        if (typeof userSync.syncedUserCount === 'number') {
          syncedUserCount = userSync.syncedUserCount
        }
      } catch (error) {
        console.warn('同步账号人数失败:', error)
      }

      try {
        const inviteSync = await syncAccountInviteCount(accountId, {
          inviteListParams: { offset: 0, limit: 1, query: '' },
          suppressAlertEmail
        })
        syncedAccount = inviteSync.account || syncedAccount
        if (typeof inviteSync.inviteCount === 'number') {
          syncedInviteCount = inviteSync.inviteCount
        }
      } catch (error) {
        console.warn('同步邀请数量失败:', error)
      }
    }
  } else {
    console.log(`账号 ${accountEmail} 缺少 ChatGPT 认证信息，跳过邀请步骤`)
  }

  const resolvedUserCount = typeof syncedAccount?.userCount === 'number'
    ? syncedAccount.userCount
    : typeof syncedUserCount === 'number'
      ? syncedUserCount
      : preflightUserCount
  const resolvedInviteCount = typeof syncedAccount?.inviteCount === 'number'
    ? syncedAccount.inviteCount
    : typeof syncedInviteCount === 'number'
      ? syncedInviteCount
      : null

  let ownerNotifyStatus = '未发送'
  let ownerNotifyMessage = '缺少账号邮箱，跳过通知'
  if (accountEmail) {
    try {
      const ownerMailSent = await sendRedemptionOwnerNotificationEmail({
        to: accountEmail,
        accountId,
        accountEmail,
        code: sanitizedCode,
        channel: requestedChannel,
        channelName: codeRecord.channelName || requestedChannelConfig?.name || requestedChannel,
        redeemerEmail: normalizedEmail,
        redeemerUid: normalizedRedeemerUid,
        inviteStatus: inviteResult.success ? '邀请已发送' : '邀请未发送（需要手动添加）',
        userCount: resolvedUserCount,
        inviteCount: resolvedInviteCount
      })
      ownerNotifyStatus = ownerMailSent ? '已发送' : '发送失败'
      ownerNotifyMessage = ownerMailSent
        ? '已通知兑换码所属账号邮箱'
        : 'SMTP 未配置或发送失败'
    } catch (error) {
      ownerNotifyStatus = '发送失败'
      ownerNotifyMessage = error?.message || '发送失败'
      console.warn('[Redemption] 账号通知邮件发送异常', {
        accountId,
        accountEmail,
        code: sanitizedCode,
        message: ownerNotifyMessage
      })
    }
  }

  return {
    data: {
      accountEmail: accountEmail,
      userCount: resolvedUserCount,
      inviteStatus: inviteResult.success ? '邀请已发送' : '邀请未发送（需要手动添加）',
      inviteDetails: inviteResult.success ? inviteResult.response : inviteResult.error,
      message: `您已成功加入 GPT team账号${inviteResult.success ? '，邀请邮件已发送至您的邮箱' : '，请联系管理员手动添加'}`,
      inviteCount: resolvedInviteCount,
      ownerNotifyStatus,
      ownerNotifyMessage
    },
    metadata: {
      codeId,
      code: sanitizedCode,
      requestedChannel,
      accountEmail,
      accountId
    }
  }
}

// 获取兑换码（支持可选分页）
router.get('/', authenticateToken, requireMenu('redemption_codes'), async (req, res) => {
  try {
    const db = await getDatabase()
    const { byKey: channelsByKey } = await getChannels(db)

    const paginated =
      req.query.page != null ||
      req.query.pageSize != null ||
      req.query.search != null ||
      req.query.status != null ||
      req.query.redeemedEmail != null ||
      req.query.redeemed_email != null

    if (!paginated) {
      const result = db.exec(`
        SELECT rc.id, rc.code, rc.is_redeemed, rc.redeemed_at, rc.redeemed_by,
               rc.account_email, rc.channel, rc.channel_name, rc.created_at, rc.updated_at,
               rc.reserved_for_uid, rc.reserved_for_username, rc.reserved_for_entry_id, rc.reserved_at,
               rc.reserved_for_order_no, rc.reserved_for_order_email, rc.order_type, rc.service_days,
               CASE
                 WHEN ga.id IS NULL THEN 0
                 ELSE COALESCE(ga.is_banned, 0)
               END AS account_is_banned
        FROM redemption_codes rc
        LEFT JOIN gpt_accounts ga
          ON LOWER(TRIM(ga.email)) = LOWER(TRIM(rc.account_email))
        ORDER BY rc.created_at DESC
      `)

      if (result.length === 0 || result[0].values.length === 0) {
        return res.json([])
      }

      return res.json(result[0].values.map(row => mapCodeRow(row, channelsByKey)))
    }

    const pageSizeMax = 200
    const pageSize = Math.min(pageSizeMax, Math.max(1, toInt(req.query.pageSize, 10)))
    const rawPage = Math.max(1, toInt(req.query.page, 1))
    const search = String(req.query.search || '').trim().toLowerCase()
    const status = String(req.query.status || 'all').trim().toLowerCase()
    const redeemedEmail = String(req.query.redeemedEmail ?? req.query.redeemed_email ?? '').trim().toLowerCase()

    const conditions = []
    const params = []

    if (status === 'redeemed') {
      conditions.push('rc.is_redeemed = 1')
    } else if (status === 'unused' || status === 'unredeemed') {
      conditions.push('rc.is_redeemed = 0')
    }

    if (search) {
      const keyword = `%${search}%`
      conditions.push(
        `
          (
            LOWER(rc.code) LIKE ?
            OR LOWER(COALESCE(rc.account_email, '')) LIKE ?
            OR LOWER(COALESCE(rc.redeemed_by, '')) LIKE ?
            OR LOWER(COALESCE(rc.reserved_for_username, '')) LIKE ?
            OR LOWER(COALESCE(rc.channel, '')) LIKE ?
            OR LOWER(COALESCE(rc.channel_name, '')) LIKE ?
          )
        `.trim()
      )
      params.push(keyword, keyword, keyword, keyword, keyword, keyword)
    }

    if (redeemedEmail) {
      const keyword = `%${redeemedEmail}%`
      conditions.push('LOWER(COALESCE(rc.redeemed_by, \'\')) LIKE ?')
      params.push(keyword)
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

    const countResult = db.exec(
      `
        SELECT COUNT(*)
        FROM redemption_codes rc
        ${whereClause}
      `,
      params
    )
    const total = Number(countResult[0]?.values?.[0]?.[0] || 0)
    const totalPages = Math.max(1, Math.ceil(total / pageSize))
    const page = total > 0 ? Math.min(rawPage, totalPages) : 1
    const offset = (page - 1) * pageSize

    const dataResult = db.exec(
      `
        SELECT rc.id, rc.code, rc.is_redeemed, rc.redeemed_at, rc.redeemed_by,
               rc.account_email, rc.channel, rc.channel_name, rc.created_at, rc.updated_at,
               rc.reserved_for_uid, rc.reserved_for_username, rc.reserved_for_entry_id, rc.reserved_at,
               rc.reserved_for_order_no, rc.reserved_for_order_email, rc.order_type, rc.service_days,
               CASE
                 WHEN ga.id IS NULL THEN 0
                 ELSE COALESCE(ga.is_banned, 0)
               END AS account_is_banned
        FROM redemption_codes rc
        LEFT JOIN gpt_accounts ga
          ON LOWER(TRIM(ga.email)) = LOWER(TRIM(rc.account_email))
        ${whereClause}
        ORDER BY rc.created_at DESC
        LIMIT ? OFFSET ?
      `,
      [...params, pageSize, offset]
    )
    const codes = (dataResult[0]?.values || []).map(row => mapCodeRow(row, channelsByKey))

    return res.json({
      codes,
      pagination: {
        page,
        pageSize,
        total
      }
    })
  } catch (error) {
    console.error('获取兑换码错误:', error)
    res.status(500).json({ error: '内部服务器错误' })
  }
})

router.post('/:id/reinvite', authenticateToken, requireMenu('redemption_codes'), async (req, res) => {
  try {
    const codeId = toInt(req.params.id, 0)
    if (!codeId) {
      return res.status(400).json({ error: '无效的兑换码 ID' })
    }

    return await withLocks([`redemption-code:reinvite:${codeId}`], async () => {
      const db = await getDatabase()
      const result = db.exec(
        `
          SELECT id, code, is_redeemed, redeemed_by, account_email, channel
          FROM redemption_codes
          WHERE id = ?
          LIMIT 1
        `,
        [codeId]
      )

      if (result.length === 0 || result[0].values.length === 0) {
        return res.status(404).json({ error: '兑换码不存在' })
      }

      const row = result[0].values[0]
      const isRedeemed = row[2] === 1
      const redeemedBy = row[3]
      const accountEmail = row[4]

      if (!isRedeemed) {
        return res.status(400).json({ error: '该兑换码尚未使用，无法重新邀请' })
      }

      const inviteEmail = extractEmailFromRedeemedBy(redeemedBy)
      if (!inviteEmail) {
        return res.status(400).json({ error: '兑换用户邮箱缺失，无法重新邀请' })
      }

      if (!accountEmail) {
        return res.status(400).json({ error: '该兑换码未绑定账号，无法重新邀请' })
      }

      const accountResult = db.exec(
        `
          SELECT id, email, token, chatgpt_account_id, oai_device_id
          FROM gpt_accounts
          WHERE lower(email) = ?
          LIMIT 1
        `,
        [normalizeEmail(accountEmail)]
      )

      if (accountResult.length === 0 || accountResult[0].values.length === 0) {
        return res.status(404).json({ error: '所属账号不存在，无法重新邀请' })
      }

      const accountRow = accountResult[0].values[0]
      const targetAccountId = Number(accountRow[0])
      const token = accountRow[2]
      const chatgptAccountId = accountRow[3]
      const oaiDeviceId = accountRow[4]

      if (!token || !chatgptAccountId) {
        return res.status(400).json({ error: '所属账号缺少 token 或 chatgpt_account_id，无法重新邀请' })
      }

      let inviteResult
      try {
        const inviteResp = await inviteAccountUser(targetAccountId, inviteEmail)
        inviteResult = { success: true, response: inviteResp.invite }
      } catch (error) {
        inviteResult = { success: false, error: error.message || '重新邀请失败' }
      }

      if (!inviteResult.success) {
        return res.status(503).json({ error: inviteResult.error })
      }

      return res.json({ message: '重新邀请已发送' })
    })
  } catch (error) {
    console.error('重新邀请失败:', error)
    res.status(500).json({ error: '内部服务器错误' })
  }
})

// 批量创建兑换码
router.post('/batch', authenticateToken, requireMenu('redemption_codes'), async (req, res) => {
  try {
    const { count, accountEmail, channel, orderType, serviceDays } = req.body
    const requestedCount = Number.parseInt(String(count ?? ''), 10)
    const db = await getDatabase()
    const redemptionSettings = getRedemptionCodeSettings(db)
    const batchCreateMaxCount = redemptionSettings.batchCreateMaxCount

    if (!Number.isFinite(requestedCount) || requestedCount < 1 || requestedCount > batchCreateMaxCount) {
      return res.status(400).json({ error: `数量必须在 1-${batchCreateMaxCount} 之间` })
    }

    // 必须指定账号
    if (!accountEmail) {
      return res.status(400).json({ error: '必须指定所属账号邮箱' })
    }
    const normalizedAccountEmail = normalizeEmail(accountEmail)

    const rawOrderType = orderType == null ? '' : String(orderType).trim().toLowerCase()
    const resolvedOrderType = rawOrderType ? normalizeOrderType(rawOrderType) : ORDER_TYPE_WARRANTY
    if (rawOrderType && resolvedOrderType !== rawOrderType) {
      return res.status(400).json({ error: 'orderType 不合法（仅支持 warranty/no_warranty/anti_ban）' })
    }

    const hasServiceDaysInput = serviceDays !== undefined && serviceDays !== null && String(serviceDays).trim() !== ''
    if (resolvedOrderType === ORDER_TYPE_WARRANTY && !hasServiceDaysInput) {
      return res.status(400).json({ error: 'warranty 订单必须设置 serviceDays（1-3650）' })
    }

    let resolvedServiceDays = null
    if (resolvedOrderType !== ORDER_TYPE_NO_WARRANTY && hasServiceDaysInput) {
      const parsedServiceDays = Number.parseInt(String(serviceDays), 10)
      if (!Number.isFinite(parsedServiceDays) || parsedServiceDays < 1 || parsedServiceDays > 3650) {
        return res.status(400).json({ error: 'serviceDays 不合法（必须为 1-3650 的整数）' })
      }
      resolvedServiceDays = parsedServiceDays
    }

    const { byKey: channelsByKey } = await getChannels(db, { forceRefresh: true })

    // 检查账号是否存在并获取当前人数
    const accountResult = db.exec(`
      SELECT
        id,
        email,
        COALESCE(user_count, 0) AS user_count,
        COALESCE(invite_count, 0) AS invite_count,
        expire_at
      FROM gpt_accounts
      WHERE lower(trim(email)) = ?
      LIMIT 1
    `, [normalizedAccountEmail])

    if (accountResult.length === 0 || accountResult[0].values.length === 0) {
      return res.status(404).json({ error: '指定的账号不存在' })
    }

    const accountRow = accountResult[0].values[0]
    const accountRecordEmail = String(accountRow[1] || normalizedAccountEmail)
    const currentUserCount = Number(accountRow[2] || 0)
    const inviteCount = Number(accountRow[3] || 0)
    const currentOccupiedSeats = currentUserCount + inviteCount
    const expireAt = accountRow[4]
    const capacityLimit = getOpenAccountsCapacityLimit(db)

    if (expireAt) {
      const expireMs = parseExpireAtToMs(expireAt)
      if (expireMs != null && expireMs < Date.now()) {
        return res.status(400).json({ error: '该账号已过期，无法创建兑换码' })
      }
    }

    if (currentOccupiedSeats >= capacityLimit) {
      return res.status(400).json({
        error: `该账号已满员（${capacityLimit}人），无法创建兑换码`,
        currentUserCount,
        inviteCount,
        capacityLimit
      })
    }

    // 获取该账号未使用的兑换码数量
    const unusedCodesResult = db.exec(`
      SELECT COUNT(*) as count FROM redemption_codes
      WHERE lower(trim(account_email)) = ? AND is_redeemed = 0
    `, [normalizedAccountEmail])

    const unusedCodesCount = unusedCodesResult[0]?.values[0]?.[0] || 0

    // 可创建数量 = 总容量 - 已占用名额(用户+邀请) - 未使用兑换码
    const availableSlots = capacityLimit - currentOccupiedSeats - unusedCodesCount

    if (availableSlots <= 0) {
      return res.status(400).json({
        error: '该账号已无可用名额（当前人数 + 未使用兑换码数已达上限）',
        currentUserCount,
        inviteCount,
        unusedCodesCount,
        allCodesCount: unusedCodesCount, // 兼容旧前端字段
        capacityLimit,
        availableSlots: 0
      })
    }

    const actualCount = Math.min(requestedCount, availableSlots)

    // 如果请求数量超过可用名额，给出详细提示
    if (requestedCount > availableSlots) {
      console.log(`请求生成${requestedCount}个兑换码，但账号只有${availableSlots}个可用名额（容量${capacityLimit}，已占用${currentOccupiedSeats}，已有${unusedCodesCount}个未使用兑换码），将只生成${actualCount}个`)
    }

    const normalizedChannel = normalizeChannel(channel, 'common')
    const channelConfig = channelsByKey.get(normalizedChannel) || null
    if (!channelConfig || !channelConfig.isActive) {
      return res.status(400).json({ error: '渠道不存在或已停用' })
    }
    const resolvedChannelName = String(channelConfig.name || '').trim() || normalizedChannel

    const createdCodes = []
    const failedCodes = []

    for (let i = 0; i < actualCount; i++) {
      let code = generateRedemptionCode()
      let attempts = 0
      let success = false

      // 尝试生成唯一的兑换码（最多重试4次）
      while (attempts < 4 && !success) {
        try {
          db.run(
            `INSERT INTO redemption_codes (code, account_email, channel, channel_name, order_type, service_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))`,
            [code, normalizedAccountEmail, normalizedChannel, resolvedChannelName, resolvedOrderType, resolvedServiceDays]
          )
          createdCodes.push(code)
          success = true
        } catch (err) {
          if (err.message.includes('UNIQUE')) {
            // 如果重复，重新生成
            code = generateRedemptionCode()
            attempts++
          } else {
            throw err
          }
        }
      }

      if (!success) {
        failedCodes.push(`尝试${attempts}次后仍然重复`)
      }
    }

    saveDatabase()

    if (createdCodes.length === 0) {
      return res.status(201).json({
        message: `未成功创建兑换码（账号 ${accountRecordEmail}）`,
        codes: [],
        failed: failedCodes.length,
        currentUserCount,
        inviteCount,
        capacityLimit,
        occupiedSeats: currentOccupiedSeats,
        unusedCodesCount,
        allCodesCount: unusedCodesCount, // 兼容旧前端字段
        availableSlots,
        info: '兑换码生成连续冲突，请重试'
      })
    }

    // 获取新创建的兑换码
    const result = db.exec(`
      SELECT id, code, is_redeemed, redeemed_at, redeemed_by,
             account_email, channel, channel_name, created_at, updated_at,
             reserved_for_uid, reserved_for_username, reserved_for_entry_id, reserved_at,
             reserved_for_order_no, reserved_for_order_email, order_type, service_days
      FROM redemption_codes
      WHERE code IN (${createdCodes.map(() => '?').join(',')})
      ORDER BY created_at DESC
    `, createdCodes)

    const codes = result[0]?.values.map(row => mapCodeRow(row, channelsByKey)) || []

    res.status(201).json({
      message: `成功为账号 ${accountRecordEmail} 创建 ${createdCodes.length} 个兑换码`,
      codes,
      failed: failedCodes.length,
      currentUserCount,
      inviteCount,
      capacityLimit,
      occupiedSeats: currentOccupiedSeats,
      unusedCodesCount: unusedCodesCount + createdCodes.length,
      allCodesCount: unusedCodesCount + createdCodes.length, // 兼容旧前端字段
      availableSlots: availableSlots - createdCodes.length,
      info: requestedCount > availableSlots ? `由于账号可用名额限制（容量${capacityLimit}，已占用${currentOccupiedSeats}，未使用兑换码${unusedCodesCount}），只生成了${actualCount}个兑换码` : undefined
    })
  } catch (error) {
    console.error('批量创建兑换码错误:', error)
    res.status(500).json({ error: '内部服务器错误' })
  }
})

// 删除兑换码
router.delete('/:id', authenticateToken, requireMenu('redemption_codes'), async (req, res) => {
  try {
    const db = await getDatabase()

    // 检查兑换码是否存在
    const checkResult = db.exec('SELECT id FROM redemption_codes WHERE id = ?', [req.params.id])
    if (checkResult.length === 0 || checkResult[0].values.length === 0) {
      return res.status(404).json({ error: '兑换码不存在' })
    }

    db.run('DELETE FROM redemption_codes WHERE id = ?', [req.params.id])
    saveDatabase()

    res.json({ message: '兑换码删除成功' })
  } catch (error) {
    console.error('删除兑换码错误:', error)
    res.status(500).json({ error: '内部服务器错误' })
  }
})

// 更新兑换码渠道
router.patch('/:id/channel', authenticateToken, requireMenu('redemption_codes'), async (req, res) => {
  try {
    const { channel } = req.body

    if (!channel) {
      return res.status(400).json({ error: '请选择要更新的渠道' })
    }

    const db = await getDatabase()
    const { byKey: channelsByKey } = await getChannels(db)
    const normalizedChannel = normalizeChannel(channel, 'common')
    const channelConfig = channelsByKey.get(normalizedChannel) || null
    if (!channelConfig || !channelConfig.isActive) {
      return res.status(400).json({ error: '渠道不存在或已停用' })
    }
    const channelName = String(channelConfig.name || '').trim() || normalizedChannel
    const checkResult = db.exec('SELECT id FROM redemption_codes WHERE id = ?', [req.params.id])
    if (checkResult.length === 0 || checkResult[0].values.length === 0) {
      return res.status(404).json({ error: '兑换码不存在' })
    }

    db.run(
      `UPDATE redemption_codes SET channel = ?, channel_name = ?, updated_at = DATETIME('now', 'localtime') WHERE id = ?`,
      [normalizedChannel, channelName, req.params.id]
    )
    saveDatabase()

    const updatedResult = db.exec(`
      SELECT id, code, is_redeemed, redeemed_at, redeemed_by,
             account_email, channel, channel_name, created_at, updated_at,
             reserved_for_uid, reserved_for_username, reserved_for_entry_id, reserved_at,
             reserved_for_order_no, reserved_for_order_email, order_type
      FROM redemption_codes
      WHERE id = ?
    `, [req.params.id])

    const updatedCode = updatedResult.length > 0 && updatedResult[0].values.length > 0
      ? mapCodeRow(updatedResult[0].values[0], channelsByKey)
      : null

    res.json({
      message: '渠道已更新',
      code: updatedCode
    })
  } catch (error) {
    console.error('更新兑换码渠道失败:', error)
    res.status(500).json({ error: '内部服务器错误' })
  }
})

// 批量删除兑换码
router.post('/batch-delete', authenticateToken, requireMenu('redemption_codes'), async (req, res) => {
  try {
    const { ids } = req.body

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: '请提供要删除的兑换码ID数组' })
    }

    const db = await getDatabase()
    const placeholders = ids.map(() => '?').join(',')

    db.run(`DELETE FROM redemption_codes WHERE id IN (${placeholders})`, ids)
    saveDatabase()

    res.json({ message: `成功删除 ${ids.length} 个兑换码` })
  } catch (error) {
    console.error('批量删除兑换码错误:', error)
    res.status(500).json({ error: '内部服务器错误' })
  }
})

// 管理后台兑换（需要认证）
router.post('/admin/redeem', authenticateToken, requireMenu('redemption_codes'), async (req, res) => {
  const alertCollector = createRedemptionAlertCollector('admin-redeem')
  try {
    const { code, email, channel, redeemerUid, orderType, order_type: orderTypeLegacy } = req.body || {}
    if (orderType !== undefined || orderTypeLegacy !== undefined) {
      return res.status(400).json({
        error: 'orderType 参数已弃用',
        message: '兑换时不允许传 orderType，系统将以兑换码创建时配置为准'
      })
    }

    const result = await redeemCodeInternal({
      code,
      email,
      channel,
      redeemerUid,
      alertCollector
    })
    const db = await getDatabase()
    await collectLowStockAlerts(db, alertCollector)
    res.json({
      message: '兑换成功',
      data: result.data
    })
  } catch (error) {
    if (error instanceof RedemptionError) {
      return res.status(error.statusCode || 400).json({
        error: error.message,
        message: error.message,
        ...(error.payload || {})
      })
    }
    console.error('管理后台兑换错误:', error)
    res.status(500).json({
      error: '内部服务器错误',
      message: '服务器错误，请稍后重试'
    })
  } finally {
    try {
      await flushRedemptionAlertCollector(alertCollector)
    } catch (mailError) {
      console.warn('[Redemption] 汇总告警发送失败', mailError?.message || mailError)
    }
  }
})

// 兑换接口（无需认证）
router.post('/redeem', async (req, res) => {
  const alertCollector = createRedemptionAlertCollector('public-redeem')
  try {
    const { code, email, channel, orderType, order_type: orderTypeLegacy } = req.body || {}
    if (orderType !== undefined || orderTypeLegacy !== undefined) {
      return res.status(400).json({
        error: 'orderType 参数已弃用',
        message: '兑换时不允许传 orderType，系统将以兑换码创建时配置为准'
      })
    }

    const normalizedChannel = normalizeChannel(channel, 'common')

    let redeemerUid = req.body?.redeemerUid
    if (normalizedChannel === 'linux-do') {
      const decoded = verifyLinuxDoSessionToken(req.headers['x-linuxdo-token'])
      const uid = decoded?.uid ? String(decoded.uid).trim() : ''
      if (!uid) {
        return res.status(401).json({ error: '缺少 Linux DO session token', code: 'LINUXDO_SESSION_REQUIRED' })
      }
      redeemerUid = uid
    }

    const result = await redeemCodeInternal({
      code,
      email,
      channel: normalizedChannel,
      redeemerUid,
      allowCommonChannelFallback: true,
      alertCollector
    })
    const db = await getDatabase()
    await collectLowStockAlerts(db, alertCollector)
    res.json({
      message: '兑换成功',
      data: result.data
    })
  } catch (error) {
    if (error instanceof RedemptionError) {
      return res.status(error.statusCode || 400).json({
        error: error.message,
        message: error.message,
        ...(error.payload || {})
      })
    }
    console.error('兑换错误:', error)
    res.status(500).json({
      error: '内部服务器错误',
      message: '服务器错误，请稍后重试'
    })
  } finally {
    try {
      await flushRedemptionAlertCollector(alertCollector)
    } catch (mailError) {
      console.warn('[Redemption] 汇总告警发送失败', mailError?.message || mailError)
    }
  }
})

// 账号补录（无需认证）
router.post('/recover', async (req, res) => {
  try {
    const normalizedEmail = normalizeEmail(req.body?.email)
    if (!normalizedEmail) {
      return res.status(400).json({ error: '请输入邮箱地址', message: '请输入邮箱地址' })
    }

    if (!EMAIL_REGEX.test(normalizedEmail)) {
      return res.status(400).json({ error: '请输入有效的邮箱地址', message: '请输入有效的邮箱地址' })
    }

    return await withLocks([`account-recovery:${normalizedEmail}`], async () => {
      const db = await getDatabase()
      const emailPattern = `%email:${normalizedEmail}%`

      const accountRecoveryWindowDays = getAccountRecoveryWindowDays()
      const threshold = `-${accountRecoveryWindowDays} days`
      const candidatesResult = db.exec(
        `
          WITH candidates AS (
            SELECT
              rc.id AS original_code_id,
              rc.redeemed_at AS original_redeemed_at,
              rc.redeemed_by AS original_redeemed_by,
              rc.account_email AS original_account_email,
              rc.channel AS original_channel,
              COALESCE(
                NULLIF(rc.order_type, ''),
                NULLIF((
                  SELECT po2.order_type
                  FROM purchase_orders po2
                  WHERE (po2.code_id = rc.id OR (po2.code_id IS NULL AND po2.code = rc.code))
                  ORDER BY po2.created_at DESC
                  LIMIT 1
                ), ''),
                'warranty'
              ) AS order_type,
              (
                SELECT po3.status
                FROM purchase_orders po3
                WHERE (po3.code_id = rc.id OR (po3.code_id IS NULL AND po3.code = rc.code))
                ORDER BY po3.created_at DESC
                LIMIT 1
              ) AS purchase_order_status,
              (
                SELECT po4.refunded_at
                FROM purchase_orders po4
                WHERE (po4.code_id = rc.id OR (po4.code_id IS NULL AND po4.code = rc.code))
                ORDER BY po4.created_at DESC
                LIMIT 1
              ) AS purchase_order_refunded_at,
              (
                SELECT ar.recovery_account_email
                FROM account_recovery_logs ar
                WHERE ar.original_code_id = rc.id
                  AND ar.status IN ('success', 'skipped')
                ORDER BY ar.id DESC
                LIMIT 1
              ) AS last_completed_recovery_account_email,
              (
                SELECT COUNT(1)
                FROM account_recovery_logs ar2
                WHERE ar2.original_code_id = rc.id
              ) AS attempts,
              co.status AS credit_order_status,
              co.refunded_at AS credit_order_refunded_at
            FROM redemption_codes rc
            LEFT JOIN credit_orders co
              ON co.order_no = rc.reserved_for_order_no
              AND co.scene = 'open_accounts_board'
            LEFT JOIN account_recovery_logs ar_recovery
              ON ar_recovery.recovery_code_id = rc.id
              AND ar_recovery.status IN ('success', 'skipped')
            WHERE rc.is_redeemed = 1
              AND rc.redeemed_at IS NOT NULL
              AND rc.redeemed_at >= DATETIME('now', 'localtime', ?)
              AND ar_recovery.id IS NULL
              AND (
                lower(trim(rc.redeemed_by)) = ?
                OR lower(trim(rc.redeemed_by)) LIKE ?
              )
          ),
          candidates_with_current AS (
            SELECT
              c.*,
              COALESCE(
                NULLIF(lower(trim(c.last_completed_recovery_account_email)), ''),
                lower(trim(c.original_account_email))
              ) AS current_account_email
            FROM candidates c
          )
          SELECT
            cw.original_code_id,
            cw.original_redeemed_at,
            cw.original_redeemed_by,
            cw.original_account_email,
            cw.original_channel,
            cw.order_type,
            cw.purchase_order_status,
            cw.purchase_order_refunded_at,
            cw.last_completed_recovery_account_email,
            cw.attempts,
            cw.current_account_email,
            ga.id AS current_account_id,
            ga.email AS current_account_record_email,
            COALESCE(ga.is_banned, 0) AS current_is_banned,
            cw.credit_order_status,
            cw.credit_order_refunded_at
          FROM candidates_with_current cw
          LEFT JOIN gpt_accounts ga ON lower(trim(ga.email)) = cw.current_account_email
          ORDER BY cw.original_redeemed_at ASC, cw.original_code_id ASC
        `,
        [threshold, normalizedEmail, emailPattern]
      )

      const candidateRows = candidatesResult[0]?.values || []
      if (candidateRows.length === 0) {
        return res.status(404).json({
          error: `${accountRecoveryWindowDays}天内不存在订单，请联系客服`,
          message: `${accountRecoveryWindowDays}天内不存在订单，请联系客服`,
          code: 'NO_RECENT_ORDER'
        })
      }

      const candidates = candidateRows.map(row => ({
        originalCodeId: Number(row[0]),
        originalRedeemedAt: row[1] ? String(row[1]) : null,
        originalRedeemedBy: row[2] ? String(row[2]) : null,
        originalAccountEmail: row[3] ? String(row[3]) : null,
        originalChannel: row[4] ? String(row[4]) : null,
        orderType: row[5] ? String(row[5]) : null,
        purchaseOrderStatus: row[6] ? String(row[6]) : null,
        purchaseOrderRefundedAt: row[7] ? String(row[7]) : null,
        lastCompletedRecoveryAccountEmail: row[8] ? String(row[8]) : null,
        attempts: Number(row[9] || 0),
        currentAccountEmail: row[10] ? String(row[10]) : '',
        currentAccountId: row[11] != null ? Number(row[11]) : null,
        currentAccountRecordEmail: row[12] ? String(row[12]) : null,
        currentIsBanned: Number(row[13] || 0) === 1,
        creditOrderStatus: row[14] ? String(row[14]) : null,
        creditOrderRefundedAt: row[15] ? String(row[15]) : null
      }))

      const eligibleCandidates = candidates.filter(candidate => !isNoWarrantyOrderType(candidate.orderType))

      if (eligibleCandidates.length === 0) {
        return res.status(403).json({
          error: '无质保订单不支持补号',
          message: '无质保订单不支持补号',
          code: 'NO_WARRANTY_ORDER'
        })
      }

      const refundableCandidates = eligibleCandidates.filter(candidate => {
        if (candidate.creditOrderRefundedAt) return false
        const creditStatus = String(candidate.creditOrderStatus || '').trim().toLowerCase()
        if (creditStatus === 'refunded') return false

        if (candidate.purchaseOrderRefundedAt) return false
        const purchaseStatus = String(candidate.purchaseOrderStatus || '').trim().toLowerCase()
        if (purchaseStatus === 'refunded') return false

        return true
      })

      if (refundableCandidates.length === 0) {
        const firstCandidate = eligibleCandidates[0]
        const windowEndsAt = buildRecoveryWindowEndsAt(firstCandidate.originalRedeemedAt)
        return res.status(403).json({
          error: '订单已退款，无法补录，请联系客服',
          message: '订单已退款，无法补录，请联系客服',
          code: 'ORDER_REFUNDED',
          processedOriginalCodeId: firstCandidate.originalCodeId,
          processedOriginalRedeemedAt: firstCandidate.originalRedeemedAt,
          processedReason: 'order_refunded',
          windowEndsAt
        })
      }

	      const firstCandidate = refundableCandidates[0]
	      let targetCandidate = refundableCandidates.find(candidate => candidate.currentIsBanned) || null
	      let processedReason = targetCandidate ? 'banned' : ''

	      const accessCache = new Map()
	      let unknownSyncError = null

      if (!targetCandidate) {
        for (const candidate of refundableCandidates) {
	          const accountId = candidate.currentAccountId
	          if (!candidate.currentAccountEmail || !accountId) {
	            targetCandidate = candidate
	            processedReason = 'missing_account'
	            break
	          }

	          let cached = accessCache.get(accountId)
	          if (!cached) {
	            const globalCached = getAccountRecoveryAccessCache(accountId)
	            if (globalCached) {
	              cached = globalCached
	              accessCache.set(accountId, globalCached)
	            }
	          }
	          if (cached?.status === 'accessible') continue
	          if (cached?.status === 'access_failure') {
	            targetCandidate = candidate
	            processedReason = 'access_failure'
	            break
	          }
	          if (cached?.status === 'unknown') {
	            if (!unknownSyncError) {
	              unknownSyncError = { error: cached.error, statusCode: cached.statusCode, candidate }
	            }
	            continue
	          }

	          try {
	            const usersData = await fetchAccountUsersList(accountId, {
	              userListParams: { offset: 0, limit: 1, query: '' }
	            })
	            const userCount = typeof usersData?.total === 'number' ? usersData.total : null
	            const entry = { status: 'accessible', userCount }
	            accessCache.set(accountId, entry)
	            setAccountRecoveryAccessCache(accountId, entry)
	          } catch (error) {
	            if (isAccountAccessFailure(error)) {
	              const entry = { status: 'access_failure' }
	              accessCache.set(accountId, { ...entry, error })
	              setAccountRecoveryAccessCache(accountId, entry)
	              targetCandidate = candidate
	              processedReason = 'access_failure'
	              break
	            }
	            const statusCode = Number(error?.status ?? error?.statusCode) || 503
	            accessCache.set(accountId, { status: 'unknown', error, statusCode })
	            if (!unknownSyncError) {
	              unknownSyncError = { error, statusCode, candidate }
	            }
	          }
	        }
	      }

      if (!targetCandidate) {
        if (unknownSyncError) {
          const candidate = unknownSyncError.candidate || firstCandidate
          const windowEndsAt = buildRecoveryWindowEndsAt(candidate.originalRedeemedAt)
          const status = Number(unknownSyncError.statusCode) || 503
          const message = unknownSyncError.error?.message || '账号同步失败，请稍后再试'

          recordAccountRecovery(db, {
            email: normalizedEmail,
            originalCodeId: candidate.originalCodeId,
            originalRedeemedAt: candidate.originalRedeemedAt,
            originalAccountEmail: candidate.originalAccountEmail,
            recoveryMode: 'original',
            recoveryAccountEmail: candidate.currentAccountRecordEmail || candidate.currentAccountEmail,
            status: 'failed',
            errorMessage: unknownSyncError.error?.message || '账号同步失败'
          })
          saveDatabase()

          return res.status(status).json({
            error: message,
            message,
            processedOriginalCodeId: candidate.originalCodeId,
            processedOriginalRedeemedAt: candidate.originalRedeemedAt,
            processedReason: 'sync_error',
            windowEndsAt
          })
        }

        const windowEndsAt = buildRecoveryWindowEndsAt(firstCandidate.originalRedeemedAt)
        const accountEmail = firstCandidate.currentAccountRecordEmail || firstCandidate.currentAccountEmail
        const cachedAccess = firstCandidate.currentAccountId ? accessCache.get(firstCandidate.currentAccountId) : null
        const userCount = cachedAccess?.status === 'accessible' ? cachedAccess.userCount ?? null : null

        recordAccountRecovery(db, {
          email: normalizedEmail,
          originalCodeId: firstCandidate.originalCodeId,
          originalRedeemedAt: firstCandidate.originalRedeemedAt,
          originalAccountEmail: firstCandidate.originalAccountEmail,
          recoveryMode: 'not-needed',
          recoveryAccountEmail: accountEmail,
          status: 'skipped',
          errorMessage: 'account_accessible'
        })
        saveDatabase()

        return res.json({
          message: '当前工作空间仍可访问，无需补录',
          data: {
            accountEmail,
            userCount,
            recoveryMode: 'not-needed',
            windowEndsAt,
            processedOriginalCodeId: firstCandidate.originalCodeId,
            processedOriginalRedeemedAt: firstCandidate.originalRedeemedAt,
            processedReason: 'all_accessible'
          }
        })
      }

      const originalCodeId = targetCandidate.originalCodeId
      const redeemedAt = targetCandidate.originalRedeemedAt
      const originalAccountEmail = targetCandidate.originalAccountEmail
      const windowEndsAt = buildRecoveryWindowEndsAt(redeemedAt)

      return await withLocks([`account-recovery:original:${originalCodeId}`], async () => {
        const completedResult = db.exec(
          `
            SELECT status, recovery_account_email
            FROM account_recovery_logs
            WHERE original_code_id = ?
              AND status IN ('success', 'skipped')
            ORDER BY id DESC
            LIMIT 1
          `,
          [originalCodeId]
        )
        const completedRow = completedResult[0]?.values?.[0]
        const completedStatus = completedRow?.[0] ? String(completedRow[0]).trim().toLowerCase() : ''
        const completedAccountEmail = completedRow?.[1] ? normalizeEmail(completedRow[1]) : ''
        const completedAccountForCheck = completedAccountEmail
          || targetCandidate.currentAccountRecordEmail
          || targetCandidate.currentAccountEmail

        if (completedStatus && completedAccountForCheck) {
          const accountStateResult = db.exec(
            `
              SELECT COALESCE(is_banned, 0) AS is_banned,
                     COALESCE(user_count, 0) AS user_count,
                     COALESCE(invite_count, 0) AS invite_count
              FROM gpt_accounts
              WHERE lower(trim(email)) = ?
              LIMIT 1
            `,
            [completedAccountForCheck]
          )
          const accountStateRow = accountStateResult[0]?.values?.[0]
          const currentIsBanned = accountStateRow ? Number(accountStateRow[0] || 0) === 1 : null
          const currentUserCount = accountStateRow ? Number(accountStateRow[1] || 0) : null
          const currentInviteCount = accountStateRow ? Number(accountStateRow[2] || 0) : null

          if (completedStatus === 'skipped') {
            return res.json({
              message: '当前工作空间仍可访问，无需补录',
              data: {
                accountEmail: completedAccountForCheck,
                userCount: currentUserCount,
                inviteCount: currentInviteCount,
                recoveryMode: 'not-needed',
                windowEndsAt,
                processedOriginalCodeId: originalCodeId,
                processedOriginalRedeemedAt: redeemedAt,
                processedReason: 'already_skipped'
              }
            })
          }

          if (completedStatus === 'success' && currentIsBanned === false) {
            return res.json({
              message: '补录已完成，请检查邮箱邀请',
              data: {
                accountEmail: completedAccountForCheck,
                userCount: currentUserCount,
                inviteCount: currentInviteCount,
                recoveryMode: 'already-done',
                windowEndsAt,
                processedOriginalCodeId: originalCodeId,
                processedOriginalRedeemedAt: redeemedAt,
                processedReason: 'already_recovered'
              }
            })
          }
        }

        const orderDeadlineMs = resolveOrderDeadlineMs(db, {
          originalCodeId,
          redeemedAt,
          orderType: targetCandidate.orderType
        })

        // 补录账号池（统一规则）：
        // - 只取开放账号（is_open=1）
        // - 严格模式下优先非当日（按 gpt_accounts.created_at 判断）
        // - 只用通用渠道兑换码（rc.channel 为空或 common）
        // - 账号 expire_at 需未过期；在系统设置开启“过期覆盖订单截止日”时，还要求覆盖订单截止日
        // - 兑换码创建时间窗口由系统设置控制（默认近 7 天；可选强制仅当天）
        const recoverySettings = await getAccountRecoverySettings(db)
        const recoveryCapacityLimit = getOpenAccountsCapacityLimit(db)
        const codeCreatedWithinDays = Math.max(1, toInt(recoverySettings?.effective?.codeCreatedWithinDays, 7))
        const requireExpireCoverDeadline = Boolean(recoverySettings?.effective?.requireExpireCoverDeadline)
        const skipCodeFormatValidation = false
        const triedRecoveryCodeIds = new Set()
        let lastAttemptError = null
        let lastAttemptRecovery = null

        const recoveryRedeemMaxAttempts = getAccountRecoveryRedeemMaxAttempts()
        for (let attempt = 1; attempt <= recoveryRedeemMaxAttempts; attempt += 1) {
          const selectedRecovery = selectRecoveryCode(db, {
            minExpireMs: requireExpireCoverDeadline ? orderDeadlineMs : Date.now(),
            capacityLimit: recoveryCapacityLimit,
            preferNonToday: requireExpireCoverDeadline,
            preferLatestExpire: !requireExpireCoverDeadline,
            limit: 200,
            codeCreatedWithinDays,
            excludeCodeIds: Array.from(triedRecoveryCodeIds)
          })

          if (!selectedRecovery) break

          lastAttemptRecovery = selectedRecovery
          triedRecoveryCodeIds.add(selectedRecovery.recoveryCodeId)

          const recoveryCodeId = selectedRecovery.recoveryCodeId
          const recoveryCode = selectedRecovery.recoveryCode
          const recoveryChannel = selectedRecovery.recoveryChannel || 'common'
          const recoveryAccountEmail = selectedRecovery.recoveryAccountEmail

          try {
            const redemptionResult = await redeemCodeInternal({
              code: recoveryCode,
              email: normalizedEmail,
              channel: recoveryChannel || 'common',
              skipCodeFormatValidation
            })

            recordAccountRecovery(db, {
              email: normalizedEmail,
              originalCodeId,
              originalRedeemedAt: redeemedAt,
              originalAccountEmail,
              recoveryMode: 'open-account',
              recoveryCodeId,
              recoveryCode,
              recoveryAccountEmail: redemptionResult.metadata?.accountEmail || recoveryAccountEmail,
              status: 'success'
            })
            saveDatabase()

            return res.json({
              message: '补录成功',
              data: {
                accountEmail: redemptionResult.data.accountEmail,
                userCount: redemptionResult.data.userCount,
                inviteStatus: redemptionResult.data.inviteStatus,
                recoveryMode: 'open-account',
                windowEndsAt,
                processedOriginalCodeId: originalCodeId,
                processedOriginalRedeemedAt: redeemedAt,
                processedReason
              }
            })
          } catch (error) {
            lastAttemptError = error
            const shouldRetry = attempt < recoveryRedeemMaxAttempts && shouldRetryAccountRecoveryRedeem(error)
            if (shouldRetry) continue

            const statusCode = error instanceof RedemptionError ? error.statusCode || 400 : 500
            recordAccountRecovery(db, {
              email: normalizedEmail,
              originalCodeId,
              originalRedeemedAt: redeemedAt,
              originalAccountEmail,
              recoveryMode: 'open-account',
              recoveryCodeId,
              recoveryCode,
              recoveryAccountEmail,
              status: 'failed',
              errorMessage: error?.message || '补录失败'
            })
            saveDatabase()
            return res.status(statusCode).json({
              error: error?.message || '补录失败，请稍后再试',
              message: error?.message || '补录失败，请稍后再试',
              processedOriginalCodeId: originalCodeId,
              processedOriginalRedeemedAt: redeemedAt,
              processedReason,
              windowEndsAt
            })
          }
        }

        const errorMessage = lastAttemptError?.message || '暂无可用通用渠道补录兑换码'
        const responseMessage = '暂无可用通用渠道补录账号，请稍后再试或联系客服'
        const statusCode = 503

        recordAccountRecovery(db, {
          email: normalizedEmail,
          originalCodeId,
          originalRedeemedAt: redeemedAt,
          originalAccountEmail,
          recoveryMode: 'open-account',
          recoveryCodeId: lastAttemptRecovery?.recoveryCodeId,
          recoveryCode: lastAttemptRecovery?.recoveryCode,
          recoveryAccountEmail: lastAttemptRecovery?.recoveryAccountEmail,
          status: 'failed',
          errorMessage
        })
        saveDatabase()

        return res.status(statusCode).json({
          error: responseMessage,
          message: responseMessage,
          processedOriginalCodeId: originalCodeId,
          processedOriginalRedeemedAt: redeemedAt,
          processedReason,
          windowEndsAt
        })
      })
    })
  } catch (error) {
    console.error('补录处理失败:', error)
    res.status(500).json({ error: '服务器错误，请稍后再试', message: '服务器错误，请稍后再试' })
  }
})

router.post('/xhs/search-order', requireFeatureEnabled('xhs'), async (req, res) => {
  try {
    const { orderNumber } = req.body || {}
    const normalizedOrderNumber = normalizeXhsOrderNumber(orderNumber)

    if (!normalizedOrderNumber) {
      return res.status(400).json({ error: '请输入有效的小红书订单号' })
    }

    const config = await getXhsConfig()
    if (!config?.authorization) {
      return res.status(503).json({ error: '请先在管理后台配置 Authorization（推荐粘贴 curl 命令）' })
    }
    if (!config?.cookies) {
      return res.status(503).json({ error: '请先在管理后台配置 Cookie（推荐粘贴 curl 命令）' })
    }

    const existingOrder = await getXhsOrderByNumber(normalizedOrderNumber)
    if (existingOrder) {
      return res.json({
        message: '订单已同步',
        order: existingOrder,
        synced: false
      })
    }

    if (isXhsSyncing()) {
      return res.status(409).json({ error: '同步任务正在运行，请稍后再试' })
    }

    let syncResult
    setXhsSyncing(true)
    try {
      syncResult = await syncOrdersFromApi({
        authorization: config.authorization,
        cookies: config.cookies,
        extraHeaders: config.extraHeaders || {},
        searchKeyword: normalizedOrderNumber,
        pageSize: 20,
        maxPages: 1,
      })
    } finally {
      setXhsSyncing(false)
    }

    await recordXhsSyncResult({ success: true })

    const syncedOrder = await getXhsOrderByNumber(normalizedOrderNumber)
    if (!syncedOrder) {
      return res.status(404).json({ error: '未找到对应订单，请确认订单号是否正确' })
    }

    return res.json({
      message: '订单同步完成',
      order: syncedOrder,
      synced: true,
      importResult: {
        created: syncResult.created,
        skipped: syncResult.skipped,
        total: syncResult.totalFetched,
      }
    })
  } catch (error) {
    console.error('[XHS Search Sync] 请求处理失败:', error)
    await recordXhsSyncResult({ success: false, error: error?.message || '同步失败' }).catch(() => {})
    res.status(500).json({ error: error?.message || '服务器错误，请稍后再试' })
  }
})

router.post('/xhs/check-order', requireFeatureEnabled('xhs'), async (req, res) => {
  try {
    const { orderNumber } = req.body || {}
    const normalizedOrderNumber = normalizeXhsOrderNumber(orderNumber)

    if (!normalizedOrderNumber) {
      return res.status(400).json({ error: '请输入有效的小红书订单号' })
    }

    const orderRecord = await getXhsOrderByNumber(normalizedOrderNumber)
    res.json({
      order: orderRecord,
      found: Boolean(orderRecord),
    })
  } catch (error) {
    console.error('[XHS Check Order] 请求失败:', error)
    res.status(500).json({ error: '查询订单失败，请稍后再试' })
  }
})

router.post('/xhs/redeem-order', requireFeatureEnabled('xhs'), async (req, res) => {
  const alertCollector = createRedemptionAlertCollector('xhs-redeem-order')
  try {
    const { email, orderNumber, strictToday } = req.body || {}
    const trimmedEmail = (email || '').trim()
    const normalizedEmail = normalizeEmail(trimmedEmail)
    const strictTodayEnabled = resolveStrictTodayEnabled(strictToday)

    if (!normalizedEmail) {
      return res.status(400).json({ error: '请输入邮箱地址' })
    }

    if (!EMAIL_REGEX.test(trimmedEmail)) {
      return res.status(400).json({ error: '请输入有效的邮箱地址' })
    }

    const normalizedOrderNumber = normalizeXhsOrderNumber(orderNumber)
    if (!normalizedOrderNumber) {
      return res.status(400).json({ error: '请输入有效的小红书订单号' })
    }

    await withLocks([`xhs-redeem`, `xhs-order:${normalizedOrderNumber}`], async () => {
      const orderRecord = await getXhsOrderByNumber(normalizedOrderNumber)
      if (!orderRecord) {
        return res.status(404).json({ error: '未找到对应订单，请稍后再试' })
      }

      if (orderRecord.isUsed) {
        return res.status(400).json({ error: '该订单已完成兑换' })
      }

      if (String(orderRecord.orderStatus || '').trim() === '已关闭') {
        return res.status(403).json({ error: '该订单已完成售后退款（已关闭），无法进行核销' })
      }

      const db = await getDatabase()
      const { byKey: channelsByKey } = await getChannels(db)
      const allowCommonFallback = Boolean(channelsByKey.get('xhs')?.allowCommonFallback)
      const now = new Date()
      const fallbackToYesterdayEnabled = !strictTodayEnabled && now.getHours() >= 0 && now.getHours() < 8
      const minAccountExpireAt = formatExpireAtComparable(addDays(now, HISTORY_CODE_MIN_ACCOUNT_REMAINING_DAYS))

      const selectChannelCode = (excludeCodeIds = []) => {
        const exclude = buildExcludeCodeClause(excludeCodeIds, 'rc')
        const todayResult = db.exec(
          `
            SELECT rc.id, rc.code, rc.created_at
            FROM redemption_codes rc
            WHERE lower(trim(rc.channel)) = 'xhs'
              AND rc.is_redeemed = 0
              AND DATE(rc.created_at) = DATE('now', 'localtime')
              AND (rc.reserved_for_uid IS NULL OR rc.reserved_for_uid = '')
              AND (rc.reserved_for_order_no IS NULL OR rc.reserved_for_order_no = '')
              AND (rc.reserved_for_entry_id IS NULL OR rc.reserved_for_entry_id = 0)
              AND (
                rc.account_email IS NULL
                OR trim(rc.account_email) = ''
                OR EXISTS (
                  SELECT 1
                  FROM gpt_accounts ga
                  WHERE lower(trim(ga.email)) = lower(trim(rc.account_email))
                )
              )
              ${exclude.clause}
            ORDER BY rc.created_at ASC
            LIMIT 1
          `,
          [...exclude.params]
        )
        let codeRow = todayResult?.[0]?.values?.[0] || null
        if (codeRow) return codeRow

        if (fallbackToYesterdayEnabled) {
          const yesterdayResult = db.exec(
            `
              SELECT rc.id, rc.code, rc.created_at
              FROM redemption_codes rc
              JOIN gpt_accounts ga
                ON lower(trim(ga.email)) = lower(trim(rc.account_email))
              WHERE lower(trim(rc.channel)) = 'xhs'
                AND rc.is_redeemed = 0
                AND DATE(rc.created_at) = DATE('now', 'localtime', '-1 day')
                AND (rc.reserved_for_uid IS NULL OR rc.reserved_for_uid = '')
                AND (rc.reserved_for_order_no IS NULL OR rc.reserved_for_order_no = '')
                AND (rc.reserved_for_entry_id IS NULL OR rc.reserved_for_entry_id = 0)
                AND ga.expire_at IS NOT NULL
                AND trim(ga.expire_at) != ''
                AND trim(ga.expire_at) >= ?
                ${exclude.clause}
              ORDER BY rc.created_at ASC
              LIMIT 1
            `,
            [minAccountExpireAt, ...exclude.params]
          )
          codeRow = yesterdayResult?.[0]?.values?.[0] || null
          if (codeRow) return codeRow
        }

        if (!strictTodayEnabled) {
          const anyDateResult = db.exec(
            `
              SELECT rc.id, rc.code, rc.created_at
              FROM redemption_codes rc
              JOIN gpt_accounts ga
                ON lower(trim(ga.email)) = lower(trim(rc.account_email))
              WHERE lower(trim(rc.channel)) = 'xhs'
                AND rc.is_redeemed = 0
                AND (rc.reserved_for_uid IS NULL OR rc.reserved_for_uid = '')
                AND (rc.reserved_for_order_no IS NULL OR rc.reserved_for_order_no = '')
                AND (rc.reserved_for_entry_id IS NULL OR rc.reserved_for_entry_id = 0)
                AND ga.expire_at IS NOT NULL
                AND trim(ga.expire_at) != ''
                AND trim(ga.expire_at) >= ?
                ${exclude.clause}
              ORDER BY rc.created_at ASC
              LIMIT 1
            `,
            [minAccountExpireAt, ...exclude.params]
          )
          codeRow = anyDateResult?.[0]?.values?.[0] || null
        }

        return codeRow
      }

      const selectCommonCode = async (excludeCodeIds = []) => {
        if (!allowCommonFallback) return null
        const exclude = buildExcludeCodeClause(excludeCodeIds, 'rc')
        return withLocks(['redemption-codes:pool:common'], async () => {
          const todayResult = db.exec(
            `
              SELECT rc.id, rc.code, rc.created_at
              FROM redemption_codes rc
              WHERE COALESCE(NULLIF(lower(trim(rc.channel)), ''), 'common') = 'common'
                AND rc.is_redeemed = 0
                AND DATE(rc.created_at) = DATE('now', 'localtime')
                AND (rc.reserved_for_uid IS NULL OR rc.reserved_for_uid = '')
                AND (rc.reserved_for_order_no IS NULL OR rc.reserved_for_order_no = '')
                AND (rc.reserved_for_entry_id IS NULL OR rc.reserved_for_entry_id = 0)
                AND (
                  rc.account_email IS NULL
                  OR trim(rc.account_email) = ''
                  OR EXISTS (
                    SELECT 1
                    FROM gpt_accounts ga
                    WHERE lower(trim(ga.email)) = lower(trim(rc.account_email))
                  )
                )
                ${exclude.clause}
              ORDER BY rc.created_at ASC
              LIMIT 1
            `,
            [...exclude.params]
          )
          let codeRow = todayResult?.[0]?.values?.[0] || null
          if (codeRow) return codeRow

          if (fallbackToYesterdayEnabled) {
            const yesterdayResult = db.exec(
              `
                SELECT rc.id, rc.code, rc.created_at
                FROM redemption_codes rc
                JOIN gpt_accounts ga
                  ON lower(trim(ga.email)) = lower(trim(rc.account_email))
                WHERE COALESCE(NULLIF(lower(trim(rc.channel)), ''), 'common') = 'common'
                  AND rc.is_redeemed = 0
                  AND DATE(rc.created_at) = DATE('now', 'localtime', '-1 day')
                  AND (rc.reserved_for_uid IS NULL OR rc.reserved_for_uid = '')
                  AND (rc.reserved_for_order_no IS NULL OR rc.reserved_for_order_no = '')
                  AND (rc.reserved_for_entry_id IS NULL OR rc.reserved_for_entry_id = 0)
                  AND ga.expire_at IS NOT NULL
                  AND trim(ga.expire_at) != ''
                  AND trim(ga.expire_at) >= ?
                  ${exclude.clause}
                ORDER BY rc.created_at ASC
                LIMIT 1
              `,
              [minAccountExpireAt, ...exclude.params]
            )
            codeRow = yesterdayResult?.[0]?.values?.[0] || null
            if (codeRow) return codeRow
          }

          if (!strictTodayEnabled) {
            const anyDateResult = db.exec(
              `
                SELECT rc.id, rc.code, rc.created_at
                FROM redemption_codes rc
                JOIN gpt_accounts ga
                  ON lower(trim(ga.email)) = lower(trim(rc.account_email))
                WHERE COALESCE(NULLIF(lower(trim(rc.channel)), ''), 'common') = 'common'
                  AND rc.is_redeemed = 0
                  AND (rc.reserved_for_uid IS NULL OR rc.reserved_for_uid = '')
                  AND (rc.reserved_for_order_no IS NULL OR rc.reserved_for_order_no = '')
                  AND (rc.reserved_for_entry_id IS NULL OR rc.reserved_for_entry_id = 0)
                  AND ga.expire_at IS NOT NULL
                  AND trim(ga.expire_at) != ''
                  AND trim(ga.expire_at) >= ?
                  ${exclude.clause}
                ORDER BY rc.created_at ASC
                LIMIT 1
              `,
              [minAccountExpireAt, ...exclude.params]
            )
            codeRow = anyDateResult?.[0]?.values?.[0] || null
          }

          return codeRow
        })
      }

      const lazyRetryMaxAttempts = getRedeemLazyRetryMaxAttempts()
      const triedCodeIds = new Set()
      for (let attempt = 1; attempt <= lazyRetryMaxAttempts; attempt += 1) {
        const excludeIds = Array.from(triedCodeIds)
        const selectedCodeRow = selectChannelCode(excludeIds) || (await selectCommonCode(excludeIds))
        if (!selectedCodeRow) break

        const selectedCodeId = Number(selectedCodeRow[0])
        const selectedCode = String(selectedCodeRow[1] || '')
        if (!selectedCodeId || !selectedCode) break
        triedCodeIds.add(selectedCodeId)

        try {
          const redemptionResult = await redeemCodeInternal({
            code: selectedCode,
            email: normalizedEmail,
            channel: 'xhs',
            skipCodeFormatValidation: true,
            allowCommonChannelFallback: true,
            alertCollector
          })
          await markXhsOrderRedeemed(orderRecord.id, selectedCodeId, selectedCode, normalizedEmail)
          await collectLowStockAlerts(db, alertCollector)

          return res.json({
            message: '兑换成功',
            data: redemptionResult.data,
            order: {
              ...orderRecord,
              status: 'redeemed',
              isUsed: true,
              userEmail: normalizedEmail,
              assignedCodeId: selectedCodeId,
              assignedCode: selectedCode,
            }
          })
        } catch (error) {
          if (isLazyRetryableAccountError(error)) {
            continue
          }
          throw error
        }
      }

      const statsResult = db.exec(
        `
          SELECT
            COUNT(*) as all_total,
            SUM(CASE WHEN is_redeemed = 0 THEN 1 ELSE 0 END) as all_unused,
            SUM(CASE WHEN DATE(created_at) = DATE('now', 'localtime') THEN 1 ELSE 0 END) as today_total,
            SUM(CASE WHEN is_redeemed = 0 AND DATE(created_at) = DATE('now', 'localtime') THEN 1 ELSE 0 END) as today_unused
          FROM redemption_codes rc
          WHERE lower(trim(rc.channel)) = 'xhs'
            AND (
              rc.account_email IS NULL
              OR trim(rc.account_email) = ''
              OR EXISTS (
                SELECT 1
                FROM gpt_accounts ga
                WHERE lower(trim(ga.email)) = lower(trim(rc.account_email))
              )
            )
        `
      )
      const statsRow = statsResult?.[0]?.values?.[0] || []
      const allTotal = Number(statsRow[0] || 0)
      const todayTotal = Number(statsRow[2] || 0)
      const todayUnused = Number(statsRow[3] || 0)

      const errorCode = allTotal === 0
        ? 'xhs_codes_not_configured'
        : (todayTotal <= 0 ? 'xhs_no_today_codes' : (todayUnused <= 0 ? 'xhs_today_codes_exhausted' : 'xhs_codes_unavailable'))

      return res.status(503).json({ error: OUT_OF_STOCK_MESSAGE, errorCode })
    })
  } catch (error) {
    if (error instanceof RedemptionError) {
      return res.status(error.statusCode || 400).json({
        error: error.message,
        message: error.message,
        ...(error.payload || {})
      })
    }
    console.error('[XHS Redeem] 兑换错误:', error)
    res.status(500).json({ error: '服务器错误，请稍后重试' })
  } finally {
    try {
      await flushRedemptionAlertCollector(alertCollector)
    } catch (mailError) {
      console.warn('[XHS Redeem] 汇总告警发送失败', mailError?.message || mailError)
    }
  }
})

router.post('/xianyu/search-order', requireFeatureEnabled('xianyu'), async (req, res) => {
  try {
    const { orderId } = req.body || {}
    const normalizedOrderId = normalizeXianyuOrderId(orderId)

    if (!normalizedOrderId) {
      return res.status(400).json({ error: '请输入有效的闲鱼订单号' })
    }

    const config = await getXianyuConfig()
    if (!config?.cookies) {
      return res.status(503).json({ error: '请先在管理后台配置 Cookie' })
    }

    const existingOrder = await getXianyuOrderById(normalizedOrderId)
    if (existingOrder) {
      return res.json({
        message: '订单已同步',
        order: existingOrder,
        synced: false
      })
    }

    const apiResult = await queryXianyuOrderDetailFromApi({
      orderId: normalizedOrderId,
      cookies: config.cookies,
    })
    if (apiResult.cookiesUpdated) {
      await updateXianyuConfig({ cookies: apiResult.cookies })
    }

    const order = transformXianyuApiOrder(apiResult.raw, normalizedOrderId)
    if (!order?.orderId) {
      return res.status(502).json({ error: '订单详情解析失败，请确认订单号是否正确' })
    }
    const orderForImport = transformXianyuApiOrderForImport(order)
    if (!orderForImport?.orderId) {
      return res.status(502).json({ error: '订单详情解析失败，无法写入数据库' })
    }
    const importResult = await importXianyuOrders(orderForImport ? [orderForImport] : [])

    await recordXianyuSyncResult({ success: true })

    const syncedOrder = await getXianyuOrderById(normalizedOrderId)
    if (!syncedOrder) {
      return res.status(404).json({ error: '未找到对应订单，请确认订单号是否正确' })
    }

    return res.json({
      message: '订单同步完成',
      order: syncedOrder,
      synced: true,
      importResult
    })
  } catch (error) {
    console.error('[Xianyu Search Sync] 请求处理失败:', error)
    await recordXianyuSyncResult({ success: false, error: error?.message || '同步失败' }).catch(() => {})
    res.status(500).json({ error: error?.message || '服务器错误，请稍后再试' })
  }
})

router.post('/xianyu/check-order', requireFeatureEnabled('xianyu'), async (req, res) => {
  try {
    const { orderId } = req.body || {}
    const normalizedOrderId = normalizeXianyuOrderId(orderId)

    if (!normalizedOrderId) {
      return res.status(400).json({ error: '请输入有效的闲鱼订单号' })
    }

    const orderRecord = await getXianyuOrderById(normalizedOrderId)
    res.json({
      order: orderRecord,
      found: Boolean(orderRecord),
    })
  } catch (error) {
    console.error('[Xianyu Check Order] 请求失败:', error)
    res.status(500).json({ error: '查询订单失败，请稍后再试' })
  }
})

router.post('/xianyu/redeem-order', requireFeatureEnabled('xianyu'), async (req, res) => {
  const alertCollector = createRedemptionAlertCollector('xianyu-redeem-order')
  try {
    const { email, orderId, strictToday } = req.body || {}
    const trimmedEmail = (email || '').trim()
    const normalizedEmail = normalizeEmail(trimmedEmail)
    const strictTodayEnabled = resolveStrictTodayEnabled(strictToday)

    if (!normalizedEmail) {
      return res.status(400).json({ error: '请输入邮箱地址' })
    }

    if (!EMAIL_REGEX.test(trimmedEmail)) {
      return res.status(400).json({ error: '请输入有效的邮箱地址' })
    }

    const normalizedOrderId = normalizeXianyuOrderId(orderId)
    if (!normalizedOrderId) {
      return res.status(400).json({ error: '请输入有效的闲鱼订单号' })
    }

    await withLocks([`xianyu-redeem`, `xianyu-order:${normalizedOrderId}`], async () => {
      const orderRecord = await getXianyuOrderById(normalizedOrderId)
      if (!orderRecord) {
        return res.status(404).json({ error: '未找到对应订单，请稍后再试' })
      }

      if (orderRecord.isUsed) {
        return res.status(400).json({ error: '该订单已完成兑换' })
      }

      if (String(orderRecord.orderStatus || '').includes('关闭')) {
        return res.status(403).json({ error: '该订单已关闭，无法进行核销' })
      }

      const db = await getDatabase()
      const { byKey: channelsByKey } = await getChannels(db)
      const allowCommonFallback = Boolean(channelsByKey.get('xianyu')?.allowCommonFallback)
      const now = new Date()
      const fallbackToYesterdayEnabled = !strictTodayEnabled && now.getHours() >= 0 && now.getHours() < 8
      const minAccountExpireAt = formatExpireAtComparable(addDays(now, HISTORY_CODE_MIN_ACCOUNT_REMAINING_DAYS))

      const selectChannelCode = (excludeCodeIds = []) => {
        const exclude = buildExcludeCodeClause(excludeCodeIds, 'rc')
        const todayResult = db.exec(
          `
            SELECT rc.id, rc.code, rc.created_at
            FROM redemption_codes rc
            WHERE lower(trim(rc.channel)) = 'xianyu'
              AND rc.is_redeemed = 0
              AND DATE(rc.created_at) = DATE('now', 'localtime')
              AND (rc.reserved_for_uid IS NULL OR rc.reserved_for_uid = '')
              AND (rc.reserved_for_order_no IS NULL OR rc.reserved_for_order_no = '')
              AND (rc.reserved_for_entry_id IS NULL OR rc.reserved_for_entry_id = 0)
              AND (
                rc.account_email IS NULL
                OR trim(rc.account_email) = ''
                OR EXISTS (
                  SELECT 1
                  FROM gpt_accounts ga
                  WHERE lower(trim(ga.email)) = lower(trim(rc.account_email))
                )
              )
              ${exclude.clause}
            ORDER BY rc.created_at ASC
            LIMIT 1
          `,
          [...exclude.params]
        )
        let codeRow = todayResult?.[0]?.values?.[0] || null
        if (codeRow) return codeRow

        if (fallbackToYesterdayEnabled) {
          const yesterdayResult = db.exec(
            `
              SELECT rc.id, rc.code, rc.created_at
              FROM redemption_codes rc
              JOIN gpt_accounts ga
                ON lower(trim(ga.email)) = lower(trim(rc.account_email))
              WHERE lower(trim(rc.channel)) = 'xianyu'
                AND rc.is_redeemed = 0
                AND DATE(rc.created_at) = DATE('now', 'localtime', '-1 day')
                AND (rc.reserved_for_uid IS NULL OR rc.reserved_for_uid = '')
                AND (rc.reserved_for_order_no IS NULL OR rc.reserved_for_order_no = '')
                AND (rc.reserved_for_entry_id IS NULL OR rc.reserved_for_entry_id = 0)
                AND ${getAccountRedeemableSql()}
                ${exclude.clause}
              ORDER BY rc.created_at ASC
              LIMIT 1
            `,
            [minAccountExpireAt, ...exclude.params]
          )
          codeRow = yesterdayResult?.[0]?.values?.[0] || null
          if (codeRow) return codeRow
        }

        if (!strictTodayEnabled) {
          const anyDateResult = db.exec(
            `
              SELECT rc.id, rc.code, rc.created_at
              FROM redemption_codes rc
              JOIN gpt_accounts ga
                ON lower(trim(ga.email)) = lower(trim(rc.account_email))
              WHERE lower(trim(rc.channel)) = 'xianyu'
                AND rc.is_redeemed = 0
                AND (rc.reserved_for_uid IS NULL OR rc.reserved_for_uid = '')
                AND (rc.reserved_for_order_no IS NULL OR rc.reserved_for_order_no = '')
                AND (rc.reserved_for_entry_id IS NULL OR rc.reserved_for_entry_id = 0)
                AND ${getAccountRedeemableSql()}
                ${exclude.clause}
              ORDER BY rc.created_at ASC
              LIMIT 1
            `,
            [minAccountExpireAt, ...exclude.params]
          )
          codeRow = anyDateResult?.[0]?.values?.[0] || null
        }

        return codeRow
      }

      const selectCommonCode = async (excludeCodeIds = []) => {
        if (!allowCommonFallback) return null
        const exclude = buildExcludeCodeClause(excludeCodeIds, 'rc')
        return withLocks(['redemption-codes:pool:common'], async () => {
          const todayResult = db.exec(
            `
              SELECT rc.id, rc.code, rc.created_at
              FROM redemption_codes rc
              WHERE COALESCE(NULLIF(lower(trim(rc.channel)), ''), 'common') = 'common'
                AND rc.is_redeemed = 0
                AND DATE(rc.created_at) = DATE('now', 'localtime')
                AND (rc.reserved_for_uid IS NULL OR rc.reserved_for_uid = '')
                AND (rc.reserved_for_order_no IS NULL OR rc.reserved_for_order_no = '')
                AND (rc.reserved_for_entry_id IS NULL OR rc.reserved_for_entry_id = 0)
                AND (
                  rc.account_email IS NULL
                  OR trim(rc.account_email) = ''
                  OR EXISTS (
                    SELECT 1
                    FROM gpt_accounts ga
                    WHERE lower(trim(ga.email)) = lower(trim(rc.account_email))
                  )
                )
                ${exclude.clause}
              ORDER BY rc.created_at ASC
              LIMIT 1
            `,
            [...exclude.params]
          )
          let codeRow = todayResult?.[0]?.values?.[0] || null
          if (codeRow) return codeRow

          if (fallbackToYesterdayEnabled) {
            const yesterdayResult = db.exec(
              `
                SELECT rc.id, rc.code, rc.created_at
                FROM redemption_codes rc
                JOIN gpt_accounts ga
                  ON lower(trim(ga.email)) = lower(trim(rc.account_email))
                WHERE COALESCE(NULLIF(lower(trim(rc.channel)), ''), 'common') = 'common'
                  AND rc.is_redeemed = 0
                  AND DATE(rc.created_at) = DATE('now', 'localtime', '-1 day')
                  AND (rc.reserved_for_uid IS NULL OR rc.reserved_for_uid = '')
                  AND (rc.reserved_for_order_no IS NULL OR rc.reserved_for_order_no = '')
                  AND (rc.reserved_for_entry_id IS NULL OR rc.reserved_for_entry_id = 0)
                  AND ${getAccountRedeemableSql()}
                  ${exclude.clause}
                ORDER BY rc.created_at ASC
                LIMIT 1
              `,
              [minAccountExpireAt, ...exclude.params]
            )
            codeRow = yesterdayResult?.[0]?.values?.[0] || null
            if (codeRow) return codeRow
          }

          if (!strictTodayEnabled) {
            const anyDateResult = db.exec(
              `
                SELECT rc.id, rc.code, rc.created_at
                FROM redemption_codes rc
                JOIN gpt_accounts ga
                  ON lower(trim(ga.email)) = lower(trim(rc.account_email))
                WHERE COALESCE(NULLIF(lower(trim(rc.channel)), ''), 'common') = 'common'
                  AND rc.is_redeemed = 0
                  AND (rc.reserved_for_uid IS NULL OR rc.reserved_for_uid = '')
                  AND (rc.reserved_for_order_no IS NULL OR rc.reserved_for_order_no = '')
                  AND (rc.reserved_for_entry_id IS NULL OR rc.reserved_for_entry_id = 0)
                  AND ${getAccountRedeemableSql()}
                  ${exclude.clause}
                ORDER BY rc.created_at ASC
                LIMIT 1
              `,
              [minAccountExpireAt, ...exclude.params]
            )
            codeRow = anyDateResult?.[0]?.values?.[0] || null
          }

          return codeRow
        })
      }

      const lazyRetryMaxAttempts = getRedeemLazyRetryMaxAttempts()
      const triedCodeIds = new Set()
      for (let attempt = 1; attempt <= lazyRetryMaxAttempts; attempt += 1) {
        const excludeIds = Array.from(triedCodeIds)
        const selectedCodeRow = selectChannelCode(excludeIds) || (await selectCommonCode(excludeIds))
        if (!selectedCodeRow) break

        const selectedCodeId = Number(selectedCodeRow[0])
        const selectedCode = String(selectedCodeRow[1] || '')
        if (!selectedCodeId || !selectedCode) break
        triedCodeIds.add(selectedCodeId)

        try {
          const redemptionResult = await redeemCodeInternal({
            code: selectedCode,
            email: normalizedEmail,
            channel: 'xianyu',
            skipCodeFormatValidation: true,
            allowCommonChannelFallback: true,
            alertCollector
          })
          await markXianyuOrderRedeemed(orderRecord.id, selectedCodeId, selectedCode, normalizedEmail)
          await collectLowStockAlerts(db, alertCollector)

          return res.json({
            message: '兑换成功',
            data: redemptionResult.data,
            order: {
              ...orderRecord,
              status: 'redeemed',
              isUsed: true,
              userEmail: normalizedEmail,
              assignedCodeId: selectedCodeId,
              assignedCode: selectedCode,
            }
          })
        } catch (error) {
          if (isLazyRetryableAccountError(error)) {
            continue
          }
          throw error
        }
      }

      const rawStatsResult = db.exec(
        `
          SELECT
            COUNT(*) as all_total,
            SUM(CASE WHEN DATE(created_at) = DATE('now', 'localtime') THEN 1 ELSE 0 END) as today_total
          FROM redemption_codes rc
          WHERE lower(trim(rc.channel)) = 'xianyu'
        `
      )
      const rawStatsRow = rawStatsResult?.[0]?.values?.[0] || []
      const allTotal = Number(rawStatsRow[0] || 0)
      const todayTotal = Number(rawStatsRow[1] || 0)

      const eligibleStatsResult = db.exec(
        `
          SELECT
            SUM(CASE WHEN is_redeemed = 0 THEN 1 ELSE 0 END) as all_unused,
            SUM(CASE WHEN is_redeemed = 0 AND DATE(created_at) = DATE('now', 'localtime') THEN 1 ELSE 0 END) as today_unused
          FROM redemption_codes rc
          WHERE lower(trim(rc.channel)) = 'xianyu'
            AND (rc.reserved_for_uid IS NULL OR rc.reserved_for_uid = '')
            AND (rc.reserved_for_order_no IS NULL OR rc.reserved_for_order_no = '')
            AND (rc.reserved_for_entry_id IS NULL OR rc.reserved_for_entry_id = 0)
            AND ${getCodeAccountRedeemableExistsSql()}
        `,
        [minAccountExpireAt]
      )
      const eligibleStatsRow = eligibleStatsResult?.[0]?.values?.[0] || []
      const todayUnused = Number(eligibleStatsRow[1] || 0)

      const errorCode = allTotal === 0
        ? 'xianyu_codes_not_configured'
        : (todayTotal <= 0 ? 'xianyu_no_today_codes' : (todayUnused <= 0 ? 'xianyu_today_codes_exhausted' : 'xianyu_codes_unavailable'))

      return res.status(503).json({ error: OUT_OF_STOCK_MESSAGE, errorCode })
    })
  } catch (error) {
    if (error instanceof RedemptionError) {
      return res.status(error.statusCode || 400).json({
        error: error.message,
        message: error.message,
        ...(error.payload || {})
      })
    }
    console.error('[Xianyu Redeem] 兑换错误:', error)
    res.status(500).json({ error: '服务器错误，请稍后重试' })
  } finally {
    try {
      await flushRedemptionAlertCollector(alertCollector)
    } catch (mailError) {
      console.warn('[Xianyu Redeem] 汇总告警发送失败', mailError?.message || mailError)
    }
  }
})

// ArtisanFlow 渠道 API：获取当天创建的兑换码
router.get('/artisan-flow/today', apiKeyAuth, async (req, res) => {
  try {
    const db = await getDatabase()

    // 使用 SQLite 的 date() 函数比较日期，'localtime' 确保使用服务器本地时间
    const result = db.exec(`
      SELECT id, code, is_redeemed, redeemed_at, redeemed_by,
             account_email, channel, channel_name, created_at, updated_at
      FROM redemption_codes
      WHERE channel = 'artisan-flow'
        AND date(created_at) = date('now', 'localtime')
      ORDER BY created_at DESC
    `)

    const codes = result.length > 0
      ? result[0].values.map(row => ({
          id: row[0],
          code: row[1],
          isRedeemed: row[2] === 1,
          redeemedAt: row[3],
          redeemedBy: row[4],
          redeemedEmail: extractEmailFromRedeemedBy(row[4]) || null,
          accountEmail: row[5],
          channel: row[6],
          channelName: row[7],
          createdAt: row[8],
          updatedAt: row[9]
        }))
      : []

    // 获取当前本地日期
    const dateResult = db.exec("SELECT date('now', 'localtime')")
    const todayDate = dateResult.length > 0 ? dateResult[0].values[0][0] : new Date().toISOString().split('T')[0]

    res.json({
      success: true,
      date: todayDate,
      total: codes.length,
      codes
    })
  } catch (error) {
    console.error('[ArtisanFlow API] 获取当天兑换码失败:', error)
    res.status(500).json({ error: '服务器错误，请稍后重试' })
  }
})

export default router
