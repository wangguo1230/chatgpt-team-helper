import { getDatabase } from '../database/init.js'
import { getOpenAccountsCapacityLimit } from '../utils/open-accounts-capacity-settings.js'

const STATUS_KEYS = ['pending', 'invited', 'redeemed', 'returned']

const toNumber = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const pickRow = (result) => result?.[0]?.values?.[0] || []

const toTriad = (total, today, yesterday) => ({
  total: toNumber(total),
  today: toNumber(today),
  yesterday: toNumber(yesterday),
})

const buildNormalizedDateExpr = (columnName) => `
  COALESCE(
    DATE(${columnName}),
    DATE(REPLACE(TRIM(COALESCE(${columnName}, '')), '/', '-')),
    CASE
      WHEN TRIM(COALESCE(${columnName}, '')) GLOB '[0-9]*'
        AND LENGTH(TRIM(COALESCE(${columnName}, ''))) >= 10
      THEN DATE(CAST(TRIM(COALESCE(${columnName}, '')) AS INTEGER), 'unixepoch', 'localtime')
      ELSE NULL
    END
  )
`

const queryOrderStats = (db) => {
  const row = pickRow(
    db.exec(
      `
        WITH order_flags AS (
          SELECT
            ${buildNormalizedDateExpr('created_at')} AS created_date,
            LOWER(TRIM(COALESCE(status, ''))) AS status_norm
          FROM alipay_redpack_orders
        )
        SELECT
          COUNT(*) AS total_count,
          SUM(CASE WHEN created_date = DATE('now', 'localtime') THEN 1 ELSE 0 END) AS today_count,
          SUM(CASE WHEN created_date = DATE('now', 'localtime', '-1 day') THEN 1 ELSE 0 END) AS yesterday_count,

          SUM(CASE WHEN status_norm = 'pending' THEN 1 ELSE 0 END) AS pending_total,
          SUM(CASE WHEN status_norm = 'invited' THEN 1 ELSE 0 END) AS invited_total,
          SUM(CASE WHEN status_norm = 'redeemed' THEN 1 ELSE 0 END) AS redeemed_total,
          SUM(CASE WHEN status_norm = 'returned' THEN 1 ELSE 0 END) AS returned_total,

          SUM(CASE WHEN created_date = DATE('now', 'localtime') AND status_norm = 'pending' THEN 1 ELSE 0 END) AS pending_today,
          SUM(CASE WHEN created_date = DATE('now', 'localtime') AND status_norm = 'invited' THEN 1 ELSE 0 END) AS invited_today,
          SUM(CASE WHEN created_date = DATE('now', 'localtime') AND status_norm = 'redeemed' THEN 1 ELSE 0 END) AS redeemed_today,
          SUM(CASE WHEN created_date = DATE('now', 'localtime') AND status_norm = 'returned' THEN 1 ELSE 0 END) AS returned_today,

          SUM(CASE WHEN created_date = DATE('now', 'localtime', '-1 day') AND status_norm = 'pending' THEN 1 ELSE 0 END) AS pending_yesterday,
          SUM(CASE WHEN created_date = DATE('now', 'localtime', '-1 day') AND status_norm = 'invited' THEN 1 ELSE 0 END) AS invited_yesterday,
          SUM(CASE WHEN created_date = DATE('now', 'localtime', '-1 day') AND status_norm = 'redeemed' THEN 1 ELSE 0 END) AS redeemed_yesterday,
          SUM(CASE WHEN created_date = DATE('now', 'localtime', '-1 day') AND status_norm = 'returned' THEN 1 ELSE 0 END) AS returned_yesterday
        FROM order_flags
      `
    )
  )

  return {
    counts: toTriad(row[0], row[1], row[2]),
    status: {
      pending: toTriad(row[3], row[7], row[11]),
      invited: toTriad(row[4], row[8], row[12]),
      redeemed: toTriad(row[5], row[9], row[13]),
      returned: toTriad(row[6], row[10], row[14]),
    },
  }
}

