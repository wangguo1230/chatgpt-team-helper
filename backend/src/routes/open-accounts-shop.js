import express from 'express'
import { getDatabase, saveDatabase } from '../database/init.js'
import { authenticateLinuxDoSession } from '../middleware/linuxdo-session.js'
import { requireFeatureEnabled } from '../middleware/feature-flags.js'
import { withLocks } from '../utils/locks.js'
import { buildCreditSign, formatCreditMoney, getCreditGatewayConfig, queryCreditOrder } from '../services/credit-gateway.js'
import {
  getPurchaseProductByKey,
  listPurchaseProducts,
  normalizeDeliveryMode,
  normalizeFulfillmentMode,
  normalizeProductCategory,
  normalizeProductKey,
  PURCHASE_DELIVERY_MODE_BOTH,
  PURCHASE_DELIVERY_MODE_EMAIL,
  PURCHASE_DELIVERY_MODE_INLINE,
  PURCHASE_FULFILLMENT_MODE_ITEM_POOL,
  PURCHASE_FULFILLMENT_MODE_REDEEM_API,
  PURCHASE_PRODUCT_CATEGORY_CODE,
  PURCHASE_REDEEM_PROVIDER_YYL,
  PURCHASE_PRODUCT_CATEGORY_LDC_SHOP
} from '../services/purchase-products.js'
import { sendLdcShopDeliveryEmail } from '../services/email-service.js'
import { redeemCardByCode } from '../services/ldc-card-provider.js'

const router = express.Router()

router.use(requireFeatureEnabled('openAccounts'))
router.use(authenticateLinuxDoSession)

const ITEM_STATUS_AVAILABLE = 'available'
const ITEM_STATUS_RESERVED = 'reserved'
const ITEM_STATUS_SOLD = 'sold'
const ITEM_STATUS_OFFLINE = 'offline'

const REDEEM_CODE_STATUS_AVAILABLE = 'available'
const REDEEM_CODE_STATUS_RESERVED = 'reserved'
const REDEEM_CODE_STATUS_REDEEMED = 'redeemed'
const REDEEM_CODE_STATUS_INVALID = 'invalid'
const REDEEM_CODE_STATUS_FAILED = 'failed'
const REDEEM_CODE_STATUS_OFFLINE = 'offline'

const ORDER_STATUS_CREATED = 'created'
const ORDER_STATUS_PENDING_PAYMENT = 'pending_payment'
const ORDER_STATUS_PAID = 'paid'
const ORDER_STATUS_DELIVERED = 'delivered'
const ORDER_STATUS_DELIVERY_FAILED = 'delivery_failed'
const ORDER_STATUS_FAILED = 'failed'
const ORDER_STATUS_EXPIRED = 'expired'
const ORDER_STATUS_REFUNDED = 'refunded'

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const normalizeUid = (value) => String(value ?? '').trim()
const normalizeUsername = (value) => String(value ?? '').trim()
const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase()
const normalizeOrderNo = (value) => String(value ?? '').trim()
const isValidEmail = (value) => {
  const normalized = normalizeEmail(value)
  return Boolean(normalized) && EMAIL_REGEX.test(normalized)
}

const requiresEmailDelivery = (deliveryMode) => {
  const normalized = normalizeDeliveryMode(deliveryMode, PURCHASE_DELIVERY_MODE_EMAIL)
  return normalized === PURCHASE_DELIVERY_MODE_EMAIL || normalized === PURCHASE_DELIVERY_MODE_BOTH
}

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const getCreditOrderExpireMinutes = () => Math.max(5, toInt(process.env.CREDIT_ORDER_EXPIRE_MINUTES, 15))
const getOrderQueryMinIntervalMs = () => Math.max(2000, toInt(process.env.LDC_SHOP_ORDER_QUERY_MIN_INTERVAL_MS, 8000))
const getRedeemCodeMaxSwitchAttempts = () => Math.max(1, toInt(process.env.LDC_SHOP_REDEEM_CODE_MAX_SWITCH_ATTEMPTS, 3))
const REDEEM_PROVIDER_SET = new Set([PURCHASE_REDEEM_PROVIDER_YYL])

const normalizeProvider = (value) => {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized) return PURCHASE_REDEEM_PROVIDER_YYL
  return REDEEM_PROVIDER_SET.has(normalized) ? normalized : PURCHASE_REDEEM_PROVIDER_YYL
}

const asJsonString = (value, fallback = null) => {
  try {
    if (value == null) return fallback
    return JSON.stringify(value)
  } catch {
    return fallback
  }
}

const cutText = (value, max = 2000) => {
  const text = String(value || '')
  if (text.length <= max) return text
  return `${text.slice(0, max)}...(truncated)`
}

const getPublicBaseUrl = (req) => {
  const configured = String(process.env.PUBLIC_BASE_URL || '').trim()
  if (configured) return configured.replace(/\/+$/, '')
  const protoHeader = req.headers['x-forwarded-proto']
  const protocol = typeof protoHeader === 'string' && protoHeader.trim() ? protoHeader.split(',')[0].trim() : req.protocol
  const host = req.get('host')
  return `${protocol}://${host}`
}

const generateCreditOrderNo = () => {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const rand = Math.floor(Math.random() * 1e6).toString().padStart(6, '0')
  return `S${stamp}${rand}`
}

const buildItemPreview = (content, previewText = '') => {
  const explicit = String(previewText || '').trim()
  if (explicit) return explicit.slice(0, 180)
  const normalized = String(content || '').replace(/\r\n/g, '\n').trim()
  if (!normalized) return ''
  const firstLine = normalized.split('\n').find(line => String(line || '').trim()) || normalized
  return firstLine.slice(0, 180)
}

const nowMs = () => Date.now()

const parseDateMs = (value) => {
  const ms = Date.parse(String(value || ''))
  return Number.isFinite(ms) ? ms : 0
}

const fetchLinuxDoUser = (db, { uid, username }) => {
  const result = db.exec(
    'SELECT uid, username, email FROM linuxdo_users WHERE uid = ? LIMIT 1',
    [uid]
  )
  const row = result[0]?.values?.[0]
  if (row) {
    return {
      uid: String(row[0] || ''),
      username: String(row[1] || username || uid),
      email: String(row[2] || '')
    }
  }

  db.run(
    `
      INSERT INTO linuxdo_users (uid, username, email, current_open_account_id, current_open_account_email, created_at, updated_at)
      VALUES (?, ?, NULL, NULL, NULL, DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))
    `,
    [uid, username || uid]
  )

  return { uid, username: username || uid, email: '' }
}

const fetchLinuxDoUserEmail = (db, uid) => {
  if (!db || !uid) return ''
  const row = db.exec(
    'SELECT email FROM linuxdo_users WHERE uid = ? LIMIT 1',
    [uid]
  )[0]?.values?.[0]
  return row?.[0] ? normalizeEmail(row[0]) : ''
}

const fetchCreditOrder = (db, orderNo) => {
  if (!db || !orderNo) return null
  const row = db.exec(
    `
      SELECT order_no, uid, scene, title, amount, status, pay_url, trade_no, query_at, created_at, paid_at, refunded_at, refund_message
      FROM credit_orders
      WHERE order_no = ?
      LIMIT 1
    `,
    [orderNo]
  )[0]?.values?.[0]

  if (!row) return null
  return {
    orderNo: String(row[0] || ''),
    uid: String(row[1] || ''),
    scene: String(row[2] || ''),
    title: String(row[3] || ''),
    amount: String(row[4] || ''),
    status: String(row[5] || ''),
    payUrl: row[6] ? String(row[6]) : null,
    tradeNo: row[7] ? String(row[7]) : null,
    queryAt: row[8] || null,
    createdAt: row[9] || null,
    paidAt: row[10] || null,
    refundedAt: row[11] || null,
    refundMessage: row[12] ? String(row[12]) : null
  }
}

