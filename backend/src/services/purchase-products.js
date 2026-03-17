import { getDatabase, saveDatabase } from '../database/init.js'

// NOTE: allow `_` for backward compatibility (e.g. `no_warranty`).
export const PRODUCT_KEY_REGEX = /^[a-z0-9-_]{2,32}$/

const ORDER_TYPE_WARRANTY = 'warranty'
const ORDER_TYPE_NO_WARRANTY = 'no_warranty'
const ORDER_TYPE_ANTI_BAN = 'anti_ban'
const ORDER_TYPE_SET = new Set([ORDER_TYPE_WARRANTY, ORDER_TYPE_NO_WARRANTY, ORDER_TYPE_ANTI_BAN])

export const PURCHASE_PRODUCT_CATEGORY_CODE = 'code'
export const PURCHASE_PRODUCT_CATEGORY_LDC_SHOP = 'ldc_shop'
const PRODUCT_CATEGORY_SET = new Set([PURCHASE_PRODUCT_CATEGORY_CODE, PURCHASE_PRODUCT_CATEGORY_LDC_SHOP])

export const PURCHASE_DELIVERY_MODE_INLINE = 'inline'
export const PURCHASE_DELIVERY_MODE_EMAIL = 'email'
export const PURCHASE_DELIVERY_MODE_BOTH = 'both'
const DELIVERY_MODE_SET = new Set([PURCHASE_DELIVERY_MODE_INLINE, PURCHASE_DELIVERY_MODE_EMAIL, PURCHASE_DELIVERY_MODE_BOTH])

export const PURCHASE_FULFILLMENT_MODE_ITEM_POOL = 'item_pool'
export const PURCHASE_FULFILLMENT_MODE_REDEEM_API = 'redeem_api'
const FULFILLMENT_MODE_SET = new Set([PURCHASE_FULFILLMENT_MODE_ITEM_POOL, PURCHASE_FULFILLMENT_MODE_REDEEM_API])

export const PURCHASE_REDEEM_PROVIDER_YYL = 'yyl'
const REDEEM_PROVIDER_SET = new Set(['', PURCHASE_REDEEM_PROVIDER_YYL])

export const normalizeOrderType = (value) => {
  const normalized = String(value || '').trim().toLowerCase()
  return ORDER_TYPE_SET.has(normalized) ? normalized : ORDER_TYPE_WARRANTY
}

export const normalizeProductCategory = (value, fallback = PURCHASE_PRODUCT_CATEGORY_CODE) => {
  const normalized = String(value || '').trim().toLowerCase()
  return PRODUCT_CATEGORY_SET.has(normalized) ? normalized : fallback
}

export const normalizeDeliveryMode = (value, fallback = PURCHASE_DELIVERY_MODE_EMAIL) => {
  const normalized = String(value || '').trim().toLowerCase()
  return DELIVERY_MODE_SET.has(normalized) ? normalized : fallback
}

export const normalizeFulfillmentMode = (value, fallback = PURCHASE_FULFILLMENT_MODE_ITEM_POOL) => {
  const normalized = String(value || '').trim().toLowerCase()
  return FULFILLMENT_MODE_SET.has(normalized) ? normalized : fallback
}

export const normalizeRedeemProvider = (value, fallback = '') => {
  const normalized = String(value || '').trim().toLowerCase()
  return REDEEM_PROVIDER_SET.has(normalized) ? normalized : fallback
}

export const normalizeProductKey = (value) => {
  const normalized = String(value ?? '').trim().toLowerCase()
  return PRODUCT_KEY_REGEX.test(normalized) ? normalized : ''
}

export const normalizeCodeChannels = (value) => {
  const raw = Array.isArray(value)
    ? value.join(',')
    : String(value ?? '')
  const tokens = raw
    .split(',')
    .map(item => String(item || '').trim().toLowerCase())
    .filter(Boolean)

  const deduped = []
  const seen = new Set()
  for (const token of tokens) {
    if (seen.has(token)) continue
    seen.add(token)
    deduped.push(token)
  }

  return {
    list: deduped,
    stored: deduped.join(',')
  }
}

const mapProductRow = (row) => {
  if (!row) return null
  return {
    id: Number(row[0]),
    productKey: row[1] ? String(row[1]) : '',
    productName: row[2] ? String(row[2]) : '',
    amount: row[3] ? String(row[3]) : '',
    serviceDays: Number(row[4] || 0),
    orderType: row[5] ? String(row[5]) : ORDER_TYPE_WARRANTY,
    codeChannels: row[6] ? String(row[6]) : '',
    isActive: Number(row[7] || 0) === 1,
    sortOrder: Number(row[8] || 0) || 0,
    createdAt: row[9] || null,
    updatedAt: row[10] || null,
    category: normalizeProductCategory(row[11], PURCHASE_PRODUCT_CATEGORY_CODE),
    deliveryMode: normalizeDeliveryMode(row[12], PURCHASE_DELIVERY_MODE_EMAIL),
    fulfillmentMode: normalizeFulfillmentMode(row[13], PURCHASE_FULFILLMENT_MODE_ITEM_POOL),
    redeemProvider: normalizeRedeemProvider(row[14], ''),
  }
}