const queryRedemptionCodeStats = (db) => {
  const row = pickRow(
    db.exec(
      `
        WITH code_flags AS (
          SELECT
            ${buildNormalizedDateExpr('created_at')} AS created_date,
            CASE WHEN COALESCE(is_redeemed, 0) = 1 THEN 1 ELSE 0 END AS is_used,
            CASE WHEN COALESCE(is_redeemed, 0) = 0 THEN 1 ELSE 0 END AS is_unused,
            CASE
              WHEN COALESCE(is_redeemed, 0) = 0
                AND (
                  NULLIF(TRIM(COALESCE(reserved_for_order_no, '')), '') IS NOT NULL
                  OR NULLIF(TRIM(COALESCE(reserved_for_uid, '')), '') IS NOT NULL
                  OR COALESCE(reserved_for_entry_id, 0) > 0
                )
              THEN 1
              ELSE 0
            END AS is_reserved
          FROM redemption_codes
        )
        SELECT
          COUNT(*) AS total_all,
          SUM(is_unused) AS total_unused,
          SUM(is_used) AS total_used,
          SUM(is_reserved) AS total_reserved,

          SUM(CASE WHEN created_date = DATE('now', 'localtime') THEN 1 ELSE 0 END) AS today_all,
          SUM(CASE WHEN created_date = DATE('now', 'localtime') THEN is_unused ELSE 0 END) AS today_unused,
          SUM(CASE WHEN created_date = DATE('now', 'localtime') THEN is_used ELSE 0 END) AS today_used,
          SUM(CASE WHEN created_date = DATE('now', 'localtime') THEN is_reserved ELSE 0 END) AS today_reserved,

          SUM(CASE WHEN created_date = DATE('now', 'localtime', '-1 day') THEN 1 ELSE 0 END) AS yesterday_all,
          SUM(CASE WHEN created_date = DATE('now', 'localtime', '-1 day') THEN is_unused ELSE 0 END) AS yesterday_unused,
          SUM(CASE WHEN created_date = DATE('now', 'localtime', '-1 day') THEN is_used ELSE 0 END) AS yesterday_used,
          SUM(CASE WHEN created_date = DATE('now', 'localtime', '-1 day') THEN is_reserved ELSE 0 END) AS yesterday_reserved
        FROM code_flags
      `
    )
  )

  return {
    total: toTriad(row[0], row[4], row[8]),
    unused: toTriad(row[1], row[5], row[9]),
    used: toTriad(row[2], row[6], row[10]),
    reserved: toTriad(row[3], row[7], row[11]),
  }
}

const ACCOUNT_FLAGS_CTE = `
  account_base AS (
    SELECT
      id,
      LOWER(TRIM(COALESCE(email, ''))) AS email_norm,
      COALESCE(is_open, 0) AS is_open,
      COALESCE(is_banned, 0) AS is_banned,
      COALESCE(user_count, 0) AS user_count,
      COALESCE(invite_count, 0) AS invite_count,
      CASE WHEN NULLIF(TRIM(COALESCE(token, '')), '') IS NOT NULL THEN 1 ELSE 0 END AS has_token,
      CASE WHEN NULLIF(TRIM(COALESCE(chatgpt_account_id, '')), '') IS NOT NULL THEN 1 ELSE 0 END AS has_chatgpt_account_id,
      CASE
        WHEN NULLIF(TRIM(COALESCE(expire_at, '')), '') IS NULL THEN 1
        WHEN DATETIME(REPLACE(TRIM(expire_at), '/', '-')) >= DATETIME('now', 'localtime') THEN 1
        ELSE 0
      END AS not_expired
    FROM gpt_accounts
  ),
  account_flags AS (
    SELECT
      *,
      CASE
        WHEN is_open = 1
          AND is_banned = 0
          AND has_token = 1
          AND has_chatgpt_account_id = 1
          AND not_expired = 1
          AND (user_count + invite_count) < ?
        THEN 1
        ELSE 0
      END AS is_invitable
    FROM account_base
  )
`

