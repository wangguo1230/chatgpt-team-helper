import { getDatabase, saveDatabase } from '../database/init.js'
import { withLocks } from '../utils/locks.js'
import { getOpenAccountsCapacityLimit } from '../utils/open-accounts-capacity-settings.js'
import { inviteAccountUser, syncAccountInviteCount, AccountSyncError } from './account-sync.js'

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const DIRECT_INVITE_ALLOWED_CHANNEL_CONDITION = "COALESCE(NULLIF(lower(trim(channel)), ''), 'common') IN ('common', 'alipay_redpack', 'alipay-redpack', 'alipayredpack', '支付宝口令红包')"
const DIRECT_INVITE_UNUSED_CODE_CONDITION = `
  is_redeemed = 0
  AND (reserved_for_uid IS NULL OR trim(reserved_for_uid) = '')
  AND (reserved_for_order_no IS NULL OR trim(reserved_for_order_no) = '')
  AND COALESCE(reserved_for_entry_id, 0) = 0
`

const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase()

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

const parsePositiveInt = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null
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
        AND ${DIRECT_INVITE_ALLOWED_CHANNEL_CONDITION}
    `,
    [normalizedEmail]
  )
  const row = result?.[0]?.values?.[0] || []
  return normalizeDirectInviteCodeStats(row[0], row[1])
}

const hasEligibleDirectInviteCodes = (stats) => {
  const normalized = normalizeDirectInviteCodeStats(stats?.totalCount, stats?.availableCount)
  return normalized.totalCount === 0 || normalized.availableCount > 0
}

const hasAvailableDirectInviteCodes = (stats) => {
  const normalized = normalizeDirectInviteCodeStats(stats?.totalCount, stats?.availableCount)
  return normalized.totalCount > 0 && normalized.availableCount > 0
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

const reserveDirectInviteCode = (db, accountEmail, inviteEmail, reserveKey) => {
  if (!db || !reserveKey) return null
  const normalizedEmail = normalizeEmail(accountEmail)
  if (!normalizedEmail) return null

  const selected = db.exec(
    `
      SELECT id, code
      FROM redemption_codes
      WHERE lower(trim(account_email)) = ?
        AND ${DIRECT_INVITE_ALLOWED_CHANNEL_CONDITION}
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

const resolveDirectInviteAccount = (db, accountId = null, options = {}) => {
  const consumeCode = options?.consumeCode !== false
  const requireAvailableDirectInviteCode = options?.requireAvailableDirectInviteCode === true
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
    if (requireAvailableDirectInviteCode && !hasAvailableDirectInviteCodes(codeStats)) {
      throw new AccountSyncError('所选账号无可用邀请码，请先补充邀请码', 409)
    }
    if (consumeCode) {
      if (!hasEligibleDirectInviteCodes(codeStats)) {
        throw new AccountSyncError('所选账号已创建邀请码但无未使用邀请码，请先补充邀请码', 409)
      }
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
      if (requireAvailableDirectInviteCode && !hasAvailableDirectInviteCodes(codeStats)) {
        continue
      }
      if (consumeCode) {
        if (!hasEligibleDirectInviteCodes(codeStats)) {
          continue
        }
      }
      return account
    } catch {
      // 继续尝试下一个候选账号
    }
  }

  if (requireAvailableDirectInviteCode) {
    throw new AccountSyncError('暂无符合快捷邀请条件的账号（需已开放、未满员且存在可用邀请码）', 409)
  }
  if (consumeCode) {
    throw new AccountSyncError('暂无符合快捷邀请条件的账号（需未满员，且邀请码为未创建或存在未使用）', 409)
  }
  throw new AccountSyncError('暂无符合快捷邀请条件的账号（需未满员）', 409)
}