const fetchShopOrder = (db, orderNo) => {
  if (!db || !orderNo) return null
  const row = db.exec(
    `
      SELECT id, order_no, credit_order_no, uid, username, user_email, product_key, product_name, amount,
             delivery_mode, fulfillment_mode, redeem_provider, item_id, redeem_code_id, item_preview, status, paid_at,
             delivery_inline_content, delivery_inline_at, delivery_email_to, delivery_email_sent_at, delivery_error,
             created_at, updated_at
      FROM ldc_shop_orders
      WHERE order_no = ?
      LIMIT 1
    `,
    [orderNo]
  )[0]?.values?.[0]

  if (!row) return null
  return {
    id: Number(row[0]),
    orderNo: String(row[1] || ''),
    creditOrderNo: row[2] ? String(row[2]) : String(row[1] || ''),
    uid: String(row[3] || ''),
    username: row[4] ? String(row[4]) : '',
    userEmail: row[5] ? String(row[5]) : '',
    productKey: String(row[6] || ''),
    productName: String(row[7] || ''),
    amount: String(row[8] || ''),
    deliveryMode: normalizeDeliveryMode(row[9], PURCHASE_DELIVERY_MODE_EMAIL),
    fulfillmentMode: normalizeFulfillmentMode(row[10], PURCHASE_FULFILLMENT_MODE_ITEM_POOL),
    redeemProvider: normalizeProvider(row[11]),
    itemId: row[12] != null ? Number(row[12]) : null,
    redeemCodeId: row[13] != null ? Number(row[13]) : null,
    itemPreview: row[14] ? String(row[14]) : '',
    status: String(row[15] || ORDER_STATUS_CREATED),
    paidAt: row[16] || null,
    deliveryInlineContent: row[17] ? String(row[17]) : '',
    deliveryInlineAt: row[18] || null,
    deliveryEmailTo: row[19] ? String(row[19]) : '',
    deliveryEmailSentAt: row[20] || null,
    deliveryError: row[21] ? String(row[21]) : '',
    createdAt: row[22] || null,
    updatedAt: row[23] || null
  }
}

const fetchShopItemById = (db, itemId) => {
  if (!db || !Number.isFinite(Number(itemId)) || Number(itemId) <= 0) return null
  const row = db.exec(
    `
      SELECT id, product_key, content, preview_text, status, reserved_order_no, sold_order_no, reserved_at, sold_at, created_at, updated_at
      FROM purchase_product_items
      WHERE id = ?
      LIMIT 1
    `,
    [Number(itemId)]
  )[0]?.values?.[0]

  if (!row) return null
  return {
    id: Number(row[0]),
    productKey: String(row[1] || ''),
    content: String(row[2] || ''),
    previewText: buildItemPreview(row[2], row[3]),
    status: String(row[4] || ITEM_STATUS_AVAILABLE),
    reservedOrderNo: row[5] ? String(row[5]) : '',
    soldOrderNo: row[6] ? String(row[6]) : '',
    reservedAt: row[7] || null,
    soldAt: row[8] || null,
    createdAt: row[9] || null,
    updatedAt: row[10] || null
  }
}

const fetchRedeemCodeById = (db, codeId) => {
  if (!db || !Number.isFinite(Number(codeId)) || Number(codeId) <= 0) return null
  const row = db.exec(
    `
      SELECT id, product_key, redeem_code, provider, status, reserved_order_no, reserved_at, used_order_no, used_at,
             card_snapshot, last_error, attempt_count, last_attempt_at, created_at, updated_at
      FROM ldc_shop_redeem_codes
      WHERE id = ?
      LIMIT 1
    `,
    [Number(codeId)]
  )[0]?.values?.[0]
  if (!row) return null
  return {
    id: Number(row[0]),
    productKey: String(row[1] || ''),
    code: String(row[2] || ''),
    provider: normalizeProvider(row[3]),
    status: String(row[4] || REDEEM_CODE_STATUS_AVAILABLE),
    reservedOrderNo: row[5] ? String(row[5]) : '',
    reservedAt: row[6] || null,
    usedOrderNo: row[7] ? String(row[7]) : '',
    usedAt: row[8] || null,
    cardSnapshot: row[9] ? safeJsonParseObject(row[9]) : null,
    lastError: row[10] ? String(row[10]) : '',
    attemptCount: Number(row[11] || 0),
    lastAttemptAt: row[12] || null,
    createdAt: row[13] || null,
    updatedAt: row[14] || null
  }
}

