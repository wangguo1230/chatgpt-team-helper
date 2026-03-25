import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import initSqlJs from 'sql.js'

import {
  ALIPAY_REDPACK_PAYMENT_METHOD_ALIPAY,
  ALIPAY_REDPACK_PRODUCT_TYPE_MOTHER,
  ALIPAY_REDPACK_PRODUCT_TYPE_SINGLE,
  countAvailableMotherAccounts,
  normalizeAlipayRedpackPaymentMethod,
  normalizeAlipayRedpackProductType,
} from '../src/services/alipay-redpack-products.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const initSql = async () => initSqlJs({
  locateFile: (file) => path.resolve(__dirname, '../../node_modules/sql.js/dist', file),
})

test('normalizeAlipayRedpackProductType / normalizeAlipayRedpackPaymentMethod 回退默认值', () => {
  assert.equal(
    normalizeAlipayRedpackProductType('gpt_parent', ALIPAY_REDPACK_PRODUCT_TYPE_SINGLE),
    ALIPAY_REDPACK_PRODUCT_TYPE_MOTHER
  )
  assert.equal(
    normalizeAlipayRedpackProductType('unknown-type', ALIPAY_REDPACK_PRODUCT_TYPE_SINGLE),
    ALIPAY_REDPACK_PRODUCT_TYPE_SINGLE
  )
  assert.equal(
    normalizeAlipayRedpackPaymentMethod('zpay', ALIPAY_REDPACK_PAYMENT_METHOD_ALIPAY),
    'zpay'
  )
  assert.equal(
    normalizeAlipayRedpackPaymentMethod('unknown-pay', ALIPAY_REDPACK_PAYMENT_METHOD_ALIPAY),
    ALIPAY_REDPACK_PAYMENT_METHOD_ALIPAY
  )
})

test('countAvailableMotherAccounts 仅统计兑换码数量 = 4 且可开放母号', async () => {
  const SQL = await initSql()
  const db = new SQL.Database()

  db.run(`
    CREATE TABLE gpt_accounts (
      id INTEGER PRIMARY KEY,
      email TEXT,
      is_open INTEGER,
      is_banned INTEGER
    );

    CREATE TABLE redemption_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_email TEXT,
      is_redeemed INTEGER
    );

    CREATE TABLE alipay_redpack_order_mother_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER,
      account_id INTEGER,
      status TEXT
    );
  `)

  db.run(`
    INSERT INTO gpt_accounts (id, email, is_open, is_banned)
    VALUES
      (1, 'ok@example.com', 1, 0),
      (2, 'three@example.com', 1, 0),
      (3, 'closed@example.com', 0, 0),
      (4, 'banned@example.com', 1, 1),
      (5, 'reserved@example.com', 1, 0),
      (6, 'returned@example.com', 1, 0)
  `)

  db.run(`
    INSERT INTO redemption_codes (account_email, is_redeemed)
    VALUES
      ('ok@example.com', 0), ('ok@example.com', 0), ('ok@example.com', 0), ('ok@example.com', 0),
      ('three@example.com', 0), ('three@example.com', 0), ('three@example.com', 0),
      ('closed@example.com', 0), ('closed@example.com', 0), ('closed@example.com', 0), ('closed@example.com', 0),
      ('banned@example.com', 0), ('banned@example.com', 0), ('banned@example.com', 0), ('banned@example.com', 0),
      ('reserved@example.com', 0), ('reserved@example.com', 0), ('reserved@example.com', 0), ('reserved@example.com', 0),
      ('returned@example.com', 0), ('returned@example.com', 0), ('returned@example.com', 0), ('returned@example.com', 0)
  `)

  db.run(`
    INSERT INTO alipay_redpack_order_mother_accounts (order_id, account_id, status)
    VALUES
      (1001, 5, 'reserved'),
      (1002, 6, 'returned')
  `)

  const count = await countAvailableMotherAccounts(db)
  assert.equal(count, 2)
})