const queryAccountSnapshotStats = (db, capacityLimit) => {
  const row = pickRow(
    db.exec(
      `
        WITH ${ACCOUNT_FLAGS_CTE}
        SELECT
          COUNT(*) AS total_accounts,
          SUM(CASE WHEN is_open = 1 THEN 1 ELSE 0 END) AS open_accounts,
          SUM(CASE WHEN is_banned = 1 THEN 1 ELSE 0 END) AS banned_accounts,
          SUM(CASE WHEN is_open = 1 AND is_banned = 0 AND not_expired = 1 THEN 1 ELSE 0 END) AS active_accounts,
          SUM(user_count) AS used_seats,
          SUM(invite_count) AS invite_pending,
          SUM(CASE WHEN is_invitable = 1 THEN 1 ELSE 0 END) AS invitable_accounts,
          SUM(CASE WHEN is_invitable = 1 THEN (? - (user_count + invite_count)) ELSE 0 END) AS invitable_remaining_seats
        FROM account_flags
      `,
      [capacityLimit, capacityLimit]
    )
  )

  return {
    total: toNumber(row[0]),
    open: toNumber(row[1]),
    banned: toNumber(row[2]),
    active: toNumber(row[3]),
    usedSeats: toNumber(row[4]),
    invitePending: toNumber(row[5]),
    invitableAccounts: toNumber(row[6]),
    invitableRemainingSeats: toNumber(row[7]),
  }
}

const queryAccountCodeLinkedStats = (db, capacityLimit) => {
  const row = pickRow(
    db.exec(
      `
        WITH ${ACCOUNT_FLAGS_CTE},
        available_codes AS (
          SELECT LOWER(TRIM(COALESCE(account_email, ''))) AS account_email_norm
          FROM redemption_codes
          WHERE COALESCE(is_redeemed, 0) = 0
            AND NULLIF(TRIM(COALESCE(account_email, '')), '') IS NOT NULL
            AND NULLIF(TRIM(COALESCE(reserved_for_order_no, '')), '') IS NULL
            AND NULLIF(TRIM(COALESCE(reserved_for_uid, '')), '') IS NULL
            AND COALESCE(reserved_for_entry_id, 0) <= 0
        )
        SELECT
          COUNT(*) AS available_codes_total,
          COUNT(DISTINCT available_codes.account_email_norm) AS account_with_available_codes,
          SUM(CASE WHEN account_flags.is_invitable = 1 THEN 1 ELSE 0 END) AS available_codes_on_invitable_accounts,
          COUNT(DISTINCT CASE WHEN account_flags.is_invitable = 1 THEN available_codes.account_email_norm ELSE NULL END) AS invitable_accounts_with_available_codes
        FROM available_codes
        LEFT JOIN account_flags ON account_flags.email_norm = available_codes.account_email_norm
      `,
      [capacityLimit]
    )
  )

  return {
    availableCodesTotal: toNumber(row[0]),
    accountWithAvailableCodes: toNumber(row[1]),
    availableCodesOnInvitableAccounts: toNumber(row[2]),
    invitableAccountsWithAvailableCodes: toNumber(row[3]),
  }
}

export const buildAdminStatsOverviewFromDb = (db) => {
  const capacityLimit = getOpenAccountsCapacityLimit(db)
  const orderStats = queryOrderStats(db)
  const codeStats = queryRedemptionCodeStats(db)
  const accountSnapshot = queryAccountSnapshotStats(db, capacityLimit)
  const accountCodeLinked = queryAccountCodeLinkedStats(db, capacityLimit)

  const totalSeats = toNumber(accountSnapshot.total) * capacityLimit
  const seatUtilization = totalSeats > 0 ? toNumber(accountSnapshot.usedSeats) / totalSeats : 0

  return {
    generatedAt: new Date().toISOString(),
    alipayRedpackOrders: orderStats,
    redemptionCodes: codeStats,
    gptAccounts: {
      total: toNumber(accountSnapshot.total),
      open: toNumber(accountSnapshot.open),
      banned: toNumber(accountSnapshot.banned),
      active: toNumber(accountSnapshot.active),
      capacityLimit,
      usedSeats: toNumber(accountSnapshot.usedSeats),
      invitePending: toNumber(accountSnapshot.invitePending),
      totalSeats,
      seatUtilization,
      invitableAccounts: toNumber(accountSnapshot.invitableAccounts),
      invitableRemainingSeats: toNumber(accountSnapshot.invitableRemainingSeats),
      codeLinked: accountCodeLinked,
    },
  }
}

export const getAdminStatsOverview = async () => {
  const db = await getDatabase()
  return buildAdminStatsOverviewFromDb(db)
}

export const __adminStatsOverviewTestUtils = {
  STATUS_KEYS,
  toTriad,
  buildAdminStatsOverviewFromDb,
}