const safeJsonParseObject = (value) => {
  try {
    const parsed = JSON.parse(String(value || ''))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

const maskCodePreview = (code) => {
  const raw = String(code || '').trim()
  if (!raw) return ''
  if (raw.length <= 4) return `${raw.slice(0, 1)}***`
  return `${raw.slice(0, 4)}***${raw.slice(-2)}`
}

const reserveRedeemCodeForOrder = (db, { productKey, orderNo, provider = PURCHASE_REDEEM_PROVIDER_YYL }) => {
  const candidate = db.exec(
    `
      SELECT id
      FROM ldc_shop_redeem_codes
      WHERE product_key = ?
        AND provider = ?
        AND status = 'available'
      ORDER BY id ASC
      LIMIT 1
    `,
    [productKey, normalizeProvider(provider)]
  )[0]?.values?.[0]
  if (!candidate) return null

  const codeId = Number(candidate[0])
  db.run(
    `
      UPDATE ldc_shop_redeem_codes
      SET status = 'reserved',
          reserved_order_no = ?,
          reserved_at = DATETIME('now', 'localtime'),
          updated_at = DATETIME('now', 'localtime')
      WHERE id = ?
        AND status = 'available'
    `,
    [orderNo, codeId]
  )

  const reserved = fetchRedeemCodeById(db, codeId)
  if (!reserved || reserved.status !== REDEEM_CODE_STATUS_RESERVED || reserved.reservedOrderNo !== orderNo) {
    return null
  }
  return reserved
}

const releaseReservedCodeByOrderNo = (db, orderNo) => {
  if (!db || !orderNo) return false
  db.run(
    `
      UPDATE ldc_shop_redeem_codes
      SET status = 'available',
          reserved_order_no = NULL,
          reserved_at = NULL,
          updated_at = DATETIME('now', 'localtime')
      WHERE reserved_order_no = ?
        AND status = 'reserved'
    `,
    [orderNo]
  )
  return true
}

const releaseReservedResourceByOrderNo = (db, orderNo) => {
  releaseReservedItemByOrderNo(db, orderNo)
  releaseReservedCodeByOrderNo(db, orderNo)
}

const markRedeemCodeInvalid = (db, codeId, { orderNo, errorCode }) => {
  if (!db || !Number.isFinite(Number(codeId)) || Number(codeId) <= 0) return
  db.run(
    `
      UPDATE ldc_shop_redeem_codes
      SET status = 'invalid',
          used_order_no = COALESCE(?, used_order_no),
          used_at = COALESCE(used_at, DATETIME('now', 'localtime')),
          reserved_order_no = NULL,
          reserved_at = NULL,
          last_error = ?,
          attempt_count = COALESCE(attempt_count, 0) + 1,
          last_attempt_at = DATETIME('now', 'localtime'),
          updated_at = DATETIME('now', 'localtime')
      WHERE id = ?
    `,
    [orderNo || null, cutText(errorCode || 'redeem_code_invalid', 120), Number(codeId)]
  )
}

const markRedeemCodeFailed = (db, codeId, { errorCode }) => {
  if (!db || !Number.isFinite(Number(codeId)) || Number(codeId) <= 0) return
  db.run(
    `
      UPDATE ldc_shop_redeem_codes
      SET status = CASE WHEN status = 'reserved' THEN 'reserved' ELSE 'failed' END,
          last_error = ?,
          attempt_count = COALESCE(attempt_count, 0) + 1,
          last_attempt_at = DATETIME('now', 'localtime'),
          updated_at = DATETIME('now', 'localtime')
      WHERE id = ?
    `,
    [cutText(errorCode || 'redeem_failed', 120), Number(codeId)]
  )
}

const markRedeemCodeRedeemed = (db, codeId, { orderNo, card }) => {
  if (!db || !Number.isFinite(Number(codeId)) || Number(codeId) <= 0) return
  db.run(
    `
      UPDATE ldc_shop_redeem_codes
      SET status = 'redeemed',
          used_order_no = ?,
          used_at = COALESCE(used_at, DATETIME('now', 'localtime')),
          reserved_order_no = NULL,
          reserved_at = NULL,
          card_snapshot = ?,
          last_error = NULL,
          attempt_count = COALESCE(attempt_count, 0) + 1,
          last_attempt_at = DATETIME('now', 'localtime'),
          updated_at = DATETIME('now', 'localtime')
      WHERE id = ?
    `,
    [orderNo, asJsonString(card, null), Number(codeId)]
  )
}

const logDeliveryAttempts = (db, order, redeemCode, steps = []) => {
  if (!db || !order?.orderNo || !Array.isArray(steps) || steps.length === 0) return
  for (const step of steps) {
    db.run(
      `
        INSERT INTO ldc_shop_delivery_attempts (
          order_no, product_key, code_id, redeem_code, provider, phase, success, http_status,
          error_code, error_message, request_payload, response_payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, DATETIME('now', 'localtime'))
      `,
      [
        order.orderNo,
        order.productKey || null,
        redeemCode?.id || order.redeemCodeId || null,
        redeemCode?.code || null,
        normalizeProvider(redeemCode?.provider || order.redeemProvider || PURCHASE_REDEEM_PROVIDER_YYL),
        String(step?.phase || 'unknown'),
        step?.ok ? 1 : 0,
        Number.isFinite(Number(step?.status)) ? Number(step.status) : null,
        cutText(step?.errorCode || '', 120) || null,
        cutText(step?.errorMessage || '', 500) || null,
        cutText(step?.requestPayload || '', 3000) || null,
        cutText(step?.responsePayload || '', 3000) || null
      ]
    )
  }
}

const markCreditOrderPending = (db, orderNo) => {
  db.run(
    `
      UPDATE credit_orders
      SET status = CASE WHEN status = 'created' THEN 'pending_payment' ELSE status END,
          updated_at = DATETIME('now', 'localtime')
      WHERE order_no = ?
    `,
    [orderNo]
  )
}

const markOrderExpiredIfPending = (db, orderNo) => {
  db.run(
    `
      UPDATE ldc_shop_orders
      SET status = CASE WHEN status IN ('created', 'pending_payment') THEN 'expired' ELSE status END,
          updated_at = DATETIME('now', 'localtime')
      WHERE order_no = ?
    `,
    [orderNo]
  )
}

const releaseReservedItemByOrderNo = (db, orderNo) => {
  if (!db || !orderNo) return false
  db.run(
    `
      UPDATE purchase_product_items
      SET status = 'available',
          reserved_order_no = NULL,
          reserved_at = NULL,
          updated_at = DATETIME('now', 'localtime')
      WHERE reserved_order_no = ?
        AND status = 'reserved'
    `,
    [orderNo]
  )
  return true
}

const cleanupExpiredReservations = (db) => {
  if (!db) return 0
  const itemRows = db.exec(
    `
      SELECT i.id, i.reserved_order_no, co.status, co.created_at
      FROM purchase_product_items i
      LEFT JOIN credit_orders co ON co.order_no = i.reserved_order_no
      WHERE i.status = 'reserved'
        AND i.reserved_order_no IS NOT NULL
        AND TRIM(i.reserved_order_no) != ''
    `
  )[0]?.values || []

  let released = 0
  for (const row of itemRows) {
    const itemId = Number(row[0])
    const orderNo = normalizeOrderNo(row[1])
    const creditStatus = row[2] ? String(row[2]) : ''
    if (!itemId || !orderNo) continue

    let shouldRelease = false
    if (!creditStatus) {
      shouldRelease = true
    } else if ([ORDER_STATUS_FAILED, ORDER_STATUS_EXPIRED, ORDER_STATUS_REFUNDED].includes(creditStatus)) {
      shouldRelease = true
    }

    if (!shouldRelease) continue

    db.run(
      `
        UPDATE purchase_product_items
        SET status = 'available',
            reserved_order_no = NULL,
            reserved_at = NULL,
            updated_at = DATETIME('now', 'localtime')
        WHERE id = ?
          AND status = 'reserved'
      `,
      [itemId]
    )

    markOrderExpiredIfPending(db, orderNo)
    released += 1
  }

  const codeRows = db.exec(
    `
      SELECT c.id, c.reserved_order_no, co.status
      FROM ldc_shop_redeem_codes c
      LEFT JOIN credit_orders co ON co.order_no = c.reserved_order_no
      WHERE c.status = 'reserved'
        AND c.reserved_order_no IS NOT NULL
        AND TRIM(c.reserved_order_no) != ''
    `
  )[0]?.values || []

  for (const row of codeRows) {
    const codeId = Number(row[0])
    const orderNo = normalizeOrderNo(row[1])
    const creditStatus = row[2] ? String(row[2]) : ''
    if (!codeId || !orderNo) continue

    let shouldRelease = false
    if (!creditStatus) {
      shouldRelease = true
    } else if ([ORDER_STATUS_FAILED, ORDER_STATUS_EXPIRED, ORDER_STATUS_REFUNDED].includes(creditStatus)) {
      shouldRelease = true
    }
    if (!shouldRelease) continue

    db.run(
      `
        UPDATE ldc_shop_redeem_codes
        SET status = 'available',
            reserved_order_no = NULL,
            reserved_at = NULL,
            updated_at = DATETIME('now', 'localtime')
        WHERE id = ?
          AND status = 'reserved'
      `,
      [codeId]
    )
    markOrderExpiredIfPending(db, orderNo)
    released += 1
  }

  if (released > 0) {
    saveDatabase()
  }

  return released
}

const reserveItemForOrder = (db, { productKey, orderNo }) => {
  const candidate = db.exec(
    `
      SELECT id, content, preview_text
      FROM purchase_product_items
      WHERE product_key = ?
        AND status = 'available'
      ORDER BY id ASC
      LIMIT 1
    `,
    [productKey]
  )[0]?.values?.[0]

  if (!candidate) return null

  const itemId = Number(candidate[0])
  db.run(
    `
      UPDATE purchase_product_items
      SET status = 'reserved',
          reserved_order_no = ?,
          reserved_at = DATETIME('now', 'localtime'),
          updated_at = DATETIME('now', 'localtime')
      WHERE id = ?
        AND status = 'available'
    `,
    [orderNo, itemId]
  )

  const reserved = fetchShopItemById(db, itemId)
  if (!reserved || reserved.status !== ITEM_STATUS_RESERVED || reserved.reservedOrderNo !== orderNo) {
    return null
  }

  return reserved
}

const buildCreditPayRequest = ({ req, uid, orderNo, title, amount, pid, key, baseUrl }) => {
  const notifyUrl = `${getPublicBaseUrl(req)}/credit/notify`
  const returnUrl = `${getPublicBaseUrl(req)}/redeem/open-accounts`
  const submitUrl = `${String(baseUrl || '').replace(/\/+$/, '')}/pay/submit.php`

  const payParams = {
    pid,
    type: 'epay',
    out_trade_no: orderNo,
    name: title,
    money: amount,
    notify_url: notifyUrl,
    return_url: returnUrl,
    device: uid
  }
  const sign = buildCreditSign(payParams, key)

  return {
    payUrl: null,
    payRequest: {
      method: 'POST',
      url: submitUrl,
      fields: {
        ...payParams,
        sign,
        sign_type: 'MD5'
      }
    }
  }
}

const shouldSyncCreditOrder = (creditOrder) => {
  if (!creditOrder) return false
  if (![ORDER_STATUS_CREATED, ORDER_STATUS_PENDING_PAYMENT].includes(creditOrder.status)) return false
  const last = parseDateMs(creditOrder.queryAt)
  if (!last) return true
  return nowMs() - last > getOrderQueryMinIntervalMs()
}

const syncCreditOrderFromGateway = async (db, creditOrder) => {
  if (!db || !creditOrder) return creditOrder
  if (!shouldSyncCreditOrder(creditOrder)) return creditOrder

  const query = await queryCreditOrder({ tradeNo: '', outTradeNo: creditOrder.orderNo })
  const queryPayload = query?.ok ? query.data : query
  const queryStatus = query?.ok ? Number(query?.data?.status ?? null) : null

  db.run(
    `
      UPDATE credit_orders
      SET query_payload = ?,
          query_at = DATETIME('now', 'localtime'),
          query_status = ?,
          updated_at = DATETIME('now', 'localtime')
      WHERE order_no = ?
    `,
    [queryPayload ? JSON.stringify(queryPayload) : null, Number.isFinite(queryStatus) ? queryStatus : null, creditOrder.orderNo]
  )

  if (query.ok) {
    const data = query.data || {}
    const paidStatus = Number(data.status || 0)
    if (Number.isFinite(paidStatus) && paidStatus === 1) {
      const paidAt = data.endtime ? String(data.endtime) : null
      db.run(
        `
          UPDATE credit_orders
          SET status = 'paid',
              paid_at = COALESCE(?, DATETIME('now', 'localtime')),
              trade_no = COALESCE(?, trade_no),
              updated_at = DATETIME('now', 'localtime')
          WHERE order_no = ?
        `,
        [paidAt, data.trade_no ? String(data.trade_no) : null, creditOrder.orderNo]
      )
    }
  }

  saveDatabase()
  return fetchCreditOrder(db, creditOrder.orderNo)
}

const buildShopOrderResponse = (order, { includeInlineContent = false, includeCreditOrderNo = false } = {}) => {
  const deliveryMode = normalizeDeliveryMode(order?.deliveryMode, PURCHASE_DELIVERY_MODE_EMAIL)
  const showInline = includeInlineContent && [PURCHASE_DELIVERY_MODE_INLINE, PURCHASE_DELIVERY_MODE_BOTH].includes(deliveryMode)

  const payload = {
    orderNo: order?.orderNo || '',
    productKey: order?.productKey || '',
    productName: order?.productName || '',
    amount: order?.amount || '',
    status: order?.status || ORDER_STATUS_CREATED,
    deliveryMode,
    fulfillmentMode: normalizeFulfillmentMode(order?.fulfillmentMode, PURCHASE_FULFILLMENT_MODE_ITEM_POOL),
    itemPreview: order?.itemPreview || '',
    userEmail: order?.userEmail || '',
    createdAt: order?.createdAt || null,
    paidAt: order?.paidAt || null,
    deliveryInlineAt: order?.deliveryInlineAt || null,
    deliveryEmailSentAt: order?.deliveryEmailSentAt || null,
    deliveryError: order?.deliveryError || null,
    delivery: {
      mode: deliveryMode,
      inlineContent: showInline ? (order?.deliveryInlineContent || '') : null,
      emailSentAt: order?.deliveryEmailSentAt || null,
      emailTo: order?.deliveryEmailTo || null
    }
  }

  if (includeCreditOrderNo) {
    payload.creditOrderNo = order?.creditOrderNo || order?.orderNo || ''
  }

  return payload
}

const markShopOrderStatusFromCredit = (db, orderNo, creditOrder) => {
  if (!db || !orderNo || !creditOrder) return
  const creditStatus = String(creditOrder.status || '')
  if (creditStatus === ORDER_STATUS_PAID) {
    db.run(
      `
        UPDATE ldc_shop_orders
        SET status = CASE WHEN status IN ('created', 'pending_payment') THEN 'paid' ELSE status END,
            paid_at = COALESCE(paid_at, ?, DATETIME('now', 'localtime')),
            updated_at = DATETIME('now', 'localtime')
        WHERE order_no = ?
      `,
      [creditOrder.paidAt || null, orderNo]
    )
    return
  }

  if (creditStatus === ORDER_STATUS_REFUNDED) {
    db.run(
      `
        UPDATE ldc_shop_orders
        SET status = CASE WHEN status IN ('created', 'pending_payment', 'paid') THEN 'refunded' ELSE status END,
            updated_at = DATETIME('now', 'localtime')
        WHERE order_no = ?
      `,
      [orderNo]
    )
    releaseReservedResourceByOrderNo(db, orderNo)
    return
  }

  if (creditStatus === ORDER_STATUS_FAILED || creditStatus === ORDER_STATUS_EXPIRED) {
    db.run(
      `
        UPDATE ldc_shop_orders
        SET status = CASE WHEN status IN ('created', 'pending_payment') THEN ? ELSE status END,
            updated_at = DATETIME('now', 'localtime')
        WHERE order_no = ?
      `,
      [creditStatus, orderNo]
    )
    releaseReservedResourceByOrderNo(db, orderNo)
  }
}

const resolveDeliveryEmail = (db, order) => {
  let emailTo = normalizeEmail(order?.deliveryEmailTo || order?.userEmail)
  if (isValidEmail(emailTo)) return emailTo

  const latestUserEmail = fetchLinuxDoUserEmail(db, order?.uid)
  if (!isValidEmail(latestUserEmail)) return emailTo

  emailTo = latestUserEmail
  db.run(
    `
      UPDATE ldc_shop_orders
      SET user_email = ?,
          updated_at = DATETIME('now', 'localtime')
      WHERE order_no = ?
    `,
    [latestUserEmail, order.orderNo]
  )
  db.run(
    `
      UPDATE credit_orders
      SET order_email = ?,
          updated_at = DATETIME('now', 'localtime')
      WHERE order_no = ?
    `,
    [latestUserEmail, order.creditOrderNo || order.orderNo]
  )
  return emailTo
}

const finalizeOrderDelivery = async (db, order, { content, contentAt, deliveryMode, errorMessage = '' }) => {
  const requiresInline = deliveryMode === PURCHASE_DELIVERY_MODE_INLINE || deliveryMode === PURCHASE_DELIVERY_MODE_BOTH
  const requiresEmail = requiresEmailDelivery(deliveryMode)

  const inlineContent = requiresInline ? String(content || '').trim() : ''
  const inlineAt = requiresInline ? (contentAt || new Date().toISOString()) : null
  const emailTo = requiresEmail ? resolveDeliveryEmail(db, order) : ''
  let emailSentAt = order.deliveryEmailSentAt || null
  let deliveryError = String(errorMessage || '').trim()

  if (!deliveryError && requiresEmail && !emailSentAt) {
    if (!isValidEmail(emailTo)) {
      deliveryError = '用户邮箱未配置或格式不正确，无法发送邮件'
    } else {
      const sent = await sendLdcShopDeliveryEmail({
        to: emailTo,
        orderNo: order.orderNo,
        productName: order.productName,
        content: inlineContent || String(content || '').trim()
      })
      logDeliveryAttempts(db, order, null, [{
        phase: 'email_delivery',
        ok: Boolean(sent),
        status: null,
        errorCode: sent ? '' : 'email_send_failed',
        errorMessage: sent ? '' : '邮件发送失败，请稍后重试',
        requestPayload: asJsonString({ to: emailTo }, ''),
        responsePayload: ''
      }])
      if (sent) {
        emailSentAt = new Date().toISOString()
      } else {
        deliveryError = '邮件发送失败，请稍后重试'
      }
    }
  }

  const delivered = (!requiresEmail || Boolean(emailSentAt)) && (!requiresInline || Boolean(inlineContent))
  const nextStatus = delivered ? ORDER_STATUS_DELIVERED : ORDER_STATUS_DELIVERY_FAILED

  db.run(
    `
      UPDATE ldc_shop_orders
      SET status = ?,
          paid_at = COALESCE(paid_at, DATETIME('now', 'localtime')),
          delivery_inline_content = ?,
          delivery_inline_at = ?,
          delivery_email_to = ?,
          delivery_email_sent_at = ?,
          delivery_error = ?,
          updated_at = DATETIME('now', 'localtime')
      WHERE order_no = ?
    `,
    [
      nextStatus,
      requiresInline ? inlineContent : null,
      requiresInline ? inlineAt : null,
      requiresEmail ? (emailTo || null) : null,
      requiresEmail ? (emailSentAt || null) : null,
      deliveryError || null,
      order.orderNo
    ]
  )

  saveDatabase()
  return fetchShopOrder(db, order.orderNo)
}

const fulfillPaidItemPoolOrder = async (db, order) => {
  if (!db || !order) return fetchShopOrder(db, order?.orderNo)

  const item = fetchShopItemById(db, order.itemId)
  if (!item || !item.content) {
    db.run(
      `
        UPDATE ldc_shop_orders
        SET status = 'delivery_failed',
            delivery_error = ?,
            updated_at = DATETIME('now', 'localtime')
        WHERE order_no = ?
      `,
      ['商品条目不存在或内容为空', order.orderNo]
    )
    saveDatabase()
    return fetchShopOrder(db, order.orderNo)
  }

  if (item.status === ITEM_STATUS_SOLD && item.soldOrderNo && item.soldOrderNo !== order.orderNo) {
    db.run(
      `
        UPDATE ldc_shop_orders
        SET status = 'delivery_failed',
            delivery_error = ?,
            updated_at = DATETIME('now', 'localtime')
        WHERE order_no = ?
      `,
      ['商品条目已被其他订单占用', order.orderNo]
    )
    saveDatabase()
    return fetchShopOrder(db, order.orderNo)
  }

  if (item.status !== ITEM_STATUS_SOLD) {
    db.run(
      `
        UPDATE purchase_product_items
        SET status = 'sold',
            sold_order_no = ?,
            sold_at = COALESCE(sold_at, DATETIME('now', 'localtime')),
            reserved_order_no = CASE WHEN reserved_order_no = ? THEN NULL ELSE reserved_order_no END,
            reserved_at = CASE WHEN reserved_order_no = ? THEN NULL ELSE reserved_at END,
            updated_at = DATETIME('now', 'localtime')
        WHERE id = ?
      `,
      [order.orderNo, order.orderNo, order.orderNo, item.id]
    )
  }

  const deliveryMode = normalizeDeliveryMode(order.deliveryMode, PURCHASE_DELIVERY_MODE_EMAIL)
  const content = String(order.deliveryInlineContent || '').trim() || item.content
  return finalizeOrderDelivery(db, order, {
    content,
    contentAt: order.deliveryInlineAt || new Date().toISOString(),
    deliveryMode
  })
}

const bindReservedRedeemCodeToOrder = (db, order, redeemCode) => {
  if (!db || !order?.orderNo || !redeemCode?.id) return
  db.run(
    `
      UPDATE ldc_shop_orders
      SET redeem_code_id = ?,
          item_preview = ?,
          updated_at = DATETIME('now', 'localtime')
      WHERE order_no = ?
    `,
    [redeemCode.id, maskCodePreview(redeemCode.code) || null, order.orderNo]
  )
}

const fulfillPaidRedeemApiOrder = async (db, order) => {
  if (!db || !order) return fetchShopOrder(db, order?.orderNo)
  const deliveryMode = normalizeDeliveryMode(order.deliveryMode, PURCHASE_DELIVERY_MODE_BOTH)
  const provider = normalizeProvider(order.redeemProvider || PURCHASE_REDEEM_PROVIDER_YYL)
  const maxSwitchAttempts = getRedeemCodeMaxSwitchAttempts()

  let content = String(order.deliveryInlineContent || '').trim()
  let contentAt = order.deliveryInlineAt || null

  let redeemCode = order.redeemCodeId ? fetchRedeemCodeById(db, order.redeemCodeId) : null
  if (!content && redeemCode?.status === REDEEM_CODE_STATUS_REDEEMED) {
    const snapshotContent = String(redeemCode.cardSnapshot?.formattedContent || '').trim()
    if (snapshotContent) {
      content = snapshotContent
      contentAt = contentAt || new Date().toISOString()
    }
  }

  if (!content) {
    let switchCount = 0
    let lastError = ''

    while (switchCount < maxSwitchAttempts) {
      if (
        !redeemCode ||
        redeemCode.productKey !== order.productKey ||
        redeemCode.provider !== provider ||
        redeemCode.status === REDEEM_CODE_STATUS_INVALID ||
        redeemCode.status === REDEEM_CODE_STATUS_REDEEMED ||
        redeemCode.status === REDEEM_CODE_STATUS_OFFLINE ||
        (redeemCode.status === REDEEM_CODE_STATUS_RESERVED && redeemCode.reservedOrderNo !== order.orderNo)
      ) {
        redeemCode = reserveRedeemCodeForOrder(db, {
          productKey: order.productKey,
          orderNo: order.orderNo,
          provider
        })
        if (!redeemCode) {
          lastError = '暂无可用兑换码，请联系管理员补货'
          break
        }
        bindReservedRedeemCodeToOrder(db, order, redeemCode)
      }

      const redeemResult = await redeemCardByCode({
        code: redeemCode.code,
        provider: redeemCode.provider
      })
      logDeliveryAttempts(db, order, redeemCode, redeemResult?.steps || [])

      if (redeemResult?.ok && redeemResult.card?.formattedContent) {
        content = String(redeemResult.card.formattedContent || '').trim()
        contentAt = new Date().toISOString()
        markRedeemCodeRedeemed(db, redeemCode.id, {
          orderNo: order.orderNo,
          card: redeemResult.card
        })
        break
      }

      const errorCode = String(redeemResult?.errorCode || redeemResult?.errorMessage || 'redeem_failed')
      if (redeemResult?.invalid) {
        markRedeemCodeInvalid(db, redeemCode.id, {
          orderNo: order.orderNo,
          errorCode
        })
        db.run(
          `
            UPDATE ldc_shop_orders
            SET redeem_code_id = NULL,
                updated_at = DATETIME('now', 'localtime')
            WHERE order_no = ?
          `,
          [order.orderNo]
        )
        redeemCode = null
        switchCount += 1
        lastError = '兑换码失效，已自动切换下一张'
        continue
      }

      markRedeemCodeFailed(db, redeemCode.id, { errorCode })
      lastError = cutText(errorCode, 180)
      break
    }

    if (!content) {
      db.run(
        `
          UPDATE ldc_shop_orders
          SET status = 'delivery_failed',
              delivery_error = ?,
              updated_at = DATETIME('now', 'localtime')
          WHERE order_no = ?
        `,
        [lastError || '发卡失败，请稍后重试', order.orderNo]
      )
      saveDatabase()
      return fetchShopOrder(db, order.orderNo)
    }
  }

  return finalizeOrderDelivery(db, order, {
    content,
    contentAt: contentAt || new Date().toISOString(),
    deliveryMode
  })
}

const fulfillPaidOrder = async (db, order) => {
  if (!db || !order) return fetchShopOrder(db, order?.orderNo)
  if (![ORDER_STATUS_PAID, ORDER_STATUS_DELIVERY_FAILED, ORDER_STATUS_CREATED, ORDER_STATUS_PENDING_PAYMENT].includes(order.status)) {
    return fetchShopOrder(db, order.orderNo)
  }

  const fulfillmentMode = normalizeFulfillmentMode(order.fulfillmentMode, PURCHASE_FULFILLMENT_MODE_ITEM_POOL)
  if (fulfillmentMode === PURCHASE_FULFILLMENT_MODE_REDEEM_API) {
    return fulfillPaidRedeemApiOrder(db, order)
  }
  return fulfillPaidItemPoolOrder(db, order)
}

const settleShopOrderByCreditOrderNo = async (db, orderNo, { syncCredit = false } = {}) => {
  if (!db || !orderNo) return { ok: false, reason: 'missing_order_no' }

  cleanupExpiredReservations(db)

  let order = fetchShopOrder(db, orderNo)
  if (!order) return { ok: false, reason: 'order_not_found' }

  let creditOrder = fetchCreditOrder(db, order.creditOrderNo || orderNo)
  if (!creditOrder) return { ok: false, reason: 'credit_order_not_found' }

  if (syncCredit && shouldSyncCreditOrder(creditOrder)) {
    creditOrder = await syncCreditOrderFromGateway(db, creditOrder)
  }

  markShopOrderStatusFromCredit(db, orderNo, creditOrder)
  saveDatabase()

  order = fetchShopOrder(db, orderNo) || order

  if (creditOrder.status === ORDER_STATUS_PAID) {
    order = await fulfillPaidOrder(db, order)
  }

  if (order.status === ORDER_STATUS_CREATED && creditOrder.status === ORDER_STATUS_PENDING_PAYMENT) {
    db.run(
      `
        UPDATE ldc_shop_orders
        SET status = 'pending_payment',
            updated_at = DATETIME('now', 'localtime')
        WHERE order_no = ?
      `,
      [orderNo]
    )
    saveDatabase()
    order = fetchShopOrder(db, orderNo) || order
  }

  return { ok: true, order, creditOrder }
}

export const settleLdcShopOrderByCreditOrderNo = async ({ orderNo, syncCredit = false, source = 'internal' } = {}) => {
  const normalizedOrderNo = normalizeOrderNo(orderNo)
  if (!normalizedOrderNo) return { ok: false, reason: 'missing_order_no', source }

  try {
    const db = await getDatabase()
    return await withLocks([`ldc-shop:order:${normalizedOrderNo}`], async () => {
      const settled = await settleShopOrderByCreditOrderNo(db, normalizedOrderNo, { syncCredit })
      if (!settled.ok) {
        return { ...settled, orderNo: normalizedOrderNo, source }
      }
      return {
        ok: true,
        orderNo: normalizedOrderNo,
        source,
        creditStatus: settled.creditOrder?.status || '',
        shopStatus: settled.order?.status || ''
      }
    })
  } catch (error) {
    console.warn('[LdcShop] settle order failed', {
      orderNo: normalizedOrderNo,
      source,
      message: error?.message || String(error)
    })
    return { ok: false, reason: 'internal_error', orderNo: normalizedOrderNo, source }
  }
}

router.get('/products', async (req, res) => {
  try {
    const db = await getDatabase()
    cleanupExpiredReservations(db)

    const products = await listPurchaseProducts(db, {
      activeOnly: true,
      category: PURCHASE_PRODUCT_CATEGORY_LDC_SHOP
    })

    const activeProducts = products.filter(item => Boolean(item?.productKey) && Boolean(item?.isActive))
    if (!activeProducts.length) {
      return res.json({ products: [] })
    }

    const stockMap = {}
    const itemPoolKeys = activeProducts
      .filter(item => normalizeFulfillmentMode(item.fulfillmentMode, PURCHASE_FULFILLMENT_MODE_ITEM_POOL) === PURCHASE_FULFILLMENT_MODE_ITEM_POOL)
      .map(item => item.productKey)
    if (itemPoolKeys.length > 0) {
      const placeholders = itemPoolKeys.map(() => '?').join(',')
      const countsResult = db.exec(
        `
          SELECT product_key, COUNT(*)
          FROM purchase_product_items
          WHERE status = 'available'
            AND product_key IN (${placeholders})
          GROUP BY product_key
        `,
        itemPoolKeys
      )[0]?.values || []
      for (const row of countsResult) {
        const key = String(row?.[0] || '')
        if (!key) continue
        stockMap[key] = Number(row?.[1] || 0)
      }
    }

    const redeemKeys = activeProducts
      .filter(item => normalizeFulfillmentMode(item.fulfillmentMode, PURCHASE_FULFILLMENT_MODE_ITEM_POOL) === PURCHASE_FULFILLMENT_MODE_REDEEM_API)
      .map(item => item.productKey)
    if (redeemKeys.length > 0) {
      const placeholders = redeemKeys.map(() => '?').join(',')
      const countsResult = db.exec(
        `
          SELECT product_key, COUNT(*)
          FROM ldc_shop_redeem_codes
          WHERE status = 'available'
            AND product_key IN (${placeholders})
          GROUP BY product_key
        `,
        redeemKeys
      )[0]?.values || []
      for (const row of countsResult) {
        const key = String(row?.[0] || '')
        if (!key) continue
        stockMap[key] = Number(row?.[1] || 0)
      }
    }

    const response = activeProducts.map(item => ({
      productKey: item.productKey,
      productName: item.productName,
      amount: item.amount,
      serviceDays: Number(item.serviceDays || 0),
      deliveryMode: normalizeDeliveryMode(item.deliveryMode, PURCHASE_DELIVERY_MODE_EMAIL),
      fulfillmentMode: normalizeFulfillmentMode(item.fulfillmentMode, PURCHASE_FULFILLMENT_MODE_ITEM_POOL),
      availableCount: Number(stockMap[item.productKey] || 0)
    }))

    return res.json({ products: response })
  } catch (error) {
    console.error('[LdcShop] get products error:', error)
    return res.status(500).json({ error: '内部服务器错误' })
  }
})

router.post('/orders', async (req, res) => {
  const uid = normalizeUid(req.linuxdo?.uid)
  const username = normalizeUsername(req.linuxdo?.username)
  const productKey = normalizeProductKey(req.body?.productKey || req.body?.product_key)

  if (!uid) return res.status(400).json({ error: '缺少 uid' })
  if (!productKey) return res.status(400).json({ error: 'productKey 不合法' })

  try {
    const db = await getDatabase()
    const { pid, key, baseUrl } = await getCreditGatewayConfig(db)
    if (!pid || !key || !baseUrl) {
      return res.status(500).json({ error: '未配置 Linux DO Credit 凭据' })
    }

    const lockKeys = [`ldc-shop:uid:${uid}`, `ldc-shop:product:${productKey}`]
    const decision = await withLocks(lockKeys, async () => {
      cleanupExpiredReservations(db)

      const product = await getPurchaseProductByKey(db, productKey)
      if (!product || !product.isActive) {
        return { ok: false, status: 404, error: '商品不存在或已下架' }
      }

      if (normalizeProductCategory(product.category, PURCHASE_PRODUCT_CATEGORY_CODE) !== PURCHASE_PRODUCT_CATEGORY_LDC_SHOP) {
        return { ok: false, status: 400, error: '该商品不支持在 LDC 小店购买' }
      }

      const amount = formatCreditMoney(product.amount)
      if (!amount) {
        return { ok: false, status: 500, error: '商品价格配置无效' }
      }

      const user = fetchLinuxDoUser(db, { uid, username: username || uid })
      const userEmail = normalizeEmail(user.email)
      const deliveryMode = normalizeDeliveryMode(product.deliveryMode, PURCHASE_DELIVERY_MODE_EMAIL)
      const fulfillmentMode = normalizeFulfillmentMode(product.fulfillmentMode, PURCHASE_FULFILLMENT_MODE_ITEM_POOL)
      const redeemProvider = normalizeProvider(product.redeemProvider || PURCHASE_REDEEM_PROVIDER_YYL)

      const expireMs = getCreditOrderExpireMinutes() * 60 * 1000
      const existingRow = db.exec(
        `
          SELECT o.order_no, o.credit_order_no, o.created_at, o.status, c.status, o.fulfillment_mode
          FROM ldc_shop_orders o
          LEFT JOIN credit_orders c ON c.order_no = o.credit_order_no
          WHERE o.uid = ?
            AND o.product_key = ?
            AND o.status IN ('created', 'pending_payment')
          ORDER BY o.created_at DESC
          LIMIT 1
        `,
        [uid, productKey]
      )[0]?.values?.[0]

      if (existingRow) {
        const existingOrderNo = normalizeOrderNo(existingRow[0])
        const existingCreditOrderNo = normalizeOrderNo(existingRow[1]) || existingOrderNo
        const createdAtMs = parseDateMs(existingRow[2])
        const ageMs = createdAtMs > 0 ? nowMs() - createdAtMs : 0
        const shopStatus = String(existingRow[3] || '')
        const creditStatus = String(existingRow[4] || '')
        const existingFulfillmentMode = normalizeFulfillmentMode(existingRow[5], PURCHASE_FULFILLMENT_MODE_ITEM_POOL)

        if (existingOrderNo && ageMs <= expireMs && [ORDER_STATUS_CREATED, ORDER_STATUS_PENDING_PAYMENT].includes(shopStatus)) {
          const reservedItem = existingFulfillmentMode === PURCHASE_FULFILLMENT_MODE_REDEEM_API
            ? db.exec(
              `
                SELECT id
                FROM ldc_shop_redeem_codes
                WHERE reserved_order_no = ?
                  AND status = 'reserved'
                LIMIT 1
              `,
              [existingOrderNo]
            )[0]?.values?.[0]
            : db.exec(
              `
                SELECT id
                FROM purchase_product_items
                WHERE reserved_order_no = ?
                  AND status = 'reserved'
                LIMIT 1
              `,
              [existingOrderNo]
            )[0]?.values?.[0]

          if (reservedItem) {
            const existingOrder = fetchShopOrder(db, existingOrderNo)
            const creditOrder = fetchCreditOrder(db, existingCreditOrderNo)
            if (existingOrder && creditOrder && [ORDER_STATUS_CREATED, ORDER_STATUS_PENDING_PAYMENT].includes(creditOrder.status)) {
              const reuseDeliveryMode = normalizeDeliveryMode(existingOrder.deliveryMode, deliveryMode)
              const reuseEmail = normalizeEmail(existingOrder.deliveryEmailTo || existingOrder.userEmail || userEmail)
              if (requiresEmailDelivery(reuseDeliveryMode) && !isValidEmail(reuseEmail)) {
                return { ok: false, status: 400, error: '该待支付订单需要邮箱交付，请先在页面配置有效邮箱' }
              }
              const reuseAmount = formatCreditMoney(creditOrder.amount || existingOrder.amount || amount) || amount
              const reuseProductName = String(existingOrder.productName || product.productName || '').trim() || product.productName

              if (isValidEmail(userEmail)) {
                db.run(
                  `
                    UPDATE ldc_shop_orders
                    SET user_email = ?,
                        updated_at = DATETIME('now', 'localtime')
                    WHERE order_no = ?
                  `,
                  [userEmail, existingOrderNo]
                )
                db.run(
                  `
                    UPDATE credit_orders
                    SET order_email = ?,
                        updated_at = DATETIME('now', 'localtime')
                    WHERE order_no = ?
                  `,
                  [userEmail, existingCreditOrderNo]
                )
              }
              markCreditOrderPending(db, existingCreditOrderNo)
              db.run(
                `
                  UPDATE ldc_shop_orders
                  SET status = 'pending_payment',
                      updated_at = DATETIME('now', 'localtime')
                  WHERE order_no = ?
                    AND status = 'created'
                `,
                [existingOrderNo]
              )
              saveDatabase()

              return {
                ok: true,
                reused: true,
                orderNo: existingOrderNo,
                creditOrderNo: existingCreditOrderNo,
                amount: reuseAmount,
                product: {
                  ...product,
                  productName: reuseProductName,
                  deliveryMode: reuseDeliveryMode
                },
                userEmail: reuseEmail || userEmail,
                fulfillmentMode: existingFulfillmentMode,
                creditOrderStatus: creditStatus || creditOrder.status || ORDER_STATUS_PENDING_PAYMENT
              }
            }
          }
        }
      }

      if (requiresEmailDelivery(deliveryMode) && !isValidEmail(userEmail)) {
        return { ok: false, status: 400, error: '当前商品需要邮箱交付，请先在页面配置有效邮箱' }
      }

      const orderNo = generateCreditOrderNo()
      const reserved = fulfillmentMode === PURCHASE_FULFILLMENT_MODE_REDEEM_API
        ? reserveRedeemCodeForOrder(db, { productKey, orderNo, provider: redeemProvider })
        : reserveItemForOrder(db, { productKey, orderNo })
      if (!reserved || !reserved.id) {
        return { ok: false, status: 409, error: '库存不足，请稍后再试' }
      }

      const title = `LDC商品小店 ${product.productName}`
      db.run(
        `
          INSERT INTO credit_orders (
            order_no, trade_no, uid, username, order_email, scene, title, amount, status, pay_url, target_account_id,
            action_payload, created_at, updated_at
          ) VALUES (?, NULL, ?, ?, ?, 'ldc_shop_purchase', ?, ?, 'created', NULL, NULL, ?, DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))
        `,
        [
          orderNo,
          uid,
          username || null,
          userEmail || null,
          title,
          amount,
          JSON.stringify({
            productKey,
            source: 'open_accounts_shop',
            fulfillmentMode,
            itemId: fulfillmentMode === PURCHASE_FULFILLMENT_MODE_ITEM_POOL ? reserved.id : null,
            redeemCodeId: fulfillmentMode === PURCHASE_FULFILLMENT_MODE_REDEEM_API ? reserved.id : null
          })
        ]
      )

      db.run(
        `
          INSERT INTO ldc_shop_orders (
            order_no, credit_order_no, uid, username, user_email, product_key, product_name, amount,
            delivery_mode, fulfillment_mode, redeem_provider, item_id, redeem_code_id, item_preview, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))
        `,
        [
          orderNo,
          orderNo,
          uid,
          username || null,
          userEmail || null,
          product.productKey,
          product.productName,
          amount,
          deliveryMode,
          fulfillmentMode,
          fulfillmentMode === PURCHASE_FULFILLMENT_MODE_REDEEM_API ? redeemProvider : null,
          fulfillmentMode === PURCHASE_FULFILLMENT_MODE_ITEM_POOL ? reserved.id : null,
          fulfillmentMode === PURCHASE_FULFILLMENT_MODE_REDEEM_API ? reserved.id : null,
          fulfillmentMode === PURCHASE_FULFILLMENT_MODE_REDEEM_API
            ? (maskCodePreview(reserved.code) || null)
            : (reserved.previewText || null)
        ]
      )

      markCreditOrderPending(db, orderNo)
      db.run(
        `
          UPDATE ldc_shop_orders
          SET status = 'pending_payment',
              updated_at = DATETIME('now', 'localtime')
          WHERE order_no = ?
            AND status = 'created'
        `,
        [orderNo]
      )

      saveDatabase()

      return {
        ok: true,
        reused: false,
        orderNo,
        creditOrderNo: orderNo,
        amount,
        product,
        userEmail,
        fulfillmentMode,
        creditOrderStatus: ORDER_STATUS_PENDING_PAYMENT
      }
    })

    if (!decision.ok) {
      return res.status(decision.status || 400).json({ error: decision.error || '下单失败' })
    }

    const title = `LDC商品小店 ${decision.product.productName}`
    const payOrderNo = normalizeOrderNo(decision.creditOrderNo) || decision.orderNo
    const pay = buildCreditPayRequest({
      req,
      uid,
      orderNo: payOrderNo,
      title,
      amount: decision.amount,
      pid,
      key,
      baseUrl
    })

    return res.json({
      orderNo: decision.orderNo,
      productKey: decision.product.productKey,
      productName: decision.product.productName,
      amount: decision.amount,
      deliveryMode: normalizeDeliveryMode(decision.product.deliveryMode, PURCHASE_DELIVERY_MODE_EMAIL),
      fulfillmentMode: normalizeFulfillmentMode(decision.fulfillmentMode, PURCHASE_FULFILLMENT_MODE_ITEM_POOL),
      status: decision.creditOrderStatus,
      reused: Boolean(decision.reused),
      creditOrder: {
        orderNo: payOrderNo,
        amount: decision.amount,
        ...pay
      }
    })
  } catch (error) {
    console.error('[LdcShop] create order error:', error)
    return res.status(500).json({ error: '创建订单失败，请稍后重试' })
  }
})

router.get('/orders', async (req, res) => {
  const uid = normalizeUid(req.linuxdo?.uid)
  if (!uid) return res.status(400).json({ error: '缺少 uid' })

  try {
    const db = await getDatabase()
    const page = Math.max(1, Number(req.query.page) || 1)
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20))
    const offset = (page - 1) * pageSize

    const countResult = db.exec('SELECT COUNT(*) FROM ldc_shop_orders WHERE uid = ?', [uid])
    const total = Number(countResult[0]?.values?.[0]?.[0] || 0)

    const rows = db.exec(
      `
        SELECT order_no
        FROM ldc_shop_orders
        WHERE uid = ?
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `,
      [uid, pageSize, offset]
    )[0]?.values || []

    const orders = rows
      .map(row => normalizeOrderNo(row?.[0]))
      .filter(Boolean)
      .map(orderNo => fetchShopOrder(db, orderNo))
      .filter(Boolean)
      .map(order => buildShopOrderResponse(order, { includeInlineContent: false, includeCreditOrderNo: true }))

    return res.json({
      orders,
      pagination: { page, pageSize, total }
    })
  } catch (error) {
    console.error('[LdcShop] list orders error:', error)
    return res.status(500).json({ error: '查询失败，请稍后再试' })
  }
})

