import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import initSqlJs from 'sql.js'

import { markAccountAsBannedAndCleanup } from '../src/services/account-sync.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const initSql = async () => {
  return initSqlJs({
    locateFile: (file) => path.resolve(__dirname, '../../node_modules/sql.js/dist', file)
  })
}

const createSchema = (db) => {
  db.run(`
    CREATE TABLE gpt_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT,
      token TEXT,
      refresh_token TEXT,
      user_count INTEGER,
      invite_count INTEGER,
      chatgpt_account_id TEXT,
      oai_device_id TEXT,
      expire_at TEXT,
      is_open INTEGER DEFAULT 1,
      is_banned INTEGER DEFAULT 0,
      ban_processed INTEGER DEFAULT 0,
      banned_at TEXT,
      risk_note TEXT,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE redemption_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT,
      is_redeemed INTEGER,
      account_email TEXT
    );
  `)
}

const seedData = (db) => {
  db.run(`
    INSERT INTO gpt_accounts (
      id, email, token, refresh_token, user_count, invite_count, chatgpt_account_id, oai_device_id,
      expire_at, is_open, is_banned, ban_processed, banned_at, risk_note, created_at, updated_at
    )
    VALUES (
      1, 'ban-test@example.com', 'token-1', NULL, 0, 0, 'acct-1', 'device-1',
      '2099/12/31 23:59:59', 1, 0, 0, NULL, NULL, DATETIME('now', 'localtime'), DATETIME('now', 'localtime')
    )
  `)

  db.run(`
    INSERT INTO redemption_codes (code, is_redeemed, account_email)
    VALUES
      ('CODE-UNUSED-1', 0, 'ban-test@example.com'),
      ('CODE-UNUSED-2', 0, 'ban-test@example.com'),
      ('CODE-USED-1', 1, 'ban-test@example.com')
  `)
}

test('markAccountAsBannedAndCleanup 重复触发时仅首次发送封号邮件', async () => {
  const SQL = await initSql()
  const db = new SQL.Database()
  createSchema(db)
  seedData(db)

  const alertPayloads = []
  const alertEmailSender = async (payload) => {
    alertPayloads.push(payload)
    return true
  }

  const first = await markAccountAsBannedAndCleanup(db, 1, 'unit test first ban', {
    sendAlertEmail: true,
    alertEmailSender
  })
  const second = await markAccountAsBannedAndCleanup(db, 1, 'unit test repeated ban', {
    sendAlertEmail: true,
    alertEmailSender
  })

  assert.equal(first.newlyBanned, true)
  assert.equal(first.alertEmailSent, true)
  assert.equal(first.deletedUnusedCodeCount, 2)

  assert.equal(second.newlyBanned, false)
  assert.equal(second.alertEmailSent, false)
  assert.equal(second.deletedUnusedCodeCount, 0)

  assert.equal(alertPayloads.length, 1)
  assert.match(String(alertPayloads[0]?.subject || ''), /\[账号封号\] ban-test@example\.com/)

  const accountResult = db.exec(`
    SELECT is_open, is_banned, ban_processed, expire_at
    FROM gpt_accounts
    WHERE id = 1
  `)
  const accountRow = accountResult[0]?.values?.[0]
  assert.ok(accountRow)
  assert.equal(accountRow[0], 0)
  assert.equal(accountRow[1], 1)
  assert.equal(accountRow[2], 0)
  assert.equal(accountRow[3], '1970/01/01 00:00:00')

  const unusedCountResult = db.exec(`
    SELECT COUNT(*)
    FROM redemption_codes
    WHERE account_email = 'ban-test@example.com'
      AND is_redeemed = 0
  `)
  const unusedCount = Number(unusedCountResult[0]?.values?.[0]?.[0] || 0)
  assert.equal(unusedCount, 0)
})