export async function listPurchaseProducts(db, { activeOnly = false, category = '' } = {}) {
  const database = db || (await getDatabase())
  const clauses = []
  const params = []
  if (activeOnly) {
    clauses.push('COALESCE(is_active, 0) = 1')
  }
  const normalizedCategory = category ? normalizeProductCategory(category, '') : ''
  if (normalizedCategory) {
    clauses.push(`COALESCE(NULLIF(TRIM(category), ''), '${PURCHASE_PRODUCT_CATEGORY_CODE}') = ?`)
    params.push(normalizedCategory)
  }
  const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const result = database.exec(
    `
      SELECT id, product_key, product_name, amount, service_days, order_type, code_channels, COALESCE(is_active, 0), COALESCE(sort_order, 0),
             created_at, updated_at, category, delivery_mode, fulfillment_mode, redeem_provider
      FROM purchase_products
      ${whereClause}
      ORDER BY COALESCE(sort_order, 0) ASC, id ASC
    `,
    params
  )
  return (result[0]?.values || []).map(mapProductRow).filter(Boolean)
}

export async function getPurchaseProductByKey(db, productKey) {
  const key = normalizeProductKey(productKey)
  if (!key) return null
  const database = db || (await getDatabase())
  const result = database.exec(
    `
      SELECT id, product_key, product_name, amount, service_days, order_type, code_channels, COALESCE(is_active, 0), COALESCE(sort_order, 0),
             created_at, updated_at, category, delivery_mode, fulfillment_mode, redeem_provider
      FROM purchase_products
      WHERE product_key = ?
      LIMIT 1
    `,
    [key]
  )
  const row = result[0]?.values?.[0] || null
  return mapProductRow(row)
}

export async function upsertPurchaseProduct(db, payload) {
  const database = db || (await getDatabase())
  if (!payload) return null

  const productKey = normalizeProductKey(payload.productKey || payload.product_key)
  if (!productKey) {
    throw new Error('invalid_product_key')
  }

  const productName = String(payload.productName || payload.product_name || '').trim()
  if (!productName) {
    throw new Error('missing_product_name')
  }

  const amount = String(payload.amount ?? '').trim()
  if (!amount) {
    throw new Error('missing_amount')
  }

  const serviceDays = Number(payload.serviceDays ?? payload.service_days ?? 0)
  if (!Number.isFinite(serviceDays) || serviceDays < 1) {
    throw new Error('invalid_service_days')
  }

  const orderType = normalizeOrderType(payload.orderType || payload.order_type)
  const category = normalizeProductCategory(
    payload.category || payload.productCategory || payload.product_category,
    PURCHASE_PRODUCT_CATEGORY_CODE
  )
  const deliveryMode = normalizeDeliveryMode(payload.deliveryMode || payload.delivery_mode, PURCHASE_DELIVERY_MODE_EMAIL)
  const rawFulfillmentMode = payload.fulfillmentMode || payload.fulfillment_mode
  const fulfillmentMode = normalizeFulfillmentMode(
    rawFulfillmentMode,
    category === PURCHASE_PRODUCT_CATEGORY_LDC_SHOP ? PURCHASE_FULFILLMENT_MODE_ITEM_POOL : PURCHASE_FULFILLMENT_MODE_ITEM_POOL
  )
  const redeemProvider = fulfillmentMode === PURCHASE_FULFILLMENT_MODE_REDEEM_API
    ? normalizeRedeemProvider(payload.redeemProvider || payload.redeem_provider, PURCHASE_REDEEM_PROVIDER_YYL)
    : ''

  const { stored: codeChannelsRaw } = normalizeCodeChannels(payload.codeChannels || payload.code_channels)
  const codeChannels = category === PURCHASE_PRODUCT_CATEGORY_CODE ? codeChannelsRaw : ''
  if (category === PURCHASE_PRODUCT_CATEGORY_CODE && !codeChannels) {
    throw new Error('missing_code_channels')
  }

  const isActive = payload.isActive === undefined ? 1 : (payload.isActive ? 1 : 0)
  const sortOrder = Number.isFinite(Number(payload.sortOrder)) ? Number(payload.sortOrder) : 0

  const exists = database.exec('SELECT id FROM purchase_products WHERE product_key = ? LIMIT 1', [productKey])
  if (exists[0]?.values?.length) {
    database.run(
      `
        UPDATE purchase_products
        SET product_name = ?,
            amount = ?,
            service_days = ?,
            order_type = ?,
            code_channels = ?,
            is_active = ?,
            sort_order = ?,
            category = ?,
            delivery_mode = ?,
            fulfillment_mode = ?,
            redeem_provider = ?,
            updated_at = DATETIME('now', 'localtime')
        WHERE product_key = ?
      `,
      [productName, amount, serviceDays, orderType, codeChannels, isActive, sortOrder, category, deliveryMode, fulfillmentMode, redeemProvider, productKey]
    )
  } else {
    database.run(
      `
        INSERT INTO purchase_products (
          product_key, product_name, amount, service_days, order_type, code_channels, is_active, sort_order, category, delivery_mode, fulfillment_mode, redeem_provider,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))
      `,
      [productKey, productName, amount, serviceDays, orderType, codeChannels, isActive, sortOrder, category, deliveryMode, fulfillmentMode, redeemProvider]
    )
  }

  saveDatabase()
  return getPurchaseProductByKey(database, productKey)
}

export async function disablePurchaseProduct(db, productKey) {
  const database = db || (await getDatabase())
  const key = normalizeProductKey(productKey)
  if (!key) throw new Error('invalid_product_key')
  database.run(
    `
      UPDATE purchase_products
      SET is_active = 0,
          updated_at = DATETIME('now', 'localtime')
      WHERE product_key = ?
    `,
    [key]
  )
  saveDatabase()
  return getPurchaseProductByKey(database, key)
}