router.get('/orders/:orderNo', async (req, res) => {
  const uid = normalizeUid(req.linuxdo?.uid)
  const orderNo = normalizeOrderNo(req.params.orderNo)
  if (!uid) return res.status(400).json({ error: '缺少 uid' })
  if (!orderNo) return res.status(400).json({ error: '缺少订单号' })

  try {
    const db = await getDatabase()

    const data = await withLocks([`ldc-shop:order:${orderNo}`], async () => {
      cleanupExpiredReservations(db)

      let order = fetchShopOrder(db, orderNo)
      if (!order) return { ok: false, status: 404, error: '订单不存在' }
      if (order.uid !== uid) return { ok: false, status: 403, error: '订单信息不匹配' }

      let creditOrder = fetchCreditOrder(db, order.creditOrderNo || orderNo)
      if (!creditOrder) {
        return { ok: false, status: 404, error: '支付订单不存在' }
      }

      if (creditOrder.uid !== uid || creditOrder.scene !== 'ldc_shop_purchase') {
        return { ok: false, status: 403, error: '支付订单信息不匹配' }
      }

      if (shouldSyncCreditOrder(creditOrder)) {
        creditOrder = await syncCreditOrderFromGateway(db, creditOrder)
      }

      markShopOrderStatusFromCredit(db, orderNo, creditOrder)
      saveDatabase()

      order = fetchShopOrder(db, orderNo) || order

      if (creditOrder.status === ORDER_STATUS_PAID) {
        order = await fulfillPaidOrder(db, order)
      }

      if (order.status === ORDER_STATUS_CREATED && creditOrder.status === ORDER_STATUS_PENDING_PAYMENT) {
        db.run(
          `
            UPDATE ldc_shop_orders
            SET status = 'pending_payment',
                updated_at = DATETIME('now', 'localtime')
            WHERE order_no = ?
          `,
          [orderNo]
        )
        saveDatabase()
        order = fetchShopOrder(db, orderNo) || order
      }

      const payload = buildShopOrderResponse(order, { includeInlineContent: true, includeCreditOrderNo: true })
      payload.credit = {
        status: creditOrder.status,
        tradeNo: creditOrder.tradeNo || null,
        payUrl: creditOrder.payUrl || null,
        paidAt: creditOrder.paidAt || null,
        refundedAt: creditOrder.refundedAt || null,
        refundMessage: creditOrder.refundMessage || null
      }

      return { ok: true, order: payload }
    })

    if (!data.ok) {
      return res.status(data.status || 400).json({ error: data.error || '查询失败' })
    }

    return res.json({ order: data.order })
  } catch (error) {
    console.error('[LdcShop] get order error:', error)
    return res.status(500).json({ error: '查询失败，请稍后再试' })
  }
})

export default router
