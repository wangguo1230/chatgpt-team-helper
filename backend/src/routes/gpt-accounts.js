import express from 'express'
import axios from 'axios'
import { getDatabase, saveDatabase } from '../database/init.js'
import { authenticateToken } from '../middleware/auth.js'
import { apiKeyAuth } from '../middleware/api-key-auth.js'
import { requireMenu } from '../middleware/rbac.js'
import { syncAccountUserCount, syncAccountInviteCount, fetchOpenAiAccountInfo, fetchAccountUsersList, AccountSyncError, deleteAccountUser, inviteAccountUser, deleteAccountInvite, refreshAccessTokenWithRefreshToken, persistAccountTokens, deleteUnusedCodesByAccountId } from '../services/account-sync.js'
import { extractOpenAiAccountPayload } from '../utils/openai-account-payload.js'
import { getOpenAccountsCapacityLimit } from '../utils/open-accounts-capacity-settings.js'
import { withLocks } from '../utils/locks.js'
import { performDirectInvite } from '../services/direct-invite.js'

const router = express.Router()
const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase()
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

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

const EXPIRE_AT_REGEX = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/

const formatExpireAt = (date) => {
  const pad = (value) => String(value).padStart(2, '0')
  try {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).formatToParts(date)
    const get = (type) => parts.find(p => p.type === type)?.value || ''
    return `${get('year')}/${get('month')}/${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`
  } catch {
    return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  }
}

const normalizeExpireAt = (value) => {
  if (value == null) return null
  const raw = String(value).trim()
  if (!raw) return null
  if (EXPIRE_AT_REGEX.test(raw)) return raw

  // 支持 YYYY-MM-DD HH:mm:ss 或 YYYY/MM/DDTHH:mm:ss 格式
  const match = raw.match(/^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/)
  if (match) {
    const seconds = match[6] || '00'
    return `${match[1]}/${match[2]}/${match[3]} ${match[4]}:${match[5]}:${seconds}`
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

const collectEmails = (payload) => {
  if (!payload) return []
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload.emails)) return payload.emails
  if (typeof payload.emails === 'string') return [payload.emails]
  if (typeof payload.email === 'string') return [payload.email]
  return []
}

const CHECK_STATUS_ALLOWED_RANGE_DAYS = new Set([7, 15, 30])
const MAX_CHECK_ACCOUNTS = 300
const CHECK_STATUS_CONCURRENCY = 3
const ZERO_JOINED_SYNC_CONCURRENCY = 3

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

  // NOTE: gpt_accounts.expire_at is stored as Asia/Shanghai time.
  const iso = `${match[1]}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}+08:00`
  const parsed = Date.parse(iso)
  return Number.isNaN(parsed) ? null : parsed
}

const parseDateTimeToMs = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return null
  const parsed = Date.parse(raw.replace(' ', 'T'))
  return Number.isNaN(parsed) ? null : parsed
}

const calculateBannedDays = (isBanned, bannedAt) => {
  if (!isBanned || !bannedAt) return null
  const bannedAtMs = parseDateTimeToMs(bannedAt)
  if (!Number.isFinite(bannedAtMs)) return null
  return Math.max(0, Math.floor((Date.now() - bannedAtMs) / (24 * 60 * 60 * 1000)))
}

const mapGptAccountRow = (row) => {
  if (!row) return null
  const isBanned = Boolean(row[10])
  const bannedAt = row[11] || null
  return {
    id: row[0],
    email: row[1],
    token: row[2],
    refreshToken: row[3],
    userCount: row[4],
    inviteCount: row[5],
    chatgptAccountId: row[6],
    oaiDeviceId: row[7],
    expireAt: row[8] || null,
    isOpen: Boolean(row[9]),
    isDemoted: false,
    isBanned,
    bannedAt,
    bannedDays: calculateBannedDays(isBanned, bannedAt),
    riskNote: row[12] || null,
    createdAt: row[13],
    updatedAt: row[14]
  }
}

const mapInvitableAccount = (row) => {
  if (!row) return null
  return {
    id: Number(row[0]),
    email: String(row[1] || ''),
    userCount: Number(row[2] || 0),
    inviteCount: Number(row[3] || 0),
    token: String(row[4] || ''),
    chatgptAccountId: String(row[5] || ''),
    expireAt: row[6] ? String(row[6]) : null,
    isOpen: Number(row[7] || 0) === 1,
    isBanned: Number(row[8] || 0) === 1
  }
}

const DIRECT_INVITE_COMMON_CHANNEL_CONDITION = "COALESCE(NULLIF(lower(trim(channel)), ''), 'common') = 'common'"
const DIRECT_INVITE_UNUSED_CODE_CONDITION = `
  is_redeemed = 0
  AND (reserved_for_uid IS NULL OR trim(reserved_for_uid) = '')
  AND (reserved_for_order_no IS NULL OR trim(reserved_for_order_no) = '')
  AND COALESCE(reserved_for_entry_id, 0) = 0
`

const normalizeDirectInviteCodeStats = (totalCount, availableCount) => {
  const normalizedTotal = Number(totalCount || 0)
  const normalizedAvailable = Number(availableCount || 0)
  return {
    totalCount: Number.isFinite(normalizedTotal) && normalizedTotal > 0 ? normalizedTotal : 0,
    availableCount: Number.isFinite(normalizedAvailable) && normalizedAvailable > 0 ? normalizedAvailable : 0
  }
}

const getDirectInviteCodeStats = (db, accountEmail) => {
  if (!db) return normalizeDirectInviteCodeStats(0, 0)
  const normalizedEmail = normalizeEmail(accountEmail)
  if (!normalizedEmail) return normalizeDirectInviteCodeStats(0, 0)

  const result = db.exec(
    `
      SELECT
        COUNT(*) AS total_count,
        SUM(
          CASE
            WHEN ${DIRECT_INVITE_UNUSED_CODE_CONDITION}
            THEN 1 ELSE 0
          END
        ) AS available_count
      FROM redemption_codes
      WHERE lower(trim(account_email)) = ?
        AND ${DIRECT_INVITE_COMMON_CHANNEL_CONDITION}
    `,
    [normalizedEmail]
  )
  const row = result?.[0]?.values?.[0] || []
  return normalizeDirectInviteCodeStats(row[0], row[1])
}

const hasEligibleDirectInviteCodes = (stats) => {
  const normalized = normalizeDirectInviteCodeStats(stats?.totalCount, stats?.availableCount)
  // 快捷邀请规则：未创建邀请码（total=0）可邀请；创建后必须仍有可用邀请码。
  return normalized.totalCount === 0 || normalized.availableCount > 0
}

const loadDirectInviteCodeStatsByEmails = (db, emails) => {
  const map = new Map()
  if (!db) return map
  const normalizedEmails = [...new Set((emails || []).map(normalizeEmail).filter(Boolean))]
  if (!normalizedEmails.length) return map

  const placeholders = normalizedEmails.map(() => '?').join(',')
  const result = db.exec(
    `
      SELECT
        lower(trim(account_email)) AS account_email,
        COUNT(*) AS total_count,
        SUM(
          CASE
            WHEN ${DIRECT_INVITE_UNUSED_CODE_CONDITION}
            THEN 1 ELSE 0
          END
        ) AS available_count
      FROM redemption_codes
      WHERE ${DIRECT_INVITE_COMMON_CHANNEL_CONDITION}
        AND lower(trim(account_email)) IN (${placeholders})
      GROUP BY lower(trim(account_email))
    `,
    normalizedEmails
  )

  for (const row of result?.[0]?.values || []) {
    const email = normalizeEmail(row[0])
    if (!email) continue
    map.set(email, normalizeDirectInviteCodeStats(row[1], row[2]))
  }

  return map
}

