import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import initSqlJs from 'sql.js'

import { buildAdminStatsOverviewFromDb } from '../src/services/admin-stats-overview.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const initSql = async () => {
  return initSqlJs({
    locateFile: (file) => path.resolve(__dirname, '../../node_modules/sql.js/dist', file)
  })
}

const createSchema = (db) => {
  db.run(`
    CREATE TABLE system_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      config_key TEXT,
      config_value TEXT,
      updated_at TEXT
    );

    CREATE TABLE alipay_redpack_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT,
      status TEXT,
      created_at TEXT
    );

    CREATE TABLE redemption_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT,
      is_redeemed INTEGER,
      reserved_for_order_no TEXT,
      reserved_for_uid TEXT,
      reserved_for_entry_id INTEGER,
      account_email TEXT,
      created_at TEXT
    );

    CREATE TABLE gpt_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT,
      token TEXT,
      chatgpt_account_id TEXT,
      user_count INTEGER,
      invite_count INTEGER,
      is_open INTEGER,
      is_banned INTEGER,
      expire_at TEXT
    );
  `)
}

const seedData = (db) => {
  db.run(
    `INSERT INTO system_config (config_key, config_value, updated_at) VALUES ('open_accounts_capacity_limit', '6', DATETIME('now', 'localtime'))`
  )

  db.run(`
    INSERT INTO alipay_redpack_orders (email, status, created_at)
    VALUES
      ('a@example.com', 'pending', DATETIME('now', 'localtime')),
      ('b@example.com', 'invited', DATETIME('now', 'localtime')),
      ('c@example.com', 'redeemed', DATETIME('now', 'localtime', '-1 day')),
      ('d@example.com', 'returned', DATETIME('now', 'localtime', '-2 day'))
  `)

  db.run(`
    INSERT INTO redemption_codes (
      code, is_redeemed, reserved_for_order_no, reserved_for_uid, reserved_for_entry_id, account_email, created_at
    )
    VALUES
      ('CODE-TODAY-UNUSED', 0, NULL, NULL, 0, 'acct1@example.com', DATETIME('now', 'localtime')),
      ('CODE-TODAY-USED', 1, NULL, NULL, 0, 'acct1@example.com', DATETIME('now', 'localtime')),
      ('CODE-TODAY-RESERVED', 0, 'ORD-001', NULL, 0, 'acct1@example.com', DATETIME('now', 'localtime')),
      ('CODE-YESTERDAY-UNUSED', 0, NULL, NULL, 0, 'acct2@example.com', DATETIME('now', 'localtime', '-1 day')),
      ('CODE-OLD-RESERVED', 0, NULL, 'uid_1', 0, 'acct2@example.com', DATETIME('now', 'localtime', '-2 day'))
  `)

  db.run(`
    INSERT INTO gpt_accounts (
      email, token, chatgpt_account_id, user_count, invite_count, is_open, is_banned, expire_at
    )
    VALUES
      ('acct1@example.com', 'token-1', 'chatgpt-1', 2, 1, 1, 0, '2099/12/31 23:59:59'),
      ('acct2@example.com', 'token-2', 'chatgpt-2', 5, 1, 1, 0, '2099/12/31 23:59:59'),
      ('acct3@example.com', 'token-3', 'chatgpt-3', 0, 0, 0, 1, '2099/12/31 23:59:59'),
      ('acct4@example.com', '', '', 1, 0, 1, 0, '2099/12/31 23:59:59')
  `)
}

