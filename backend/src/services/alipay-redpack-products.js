import { getDatabase, saveDatabase } from '../database/init.js'
import { normalizeProductKey, normalizeOrderType } from './purchase-products.js'

export const ALIPAY_REDPACK_PRODUCT_TYPE_SINGLE = 'gpt_single'
export const ALIPAY_REDPACK_PRODUCT_TYPE_MOTHER = 'gpt_parent'
export const ALIPAY_REDPACK_PRODUCT_TYPE_SET = new Set([
  ALIPAY_REDPACK_PRODUCT_TYPE_SINGLE,
  ALIPAY_REDPACK_PRODUCT_TYPE_MOTHER,
])

export const ALIPAY_REDPACK_PAYMENT_METHOD_ALIPAY = 'alipay_passphrase'
export const ALIPAY_REDPACK_PAYMENT_METHOD_ZPAY = 'zpay'
export const ALIPAY_REDPACK_PAYMENT_METHOD_SET = new Set([
  ALIPAY_REDPACK_PAYMENT_METHOD_ALIPAY,
  ALIPAY_REDPACK_PAYMENT_METHOD_ZPAY,
])

const SALES_CHANNEL_ALIPAY_REDPACK = 'alipay_redpack'
const DEFAULT_PRODUCT_TYPE = ALIPAY_REDPACK_PRODUCT_TYPE_SINGLE
const DEFAULT_PAYMENT_METHOD = ALIPAY_REDPACK_PAYMENT_METHOD_ALIPAY
const DEFAULT_SERVICE_DAYS = 30

const normalizeMoney2 = (value) => {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return ''
  return (Math.round(parsed * 100) / 100).toFixed(2)
}

export const normalizeAlipayRedpackProductType = (value, fallback = DEFAULT_PRODUCT_TYPE) => {
  const normalized = String(value || '').trim().toLowerCase()
  return ALIPAY_REDPACK_PRODUCT_TYPE_SET.has(normalized) ? normalized : fallback
}

export const normalizeAlipayRedpackPaymentMethod = (value, fallback = DEFAULT_PAYMENT_METHOD) => {
  const normalized = String(value || '').trim().toLowerCase()
  return ALIPAY_REDPACK_PAYMENT_METHOD_SET.has(normalized) ? normalized : fallback
}

const parsePositiveInt = (value, fallback = 0) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const mapAlipayProductRow = (row = []) => ({
  id: Number(row[0] || 0),
  productKey: String(row[1] || ''),
  productName: String(row[2] || ''),
  amount: String(row[3] || ''),
  serviceDays: Number(row[4] || DEFAULT_SERVICE_DAYS),
  orderType: String(row[5] || 'warranty'),
  isActive: Number(row[6] || 0) === 1,
  sortOrder: Number(row[7] || 0),
  productType: normalizeAlipayRedpackProductType(row[8], DEFAULT_PRODUCT_TYPE),
  paymentMethod: normalizeAlipayRedpackPaymentMethod(row[9], DEFAULT_PAYMENT_METHOD),
  createdAt: row[10] || null,
  updatedAt: row[11] || null,
})

export const getAlipayRedpackProductByKey = async (db, productKey, { activeOnly = false } = {}) => {
  const database = db || (await getDatabase())
  const normalizedKey = normalizeProductKey(productKey)
  if (!normalizedKey) return null
  const rows = database.exec(
    `
      SELECT id, product_key, product_name, amount, service_days, order_type,
             COALESCE(is_active, 0), COALESCE(sort_order, 0), alipay_product_type, payment_method,
             created_at, updated_at
      FROM purchase_products
      WHERE product_key = ?
        AND COALESCE(NULLIF(TRIM(sales_channel), ''), 'purchase') = 'alipay_redpack'
        ${activeOnly ? 'AND COALESCE(is_active, 0) = 1' : ''}
      LIMIT 1
    `,
    [normalizedKey]
  )
  const row = rows?.[0]?.values?.[0] || null
  return row ? mapAlipayProductRow(row) : null
}

export const listAlipayRedpackProducts = async (db, { activeOnly = false } = {}) => {
  const database = db || (await getDatabase())
  const rows = database.exec(
    `
      SELECT id, product_key, product_name, amount, service_days, order_type,
             COALESCE(is_active, 0), COALESCE(sort_order, 0), alipay_product_type, payment_method,
             created_at, updated_at
      FROM purchase_products
      WHERE COALESCE(NULLIF(TRIM(sales_channel), ''), 'purchase') = 'alipay_redpack'
        ${activeOnly ? 'AND COALESCE(is_active, 0) = 1' : ''}
      ORDER BY COALESCE(sort_order, 0) ASC, id ASC
    `
  )
  return (rows?.[0]?.values || []).map(mapAlipayProductRow)
}