const reserveDirectInviteCode = (db, accountEmail, inviteEmail, reserveKey) => {
  if (!db || !reserveKey) return null
  const normalizedEmail = normalizeEmail(accountEmail)
  if (!normalizedEmail) return null

  const selected = db.exec(
    `
      SELECT id, code
      FROM redemption_codes
      WHERE lower(trim(account_email)) = ?
        AND ${DIRECT_INVITE_COMMON_CHANNEL_CONDITION}
        AND ${DIRECT_INVITE_UNUSED_CODE_CONDITION}
      ORDER BY datetime(created_at) ASC, id ASC
      LIMIT 1
    `,
    [normalizedEmail]
  )
  const row = selected?.[0]?.values?.[0]
  if (!row) return null

  const codeId = Number(row[0])
  const code = String(row[1] || '')
  if (!Number.isFinite(codeId) || codeId <= 0 || !code) return null

  db.run(
    `
      UPDATE redemption_codes
      SET reserved_for_order_no = ?,
          reserved_for_order_email = ?,
          updated_at = DATETIME('now', 'localtime')
      WHERE id = ?
        AND ${DIRECT_INVITE_UNUSED_CODE_CONDITION}
    `,
    [reserveKey, inviteEmail || null, codeId]
  )

  const modified = typeof db.getRowsModified === 'function' ? Number(db.getRowsModified() || 0) : 0
  if (modified <= 0) return null

  return { id: codeId, code }
}

const releaseDirectInviteCodeReservation = (db, codeId, reserveKey) => {
  if (!db || !reserveKey) return false
  const normalizedCodeId = Number(codeId)
  if (!Number.isFinite(normalizedCodeId) || normalizedCodeId <= 0) return false
  db.run(
    `
      UPDATE redemption_codes
      SET reserved_for_order_no = NULL,
          reserved_for_order_email = NULL,
          updated_at = DATETIME('now', 'localtime')
      WHERE id = ?
        AND is_redeemed = 0
        AND reserved_for_order_no = ?
    `,
    [normalizedCodeId, reserveKey]
  )
  const modified = typeof db.getRowsModified === 'function' ? Number(db.getRowsModified() || 0) : 0
  if (modified > 0) {
    saveDatabase()
  }
  return modified > 0
}

const consumeReservedDirectInviteCode = (db, codeId, reserveKey) => {
  if (!db || !reserveKey) return false
  const normalizedCodeId = Number(codeId)
  if (!Number.isFinite(normalizedCodeId) || normalizedCodeId <= 0) return false
  db.run(
    `
      DELETE FROM redemption_codes
      WHERE id = ?
        AND is_redeemed = 0
        AND reserved_for_order_no = ?
    `,
    [normalizedCodeId, reserveKey]
  )
  const modified = typeof db.getRowsModified === 'function' ? Number(db.getRowsModified() || 0) : 0
  if (modified > 0) {
    saveDatabase()
  }
  return modified > 0
}

const forceConsumeDirectInviteCode = (db, codeId) => {
  if (!db) return false
  const normalizedCodeId = Number(codeId)
  if (!Number.isFinite(normalizedCodeId) || normalizedCodeId <= 0) return false
  db.run(
    `
      DELETE FROM redemption_codes
      WHERE id = ?
        AND is_redeemed = 0
    `,
    [normalizedCodeId]
  )
  const modified = typeof db.getRowsModified === 'function' ? Number(db.getRowsModified() || 0) : 0
  if (modified > 0) {
    saveDatabase()
  }
  return modified > 0
}

const assertInvitableAccount = (account, { capacityLimit, nowMs }) => {
  if (!account) {
    throw new AccountSyncError('账号不存在', 404)
  }

  if (account.isBanned) {
    throw new AccountSyncError('账号已封禁，无法邀请', 400)
  }

  if (!account.isOpen) {
    throw new AccountSyncError('账号未开放，无法邀请', 400)
  }

  if (!account.token || !account.chatgptAccountId) {
    throw new AccountSyncError('账号缺少 token 或 chatgpt_account_id，无法邀请', 400)
  }

  const expireAtMs = parseExpireAtToMs(account.expireAt)
  if (expireAtMs != null && expireAtMs < nowMs) {
    throw new AccountSyncError('账号已过期，无法邀请', 400)
  }

  const occupancy = Number(account.userCount || 0) + Number(account.inviteCount || 0)
  if (occupancy >= capacityLimit) {
    throw new AccountSyncError('账号已满员，无法邀请', 409)
  }
}

const resolveDirectInviteAccount = (db, accountId = null) => {
  const capacityLimit = getOpenAccountsCapacityLimit(db)
  const nowMs = Date.now()

  if (Number.isFinite(accountId) && Number(accountId) > 0) {
    const result = db.exec(
      `
        SELECT id, email, COALESCE(user_count, 0), COALESCE(invite_count, 0),
               token, chatgpt_account_id, expire_at, COALESCE(is_open, 0), COALESCE(is_banned, 0)
        FROM gpt_accounts
        WHERE id = ?
        LIMIT 1
      `,
      [Number(accountId)]
    )
    const account = mapInvitableAccount(result?.[0]?.values?.[0] || null)
    assertInvitableAccount(account, { capacityLimit, nowMs })
    const codeStats = getDirectInviteCodeStats(db, account?.email)
    if (!hasEligibleDirectInviteCodes(codeStats)) {
      throw new AccountSyncError('所选账号已创建邀请码但无未使用邀请码，请先补充邀请码', 409)
    }
    return account
  }

  const result = db.exec(
    `
      SELECT id, email, COALESCE(user_count, 0), COALESCE(invite_count, 0),
             token, chatgpt_account_id, expire_at, COALESCE(is_open, 0), COALESCE(is_banned, 0)
      FROM gpt_accounts
      WHERE COALESCE(is_open, 0) = 1
        AND COALESCE(is_banned, 0) = 0
        AND token IS NOT NULL
        AND TRIM(token) != ''
        AND chatgpt_account_id IS NOT NULL
        AND TRIM(chatgpt_account_id) != ''
      ORDER BY COALESCE(user_count, 0) + COALESCE(invite_count, 0) ASC, id ASC
      LIMIT 300
    `
  )
  const rows = result?.[0]?.values || []
  for (const row of rows) {
    const account = mapInvitableAccount(row)
    try {
      assertInvitableAccount(account, { capacityLimit, nowMs })
      const codeStats = getDirectInviteCodeStats(db, account?.email)
      if (!hasEligibleDirectInviteCodes(codeStats)) {
        continue
      }
      return account
    } catch {
      // 继续尝试下一个候选账号
    }
  }

  throw new AccountSyncError('暂无符合快捷邀请条件的账号（需未满员，且邀请码为未创建或存在未使用）', 409)
}

