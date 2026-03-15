import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import initSqlJs from 'sql.js'

import {
  createRedemptionAlertCollector,
  collectRedemptionLowStockAlerts,
} from '../src/routes/redemption-codes.js'
import { invalidateChannelsCache } from '../src/utils/channels.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const initSql = async () => {
  return initSqlJs({
    locateFile: (file) => path.resolve(__dirname, '../../node_modules/sql.js/dist', file)
  })
}

const createSchema = (db) => {
  db.run(`
    CREATE TABLE channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT,
      name TEXT,
      redeem_mode TEXT,
      allow_common_fallback INTEGER,
      is_active INTEGER,
      is_builtin INTEGER,
      sort_order INTEGER,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE redemption_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT,
      is_redeemed INTEGER,
      account_email TEXT,
      channel TEXT,
      reserved_for_uid TEXT,
      reserved_for_order_no TEXT,
      reserved_for_entry_id INTEGER,
      created_at TEXT
    );

    CREATE TABLE gpt_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT,
      is_open INTEGER,
      is_banned INTEGER,
      token TEXT,
      chatgpt_account_id TEXT,
      expire_at TEXT,
      user_count INTEGER,
      invite_count INTEGER
    );

    CREATE TABLE system_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      config_key TEXT,
      config_value TEXT,
      updated_at TEXT
    );

    CREATE TABLE credit_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no TEXT,
      status TEXT,
      scene TEXT
    );
  `)
}

const setupChannels = (db) => {
  db.run(
    `
      INSERT INTO channels (key, name, redeem_mode, allow_common_fallback, is_active, is_builtin, sort_order, created_at, updated_at)
      VALUES
        ('linux-do', 'LinuxDo', 'linux-do', 0, 1, 1, 1, DATETIME('now'), DATETIME('now')),
        ('xianyu', '闲鱼', 'code', 0, 1, 1, 2, DATETIME('now'), DATETIME('now'))
    `
  )
}

const seedAccountsAndCodes = (db) => {
  db.run(
    `
      INSERT INTO gpt_accounts (email, is_open, is_banned, token, chatgpt_account_id, expire_at, user_count, invite_count)
      VALUES
        ('valid@example.com', 1, 0, 'token-valid', 'acct-valid', '2099/12/31 23:59', 0, 0),
        ('banned@example.com', 0, 1, 'token-banned', 'acct-banned', '2099/12/31 23:59', 0, 0)
    `
  )

  db.run(
    `
      INSERT INTO redemption_codes (code, is_redeemed, account_email, channel, reserved_for_uid, reserved_for_order_no, reserved_for_entry_id, created_at)
      VALUES
        -- linux-do: 仅 1 张可兑换（阈值 2 时应告警）
        ('LINUX-OK-0001', 0, 'valid@example.com', 'linux-do', NULL, NULL, 0, DATETIME('now')),
        ('LINUX-RS-0002', 0, 'valid@example.com', 'linux-do', NULL, 'ORD-001', 0, DATETIME('now')),
        ('LINUX-BN-0003', 0, 'banned@example.com', 'linux-do', NULL, NULL, 0, DATETIME('now')),

        -- xianyu: 2 张可兑换（阈值 2 时不告警）
        ('XY-OK-0001', 0, NULL, 'xianyu', NULL, NULL, 0, DATETIME('now')),
        ('XY-OK-0002', 0, 'valid@example.com', 'xianyu', NULL, NULL, 0, DATETIME('now')),
        ('XY-RS-0003', 0, NULL, 'xianyu', '10086', NULL, 0, DATETIME('now'))
    `
  )

  db.run(
    `
      INSERT INTO credit_orders (order_no, status, scene)
      VALUES
        ('CO-001', 'created', 'open_accounts_board'),
        ('CO-002', 'pending_payment', 'open_accounts_board'),
        ('CO-003', 'paid', 'open_accounts_board'),
        ('CO-004', 'pending_payment', 'ldc_shop_purchase')
    `
  )
}