test('admin stats overview: 三维统计口径正确', async () => {
  const SQL = await initSql()
  const db = new SQL.Database()

  createSchema(db)
  seedData(db)

  const result = buildAdminStatsOverviewFromDb(db)

  assert.equal(result.alipayRedpackOrders.counts.total, 4)
  assert.equal(result.alipayRedpackOrders.counts.today, 2)
  assert.equal(result.alipayRedpackOrders.counts.yesterday, 1)

  assert.equal(result.alipayRedpackOrders.status.pending.total, 1)
  assert.equal(result.alipayRedpackOrders.status.invited.total, 1)
  assert.equal(result.alipayRedpackOrders.status.redeemed.total, 1)
  assert.equal(result.alipayRedpackOrders.status.returned.total, 1)

  assert.equal(result.redemptionCodes.total.total, 5)
  assert.equal(result.redemptionCodes.total.today, 3)
  assert.equal(result.redemptionCodes.total.yesterday, 1)

  assert.equal(result.redemptionCodes.unused.total, 4)
  assert.equal(result.redemptionCodes.unused.today, 2)
  assert.equal(result.redemptionCodes.unused.yesterday, 1)

  assert.equal(result.redemptionCodes.used.total, 1)
  assert.equal(result.redemptionCodes.used.today, 1)
  assert.equal(result.redemptionCodes.used.yesterday, 0)

  assert.equal(result.redemptionCodes.reserved.total, 2)
  assert.equal(result.redemptionCodes.reserved.today, 1)
  assert.equal(result.redemptionCodes.reserved.yesterday, 0)

  assert.equal(result.gptAccounts.total, 4)
  assert.equal(result.gptAccounts.open, 3)
  assert.equal(result.gptAccounts.banned, 1)
  assert.equal(result.gptAccounts.active, 3)

  assert.equal(result.gptAccounts.capacityLimit, 6)
  assert.equal(result.gptAccounts.usedSeats, 8)
  assert.equal(result.gptAccounts.invitePending, 2)
  assert.equal(result.gptAccounts.totalSeats, 24)
  assert.equal(Number(result.gptAccounts.seatUtilization.toFixed(4)), 0.3333)

  assert.equal(result.gptAccounts.invitableAccounts, 1)
  assert.equal(result.gptAccounts.invitableRemainingSeats, 3)

  assert.equal(result.gptAccounts.codeLinked.availableCodesTotal, 2)
  assert.equal(result.gptAccounts.codeLinked.accountWithAvailableCodes, 2)
  assert.equal(result.gptAccounts.codeLinked.availableCodesOnInvitableAccounts, 1)
  assert.equal(result.gptAccounts.codeLinked.invitableAccountsWithAvailableCodes, 1)
})

test('admin stats overview: 兼容旧时间格式与状态大小写', async () => {
  const SQL = await initSql()
  const db = new SQL.Database()

  createSchema(db)
  seedData(db)

  db.run(`
    INSERT INTO alipay_redpack_orders (email, status, created_at)
    VALUES
      ('legacy1@example.com', 'PENDING', STRFTIME('%Y/%m/%d %H:%M:%S', 'now', 'localtime')),
      ('legacy2@example.com', 'Invited', STRFTIME('%s', 'now', 'localtime'))
  `)

  db.run(`
    INSERT INTO redemption_codes (
      code, is_redeemed, reserved_for_order_no, reserved_for_uid, reserved_for_entry_id, account_email, created_at
    )
    VALUES
      ('CODE-LEGACY-SLASH', 0, NULL, NULL, 0, 'acct1@example.com', STRFTIME('%Y/%m/%d %H:%M:%S', 'now', 'localtime')),
      ('CODE-LEGACY-UNIX', 1, NULL, NULL, 0, 'acct1@example.com', STRFTIME('%s', 'now', 'localtime'))
  `)

  const result = buildAdminStatsOverviewFromDb(db)

  assert.equal(result.alipayRedpackOrders.counts.total, 6)
  assert.equal(result.alipayRedpackOrders.counts.today, 4)
  assert.equal(result.alipayRedpackOrders.status.pending.total, 2)
  assert.equal(result.alipayRedpackOrders.status.invited.total, 2)

  assert.equal(result.redemptionCodes.total.total, 7)
  assert.equal(result.redemptionCodes.total.today, 5)
  assert.equal(result.redemptionCodes.unused.total, 5)
  assert.equal(result.redemptionCodes.used.total, 2)
})