export const getDirectInviteStockSummary = async ({ consumeCode = true } = {}) => {
  const db = await getDatabase()
  const capacityLimit = getOpenAccountsCapacityLimit(db)
  const nowMs = Date.now()

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
      LIMIT 1000
    `
  )

  const rows = result?.[0]?.values || []
  let invitableAccountCount = 0
  let availableSlots = 0

  for (const row of rows) {
    const account = mapInvitableAccount(row)
    if (!account) continue

    try {
      assertInvitableAccount(account, { capacityLimit, nowMs })
      if (consumeCode) {
        const codeStats = getDirectInviteCodeStats(db, account.email)
        if (!hasEligibleDirectInviteCodes(codeStats)) continue
      }

      invitableAccountCount += 1
      const occupancy = Number(account.userCount || 0) + Number(account.inviteCount || 0)
      availableSlots += Math.max(0, Number(capacityLimit || 0) - occupancy)
    } catch {
      // ignore ineligible account
    }
  }

  return {
    consumeCode,
    capacityLimit: Number(capacityLimit || 0),
    candidateAccountCount: Number(rows.length || 0),
    invitableAccountCount,
    availableSlots: Math.max(0, Number(availableSlots || 0)),
  }
}

export const performDirectInvite = async ({ email, accountId = null, consumeCode = true, requireAvailableDirectInviteCode = false } = {}) => {
  const normalizedEmail = normalizeEmail(email)
  if (!normalizedEmail) {
    throw new AccountSyncError('请提供邀请邮箱地址', 400)
  }
  if (!EMAIL_REGEX.test(normalizedEmail)) {
    throw new AccountSyncError('邮箱格式不正确', 400)
  }

  const preferredAccountId = parsePositiveInt(accountId)
  const lockKeys = ['direct-invite:global']
  if (preferredAccountId) {
    lockKeys.push(`direct-invite:account:${preferredAccountId}`)
  }

  return withLocks(lockKeys, async () => {
    const db = await getDatabase()
    const account = resolveDirectInviteAccount(db, preferredAccountId, {
      consumeCode,
      requireAvailableDirectInviteCode,
    })
    const codeStats = consumeCode ? getDirectInviteCodeStats(db, account.email) : { totalCount: 0, availableCount: 0 }
    const needsCodeConsume = consumeCode && codeStats.totalCount > 0
    const reserveKey = needsCodeConsume
      ? `direct_invite:${account.id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
      : null
    const reservedCode = needsCodeConsume && reserveKey
      ? reserveDirectInviteCode(db, account.email, normalizedEmail, reserveKey)
      : null

    if (needsCodeConsume && !reservedCode) {
      throw new AccountSyncError('账号邀请码已不足，请补充未使用邀请码后重试', 409)
    }

    let result
    try {
      result = await inviteAccountUser(account.id, normalizedEmail)
    } catch (error) {
      if (reservedCode && reserveKey) {
        try {
          releaseDirectInviteCodeReservation(db, reservedCode.id, reserveKey)
        } catch (releaseError) {
          console.error('快捷邀请失败后释放兑换码预留失败:', releaseError)
        }
      }
      throw error
    }

    const optimisticInviteCount = incrementInviteCountOptimistically(db, account.id)

    let codeConsumed = reservedCode && reserveKey
      ? consumeReservedDirectInviteCode(db, reservedCode.id, reserveKey)
      : false
    if (reservedCode && !codeConsumed) {
      codeConsumed = forceConsumeDirectInviteCode(db, reservedCode.id)
    }
    if (reservedCode && !codeConsumed) {
      console.error('快捷邀请扣减兑换码失败', {
        accountId: account.id,
        accountEmail: account.email,
        inviteEmail: normalizedEmail,
        reservedCodeId: reservedCode?.id
      })
    }

    let inviteCount = Number.isFinite(optimisticInviteCount) ? optimisticInviteCount : null
    try {
      const synced = await syncAccountInviteCount(account.id, {
        inviteListParams: { offset: 0, limit: 1, query: '' }
      })
      const syncedInviteCount = Number(synced.inviteCount)
      if (Number.isFinite(syncedInviteCount)) {
        inviteCount = syncedInviteCount
      }
      if (Number.isFinite(optimisticInviteCount)) {
        const normalizedFloor = Math.max(Number(optimisticInviteCount), Number(inviteCount || 0))
        inviteCount = ensureInviteCountAtLeast(db, account.id, normalizedFloor) ?? normalizedFloor
      }
    } catch (syncError) {
      console.warn('快捷邀请发送成功，但同步邀请数失败:', syncError?.message || syncError)
    }

    return {
      ...result,
      accountId: account.id,
      accountEmail: account.email,
      inviteCount,
      autoSelected: !preferredAccountId,
      consumedCodeId: codeConsumed && reservedCode ? reservedCode.id : null,
      consumedCode: codeConsumed && reservedCode ? reservedCode.code : null
    }
  })
}