const buildQuickInviteMeta = (account, { capacityLimit, nowMs, codeStats }) => {
  const occupancy = Number(account?.userCount || 0) + Number(account?.inviteCount || 0)
  const normalizedStats = normalizeDirectInviteCodeStats(codeStats?.totalCount, codeStats?.availableCount)
  const base = {
    quickInviteOccupancy: occupancy,
    quickInviteCapacityLimit: Number(capacityLimit || 0),
    directInviteCodeTotal: normalizedStats.totalCount,
    directInviteCodeAvailable: normalizedStats.availableCount
  }

  if (!account) {
    return { ...base, quickInviteEligible: false, quickInviteReason: '账号不存在' }
  }
  if (account.isBanned) {
    return { ...base, quickInviteEligible: false, quickInviteReason: '账号已封禁' }
  }
  if (!account.isOpen) {
    return { ...base, quickInviteEligible: false, quickInviteReason: '账号未开放' }
  }
  if (!account.token || !account.chatgptAccountId) {
    return { ...base, quickInviteEligible: false, quickInviteReason: '账号缺少 token 或 ChatGPT ID' }
  }
  const expireAtMs = parseExpireAtToMs(account.expireAt)
  if (expireAtMs != null && expireAtMs < nowMs) {
    return { ...base, quickInviteEligible: false, quickInviteReason: '账号已过期' }
  }
  if (occupancy >= capacityLimit) {
    return { ...base, quickInviteEligible: false, quickInviteReason: '账号已满员' }
  }
  if (!hasEligibleDirectInviteCodes(normalizedStats)) {
    return { ...base, quickInviteEligible: false, quickInviteReason: '已创建邀请码但无未使用邀请码' }
  }

  return { ...base, quickInviteEligible: true, quickInviteReason: null }
}

const parsePositiveInt = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null
}

const readAccountInviteCount = (db, accountId) => {
  const normalizedAccountId = parsePositiveInt(accountId)
  if (!db || !normalizedAccountId) return null
  const result = db.exec(
    `
      SELECT COALESCE(invite_count, 0)
      FROM gpt_accounts
      WHERE id = ?
      LIMIT 1
    `,
    [normalizedAccountId]
  )
  const row = result?.[0]?.values?.[0]
  const inviteCount = row ? Number(row[0]) : NaN
  return Number.isFinite(inviteCount) && inviteCount >= 0 ? inviteCount : null
}

const incrementInviteCountOptimistically = (db, accountId) => {
  const normalizedAccountId = parsePositiveInt(accountId)
  if (!db || !normalizedAccountId) return null
  db.run(
    `
      UPDATE gpt_accounts
      SET invite_count = COALESCE(invite_count, 0) + 1,
          updated_at = DATETIME('now', 'localtime')
      WHERE id = ?
    `,
    [normalizedAccountId]
  )
  const modified = typeof db.getRowsModified === 'function' ? Number(db.getRowsModified() || 0) : 0
  if (modified > 0) {
    saveDatabase()
  }
  return readAccountInviteCount(db, normalizedAccountId)
}

const ensureInviteCountAtLeast = (db, accountId, minValue) => {
  const normalizedAccountId = parsePositiveInt(accountId)
  const normalizedMin = Number(minValue)
  if (!db || !normalizedAccountId || !Number.isFinite(normalizedMin) || normalizedMin < 0) {
    return readAccountInviteCount(db, normalizedAccountId)
  }

  const current = readAccountInviteCount(db, normalizedAccountId)
  if (!Number.isFinite(current) || current >= normalizedMin) {
    return current
  }

  db.run(
    `
      UPDATE gpt_accounts
      SET invite_count = ?,
          updated_at = DATETIME('now', 'localtime')
      WHERE id = ?
    `,
    [Math.floor(normalizedMin), normalizedAccountId]
  )
  const modified = typeof db.getRowsModified === 'function' ? Number(db.getRowsModified() || 0) : 0
  if (modified > 0) {
    saveDatabase()
  }
  return readAccountInviteCount(db, normalizedAccountId)
}

const mapWithConcurrency = async (items, concurrency, fn) => {
  const list = Array.isArray(items) ? items : []
  const limit = Math.max(1, Number(concurrency) || 1)
  if (!list.length) return []

  const results = new Array(list.length)
  let cursor = 0

  const workers = Array.from({ length: Math.min(limit, list.length) }).map(async () => {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const index = cursor++
      if (index >= list.length) break
      results[index] = await fn(list[index], index)
    }
  })

  await Promise.all(workers)
  return results
}

const eachWithConcurrency = async (items, concurrency, fn) => {
  const list = Array.isArray(items) ? items : []
  const limit = Math.max(1, Number(concurrency) || 1)
  if (!list.length) return

  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, list.length) }).map(async () => {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const index = cursor++
      if (index >= list.length) break
      await fn(list[index], index)
    }
  })

  await Promise.all(workers)
}

// 已将此处的重复逻辑迁移至 account-sync.js

const loadAccountsForStatusCheck = async (db, { threshold }) => {
  const countResult = db.exec(
    `SELECT COUNT(*) FROM gpt_accounts WHERE created_at >= DATETIME('now', 'localtime', ?) AND COALESCE(is_banned, 0) = 0`,
    [threshold]
  )
  const totalEligible = Number(countResult[0]?.values?.[0]?.[0] || 0)

  const dataResult = db.exec(
    `
      SELECT id,
             email,
             token,
             refresh_token,
             user_count,
             invite_count,
             chatgpt_account_id,
             oai_device_id,
             expire_at,
             is_open,
             COALESCE(is_banned, 0) AS is_banned,
             created_at,
             updated_at
      FROM gpt_accounts
      WHERE created_at >= DATETIME('now', 'localtime', ?)
        AND COALESCE(is_banned, 0) = 0
      ORDER BY created_at DESC
      LIMIT ?
    `,
    [threshold, MAX_CHECK_ACCOUNTS]
  )

  const rows = dataResult[0]?.values || []
  const accounts = rows.map(row => ({
    id: Number(row[0]),
    email: String(row[1] || ''),
    token: row[2] || '',
    refreshToken: row[3] || null,
    userCount: Number(row[4] || 0),
    inviteCount: Number(row[5] || 0),
    chatgptAccountId: row[6] || '',
    oaiDeviceId: row[7] || '',
    expireAt: row[8] || null,
    isOpen: Boolean(row[9]),
    isDemoted: false,
    isBanned: Boolean(row[10]),
    createdAt: row[11],
    updatedAt: row[12]
  }))

  const truncated = totalEligible > accounts.length
  const skipped = truncated ? Math.max(0, totalEligible - accounts.length) : 0

  return {
    totalEligible,
    accounts,
    truncated,
    skipped
  }
}

const checkSingleAccountStatus = async (db, account, nowMs) => {
  const base = {
    id: account.id,
    email: account.email,
    createdAt: account.createdAt,
    expireAt: account.expireAt || null,
    refreshed: false
  }

  if (account.isBanned) {
    await deleteUnusedCodesByAccountId(db, account.id)
    return { ...base, status: 'banned', reason: null }
  }

  const expireAtMs = parseExpireAtToMs(account.expireAt)
  if (expireAtMs != null && expireAtMs < nowMs) {
    await deleteUnusedCodesByAccountId(db, account.id)
    return { ...base, status: 'expired', reason: 'expireAt 已过期' }
  }

  try {
    await fetchAccountUsersList(account.id, {
      accountRecord: account,
      userListParams: { offset: 0, limit: 1, query: '' }
    })
    return { ...base, status: 'normal', reason: null }
  } catch (error) {
    const message = error?.message ? String(error.message) : String(error || '')
    const status = Number(error?.status || 0)

    if (message.includes('account_deactivated') || message.includes('已自动标记为封号')) {
      return { ...base, status: 'banned', reason: message || null }
    }

    if (status === 401 || status === 403) {
      return { ...base, status: 'expired', reason: message || 'Token 已过期或无效，请更新账号 token' }
    }

    return { ...base, status: 'failed', reason: message || '检查失败' }
  }
}