export const upsertAlipayRedpackProduct = async (db, payload = {}) => {
  const database = db || (await getDatabase())

  const productKey = normalizeProductKey(payload.productKey || payload.product_key)
  if (!productKey) throw new Error('invalid_product_key')

  const productName = String(payload.productName || payload.product_name || '').trim()
  if (!productName) throw new Error('missing_product_name')

  const amount = normalizeMoney2(payload.amount)
  if (!amount) throw new Error('invalid_amount')

  const serviceDays = parsePositiveInt(payload.serviceDays ?? payload.service_days, DEFAULT_SERVICE_DAYS)
  const orderType = normalizeOrderType(payload.orderType || payload.order_type)
  const sortOrder = Number.isFinite(Number(payload.sortOrder ?? payload.sort_order))
    ? Number(payload.sortOrder ?? payload.sort_order)
    : 0
  const isActive = payload.isActive == null ? 1 : (payload.isActive ? 1 : 0)
  const productType = normalizeAlipayRedpackProductType(payload.productType || payload.product_type, DEFAULT_PRODUCT_TYPE)
  const paymentMethod = normalizeAlipayRedpackPaymentMethod(payload.paymentMethod || payload.payment_method, DEFAULT_PAYMENT_METHOD)

  const exists = database.exec(
    `
      SELECT id
      FROM purchase_products
      WHERE product_key = ?
        AND COALESCE(NULLIF(TRIM(sales_channel), ''), 'purchase') = 'alipay_redpack'
      LIMIT 1
    `,
    [productKey]
  )
  if (exists?.[0]?.values?.length) {
    database.run(
      `
        UPDATE purchase_products
        SET product_name = ?,
            amount = ?,
            service_days = ?,
            order_type = ?,
            code_channels = 'alipay_redpack',
            is_active = ?,
            sort_order = ?,
            category = 'code',
            delivery_mode = 'email',
            fulfillment_mode = 'item_pool',
            redeem_provider = NULL,
            sales_channel = 'alipay_redpack',
            payment_method = ?,
            alipay_product_type = ?,
            updated_at = DATETIME('now', 'localtime')
        WHERE product_key = ?
      `,
      [
        productName,
        amount,
        serviceDays,
        orderType,
        isActive,
        sortOrder,
        paymentMethod,
        productType,
        productKey,
      ]
    )
  } else {
    database.run(
      `
        INSERT INTO purchase_products (
          product_key, product_name, amount, service_days, order_type, code_channels,
          is_active, sort_order, category, delivery_mode, fulfillment_mode, redeem_provider,
          sales_channel, payment_method, alipay_product_type, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, 'alipay_redpack',
          ?, ?, 'code', 'email', 'item_pool', NULL,
          'alipay_redpack', ?, ?, DATETIME('now', 'localtime'), DATETIME('now', 'localtime')
        )
      `,
      [
        productKey,
        productName,
        amount,
        serviceDays,
        orderType,
        isActive,
        sortOrder,
        paymentMethod,
        productType,
      ]
    )
  }

  saveDatabase()
  return getAlipayRedpackProductByKey(database, productKey)
}

export const deleteAlipayRedpackProduct = async (db, productKey) => {
  const database = db || (await getDatabase())
  const normalizedKey = normalizeProductKey(productKey)
  if (!normalizedKey) throw new Error('invalid_product_key')

  database.run(
    `
      UPDATE purchase_products
      SET is_active = 0,
          updated_at = DATETIME('now', 'localtime')
      WHERE product_key = ?
        AND COALESCE(NULLIF(TRIM(sales_channel), ''), 'purchase') = 'alipay_redpack'
    `,
    [normalizedKey]
  )
  saveDatabase()
  return getAlipayRedpackProductByKey(database, normalizedKey)
}

export const countAvailableMotherAccounts = async (db) => {
  const database = db || (await getDatabase())
  const result = database.exec(
    `
      SELECT COUNT(*)
      FROM (
        SELECT ga.id
        FROM gpt_accounts ga
        LEFT JOIN redemption_codes rc
          ON lower(trim(rc.account_email)) = lower(trim(ga.email))
         AND COALESCE(rc.is_redeemed, 0) = 0
        LEFT JOIN alipay_redpack_order_mother_accounts ama
          ON ama.account_id = ga.id
         AND COALESCE(ama.status, 'reserved') IN ('reserved', 'delivered')
        WHERE COALESCE(ga.is_open, 0) = 1
          AND COALESCE(ga.is_banned, 0) = 0
          AND ama.id IS NULL
        GROUP BY ga.id
        HAVING COUNT(rc.id) = 4
      )
    `
  )
  return Number(result?.[0]?.values?.[0]?.[0] || 0)
}