test('低库存统计仅计入真实可兑换库存', async () => {
  const SQL = await initSql()
  const db = new SQL.Database()
  createSchema(db)
  setupChannels(db)
  seedAccountsAndCodes(db)

  db.run(
    `INSERT INTO system_config (config_key, config_value, updated_at) VALUES ('redemption_low_stock_threshold', '2', DATETIME('now'))`
  )

  invalidateChannelsCache()
  const collector = createRedemptionAlertCollector('unit-test')
  await collectRedemptionLowStockAlerts(db, collector)

  assert.equal(collector.threshold, 2)
  assert.equal(collector.pendingAuthorizationOrderCount, 2)
  assert.deepEqual(
    collector.lowStockChannels.map(item => item.channel),
    ['linux-do']
  )
  assert.equal(collector.lowStockChannels[0].availableCount, 1)
})

test('阈值为 0 时不产生低库存告警', async () => {
  const SQL = await initSql()
  const db = new SQL.Database()
  createSchema(db)
  setupChannels(db)
  seedAccountsAndCodes(db)

  db.run(
    `INSERT INTO system_config (config_key, config_value, updated_at) VALUES ('redemption_low_stock_threshold', '0', DATETIME('now'))`
  )

  invalidateChannelsCache()
  const collector = createRedemptionAlertCollector('unit-test-threshold-0')
  await collectRedemptionLowStockAlerts(db, collector)

  assert.equal(collector.threshold, 0)
  assert.equal(collector.pendingAuthorizationOrderCount, 2)
  assert.equal(collector.lowStockChannels.length, 0)
})

test('告警收集器阈值会读取当前环境变量（实时）', () => {
  const previous = process.env.REDEMPTION_LOW_STOCK_THRESHOLD
  try {
    process.env.REDEMPTION_LOW_STOCK_THRESHOLD = '3'
    const collectorA = createRedemptionAlertCollector('runtime-a')
    assert.equal(collectorA.threshold, 3)

    process.env.REDEMPTION_LOW_STOCK_THRESHOLD = '9'
    const collectorB = createRedemptionAlertCollector('runtime-b')
    assert.equal(collectorB.threshold, 9)
  } finally {
    if (previous === undefined) {
      delete process.env.REDEMPTION_LOW_STOCK_THRESHOLD
    } else {
      process.env.REDEMPTION_LOW_STOCK_THRESHOLD = previous
    }
  }
})

test('告警收集器支持按渠道范围统计（scopeChannels）', async () => {
  const SQL = await initSql()
  const db = new SQL.Database()
  createSchema(db)
  setupChannels(db)
  seedAccountsAndCodes(db)

  db.run(
    `INSERT INTO system_config (config_key, config_value, updated_at) VALUES ('redemption_low_stock_threshold', '2', DATETIME('now'))`
  )

  invalidateChannelsCache()
  const collector = createRedemptionAlertCollector('unit-test-scope', {
    scopeChannels: ['xianyu']
  })
  await collectRedemptionLowStockAlerts(db, collector)

  assert.equal(collector.threshold, 2)
  assert.equal(collector.pendingAuthorizationOrderCount, 2)
  assert.equal(collector.lowStockChannels.length, 0)
})

test('收集器会统计待授权状态的开放账号订单数量', async () => {
  const SQL = await initSql()
  const db = new SQL.Database()
  createSchema(db)
  setupChannels(db)
  seedAccountsAndCodes(db)

  db.run(
    `INSERT INTO system_config (config_key, config_value, updated_at) VALUES ('redemption_low_stock_threshold', '0', DATETIME('now'))`
  )

  invalidateChannelsCache()
  const collector = createRedemptionAlertCollector('unit-test-pending-orders')
  await collectRedemptionLowStockAlerts(db, collector)

  assert.equal(collector.pendingAuthorizationOrderCount, 2)
})