const syncSingleAccountUserAndInvite = async (accountId) => {
  const userSync = await syncAccountUserCount(accountId)
  const inviteSync = await syncAccountInviteCount(accountId, {
    accountRecord: userSync.account,
    inviteListParams: { offset: 0, limit: 1, query: '' }
  })

  return {
    account: inviteSync.account,
    syncedUserCount: userSync.syncedUserCount,
    inviteCount: inviteSync.inviteCount,
    users: userSync.users
  }
}

// 使用系统设置中的 API 密钥（x-api-key）标记账号为“封号”
router.post('/ban', apiKeyAuth, async (req, res) => {
  try {
    const rawEmails = collectEmails(req.body)
    const emails = [...new Set(rawEmails.map(normalizeEmail).filter(Boolean))]

    if (emails.length === 0) {
      return res.status(400).json({ error: 'emails is required' })
    }
    if (emails.length > 500) {
      return res.status(400).json({ error: 'emails is too large (max 500)' })
    }

    const db = await getDatabase()
    const placeholders = emails.map(() => '?').join(',')

    const existing = db.exec(
      `
        SELECT id, email
        FROM gpt_accounts
        WHERE LOWER(email) IN (${placeholders})
      `,
      emails
    )

    const matched = (existing[0]?.values || [])
      .map(row => ({
        id: Number(row[0]),
        email: String(row[1] || '')
      }))
      .filter(item => Number.isFinite(item.id) && item.email)

    const matchedSet = new Set(matched.map(item => normalizeEmail(item.email)))
    const notFound = emails.filter(email => !matchedSet.has(email))

	    if (matched.length > 0) {
	      db.run(
	        `
	          UPDATE gpt_accounts
	          SET is_open = 0,
	              is_banned = 1,
	              banned_at = COALESCE(banned_at, DATETIME('now', 'localtime')),
	              updated_at = DATETIME('now', 'localtime')
	          WHERE LOWER(email) IN (${placeholders})
	        `,
	        emails
	      )
      for (const item of matched) {
        await deleteUnusedCodesByAccountId(db, item.id)
      }
      saveDatabase()
    }

    return res.json({
      message: 'ok',
      updated: matched.length,
      matched,
      notFound
    })
  } catch (error) {
    console.error('Ban GPT accounts by email error:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.use(authenticateToken, requireMenu('accounts'))

// 校验 access token，并返回可用的 Team 账号列表（用于新建账号时选择 chatgptAccountId）
router.post('/check-token', async (req, res) => {
  try {
    const body = req.body || {}
    const payload = extractOpenAiAccountPayload(body)
    if (payload.parseErrors.length > 0) {
      return res.status(400).json({ error: payload.parseErrors[0] })
    }

    const normalizedToken = String(payload.token || '').trim()
    const proxy = body?.proxy ?? null
    if (!normalizedToken) {
      return res.status(400).json({ error: 'token is required' })
    }

    const accounts = await fetchOpenAiAccountInfo(normalizedToken, proxy)
    return res.json({ accounts })
  } catch (error) {
    console.error('Check GPT token error:', error)

    if (error instanceof AccountSyncError || error?.status) {
      return res.status(error.status || 500).json({ error: error.message })
    }

    return res.status(500).json({ error: '内部服务器错误' })
  }
})

// 批量检查指定时间范围内创建的账号状态（封号 / 过期 / 正常 / 失败）
router.post('/check-status', async (req, res) => {
  try {
    const rangeDays = Number.parseInt(String(req.body?.rangeDays ?? ''), 10)
    if (!CHECK_STATUS_ALLOWED_RANGE_DAYS.has(rangeDays)) {
      return res.status(400).json({ error: 'rangeDays must be one of 7, 15, 30' })
    }

    const threshold = `-${rangeDays} days`
    const db = await getDatabase()

    const { totalEligible, accounts, truncated, skipped } = await loadAccountsForStatusCheck(db, { threshold })
    const nowMs = Date.now()
    const items = await mapWithConcurrency(accounts, CHECK_STATUS_CONCURRENCY, async (account) => {
      return await checkSingleAccountStatus(db, account, nowMs)
    })

    const summary = { normal: 0, expired: 0, banned: 0, failed: 0 }
    let refreshedCount = 0
    for (const item of items) {
      if (!item || typeof item.status !== 'string') continue
      if (Object.prototype.hasOwnProperty.call(summary, item.status)) {
        summary[item.status] += 1
      }
      if (item.refreshed) {
        refreshedCount += 1
      }
    }

    return res.json({
      message: 'ok',
      rangeDays,
      checkedTotal: items.length,
      summary,
      refreshedCount,
      items,
      truncated,
      skipped
    })
  } catch (error) {
    console.error('Check GPT account status error:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// SSE: 批量检查账号状态，并实时推送进度（text/event-stream）
router.get('/check-status/stream', async (req, res) => {
  try {
    const rangeDays = Number.parseInt(String(req.query?.rangeDays ?? ''), 10)
    if (!CHECK_STATUS_ALLOWED_RANGE_DAYS.has(rangeDays)) {
      return res.status(400).json({ error: 'rangeDays must be one of 7, 15, 30' })
    }

    const threshold = `-${rangeDays} days`
    const db = await getDatabase()
    const { accounts, truncated, skipped } = await loadAccountsForStatusCheck(db, { threshold })

    res.status(200)
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, private')
    res.setHeader('Connection', 'keep-alive')
    // Hint Nginx not to buffer (best-effort).
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders?.()

    const sendEvent = (event, payload) => {
      if (res.writableEnded) return
      const data = payload == null ? '' : JSON.stringify(payload)
      res.write(`event: ${event}\n`)
      if (data) {
        res.write(`data: ${data}\n`)
      } else {
        res.write('data: {}\n')
      }
      res.write('\n')
    }

    let closed = false
    req.on('close', () => {
      closed = true
    })

    // Keep the connection active behind proxies (default read timeout is often ~60s).
    const keepAliveTimer = setInterval(() => {
      if (closed || res.writableEnded) return
      try {
        res.write(': ping\n\n')
      } catch {
        // ignore
      }
    }, 15000)

    const total = accounts.length
    sendEvent('meta', { rangeDays, total, truncated, skipped })
    sendEvent('progress', { processed: 0, total, percent: total ? 0 : 100 })

    const nowMs = Date.now()
    const summary = { normal: 0, expired: 0, banned: 0, failed: 0 }
    let refreshedCount = 0
    let processed = 0

    try {
      await eachWithConcurrency(accounts, CHECK_STATUS_CONCURRENCY, async (account) => {
        if (closed) return

        const item = await checkSingleAccountStatus(db, account, nowMs)

        processed += 1
        if (Object.prototype.hasOwnProperty.call(summary, item.status)) {
          summary[item.status] += 1
        }
        if (item.refreshed) {
          refreshedCount += 1
        }

        const percent = total ? Math.round((processed / total) * 100) : 100
        sendEvent('item', item)
        sendEvent('progress', { processed, total, percent })
      })

      if (!closed) {
        sendEvent('done', {
          message: 'ok',
          rangeDays,
          checkedTotal: processed,
          summary,
          refreshedCount,
          truncated,
          skipped
        })
      }
    } catch (error) {
      if (!closed) {
        const message = error?.message ? String(error.message) : 'Internal server error'
        sendEvent('error', { error: message })
      }
    } finally {
      clearInterval(keepAliveTimer)
      try {
        res.end()
      } catch {
        // ignore
      }
    }
  } catch (error) {
    console.error('Check GPT account status (SSE) error:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// 获取账号列表（支持分页、搜索、筛选）
router.get('/', async (req, res) => {
  try {
    const db = await getDatabase()
    const page = Math.max(1, Number(req.query.page) || 1)
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 10))
    const search = (req.query.search || '').trim().toLowerCase()
    const openStatus = req.query.openStatus // 'open' | 'closed' | undefined

    // 构建 WHERE 条件
    const conditions = []
    const params = []

    if (search) {
      conditions.push(`(LOWER(email) LIKE ? OR LOWER(token) LIKE ? OR LOWER(refresh_token) LIKE ? OR LOWER(chatgpt_account_id) LIKE ?)`)
      const searchPattern = `%${search}%`
      params.push(searchPattern, searchPattern, searchPattern, searchPattern)
    }

    if (openStatus === 'open') {
      conditions.push('is_open = 1')
    } else if (openStatus === 'closed') {
      conditions.push('(is_open = 0 OR is_open IS NULL)')
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    // 查询总数
    const countResult = db.exec(`SELECT COUNT(*) FROM gpt_accounts ${whereClause}`, params)
    const total = countResult[0]?.values?.[0]?.[0] || 0

	    // 查询分页数据
	    const offset = (page - 1) * pageSize
	    const dataResult = db.exec(`
	      SELECT id, email, token, refresh_token, user_count, invite_count, chatgpt_account_id, oai_device_id, expire_at, is_open,
	             COALESCE(is_banned, 0) AS is_banned,
	             banned_at,
	             risk_note,
	             created_at, updated_at
	      FROM gpt_accounts
	      ${whereClause}
	      ORDER BY created_at DESC
	      LIMIT ? OFFSET ?
	    `, [...params, pageSize, offset])

	    const accounts = (dataResult[0]?.values || []).map(mapGptAccountRow)
      const capacityLimit = getOpenAccountsCapacityLimit(db)
      const nowMs = Date.now()
      const codeStatsByEmail = loadDirectInviteCodeStatsByEmails(
        db,
        accounts.map(account => account?.email)
      )
      const accountsWithQuickInviteMeta = accounts.map(account => {
        const normalizedEmail = normalizeEmail(account?.email)
        const stats = codeStatsByEmail.get(normalizedEmail) || normalizeDirectInviteCodeStats(0, 0)
        const quickInviteMeta = buildQuickInviteMeta(account, { capacityLimit, nowMs, codeStats: stats })
        return {
          ...account,
          ...quickInviteMeta
        }
      })

    res.json({
      accounts: accountsWithQuickInviteMeta,
      pagination: { page, pageSize, total }
    })
  } catch (error) {
    console.error('Get GPT accounts error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Get a single GPT account
router.get('/:id', async (req, res) => {
  try {
	    const db = await getDatabase()
	    const result = db.exec(`
	      SELECT id, email, token, refresh_token, user_count, invite_count, chatgpt_account_id, oai_device_id, expire_at, is_open,
	             COALESCE(is_banned, 0) AS is_banned,
	             banned_at,
	             risk_note,
	             created_at, updated_at
	      FROM gpt_accounts
	      WHERE id = ?
	    `, [req.params.id])

    if (result.length === 0 || result[0].values.length === 0) {
      return res.status(404).json({ error: 'Account not found' })
    }

	    const row = result[0].values[0]
	    const account = mapGptAccountRow(row)

    res.json(account)
  } catch (error) {
    console.error('Get GPT account error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Create a new GPT account
router.post('/', async (req, res) => {
  try {
    const body = req.body || {}
    const { userCount } = body

    const extracted = extractOpenAiAccountPayload(body)
    if (extracted.parseErrors.length > 0) {
      return res.status(400).json({ error: extracted.parseErrors[0] })
    }

    const email = String(extracted.email || body.email || '').trim()
    const token = String(extracted.token || '').trim()
    const refreshToken = String(extracted.refreshToken || '').trim()
    const normalizedChatgptAccountId = String(extracted.chatgptAccountId || '').trim()
    const normalizedOaiDeviceId = String(extracted.oaiDeviceId || body.oaiDeviceId || '').trim()
    const hasExpireAt = extracted.hasExpireAt || Object.prototype.hasOwnProperty.call(body, 'expireAt')
    const expireAtInput = hasExpireAt
      ? (extracted.hasExpireAt ? extracted.expireAtInput : body.expireAt)
      : null
    const normalizedExpireAt = hasExpireAt ? normalizeExpireAt(expireAtInput) : null

    // isDemoted/is_demoted: deprecated (ignored).

    const hasIsBanned = Object.prototype.hasOwnProperty.call(body, 'isBanned') || Object.prototype.hasOwnProperty.call(body, 'is_banned')
    const isBannedInput = Object.prototype.hasOwnProperty.call(body, 'isBanned') ? body.isBanned : body.is_banned
    const normalizedIsBanned = hasIsBanned ? normalizeBoolean(isBannedInput) : null
    if (hasIsBanned && normalizedIsBanned === null) {
      return res.status(400).json({ error: 'Invalid isBanned format' })
    }
    const isBannedValue = normalizedIsBanned ? 1 : 0

    if (!email || !token || !normalizedChatgptAccountId) {
      return res.status(400).json({ error: 'Email, token and ChatGPT ID are required' })
    }

    if (hasExpireAt && expireAtInput != null && String(expireAtInput).trim() && !normalizedExpireAt) {
      return res.status(400).json({
        error: 'Invalid expireAt format',
        message: 'expireAt 格式错误，请使用 YYYY/MM/DD HH:mm'
      })
    }

    const normalizedEmail = normalizeEmail(email)

    const db = await getDatabase()

    // 设置默认人数为1而不是0
    const finalUserCount = userCount !== undefined ? userCount : 1

	    db.run(
	      `
	        INSERT INTO gpt_accounts (
	          email,
	          token,
	          refresh_token,
	          user_count,
	          chatgpt_account_id,
	          oai_device_id,
	          expire_at,
	          is_banned,
	          banned_at,
	          created_at,
	          updated_at
	        ) VALUES (
	          ?, ?, ?, ?, ?, ?, ?, ?,
	          CASE WHEN ? = 1 THEN DATETIME('now', 'localtime') ELSE NULL END,
	          DATETIME('now', 'localtime'),
	          DATETIME('now', 'localtime')
	        )
	      `,
	      [
	        normalizedEmail,
	        token,
	        refreshToken || null,
	        finalUserCount,
	        normalizedChatgptAccountId,
	        normalizedOaiDeviceId || null,
	        normalizedExpireAt,
	        isBannedValue,
	        isBannedValue
	      ]
	    )

		    // 获取新创建账号的ID
		    const accountResult = db.exec(`
		      SELECT id, email, token, refresh_token, user_count, invite_count, chatgpt_account_id, oai_device_id, expire_at, is_open,
		             COALESCE(is_banned, 0) AS is_banned,
		             banned_at,
		             risk_note,
		             created_at, updated_at
		      FROM gpt_accounts
		      WHERE id = last_insert_rowid()
		    `)
	    const row = accountResult[0].values[0]
	    const account = mapGptAccountRow(row)

    saveDatabase()

    res.status(201).json({
      account,
      message: '账号创建成功'
    })
  } catch (error) {
    console.error('Create GPT account error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Update a GPT account
router.put('/:id', async (req, res) => {
  try {
    const body = req.body || {}
    const { userCount } = body

    const extracted = extractOpenAiAccountPayload(body)
    if (extracted.parseErrors.length > 0) {
      return res.status(400).json({ error: extracted.parseErrors[0] })
    }

    const email = String(extracted.email || body.email || '').trim()
    const token = String(extracted.token || '').trim()
    const refreshToken = String(extracted.refreshToken || '').trim()
    const normalizedChatgptAccountId = String(extracted.chatgptAccountId || '').trim()
    const normalizedOaiDeviceId = String(extracted.oaiDeviceId || body.oaiDeviceId || '').trim()
    const hasExpireAt = extracted.hasExpireAt || Object.prototype.hasOwnProperty.call(body, 'expireAt')
    const expireAtInput = hasExpireAt
      ? (extracted.hasExpireAt ? extracted.expireAtInput : body.expireAt)
      : null
    const normalizedExpireAt = hasExpireAt ? normalizeExpireAt(expireAtInput) : null

    // isDemoted/is_demoted: deprecated (ignored).

    const hasIsBanned = Object.prototype.hasOwnProperty.call(body, 'isBanned') || Object.prototype.hasOwnProperty.call(body, 'is_banned')
    const isBannedInput = Object.prototype.hasOwnProperty.call(body, 'isBanned') ? body.isBanned : body.is_banned
    const normalizedIsBanned = hasIsBanned ? normalizeBoolean(isBannedInput) : null
    if (hasIsBanned && normalizedIsBanned === null) {
      return res.status(400).json({ error: 'Invalid isBanned format' })
    }
    const shouldUpdateIsBanned = hasIsBanned
    const isBannedValue = normalizedIsBanned ? 1 : 0
    const shouldApplyBanSideEffects = shouldUpdateIsBanned && isBannedValue === 1

    if (!email || !token || !normalizedChatgptAccountId) {
      return res.status(400).json({ error: 'Email, token and ChatGPT ID are required' })
    }

    if (hasExpireAt && expireAtInput != null && String(expireAtInput).trim() && !normalizedExpireAt) {
      return res.status(400).json({
        error: 'Invalid expireAt format',
        message: 'expireAt 格式错误，请使用 YYYY/MM/DD HH:mm'
      })
    }

    const db = await getDatabase()

    // Check if account exists
    const checkResult = db.exec('SELECT id, email FROM gpt_accounts WHERE id = ?', [req.params.id])
    if (checkResult.length === 0 || checkResult[0].values.length === 0) {
      return res.status(404).json({ error: 'Account not found' })
    }

    const existingEmail = checkResult[0].values[0][1]

	    db.run(
	      `UPDATE gpt_accounts
	       SET email = ?,
	           token = ?,
	           refresh_token = ?,
	           user_count = ?,
	           chatgpt_account_id = ?,
	           oai_device_id = ?,
	           expire_at = CASE WHEN ? = 1 THEN ? ELSE expire_at END,
	           is_banned = CASE WHEN ? = 1 THEN ? ELSE is_banned END,
	           banned_at = CASE WHEN ? = 1 THEN CASE WHEN ? = 1 THEN COALESCE(banned_at, DATETIME('now', 'localtime')) ELSE NULL END ELSE banned_at END,
	           is_open = CASE WHEN ? = 1 THEN 0 ELSE is_open END,
	           ban_processed = CASE WHEN ? = 1 THEN 0 ELSE ban_processed END,
	           updated_at = DATETIME('now', 'localtime')
	       WHERE id = ?`,
	      [
        email,
        token,
        refreshToken || null,
        userCount || 0,
        normalizedChatgptAccountId,
        normalizedOaiDeviceId || null,
        hasExpireAt ? 1 : 0,
	        normalizedExpireAt,
	        shouldUpdateIsBanned ? 1 : 0,
	        isBannedValue,
	        shouldUpdateIsBanned ? 1 : 0,
	        isBannedValue,
	        shouldApplyBanSideEffects ? 1 : 0,
	        shouldApplyBanSideEffects ? 1 : 0,
	        req.params.id
	      ]
	    )

    if (existingEmail && existingEmail !== email) {
      db.run(
        `UPDATE redemption_codes SET account_email = ?, updated_at = DATETIME('now', 'localtime') WHERE account_email = ?`,
        [email, existingEmail]
      )
    }

    const isNowExpired = hasExpireAt && normalizedExpireAt && parseExpireAtToMs(normalizedExpireAt) != null && parseExpireAtToMs(normalizedExpireAt) < Date.now()
    if (shouldApplyBanSideEffects || isNowExpired) {
      await deleteUnusedCodesByAccountId(db, req.params.id)
    }

    saveDatabase()

		    // Get the updated account
		    const result = db.exec(`
		      SELECT id, email, token, refresh_token, user_count, invite_count, chatgpt_account_id, oai_device_id, expire_at, is_open,
		             COALESCE(is_banned, 0) AS is_banned,
		             banned_at,
		             risk_note,
		             created_at, updated_at
		      FROM gpt_accounts
		      WHERE id = ?
		    `, [req.params.id])
	    const row = result[0].values[0]
	    const account = mapGptAccountRow(row)

    res.json(account)
  } catch (error) {
    console.error('Update GPT account error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// 设置账号是否开放展示
router.patch('/:id/open', async (req, res) => {
  try {
    const { isOpen } = req.body || {}
    if (typeof isOpen !== 'boolean') {
      return res.status(400).json({ error: 'isOpen must be a boolean' })
    }

	    const db = await getDatabase()

	    const checkResult = db.exec('SELECT id, COALESCE(is_banned, 0) AS is_banned FROM gpt_accounts WHERE id = ?', [req.params.id])
	    if (checkResult.length === 0 || checkResult[0].values.length === 0) {
	      return res.status(404).json({ error: 'Account not found' })
	    }

	    const isBanned = Boolean(checkResult[0].values[0][1])
	    if (isOpen && isBanned) {
	      return res.status(400).json({ error: '账号已封号，不能设置为开放账号' })
	    }

	    db.run(
	      `UPDATE gpt_accounts SET is_open = ?, updated_at = DATETIME('now', 'localtime') WHERE id = ?`,
	      [isOpen ? 1 : 0, req.params.id]
	    )
	    saveDatabase()

			    const result = db.exec(
			      `
			        SELECT id, email, token, refresh_token, user_count, invite_count, chatgpt_account_id, oai_device_id, expire_at, is_open,
			               COALESCE(is_banned, 0) AS is_banned,
			               banned_at,
			               risk_note,
			               created_at, updated_at
			        FROM gpt_accounts
			        WHERE id = ?
			      `,
			      [req.params.id]
			    )
		    const row = result[0].values[0]
		    const account = mapGptAccountRow(row)

    res.json(account)
  } catch (error) {
    console.error('Update GPT account open status error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// 标记账号为封号（后台手动操作）
router.patch('/:id/ban', async (req, res) => {
  try {
    const accountId = Number(req.params.id)
    if (!Number.isFinite(accountId)) {
      return res.status(400).json({ error: 'Invalid account id' })
    }

    const db = await getDatabase()
    const checkResult = db.exec('SELECT id FROM gpt_accounts WHERE id = ?', [accountId])
    if (checkResult.length === 0 || checkResult[0].values.length === 0) {
      return res.status(404).json({ error: 'Account not found' })
    }

	    db.run(
	      `
	        UPDATE gpt_accounts
	        SET is_open = 0,
	            is_banned = 1,
	            ban_processed = 0,
	            banned_at = COALESCE(banned_at, DATETIME('now', 'localtime')),
	            updated_at = DATETIME('now', 'localtime')
	        WHERE id = ?
	      `,
	      [accountId]
	    )
    saveDatabase()

	    const result = db.exec(
	      `
	        SELECT id, email, token, refresh_token, user_count, invite_count, chatgpt_account_id, oai_device_id, expire_at, is_open,
	               COALESCE(is_banned, 0) AS is_banned,
	               banned_at,
	               risk_note,
	               created_at, updated_at
	        FROM gpt_accounts
	        WHERE id = ?
	      `,
	      [accountId]
	    )
	    const row = result[0].values[0]
	    const account = mapGptAccountRow(row)

    res.json(account)
  } catch (error) {
    console.error('Ban GPT account error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// 批量删除封号账号（仅删除 is_banned = 1 的记录）
router.delete('/banned/batch', async (req, res) => {
  try {
    const db = await getDatabase()
    const rawAccountIds = Array.isArray(req.body?.accountIds) ? req.body.accountIds : null
    const normalizedAccountIds = rawAccountIds
      ? [...new Set(rawAccountIds.map(id => Number(id)).filter(id => Number.isInteger(id) && id > 0))]
      : null

    if (rawAccountIds && normalizedAccountIds && normalizedAccountIds.length === 0) {
      return res.status(400).json({ error: 'accountIds 必须是正整数数组' })
    }

    let query = 'SELECT id FROM gpt_accounts WHERE COALESCE(is_banned, 0) = 1'
    let params = []

    if (normalizedAccountIds && normalizedAccountIds.length > 0) {
      const placeholders = normalizedAccountIds.map(() => '?').join(',')
      query += ` AND id IN (${placeholders})`
      params = normalizedAccountIds
    }

    const matchedResult = db.exec(query, params)
    const bannedIds = (matchedResult[0]?.values || [])
      .map(row => Number(row[0]))
      .filter(id => Number.isInteger(id) && id > 0)

    if (bannedIds.length === 0) {
      return res.json({
        message: '没有可删除的封号账号',
        deleted: 0,
        matched: 0,
        requestedIds: normalizedAccountIds || null
      })
    }

    const deletePlaceholders = bannedIds.map(() => '?').join(',')
    db.run(`DELETE FROM gpt_accounts WHERE id IN (${deletePlaceholders})`, bannedIds)
    saveDatabase()

    return res.json({
      message: '封号账号批量删除成功',
      deleted: bannedIds.length,
      matched: bannedIds.length,
      requestedIds: normalizedAccountIds || null
    })
  } catch (error) {
    console.error('Batch delete banned GPT accounts error:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// 批量删除过期账号（仅删除“过期”状态，不包含封号账号）
router.delete('/expired/batch', async (req, res) => {
  try {
    const db = await getDatabase()
    const rawAccountIds = Array.isArray(req.body?.accountIds) ? req.body.accountIds : null
    const normalizedAccountIds = rawAccountIds
      ? [...new Set(rawAccountIds.map(id => Number(id)).filter(id => Number.isInteger(id) && id > 0))]
      : null

    if (rawAccountIds && normalizedAccountIds && normalizedAccountIds.length === 0) {
      return res.status(400).json({ error: 'accountIds 必须是正整数数组' })
    }

    let query = `
      SELECT id, expire_at
      FROM gpt_accounts
      WHERE COALESCE(is_banned, 0) = 0
        AND expire_at IS NOT NULL
        AND TRIM(expire_at) != ''
    `
    let params = []

    if (normalizedAccountIds && normalizedAccountIds.length > 0) {
      const placeholders = normalizedAccountIds.map(() => '?').join(',')
      query += ` AND id IN (${placeholders})`
      params = normalizedAccountIds
    }

    const matchedResult = db.exec(query, params)
    const nowMs = Date.now()
    const expiredIds = (matchedResult[0]?.values || [])
      .map(row => ({
        id: Number(row[0]),
        expireAt: row[1] == null ? '' : String(row[1]).trim()
      }))
      .filter(item => Number.isInteger(item.id) && item.id > 0)
      .filter(item => {
        const expireAtMs = parseExpireAtToMs(item.expireAt)
        return expireAtMs != null && expireAtMs < nowMs
      })
      .map(item => item.id)

    if (expiredIds.length === 0) {
      return res.json({
        message: '没有可删除的过期账号',
        deleted: 0,
        matched: 0,
        requestedIds: normalizedAccountIds || null
      })
    }

    const deletePlaceholders = expiredIds.map(() => '?').join(',')
    db.run(`DELETE FROM gpt_accounts WHERE id IN (${deletePlaceholders})`, expiredIds)
    saveDatabase()

    return res.json({
      message: '过期账号批量删除成功',
      deleted: expiredIds.length,
      matched: expiredIds.length,
      requestedIds: normalizedAccountIds || null
    })
  } catch (error) {
    console.error('Batch delete expired GPT accounts error:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// Delete a GPT account
router.delete('/:id', async (req, res) => {
  try {
    const db = await getDatabase()

    // Check if account exists
    const checkResult = db.exec('SELECT id FROM gpt_accounts WHERE id = ?', [req.params.id])
    if (checkResult.length === 0 || checkResult[0].values.length === 0) {
      return res.status(404).json({ error: 'Account not found' })
    }

    db.run('DELETE FROM gpt_accounts WHERE id = ?', [req.params.id])
    saveDatabase()

    res.json({ message: 'Account deleted successfully' })
  } catch (error) {
    console.error('Delete GPT account error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// 同步账号用户数量
router.post('/:id/sync-user-count', async (req, res) => {
  const accountId = Number(req.params.id)
  if (!Number.isFinite(accountId) || accountId <= 0) {
    return res.status(400).json({ error: '无效的账号 ID' })
  }

  try {
    const synced = await syncSingleAccountUserAndInvite(accountId)

    res.json({
      message: '账号同步成功',
      account: synced.account,
      syncedUserCount: synced.syncedUserCount,
      inviteCount: synced.inviteCount,
      users: synced.users
    })
  } catch (error) {
    console.error('同步账号人数错误:', error)

    if (error instanceof AccountSyncError || error?.status) {
      return res.status(error.status || 500).json({ error: error.message })
    }

    res.status(500).json({ error: '内部服务器错误' })
  }
})

// 一键同步“已加入 = 0”的账号
router.post('/sync-user-count/zero-joined', async (req, res) => {
  try {
    const db = await getDatabase()
    const result = db.exec(
      `
        SELECT id, email
        FROM gpt_accounts
        WHERE COALESCE(is_banned, 0) = 0
          AND COALESCE(user_count, 0) = 0
        ORDER BY created_at DESC
      `
    )
    const targets = (result[0]?.values || [])
      .map(row => ({
        id: Number(row[0]),
        email: String(row[1] || '')
      }))
      .filter(item => Number.isInteger(item.id) && item.id > 0)

    if (targets.length === 0) {
      return res.json({
        message: '没有可同步的账号',
        targetCount: 0,
        syncedCount: 0,
        failedCount: 0,
        items: []
      })
    }

    const items = await mapWithConcurrency(targets, ZERO_JOINED_SYNC_CONCURRENCY, async (item) => {
      try {
        const synced = await syncSingleAccountUserAndInvite(item.id)
        return {
          id: item.id,
          email: item.email,
          status: 'synced',
          syncedUserCount: synced.syncedUserCount,
          inviteCount: synced.inviteCount,
          error: null
        }
      } catch (error) {
        return {
          id: item.id,
          email: item.email,
          status: 'failed',
          syncedUserCount: null,
          inviteCount: null,
          error: error?.message ? String(error.message) : '同步失败'
        }
      }
    })

    const syncedCount = items.filter(item => item.status === 'synced').length
    const failedCount = items.length - syncedCount

    return res.json({
      message: failedCount > 0 ? '部分账号同步失败' : '账号同步成功',
      targetCount: items.length,
      syncedCount,
      failedCount,
      items
    })
  } catch (error) {
    console.error('Batch sync zero-joined GPT accounts error:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.delete('/:id/users/:userId', async (req, res) => {
  try {
    const { account, syncedUserCount, users } = await deleteAccountUser(Number(req.params.id), req.params.userId)
    res.json({
      message: '成员删除成功',
      account,
      syncedUserCount,
      users
    })
  } catch (error) {
    console.error('删除成员失败:', error)

    if (error instanceof AccountSyncError || error.status) {
      return res.status(error.status || 500).json({ error: error.message })
    }

    res.status(500).json({ error: '内部服务器错误' })
  }
})

router.post('/:id/invite-user', async (req, res) => {
  try {
    const { email } = req.body || {}
    const accountId = Number(req.params.id)
    if (!email) {
      return res.status(400).json({ error: '请提供邀请邮箱地址' })
    }
    const result = await inviteAccountUser(accountId, email)
    const db = await getDatabase()
    const optimisticInviteCount = incrementInviteCountOptimistically(db, accountId)
    let inviteCount = Number.isFinite(optimisticInviteCount) ? optimisticInviteCount : null
    try {
      const synced = await syncAccountInviteCount(accountId, {
        inviteListParams: { offset: 0, limit: 1, query: '' }
      })
      const syncedInviteCount = Number(synced.inviteCount)
      if (Number.isFinite(syncedInviteCount)) {
        inviteCount = syncedInviteCount
      }
      if (Number.isFinite(optimisticInviteCount)) {
        const normalizedFloor = Math.max(Number(optimisticInviteCount), Number(inviteCount || 0))
        inviteCount = ensureInviteCountAtLeast(db, accountId, normalizedFloor) ?? normalizedFloor
      }
    } catch (syncError) {
      console.warn('邀请发送成功，但同步邀请数失败:', syncError?.message || syncError)
    }

    res.json({
      ...result,
      inviteCount
    })
  } catch (error) {
    console.error('邀请成员失败:', error)

    if (error instanceof AccountSyncError || error.status) {
      return res.status(error.status || 500).json({ error: error.message })
    }

    res.status(500).json({ error: '内部服务器错误' })
  }
})

router.post('/invite/direct', async (req, res) => {
  try {
    const response = await performDirectInvite({
      email: req.body?.email,
      accountId: req.body?.accountId
    })

    res.json(response)
  } catch (error) {
    console.error('快捷邀请失败:', error)
    if (error instanceof AccountSyncError || error?.status) {
      return res.status(error.status || 500).json({ error: error.message })
    }
    res.status(500).json({ error: '内部服务器错误' })
  }
})

// 查询已邀请列表（用于统计待加入人数）
router.get('/:id/invites', async (req, res) => {
  try {
    const { invites } = await syncAccountInviteCount(Number(req.params.id), {
      inviteListParams: req.query || {}
    })
    res.json(invites)
  } catch (error) {
    console.error('获取邀请列表失败:', error)

    if (error instanceof AccountSyncError || error.status) {
      return res.status(error.status || 500).json({ error: error.message })
    }

    res.status(500).json({ error: '内部服务器错误' })
  }
})

// 撤回邀请
router.delete('/:id/invites', async (req, res) => {
  try {
    const emailAddress = req.body?.email_address || req.body?.emailAddress || req.body?.email
    if (!emailAddress) {
      return res.status(400).json({ error: '请提供邀请邮箱地址' })
    }

    const result = await deleteAccountInvite(Number(req.params.id), emailAddress)
    res.json(result)
  } catch (error) {
    console.error('撤回邀请失败:', error)

    if (error instanceof AccountSyncError || error.status) {
      return res.status(error.status || 500).json({ error: error.message })
    }

    res.status(500).json({ error: '内部服务器错误' })
  }
})

// 刷新账号的 access token
router.post('/:id/refresh-token', async (req, res) => {
  try {
    const db = await getDatabase()
    const accountId = Number(req.params.id)

    const checkResult = db.exec(
      'SELECT id, refresh_token, proxy FROM gpt_accounts WHERE id = ?',
      [accountId]
    )

    if (checkResult.length === 0 || checkResult[0].values.length === 0) {
      return res.status(404).json({ error: '账号不存在' })
    }

    const row = checkResult[0].values[0]
    const refreshToken = row[1]
    const proxy = row[2]

    if (!refreshToken) {
      return res.status(400).json({ error: '该账号未配置 refresh token' })
    }

    // 使用统一的刷新函数，支持代理
    const tokens = await refreshAccessTokenWithRefreshToken(refreshToken, {
      proxy: proxy || null,
      accountId
    })

    const persisted = await persistAccountTokens(db, accountId, tokens)

	    const updatedResult = db.exec(
	      'SELECT id, email, token, refresh_token, user_count, invite_count, chatgpt_account_id, oai_device_id, expire_at, is_open, COALESCE(is_banned, 0) AS is_banned, banned_at, risk_note, created_at, updated_at FROM gpt_accounts WHERE id = ?',
	      [accountId]
	    )
	    const updatedRow = updatedResult[0].values[0]
	    const account = mapGptAccountRow(updatedRow)

    res.json({
      message: 'Token 刷新成功',
      account,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken || refreshToken
    })
  } catch (error) {
    console.error('刷新 token 错误:', error?.message || error)

    if (error instanceof AccountSyncError || error?.status) {
      return res.status(error.status || 500).json({ error: error.message })
    }

    if (error.response) {
      const message =
        error.response.data?.error?.message ||
        error.response.data?.error_description ||
        error.response.data?.error ||
        '刷新 token 失败'

      return res.status(502).json({
        error: message,
        upstream_status: error.response.status
      })
    }

    res.status(500).json({ error: '刷新 token 时发生内部错误' })
  }
})

export default router
