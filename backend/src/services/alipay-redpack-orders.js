import { getDatabase, saveDatabase } from '../database/init.js'
import { resolveOrderDeadlineMs } from './account-recovery.js'

export class AlipayRedpackOrderError extends Error {
  constructor(message, statusCode = 400, code = 'alipay_redpack_bad_request') {
    super(message)
    this.name = 'AlipayRedpackOrderError'
    this.statusCode = statusCode
    this.code = code
  }
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const ALIPAY_PASSPHRASE_MIN_LENGTH = 8
const STATUS_SET = new Set(['pending', 'invited', 'redeemed', 'returned'])
const PUBLIC_SUPPLEMENTABLE_STATUS_SET = new Set(['invited', 'redeemed'])
const SUPPLEMENT_STATUS_PROCESSING = 'processing'
const SUPPLEMENT_STATUS_AUTO_SUCCESS = 'auto_success'
const SUPPLEMENT_STATUS_MANUAL_REQUIRED = 'manual_required'
const SUPPLEMENT_STATUS_AUTO_FAILED = 'auto_failed'
const SUPPLEMENT_STATUS_REJECTED_OUT_OF_WARRANTY = 'rejected_out_of_warranty'
const SUPPLEMENT_STATUS_SKIPPED_NO_NEED = 'skipped_no_need'
const SUPPLEMENT_STATUS_MANUAL_DONE = 'manual_done'
const SUPPLEMENT_STATUS_SET = new Set([
  SUPPLEMENT_STATUS_PROCESSING,
  SUPPLEMENT_STATUS_AUTO_SUCCESS,
  SUPPLEMENT_STATUS_MANUAL_REQUIRED,
  SUPPLEMENT_STATUS_AUTO_FAILED,
  SUPPLEMENT_STATUS_REJECTED_OUT_OF_WARRANTY,
  SUPPLEMENT_STATUS_SKIPPED_NO_NEED,
  SUPPLEMENT_STATUS_MANUAL_DONE,
])
const ALIPAY_REDPACK_CHANNEL = 'alipay_redpack'
const ALIPAY_REDPACK_CHANNEL_NAME = '支付宝口令红包'
const ALIPAY_REDPACK_ORDER_RESERVE_PREFIX = 'alipay_redpack_order:'
const ORDER_TYPE_WARRANTY = 'warranty'
const ORDER_TYPE_NO_WARRANTY = 'no_warranty'
const ORDER_TYPE_ANTI_BAN = 'anti_ban'
const ORDER_TYPE_SET = new Set([ORDER_TYPE_WARRANTY, ORDER_TYPE_NO_WARRANTY, ORDER_TYPE_ANTI_BAN])
const DAY_MS = 24 * 60 * 60 * 1000

const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase()
const normalizePassphrase = (value) => String(value ?? '').trim()
const normalizeNote = (value) => String(value ?? '').trim()
const normalizeOrderStatus = (value) => String(value || '').trim().toLowerCase()
const normalizeOrderType = (value) => {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'no-warranty' || normalized === 'nowarranty') return ORDER_TYPE_NO_WARRANTY
  if (normalized === 'anti-ban') return ORDER_TYPE_ANTI_BAN
  return ORDER_TYPE_SET.has(normalized) ? normalized : ORDER_TYPE_WARRANTY
}
const isNoWarrantyOrderType = (value) => normalizeOrderType(value) === ORDER_TYPE_NO_WARRANTY
const toPositiveInt = (value, fallback = 0) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}
const parseDateTimeToMs = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return NaN
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T')
  const parsed = Date.parse(normalized)
  if (!Number.isNaN(parsed)) return parsed
  const parsedWithTimezone = Date.parse(`${normalized}+08:00`)
  return Number.isNaN(parsedWithTimezone) ? NaN : parsedWithTimezone
}
const getDefaultWarrantyServiceDays = () => Math.max(1, toPositiveInt(process.env.PURCHASE_SERVICE_DAYS, 30))

const mapOrderRow = (row = []) => ({
  id: Number(row[0]),
  email: row[1] || '',
  alipayPassphrase: row[2] || '',
  redemptionCodeId: row[3] != null ? Number(row[3]) : null,
  redemptionCodeRedeemedAt: row[4] || null,
  note: row[5] || '',
  status: row[6] || 'pending',
  inviteResult: row[7] || '',
  invitedAccountId: row[8] != null ? Number(row[8]) : null,
  invitedAccountEmail: row[9] || null,
  inviteSentAt: row[10] || null,
  redeemedAt: row[11] || null,
  operatorUserId: row[12] != null ? Number(row[12]) : null,
  operatorUsername: row[13] || null,
  createdAt: row[14] || null,
  updatedAt: row[15] || null,
  redemptionCode: row[16] ? String(row[16]) : null,
})

const mapSupplementRow = (row = []) => ({
  id: Number(row[0]),
  orderId: Number(row[1]),
  email: String(row[2] || ''),
  status: String(row[3] || SUPPLEMENT_STATUS_PROCESSING),
  requestedBy: String(row[4] || 'public'),
  detail: row[5] ? String(row[5]) : '',
  redemptionCodeId: row[6] != null ? Number(row[6]) : null,
  redemptionCode: row[7] ? String(row[7]) : null,
  inviteAccountId: row[8] != null ? Number(row[8]) : null,
  inviteAccountEmail: row[9] ? String(row[9]) : null,
  queueIsMember: Number(row[10] || 0) === 1,
  queueIsInvited: Number(row[11] || 0) === 1,
  withinWarranty: Number(row[12] || 0) === 1,
  windowEndsAt: row[13] ? String(row[13]) : null,
  processedAt: row[14] ? String(row[14]) : null,
  createdAt: row[15] ? String(row[15]) : null,
  updatedAt: row[16] ? String(row[16]) : null,
})

const getOrderRowById = (db, id) => {
  const result = db.exec(
    `
      SELECT id, email, alipay_passphrase, redemption_code_id, redemption_code_redeemed_at, note, status, invite_result,
             invited_account_id, invited_account_email, invite_sent_at, redeemed_at,
             operator_user_id, operator_username, created_at, updated_at,
             (SELECT code FROM redemption_codes WHERE id = alipay_redpack_orders.redemption_code_id LIMIT 1) AS redemption_code
      FROM alipay_redpack_orders
      WHERE id = ?
      LIMIT 1
    `,
    [id]
  )
  return result?.[0]?.values?.[0] || null
}

const getOrderRowByPassphrase = (db, passphrase) => {
  const result = db.exec(
    `
      SELECT id, email, alipay_passphrase, redemption_code_id, redemption_code_redeemed_at, note, status, invite_result,
             invited_account_id, invited_account_email, invite_sent_at, redeemed_at,
             operator_user_id, operator_username, created_at, updated_at,
             (SELECT code FROM redemption_codes WHERE id = alipay_redpack_orders.redemption_code_id LIMIT 1) AS redemption_code
      FROM alipay_redpack_orders
      WHERE alipay_passphrase = ?
      LIMIT 1
    `,
    [passphrase]
  )
  return result?.[0]?.values?.[0] || null
}

const getLatestOrderRowByEmail = (db, email) => {
  const normalizedEmail = normalizeEmail(email)
  if (!normalizedEmail) return null
  const result = db.exec(
    `
      SELECT id, email, alipay_passphrase, redemption_code_id, redemption_code_redeemed_at, note, status, invite_result,
             invited_account_id, invited_account_email, invite_sent_at, redeemed_at,
             operator_user_id, operator_username, created_at, updated_at,
             (SELECT code FROM redemption_codes WHERE id = alipay_redpack_orders.redemption_code_id LIMIT 1) AS redemption_code
      FROM alipay_redpack_orders
      WHERE lower(trim(email)) = ?
      ORDER BY datetime(created_at) DESC, id DESC
      LIMIT 1
    `,
    [normalizedEmail]
  )
  return result?.[0]?.values?.[0] || null
}

const getLatestActiveOrderRowByEmail = (db, email) => {
  const normalizedEmail = normalizeEmail(email)
  if (!normalizedEmail) return null
  const result = db.exec(
    `
      SELECT id, email, alipay_passphrase, redemption_code_id, redemption_code_redeemed_at, note, status, invite_result,
             invited_account_id, invited_account_email, invite_sent_at, redeemed_at,
             operator_user_id, operator_username, created_at, updated_at,
             (SELECT code FROM redemption_codes WHERE id = alipay_redpack_orders.redemption_code_id LIMIT 1) AS redemption_code
      FROM alipay_redpack_orders
      WHERE lower(trim(email)) = ?
        AND status != 'returned'
      ORDER BY datetime(created_at) DESC, id DESC
      LIMIT 1
    `,
    [normalizedEmail]
  )
  return result?.[0]?.values?.[0] || null
}

const getOrderRowByIdAndEmail = (db, id, email) => {
  const normalizedId = toPositiveInt(id, 0)
  const normalizedEmail = normalizeEmail(email)
  if (!normalizedId || !normalizedEmail) return null
  const result = db.exec(
    `
      SELECT id, email, alipay_passphrase, redemption_code_id, redemption_code_redeemed_at, note, status, invite_result,
             invited_account_id, invited_account_email, invite_sent_at, redeemed_at,
             operator_user_id, operator_username, created_at, updated_at,
             (SELECT code FROM redemption_codes WHERE id = alipay_redpack_orders.redemption_code_id LIMIT 1) AS redemption_code
      FROM alipay_redpack_orders
      WHERE id = ?
        AND lower(trim(email)) = ?
      LIMIT 1
    `,
    [normalizedId, normalizedEmail]
  )
  return result?.[0]?.values?.[0] || null
}

const listOrderRowsByEmail = (db, email, limit = 20) => {
  const normalizedEmail = normalizeEmail(email)
  if (!normalizedEmail) return []
  const normalizedLimit = Math.min(Math.max(toPositiveInt(limit, 20), 1), 100)
  const result = db.exec(
    `
      SELECT id, email, alipay_passphrase, redemption_code_id, redemption_code_redeemed_at, note, status, invite_result,
             invited_account_id, invited_account_email, invite_sent_at, redeemed_at,
             operator_user_id, operator_username, created_at, updated_at,
             (SELECT code FROM redemption_codes WHERE id = alipay_redpack_orders.redemption_code_id LIMIT 1) AS redemption_code
      FROM alipay_redpack_orders
      WHERE lower(trim(email)) = ?
      ORDER BY datetime(created_at) DESC, id DESC
      LIMIT ?
    `,
    [normalizedEmail, normalizedLimit]
  )
  return result?.[0]?.values || []
}

const getSupplementRowById = (db, id) => {
  const normalizedId = toPositiveInt(id, 0)
  if (!normalizedId) return null
  const result = db.exec(
    `
      SELECT id, order_id, email, status, requested_by, detail, redemption_code_id, redemption_code,
             invite_account_id, invite_account_email, COALESCE(queue_is_member, 0), COALESCE(queue_is_invited, 0),
             COALESCE(within_warranty, 0), window_ends_at, processed_at, created_at, updated_at
      FROM alipay_redpack_supplements
      WHERE id = ?
      LIMIT 1
    `,
    [normalizedId]
  )
  return result?.[0]?.values?.[0] || null
}

const getOrderByIdInternal = (db, id) => {
  const row = getOrderRowById(db, id)
  return row ? mapOrderRow(row) : null
}

const mapRedemptionCodeRow = (row = []) => ({
  id: Number(row[0]),
  code: String(row[1] || ''),
  isRedeemed: Number(row[2] || 0) === 1,
  redeemedAt: row[3] || null,
  redeemedBy: row[4] || null,
  channel: String(row[5] || ''),
  channelName: String(row[6] || ''),
  reservedForOrderNo: row[7] || null,
  reservedForOrderEmail: row[8] || null,
  reservedForUid: row[9] || null,
  reservedForEntryId: row[10] != null ? Number(row[10]) : null,
})

const getRedemptionCodeRowById = (db, id) => {
  const result = db.exec(
    `
      SELECT id, code, COALESCE(is_redeemed, 0), redeemed_at, redeemed_by, channel, channel_name,
             reserved_for_order_no, reserved_for_order_email, reserved_for_uid, COALESCE(reserved_for_entry_id, 0)
      FROM redemption_codes
      WHERE id = ?
      LIMIT 1
    `,
    [id]
  )
  return result?.[0]?.values?.[0] || null
}

const getRedemptionCodeOrderMeta = (db, { codeId, code } = {}) => {
  const normalizedCodeId = toPositiveInt(codeId, 0)
  if (normalizedCodeId > 0) {
    const byId = db.exec(
      `
        SELECT order_type, service_days
        FROM redemption_codes
        WHERE id = ?
        LIMIT 1
      `,
      [normalizedCodeId]
    )
    const row = byId?.[0]?.values?.[0]
    if (row) {
      return {
        orderType: row[0] ? String(row[0]) : null,
        serviceDays: row[1] != null ? Number(row[1]) : null,
      }
    }
  }

  const normalizedCode = normalizePassphrase(code)
  if (!normalizedCode) return { orderType: null, serviceDays: null }

  const byCode = db.exec(
    `
      SELECT order_type, service_days
      FROM redemption_codes
      WHERE code = ?
      LIMIT 1
    `,
    [normalizedCode]
  )
  const row = byCode?.[0]?.values?.[0]
  return {
    orderType: row?.[0] ? String(row[0]) : null,
    serviceDays: row?.[1] != null ? Number(row[1]) : null,
  }
}

const resolveOrderWarrantyInfo = (db, order) => {
  const normalizedCodeId = toPositiveInt(order?.redemptionCodeId, 0)
  const passphrase = normalizePassphrase(order?.alipayPassphrase)
  const meta = getRedemptionCodeOrderMeta(db, {
    codeId: normalizedCodeId,
    code: passphrase,
  })
  const orderType = normalizeOrderType(meta.orderType || ORDER_TYPE_WARRANTY)
  const startAt = order?.redeemedAt || order?.inviteSentAt || order?.createdAt || null

  const deadlineMsFromResolver = resolveOrderDeadlineMs(db, {
    originalCodeId: normalizedCodeId || undefined,
    originalCode: passphrase || undefined,
    redeemedAt: startAt,
    orderType,
  })
  let deadlineMs = Number(deadlineMsFromResolver)

  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    const startMs = parseDateTimeToMs(startAt)
    if (Number.isFinite(startMs)) {
      deadlineMs = startMs + getDefaultWarrantyServiceDays() * DAY_MS
    }
  }

  const windowEndsAt = Number.isFinite(deadlineMs) && deadlineMs > 0
    ? new Date(deadlineMs).toISOString()
    : null

  return {
    orderType,
    serviceDays: Number.isFinite(Number(meta.serviceDays)) ? Number(meta.serviceDays) : null,
    windowEndsAt,
    withinWarranty: !isNoWarrantyOrderType(orderType) && (
      !Number.isFinite(deadlineMs) || deadlineMs <= 0 || Date.now() <= deadlineMs
    ),
  }
}

const isAlipayRedpackCodeChannel = (value) => String(value || '').trim().toLowerCase() === ALIPAY_REDPACK_CHANNEL
const buildOrderReservationNo = (orderId) => `${ALIPAY_REDPACK_ORDER_RESERVE_PREFIX}${orderId}`
const isBlank = (value) => String(value ?? '').trim() === ''

const reserveAlipayRedpackCodeById = (db, codeId, { reservationNo, orderEmail }) => {
  const normalizedCodeId = toPositiveInt(codeId, 0)
  if (!normalizedCodeId || !reservationNo) return false

  db.run(
    `
      UPDATE redemption_codes
      SET reserved_for_order_no = ?,
          reserved_for_order_email = ?,
          reserved_at = DATETIME('now', 'localtime'),
          channel = ?,
          channel_name = COALESCE(NULLIF(channel_name, ''), ?),
          updated_at = DATETIME('now', 'localtime')
      WHERE id = ?
        AND COALESCE(is_redeemed, 0) = 0
        AND COALESCE(NULLIF(lower(trim(channel)), ''), '') = ?
        AND (reserved_for_uid IS NULL OR trim(reserved_for_uid) = '')
        AND COALESCE(reserved_for_entry_id, 0) = 0
        AND (
          reserved_for_order_no IS NULL
          OR trim(reserved_for_order_no) = ''
          OR reserved_for_order_no = ?
        )
    `,
    [
      reservationNo,
      String(orderEmail || '').trim().toLowerCase() || null,
      ALIPAY_REDPACK_CHANNEL,
      ALIPAY_REDPACK_CHANNEL_NAME,
      normalizedCodeId,
      ALIPAY_REDPACK_CHANNEL,
      reservationNo,
    ]
  )
  return Number(db.getRowsModified?.() || 0) > 0
}

const selectAvailableAlipayRedpackCodeRow = (db) => {
  const result = db.exec(
    `
      SELECT id, code, COALESCE(is_redeemed, 0), redeemed_at, redeemed_by, channel, channel_name,
             reserved_for_order_no, reserved_for_order_email, reserved_for_uid, COALESCE(reserved_for_entry_id, 0)
      FROM redemption_codes
      WHERE COALESCE(is_redeemed, 0) = 0
        AND COALESCE(NULLIF(lower(trim(channel)), ''), '') = ?
        AND (reserved_for_uid IS NULL OR trim(reserved_for_uid) = '')
        AND COALESCE(reserved_for_entry_id, 0) = 0
        AND (reserved_for_order_no IS NULL OR trim(reserved_for_order_no) = '')
      ORDER BY datetime(created_at) ASC, id ASC
      LIMIT 1
    `,
    [ALIPAY_REDPACK_CHANNEL]
  )
  return result?.[0]?.values?.[0] || null
}

const releaseAlipayRedpackOrderCodeReservation = (
  db,
  order,
  { recoverRedeemed = false } = {}
) => {
  if (!db || !order?.id) return { released: false, restoredFromRedeemed: false }

  const orderId = toPositiveInt(order.id, 0)
  const codeId = toPositiveInt(order.redemptionCodeId, 0)
  if (!orderId || !codeId) return { released: false, restoredFromRedeemed: false }

  const reservationNo = buildOrderReservationNo(orderId)
  const codeRow = getRedemptionCodeRowById(db, codeId)
  if (!codeRow) return { released: false, restoredFromRedeemed: false }

  const code = mapRedemptionCodeRow(codeRow)
  if (!isAlipayRedpackCodeChannel(code.channel)) {
    return { released: false, restoredFromRedeemed: false }
  }

  if (code.isRedeemed) {
    if (!recoverRedeemed) return { released: false, restoredFromRedeemed: false }

    const redeemedBy = String(code.redeemedBy || '').trim().toLowerCase()
    const byOrderTag = redeemedBy.includes(`alipay_redpack_order:${orderId}`)
      || redeemedBy.includes(`order:${orderId}`)
    const byThisOrder = byOrderTag
    if (!byThisOrder) return { released: false, restoredFromRedeemed: false }

    db.run(
      `
        UPDATE redemption_codes
        SET is_redeemed = 0,
            redeemed_at = NULL,
            redeemed_by = NULL,
            reserved_for_order_no = NULL,
            reserved_for_order_email = NULL,
            reserved_at = NULL,
            updated_at = DATETIME('now', 'localtime')
        WHERE id = ?
          AND COALESCE(is_redeemed, 0) = 1
      `,
      [codeId]
    )
    return {
      released: false,
      restoredFromRedeemed: Number(db.getRowsModified?.() || 0) > 0
    }
  }

  db.run(
    `
      UPDATE redemption_codes
      SET reserved_for_order_no = NULL,
          reserved_for_order_email = NULL,
          reserved_at = NULL,
          updated_at = DATETIME('now', 'localtime')
      WHERE id = ?
        AND COALESCE(is_redeemed, 0) = 0
        AND (
          reserved_for_order_no = ?
          OR reserved_for_order_no IS NULL
          OR trim(reserved_for_order_no) = ''
        )
    `,
    [codeId, reservationNo]
  )
  return {
    released: Number(db.getRowsModified?.() || 0) > 0,
    restoredFromRedeemed: false
  }
}

const ensureOrderRedemptionCodeLinked = (db, order) => {
  if (!db || !order?.id) {
    throw new AlipayRedpackOrderError('订单不存在', 404, 'alipay_redpack_not_found')
  }

  const reservationNo = buildOrderReservationNo(order.id)
  const normalizedOrderEmail = normalizeEmail(order.email)

  const codeIdFromOrder = toPositiveInt(order.redemptionCodeId, 0)
  if (codeIdFromOrder > 0) {
    const existingById = getRedemptionCodeRowById(db, codeIdFromOrder)
    if (!existingById) {
      throw new AlipayRedpackOrderError('订单关联兑换码不存在，请联系管理员处理', 409, 'alipay_redpack_code_missing')
    }

    if (!isAlipayRedpackCodeChannel(existingById[5])) {
      throw new AlipayRedpackOrderError('订单关联兑换码渠道异常，请联系管理员处理', 409, 'alipay_redpack_code_channel_mismatch')
    }

    const mapped = mapRedemptionCodeRow(existingById)
    if (mapped.isRedeemed) {
      return mapped
    }

    const reservedForOrderNo = String(mapped.reservedForOrderNo || '').trim()
    if (!isBlank(reservedForOrderNo) && reservedForOrderNo !== reservationNo) {
      throw new AlipayRedpackOrderError('订单绑定兑换码已被其他订单占用，请联系管理员处理', 409, 'alipay_redpack_code_reserved_by_other')
    }

    if (!isBlank(mapped.reservedForUid) || Number(mapped.reservedForEntryId || 0) > 0) {
      throw new AlipayRedpackOrderError('订单绑定兑换码当前不可用，请联系管理员处理', 409, 'alipay_redpack_code_unavailable')
    }

    if (reservedForOrderNo !== reservationNo) {
      const reserved = reserveAlipayRedpackCodeById(db, codeIdFromOrder, {
        reservationNo,
        orderEmail: normalizedOrderEmail,
      })
      if (!reserved) {
        throw new AlipayRedpackOrderError('订单兑换码占用失败，请稍后重试', 409, 'alipay_redpack_code_reserve_failed')
      }
    }

    const latestRow = getRedemptionCodeRowById(db, codeIdFromOrder)
    if (!latestRow) {
      throw new AlipayRedpackOrderError('订单兑换码状态异常，请联系管理员处理', 500, 'alipay_redpack_code_missing')
    }
    return mapRedemptionCodeRow(latestRow)
  }

  let selectedCodeId = 0
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = selectAvailableAlipayRedpackCodeRow(db)
    if (!candidate) break

    const candidateId = Number(candidate[0] || 0)
    if (!candidateId) continue

    const reserved = reserveAlipayRedpackCodeById(db, candidateId, {
      reservationNo,
      orderEmail: normalizedOrderEmail,
    })
    if (!reserved) {
      continue
    }

    selectedCodeId = candidateId
    break
  }

  if (!selectedCodeId) {
    throw new AlipayRedpackOrderError(
      '当前支付宝口令红包库存不足，请稍后重试',
      409,
      'alipay_redpack_out_of_stock'
    )
  }

  db.run(
    `
      UPDATE alipay_redpack_orders
      SET redemption_code_id = ?,
          updated_at = DATETIME('now', 'localtime')
      WHERE id = ?
    `,
    [selectedCodeId, Number(order.id)]
  )

  const latestCodeRow = getRedemptionCodeRowById(db, selectedCodeId)
  if (!latestCodeRow) {
    throw new AlipayRedpackOrderError('订单兑换码状态异常，请联系管理员处理', 500, 'alipay_redpack_code_missing')
  }
  return mapRedemptionCodeRow(latestCodeRow)
}

const markOrderRedemptionCodeRedeemedAt = (db, orderId, redeemedAt = null) => {
  const normalizedOrderId = toPositiveInt(orderId)
  if (!normalizedOrderId) return

  if (redeemedAt) {
    db.run(
      `
        UPDATE alipay_redpack_orders
        SET redemption_code_redeemed_at = ?,
            updated_at = DATETIME('now', 'localtime')
        WHERE id = ?
      `,
      [redeemedAt, normalizedOrderId]
    )
    return
  }

  db.run(
    `
      UPDATE alipay_redpack_orders
      SET redemption_code_redeemed_at = NULL,
          updated_at = DATETIME('now', 'localtime')
      WHERE id = ?
    `,
    [normalizedOrderId]
  )
}

const ensureEmailAndPassphrase = ({ email, alipayPassphrase }) => {
  const normalizedEmail = normalizeEmail(email)
  if (!normalizedEmail || !EMAIL_REGEX.test(normalizedEmail)) {
    throw new AlipayRedpackOrderError('请输入有效的邮箱地址', 400, 'alipay_redpack_invalid_email')
  }

  const passphrase = normalizePassphrase(alipayPassphrase)
  if (!passphrase) {
    throw new AlipayRedpackOrderError('请输入支付宝口令', 400, 'alipay_redpack_missing_passphrase')
  }
  if (passphrase.length < ALIPAY_PASSPHRASE_MIN_LENGTH) {
    throw new AlipayRedpackOrderError('支付宝口令至少8位字符', 400, 'alipay_redpack_passphrase_too_short')
  }

  if (passphrase.length > 255) {
    throw new AlipayRedpackOrderError('支付宝口令长度不能超过255字符', 400, 'alipay_redpack_passphrase_too_long')
  }

  return { normalizedEmail, passphrase }
}

const ensureNoteLength = (note) => {
  const normalized = normalizeNote(note)
  if (normalized.length > 1000) {
    throw new AlipayRedpackOrderError('备注长度不能超过1000字符', 400, 'alipay_redpack_note_too_long')
  }
  return normalized
}

const buildSearchClause = (search) => {
  const normalized = String(search ?? '').trim().toLowerCase()
  if (!normalized) {
    return { clause: '', params: [] }
  }

  const keyword = `%${normalized}%`
  return {
    clause: `
      AND (
        lower(email) LIKE ?
        OR lower(alipay_passphrase) LIKE ?
        OR lower(COALESCE(note, '')) LIKE ?
        OR lower(COALESCE(invite_result, '')) LIKE ?
        OR lower(COALESCE(operator_username, '')) LIKE ?
      )
    `,
    params: [keyword, keyword, keyword, keyword, keyword]
  }
}

const buildStatusClause = (status) => {
  const normalized = String(status ?? '').trim().toLowerCase()
  if (!normalized || normalized === 'all') {
    return { clause: '', params: [] }
  }
  if (!STATUS_SET.has(normalized)) {
    throw new AlipayRedpackOrderError('无效的状态筛选', 400, 'alipay_redpack_invalid_status')
  }
  return {
    clause: 'AND status = ?',
    params: [normalized]
  }
}

export const getAlipayRedpackOrderById = async (id) => {
  const normalizedId = toPositiveInt(id)
  if (!normalizedId) return null
  const db = await getDatabase()
  return getOrderByIdInternal(db, normalizedId)
}

export const getLatestAlipayRedpackOrderByEmail = async (email) => {
  const normalizedEmail = normalizeEmail(email)
  if (!normalizedEmail || !EMAIL_REGEX.test(normalizedEmail)) {
    throw new AlipayRedpackOrderError('请输入有效的邮箱地址', 400, 'alipay_redpack_invalid_email')
  }

  const db = await getDatabase()
  const row = getLatestOrderRowByEmail(db, normalizedEmail)
  return row ? mapOrderRow(row) : null
}

export const getAlipayRedpackSupplementCandidateByEmail = async (email) => {
  const normalizedEmail = normalizeEmail(email)
  if (!normalizedEmail || !EMAIL_REGEX.test(normalizedEmail)) {
    throw new AlipayRedpackOrderError('请输入有效的邮箱地址', 400, 'alipay_redpack_invalid_email')
  }

  const db = await getDatabase()
  const row = getLatestActiveOrderRowByEmail(db, normalizedEmail)
  if (!row) {
    throw new AlipayRedpackOrderError('该邮箱暂无可补录订单，请先提交订单', 404, 'alipay_redpack_order_not_found')
  }

  const order = mapOrderRow(row)
  const warranty = resolveOrderWarrantyInfo(db, order)
  return {
    order,
    ...warranty,
  }
}

export const listAlipayRedpackSupplementOrdersByEmail = async (
  email,
  { limit = 20, onlyPublicSupplementable = false } = {}
) => {
  const normalizedEmail = normalizeEmail(email)
  if (!normalizedEmail || !EMAIL_REGEX.test(normalizedEmail)) {
    throw new AlipayRedpackOrderError('请输入有效的邮箱地址', 400, 'alipay_redpack_invalid_email')
  }

  const db = await getDatabase()
  const rows = listOrderRowsByEmail(db, normalizedEmail, limit)
  const orders = rows
    .map((row) => {
      const order = mapOrderRow(row)
      const normalizedStatus = normalizeOrderStatus(order.status)
      if (onlyPublicSupplementable && !PUBLIC_SUPPLEMENTABLE_STATUS_SET.has(normalizedStatus)) {
        return null
      }
      const warranty = resolveOrderWarrantyInfo(db, order)
      return {
        orderId: order.id,
        createdAt: order.createdAt || null,
        status: normalizedStatus || 'pending',
        warrantyDays: Number.isFinite(Number(warranty.serviceDays)) ? Number(warranty.serviceDays) : null,
        withinWarranty: Boolean(warranty.withinWarranty),
        windowEndsAt: warranty.windowEndsAt || null,
      }
    })
    .filter(Boolean)

  return {
    email: normalizedEmail,
    total: orders.length,
    orders,
  }
}

export const getAlipayRedpackSupplementCandidateByOrder = async ({
  email,
  orderId,
  allowPending = false,
} = {}) => {
  const normalizedEmail = normalizeEmail(email)
  if (!normalizedEmail || !EMAIL_REGEX.test(normalizedEmail)) {
    throw new AlipayRedpackOrderError('请输入有效的邮箱地址', 400, 'alipay_redpack_invalid_email')
  }

  const normalizedOrderId = toPositiveInt(orderId, 0)
  if (!normalizedOrderId) {
    throw new AlipayRedpackOrderError('无效订单ID', 400, 'alipay_redpack_invalid_id')
  }

  const db = await getDatabase()
  const row = getOrderRowByIdAndEmail(db, normalizedOrderId, normalizedEmail)
  if (!row) {
    throw new AlipayRedpackOrderError('未找到该邮箱对应的订单', 404, 'alipay_redpack_order_not_found')
  }

  const order = mapOrderRow(row)
  const normalizedStatus = normalizeOrderStatus(order.status)
  if (normalizedStatus === 'returned') {
    throw new AlipayRedpackOrderError('该订单已退回，无法补录，请重新提交有效口令', 409, 'alipay_redpack_order_returned')
  }
  if (!allowPending && normalizedStatus === 'pending') {
    throw new AlipayRedpackOrderError('该订单仍在待处理中，暂不支持补录', 409, 'alipay_redpack_pending_not_supplementable')
  }

  const warranty = resolveOrderWarrantyInfo(db, order)
  return {
    order: {
      ...order,
      status: normalizedStatus || order.status || 'pending',
    },
    ...warranty,
  }
}

export const resetAlipayRedpackOrderForPublicSupplement = async (
  id,
  {
    note,
    inviteResult,
  } = {}
) => {
  const normalizedId = toPositiveInt(id)
  if (!normalizedId) {
    throw new AlipayRedpackOrderError('无效订单ID', 400, 'alipay_redpack_invalid_id')
  }

  const hasNote = note !== undefined
  const normalizedNote = hasNote ? ensureNoteLength(note) : ''

  const db = await getDatabase()
  const existing = getOrderRowById(db, normalizedId)
  if (!existing) {
    throw new AlipayRedpackOrderError('订单不存在', 404, 'alipay_redpack_not_found')
  }

  const updates = [
    "status = 'pending'",
    'invite_result = ?',
    'invited_account_id = NULL',
    'invited_account_email = NULL',
    'invite_sent_at = NULL',
    'redeemed_at = NULL',
    'operator_user_id = NULL',
    'operator_username = NULL',
    "updated_at = DATETIME('now', 'localtime')",
  ]
  const params = [
    String(inviteResult ?? '').trim() || '自动补录：已重置为待处理',
  ]

  if (hasNote) {
    updates.push('note = ?')
    params.push(normalizedNote || null)
  }

  db.run(
    `UPDATE alipay_redpack_orders SET ${updates.join(', ')} WHERE id = ?`,
    [...params, normalizedId]
  )
  await saveDatabase()

  return getOrderByIdInternal(db, normalizedId)
}

export const prepareAlipayRedpackOrderForAutoSupplement = async (
  id,
  {
    note,
    inviteResult,
  } = {}
) => {
  const normalizedId = toPositiveInt(id, 0)
  if (!normalizedId) {
    throw new AlipayRedpackOrderError('无效订单ID', 400, 'alipay_redpack_invalid_id')
  }

  const hasNote = note !== undefined
  const normalizedNote = hasNote ? ensureNoteLength(note) : ''
  const normalizedInviteResult = String(inviteResult ?? '').trim() || '自动补录：重新分配兑换码并开始邀请'

  const db = await getDatabase()
  db.run('BEGIN IMMEDIATE TRANSACTION')
  try {
    const existing = getOrderByIdInternal(db, normalizedId)
    if (!existing) {
      throw new AlipayRedpackOrderError('订单不存在', 404, 'alipay_redpack_not_found')
    }
    if (String(existing.status || '').trim().toLowerCase() === 'returned') {
      throw new AlipayRedpackOrderError('该订单已退回，无法补录', 409, 'alipay_redpack_order_returned')
    }

    releaseAlipayRedpackOrderCodeReservation(db, existing, { recoverRedeemed: false })

    const updates = [
      "status = 'pending'",
      'invite_result = ?',
      'redemption_code_id = NULL',
      'redemption_code_redeemed_at = NULL',
      'invited_account_id = NULL',
      'invited_account_email = NULL',
      'invite_sent_at = NULL',
      'redeemed_at = NULL',
      'operator_user_id = NULL',
      'operator_username = NULL',
      "updated_at = DATETIME('now', 'localtime')",
    ]
    const params = [normalizedInviteResult]

    if (hasNote) {
      updates.push('note = ?')
      params.push(normalizedNote || null)
    }

    db.run(
      `UPDATE alipay_redpack_orders SET ${updates.join(', ')} WHERE id = ?`,
      [...params, normalizedId]
    )

    const refreshed = getOrderByIdInternal(db, normalizedId)
    if (!refreshed) {
      throw new AlipayRedpackOrderError('订单不存在', 404, 'alipay_redpack_not_found')
    }

    const code = ensureOrderRedemptionCodeLinked(db, refreshed)
    db.run('COMMIT')
    await saveDatabase()

    return {
      order: getOrderByIdInternal(db, normalizedId),
      code,
    }
  } catch (error) {
    try {
      db.run('ROLLBACK')
    } catch {
      // ignore rollback errors
    }
    throw error
  }
}

export const getAlipayRedpackRedemptionCodeStockSummary = async () => {
  const db = await getDatabase()
  const result = db.exec(
    `
      SELECT
        SUM(
          CASE
            WHEN COALESCE(is_redeemed, 0) = 0
              AND COALESCE(NULLIF(lower(trim(channel)), ''), '') = ?
              AND (reserved_for_uid IS NULL OR trim(reserved_for_uid) = '')
              AND COALESCE(reserved_for_entry_id, 0) = 0
              AND (reserved_for_order_no IS NULL OR trim(reserved_for_order_no) = '')
            THEN 1 ELSE 0
          END
        ) AS available_count,
        SUM(
          CASE
            WHEN COALESCE(is_redeemed, 0) = 0
              AND COALESCE(NULLIF(lower(trim(channel)), ''), '') = ?
              AND reserved_for_order_no LIKE ?
            THEN 1 ELSE 0
          END
        ) AS reserved_count,
        SUM(
          CASE
            WHEN COALESCE(is_redeemed, 0) = 0
              AND COALESCE(NULLIF(lower(trim(channel)), ''), '') = ?
            THEN 1 ELSE 0
          END
        ) AS total_unused_count
      FROM redemption_codes
    `
    ,
    [
      ALIPAY_REDPACK_CHANNEL,
      ALIPAY_REDPACK_CHANNEL,
      `${ALIPAY_REDPACK_ORDER_RESERVE_PREFIX}%`,
      ALIPAY_REDPACK_CHANNEL,
    ]
  )
  const row = result?.[0]?.values?.[0] || []
  return {
    availableCount: Number(row[0] || 0),
    reservedCount: Number(row[1] || 0),
    totalUnusedCount: Number(row[2] || 0),
  }
}

export const createAlipayRedpackSupplementRecord = async ({
  orderId,
  email,
  status = SUPPLEMENT_STATUS_PROCESSING,
  requestedBy = 'public',
  detail = '',
  withinWarranty = null,
  windowEndsAt = null,
  redemptionCodeId = null,
  redemptionCode = null,
  inviteAccountId = null,
  inviteAccountEmail = null,
  queueIsMember = null,
  queueIsInvited = null,
} = {}) => {
  const normalizedOrderId = toPositiveInt(orderId, 0)
  const normalizedEmail = normalizeEmail(email)
  const normalizedStatus = String(status || '').trim().toLowerCase() || SUPPLEMENT_STATUS_PROCESSING
  if (!normalizedOrderId) {
    throw new AlipayRedpackOrderError('无效订单ID', 400, 'alipay_redpack_invalid_id')
  }
  if (!normalizedEmail || !EMAIL_REGEX.test(normalizedEmail)) {
    throw new AlipayRedpackOrderError('请输入有效的邮箱地址', 400, 'alipay_redpack_invalid_email')
  }
  if (!SUPPLEMENT_STATUS_SET.has(normalizedStatus)) {
    throw new AlipayRedpackOrderError('无效补录状态', 400, 'alipay_redpack_invalid_supplement_status')
  }

  const db = await getDatabase()
  db.run(
    `
      INSERT INTO alipay_redpack_supplements (
        order_id, email, status, requested_by, detail,
        redemption_code_id, redemption_code, invite_account_id, invite_account_email,
        queue_is_member, queue_is_invited, within_warranty, window_ends_at, processed_at,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, CASE WHEN ? = 1 THEN DATETIME('now', 'localtime') ELSE NULL END,
        DATETIME('now', 'localtime'), DATETIME('now', 'localtime')
      )
    `,
    [
      normalizedOrderId,
      normalizedEmail,
      normalizedStatus,
      String(requestedBy || 'public').trim() || 'public',
      String(detail || '').trim() || null,
      toPositiveInt(redemptionCodeId, 0) || null,
      String(redemptionCode || '').trim() || null,
      toPositiveInt(inviteAccountId, 0) || null,
      String(inviteAccountEmail || '').trim() || null,
      queueIsMember == null ? 0 : (queueIsMember ? 1 : 0),
      queueIsInvited == null ? 0 : (queueIsInvited ? 1 : 0),
      withinWarranty == null ? 0 : (withinWarranty ? 1 : 0),
      windowEndsAt || null,
      normalizedStatus === SUPPLEMENT_STATUS_PROCESSING ? 0 : 1,
    ]
  )

  const idRow = db.exec('SELECT last_insert_rowid()')[0]?.values?.[0]
  const createdId = idRow ? Number(idRow[0]) : 0
  await saveDatabase()

  const created = getSupplementRowById(db, createdId)
  return created ? mapSupplementRow(created) : null
}

export const updateAlipayRedpackSupplementRecord = async (
  id,
  {
    status,
    detail,
    redemptionCodeId,
    redemptionCode,
    inviteAccountId,
    inviteAccountEmail,
    queueIsMember,
    queueIsInvited,
    withinWarranty,
    windowEndsAt,
  } = {}
) => {
  const normalizedId = toPositiveInt(id, 0)
  if (!normalizedId) {
    throw new AlipayRedpackOrderError('无效补录记录ID', 400, 'alipay_redpack_invalid_supplement_id')
  }

  const db = await getDatabase()
  const existing = getSupplementRowById(db, normalizedId)
  if (!existing) {
    throw new AlipayRedpackOrderError('补录记录不存在', 404, 'alipay_redpack_supplement_not_found')
  }

  const updates = ["updated_at = DATETIME('now', 'localtime')"]
  const params = []

  if (status !== undefined) {
    const normalizedStatus = String(status || '').trim().toLowerCase()
    if (!SUPPLEMENT_STATUS_SET.has(normalizedStatus)) {
      throw new AlipayRedpackOrderError('无效补录状态', 400, 'alipay_redpack_invalid_supplement_status')
    }
    updates.push('status = ?')
    params.push(normalizedStatus)
    updates.push(
      normalizedStatus === SUPPLEMENT_STATUS_PROCESSING
        ? 'processed_at = NULL'
        : "processed_at = DATETIME('now', 'localtime')"
    )
  }

  if (detail !== undefined) {
    updates.push('detail = ?')
    params.push(String(detail || '').trim() || null)
  }
  if (redemptionCodeId !== undefined) {
    updates.push('redemption_code_id = ?')
    params.push(toPositiveInt(redemptionCodeId, 0) || null)
  }
  if (redemptionCode !== undefined) {
    updates.push('redemption_code = ?')
    params.push(String(redemptionCode || '').trim() || null)
  }
  if (inviteAccountId !== undefined) {
    updates.push('invite_account_id = ?')
    params.push(toPositiveInt(inviteAccountId, 0) || null)
  }
  if (inviteAccountEmail !== undefined) {
    updates.push('invite_account_email = ?')
    params.push(String(inviteAccountEmail || '').trim() || null)
  }
  if (queueIsMember !== undefined) {
    updates.push('queue_is_member = ?')
    params.push(queueIsMember ? 1 : 0)
  }
  if (queueIsInvited !== undefined) {
    updates.push('queue_is_invited = ?')
    params.push(queueIsInvited ? 1 : 0)
  }
  if (withinWarranty !== undefined) {
    updates.push('within_warranty = ?')
    params.push(withinWarranty ? 1 : 0)
  }
  if (windowEndsAt !== undefined) {
    updates.push('window_ends_at = ?')
    params.push(windowEndsAt || null)
  }

  db.run(
    `UPDATE alipay_redpack_supplements SET ${updates.join(', ')} WHERE id = ?`,
    [...params, normalizedId]
  )
  await saveDatabase()

  const latest = getSupplementRowById(db, normalizedId)
  return latest ? mapSupplementRow(latest) : null
}

export const getAlipayRedpackSupplementById = async (id) => {
  const normalizedId = toPositiveInt(id, 0)
  if (!normalizedId) return null
  const db = await getDatabase()
  const row = getSupplementRowById(db, normalizedId)
  return row ? mapSupplementRow(row) : null
}

export const listAlipayRedpackSupplementsAdmin = async (
  {
    search = '',
    status = 'all',
    limit = 200,
    offset = 0,
  } = {}
) => {
  const normalizedLimit = Math.min(Math.max(toPositiveInt(limit, 200), 1), 1000)
  const normalizedOffset = Math.max(toPositiveInt(offset, 0), 0)
  const normalizedSearch = String(search || '').trim().toLowerCase()
  const normalizedStatus = String(status || '').trim().toLowerCase()

  const where = ['1 = 1']
  const params = []
  if (normalizedSearch) {
    const keyword = `%${normalizedSearch}%`
    where.push(`
      (
        lower(ars.email) LIKE ?
        OR CAST(ars.order_id AS TEXT) LIKE ?
        OR lower(COALESCE(ars.status, '')) LIKE ?
        OR lower(COALESCE(ars.detail, '')) LIKE ?
      )
    `)
    params.push(keyword, keyword, keyword, keyword)
  }

  if (normalizedStatus && normalizedStatus !== 'all') {
    if (!SUPPLEMENT_STATUS_SET.has(normalizedStatus)) {
      throw new AlipayRedpackOrderError('无效补录状态筛选', 400, 'alipay_redpack_invalid_supplement_status')
    }
    where.push('ars.status = ?')
    params.push(normalizedStatus)
  }

  const whereSql = `WHERE ${where.join(' AND ')}`
  const db = await getDatabase()
  const totalResult = db.exec(
    `SELECT COUNT(*) FROM alipay_redpack_supplements ars ${whereSql}`,
    params
  )
  const total = Number(totalResult?.[0]?.values?.[0]?.[0] || 0)

  const rowsResult = db.exec(
    `
      SELECT ars.id, ars.order_id, ars.email, ars.status, ars.requested_by, ars.detail,
             ars.redemption_code_id, ars.redemption_code, ars.invite_account_id, ars.invite_account_email,
             COALESCE(ars.queue_is_member, 0), COALESCE(ars.queue_is_invited, 0),
             COALESCE(ars.within_warranty, 0), ars.window_ends_at, ars.processed_at, ars.created_at, ars.updated_at
      FROM alipay_redpack_supplements ars
      ${whereSql}
      ORDER BY datetime(ars.created_at) DESC, ars.id DESC
      LIMIT ? OFFSET ?
    `,
    [...params, normalizedLimit, normalizedOffset]
  )

  const rows = rowsResult?.[0]?.values || []
  return {
    records: rows.map(mapSupplementRow),
    total,
    limit: normalizedLimit,
    offset: normalizedOffset,
  }
}

export const createAlipayRedpackOrderPublic = async ({ email, alipayPassphrase, note = '' } = {}) => {
  const { normalizedEmail, passphrase } = ensureEmailAndPassphrase({ email, alipayPassphrase })
  const normalizedNote = ensureNoteLength(note)

  const db = await getDatabase()
  db.run('BEGIN IMMEDIATE TRANSACTION')
  try {
    const exists = getOrderRowByPassphrase(db, passphrase)
    if (exists) {
      throw new AlipayRedpackOrderError('该支付宝口令已存在，请勿重复提交', 409, 'alipay_redpack_passphrase_exists')
    }

    db.run(
      `
        INSERT INTO alipay_redpack_orders (
          email, alipay_passphrase, note, status,
          created_at, updated_at
        )
        VALUES (?, ?, ?, 'pending', DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))
      `,
      [normalizedEmail, passphrase, normalizedNote || null]
    )

    const idRow = db.exec('SELECT last_insert_rowid()')[0]?.values?.[0]
    const createdId = idRow ? Number(idRow[0]) : 0
    const created = getOrderByIdInternal(db, createdId)
    if (!created) {
      throw new AlipayRedpackOrderError('订单创建失败，请稍后重试', 500, 'alipay_redpack_create_failed')
    }

    ensureOrderRedemptionCodeLinked(db, created)
    db.run('COMMIT')
    await saveDatabase()

    const latest = getOrderByIdInternal(db, createdId)
    if (!latest) {
      throw new AlipayRedpackOrderError('订单创建失败，请稍后重试', 500, 'alipay_redpack_create_failed')
    }
    return latest
  } catch (error) {
    try {
      db.run('ROLLBACK')
    } catch {
      // ignore rollback errors
    }
    if (error instanceof AlipayRedpackOrderError) {
      throw error
    }
    if (String(error?.message || '').toLowerCase().includes('unique')) {
      throw new AlipayRedpackOrderError('该支付宝口令已存在，请勿重复提交', 409, 'alipay_redpack_passphrase_exists')
    }
    throw error
  }
}

export const supplementAlipayRedpackOrderPublic = async ({ email, alipayPassphrase, note } = {}) => {
  const { normalizedEmail, passphrase } = ensureEmailAndPassphrase({ email, alipayPassphrase })
  const hasNote = note !== undefined
  const normalizedNote = hasNote ? ensureNoteLength(note) : ''

  const db = await getDatabase()
  const existingRow = getOrderRowByPassphrase(db, passphrase)

  if (!existingRow) {
    const created = await createAlipayRedpackOrderPublic({
      email: normalizedEmail,
      alipayPassphrase: passphrase,
      note: hasNote ? normalizedNote : ''
    })
    return {
      created: true,
      order: created
    }
  }

  const existingOrder = mapOrderRow(existingRow)
  if (normalizeEmail(existingOrder.email) !== normalizedEmail) {
    throw new AlipayRedpackOrderError(
      '该支付宝口令已被其他邮箱使用，不能改绑邮箱，请联系管理员处理',
      409,
      'alipay_redpack_email_mismatch'
    )
  }
  if (String(existingOrder.status || '').trim().toLowerCase() === 'returned') {
    throw new AlipayRedpackOrderError(
      '该支付宝口令订单已退回，请更换有效口令重新提交',
      409,
      'alipay_redpack_order_returned'
    )
  }

  const existingId = Number(existingRow[0])
  db.run('BEGIN IMMEDIATE TRANSACTION')
  try {
    const updates = ["updated_at = DATETIME('now', 'localtime')"]
    const params = []

    if (hasNote) {
      updates.push('note = ?')
      params.push(normalizedNote || null)
    }

    db.run(
      `UPDATE alipay_redpack_orders SET ${updates.join(', ')} WHERE id = ?`,
      [...params, existingId]
    )

    const refreshed = getOrderByIdInternal(db, existingId)
    if (!refreshed) {
      throw new AlipayRedpackOrderError('订单不存在', 404, 'alipay_redpack_not_found')
    }

    ensureOrderRedemptionCodeLinked(db, refreshed)

    db.run('COMMIT')
    await saveDatabase()

    return {
      created: false,
      order: getOrderByIdInternal(db, existingId)
    }
  } catch (error) {
    try {
      db.run('ROLLBACK')
    } catch {
      // ignore rollback errors
    }
    throw error
  }
}

export const listAlipayRedpackOrdersAdmin = async ({ search = '', status = 'all', limit = 200, offset = 0 } = {}) => {
  const normalizedLimit = Math.min(Math.max(toPositiveInt(limit, 200), 1), 1000)
  const normalizedOffset = Math.max(toPositiveInt(offset, 0), 0)

  const statusClause = buildStatusClause(status)
  const searchClause = buildSearchClause(search)

  const db = await getDatabase()
  const whereSql = `WHERE 1 = 1 ${statusClause.clause} ${searchClause.clause}`
  const whereParams = [...statusClause.params, ...searchClause.params]

  const totalResult = db.exec(
    `SELECT COUNT(*) FROM alipay_redpack_orders ${whereSql}`,
    whereParams
  )
  const total = Number(totalResult?.[0]?.values?.[0]?.[0] || 0)

  const rowsResult = db.exec(
    `
      SELECT id, email, alipay_passphrase, redemption_code_id, redemption_code_redeemed_at, note, status, invite_result,
             invited_account_id, invited_account_email, invite_sent_at, redeemed_at,
             operator_user_id, operator_username, created_at, updated_at,
             (SELECT code FROM redemption_codes WHERE id = alipay_redpack_orders.redemption_code_id LIMIT 1) AS redemption_code
      FROM alipay_redpack_orders
      ${whereSql}
      ORDER BY datetime(created_at) DESC, id DESC
      LIMIT ? OFFSET ?
    `,
    [...whereParams, normalizedLimit, normalizedOffset]
  )

  const rows = rowsResult?.[0]?.values || []
  return {
    orders: rows.map(mapOrderRow),
    total,
    limit: normalizedLimit,
    offset: normalizedOffset,
  }
}

export const ensureAlipayRedpackOrderRedemptionCode = async (id) => {
  const normalizedId = toPositiveInt(id)
  if (!normalizedId) {
    throw new AlipayRedpackOrderError('无效订单ID', 400, 'alipay_redpack_invalid_id')
  }

  const db = await getDatabase()
  const existing = getOrderByIdInternal(db, normalizedId)
  if (!existing) {
    throw new AlipayRedpackOrderError('订单不存在', 404, 'alipay_redpack_not_found')
  }

  const code = ensureOrderRedemptionCodeLinked(db, existing)
  await saveDatabase()
  return {
    order: getOrderByIdInternal(db, normalizedId),
    code,
  }
}

export const consumeAlipayRedpackOrderRedemptionCode = async (
  id,
  {
    redeemedBy = '',
  } = {}
) => {
  const normalizedId = toPositiveInt(id)
  if (!normalizedId) {
    throw new AlipayRedpackOrderError('无效订单ID', 400, 'alipay_redpack_invalid_id')
  }

  const db = await getDatabase()
  const existing = getOrderByIdInternal(db, normalizedId)
  if (!existing) {
    throw new AlipayRedpackOrderError('订单不存在', 404, 'alipay_redpack_not_found')
  }

  const reservationNo = buildOrderReservationNo(normalizedId)
  const linkedCode = ensureOrderRedemptionCodeLinked(db, existing)
  if (!linkedCode?.id) {
    throw new AlipayRedpackOrderError('订单未关联可用兑换码', 500, 'alipay_redpack_code_missing')
  }

  if (linkedCode.isRedeemed) {
    const redeemedAt = linkedCode.redeemedAt || new Date().toISOString()
    markOrderRedemptionCodeRedeemedAt(db, normalizedId, redeemedAt)
    await saveDatabase()
    return {
      order: getOrderByIdInternal(db, normalizedId),
      code: linkedCode,
      consumedNow: false,
      alreadyRedeemed: true,
    }
  }

  const finalRedeemedBy = String(redeemedBy || '').trim() || `alipay_redpack_order:${normalizedId} | email:${existing.email}`
  db.run(
    `
      UPDATE redemption_codes
      SET is_redeemed = 1,
          redeemed_at = DATETIME('now', 'localtime'),
          redeemed_by = ?,
          channel = ?,
          channel_name = ?,
          reserved_for_order_no = NULL,
          reserved_for_order_email = NULL,
          reserved_at = NULL,
          updated_at = DATETIME('now', 'localtime')
      WHERE id = ?
        AND COALESCE(is_redeemed, 0) = 0
        AND (
          reserved_for_order_no = ?
          OR reserved_for_order_no IS NULL
          OR trim(reserved_for_order_no) = ''
        )
    `,
    [finalRedeemedBy, ALIPAY_REDPACK_CHANNEL, ALIPAY_REDPACK_CHANNEL_NAME, linkedCode.id, reservationNo]
  )

  const modified = typeof db.getRowsModified === 'function' ? Number(db.getRowsModified() || 0) : 0
  const latestCodeRow = getRedemptionCodeRowById(db, linkedCode.id)
  const latestCode = latestCodeRow ? mapRedemptionCodeRow(latestCodeRow) : linkedCode
  if (modified <= 0 && latestCode?.isRedeemed) {
    const redeemedAt = latestCode.redeemedAt || new Date().toISOString()
    markOrderRedemptionCodeRedeemedAt(db, normalizedId, redeemedAt)
    await saveDatabase()
    return {
      order: getOrderByIdInternal(db, normalizedId),
      code: latestCode,
      consumedNow: false,
      alreadyRedeemed: true,
    }
  }

  if (modified <= 0) {
    const reservedForOrderNo = String(latestCode?.reservedForOrderNo || '').trim()
    if (reservedForOrderNo && reservedForOrderNo !== reservationNo) {
      throw new AlipayRedpackOrderError('订单占用的兑换码已失效，请重新下单', 409, 'alipay_redpack_code_reservation_lost')
    }
    throw new AlipayRedpackOrderError('兑换码消耗失败，请稍后重试', 500, 'alipay_redpack_code_consume_failed')
  }

  markOrderRedemptionCodeRedeemedAt(
    db,
    normalizedId,
    latestCode?.redeemedAt || new Date().toISOString()
  )
  await saveDatabase()

  return {
    order: getOrderByIdInternal(db, normalizedId),
    code: latestCode,
    consumedNow: modified > 0,
    alreadyRedeemed: false,
  }
}

export const rollbackAlipayRedpackOrderRedemptionCodeConsume = async ({ orderId, codeId } = {}) => {
  const normalizedOrderId = toPositiveInt(orderId)
  const normalizedCodeId = toPositiveInt(codeId)
  if (!normalizedOrderId || !normalizedCodeId) return null

  const db = await getDatabase()
  const order = getOrderByIdInternal(db, normalizedOrderId)
  if (!order || Number(order.redemptionCodeId || 0) !== normalizedCodeId) return null

  const reservationNo = buildOrderReservationNo(normalizedOrderId)
  const codeRow = getRedemptionCodeRowById(db, normalizedCodeId)
  if (!codeRow) return null
  const code = mapRedemptionCodeRow(codeRow)
  if (!isAlipayRedpackCodeChannel(code.channel)) return { order, code, rolledBack: false }

  let rolledBack = false

  if (code.isRedeemed) {
    db.run(
      `
        UPDATE redemption_codes
        SET is_redeemed = 0,
            redeemed_at = NULL,
            redeemed_by = NULL,
            updated_at = DATETIME('now', 'localtime')
        WHERE id = ?
          AND COALESCE(is_redeemed, 0) = 1
      `,
      [normalizedCodeId]
    )
    rolledBack = Number(db.getRowsModified?.() || 0) > 0
  }

  const reservedNow = reserveAlipayRedpackCodeById(db, normalizedCodeId, {
    reservationNo,
    orderEmail: order.email,
  })

  if (rolledBack || reservedNow) {
    markOrderRedemptionCodeRedeemedAt(db, normalizedOrderId, null)
    await saveDatabase()
  }

  return {
    order: getOrderByIdInternal(db, normalizedOrderId),
    code: mapRedemptionCodeRow(getRedemptionCodeRowById(db, normalizedCodeId) || codeRow),
    rolledBack,
  }
}

export const markAlipayRedpackOrderInviteFailed = async (
  id,
  {
    inviteResult,
    operatorUserId = null,
    operatorUsername = null,
  } = {}
) => {
  const normalizedId = toPositiveInt(id)
  if (!normalizedId) {
    throw new AlipayRedpackOrderError('无效订单ID', 400, 'alipay_redpack_invalid_id')
  }

  const db = await getDatabase()
  const existing = getOrderRowById(db, normalizedId)
  if (!existing) {
    throw new AlipayRedpackOrderError('订单不存在', 404, 'alipay_redpack_not_found')
  }

  db.run(
    `
      UPDATE alipay_redpack_orders
      SET status = 'pending',
          invite_result = ?,
          operator_user_id = ?,
          operator_username = ?,
          updated_at = DATETIME('now', 'localtime')
      WHERE id = ?
    `,
    [
      String(inviteResult ?? '').trim() || '邀请失败',
      toPositiveInt(operatorUserId, 0) || null,
      String(operatorUsername ?? '').trim() || null,
      normalizedId
    ]
  )
  await saveDatabase()
  return getOrderByIdInternal(db, normalizedId)
}

export const markAlipayRedpackOrderInvited = async (
  id,
  {
    inviteResult,
    invitedAccountId = null,
    invitedAccountEmail = null,
    operatorUserId = null,
    operatorUsername = null,
  } = {}
) => {
  const normalizedId = toPositiveInt(id)
  if (!normalizedId) {
    throw new AlipayRedpackOrderError('无效订单ID', 400, 'alipay_redpack_invalid_id')
  }

  const db = await getDatabase()
  const existing = getOrderRowById(db, normalizedId)
  if (!existing) {
    throw new AlipayRedpackOrderError('订单不存在', 404, 'alipay_redpack_not_found')
  }

  db.run(
    `
      UPDATE alipay_redpack_orders
      SET status = 'invited',
          invite_result = ?,
          invited_account_id = ?,
          invited_account_email = ?,
          invite_sent_at = COALESCE(invite_sent_at, DATETIME('now', 'localtime')),
          operator_user_id = ?,
          operator_username = ?,
          updated_at = DATETIME('now', 'localtime')
      WHERE id = ?
    `,
    [
      String(inviteResult ?? '').trim() || '邀请已发送',
      toPositiveInt(invitedAccountId, 0) || null,
      String(invitedAccountEmail ?? '').trim() || null,
      toPositiveInt(operatorUserId, 0) || null,
      String(operatorUsername ?? '').trim() || null,
      normalizedId
    ]
  )
  await saveDatabase()
  return getOrderByIdInternal(db, normalizedId)
}

export const markAlipayRedpackOrderRedeemed = async (
  id,
  {
    inviteResult,
    invitedAccountId = null,
    invitedAccountEmail = null,
    operatorUserId = null,
    operatorUsername = null,
  } = {}
) => {
  const normalizedId = toPositiveInt(id)
  if (!normalizedId) {
    throw new AlipayRedpackOrderError('无效订单ID', 400, 'alipay_redpack_invalid_id')
  }

  const db = await getDatabase()
  const existing = getOrderRowById(db, normalizedId)
  if (!existing) {
    throw new AlipayRedpackOrderError('订单不存在', 404, 'alipay_redpack_not_found')
  }

  db.run(
    `
      UPDATE alipay_redpack_orders
      SET status = 'redeemed',
          invite_result = ?,
          invited_account_id = ?,
          invited_account_email = ?,
          invite_sent_at = COALESCE(invite_sent_at, DATETIME('now', 'localtime')),
          redeemed_at = COALESCE(redeemed_at, DATETIME('now', 'localtime')),
          operator_user_id = ?,
          operator_username = ?,
          updated_at = DATETIME('now', 'localtime')
      WHERE id = ?
    `,
    [
      String(inviteResult ?? '').trim() || '已兑换',
      toPositiveInt(invitedAccountId, 0) || null,
      String(invitedAccountEmail ?? '').trim() || null,
      toPositiveInt(operatorUserId, 0) || null,
      String(operatorUsername ?? '').trim() || null,
      normalizedId
    ]
  )
  await saveDatabase()
  return getOrderByIdInternal(db, normalizedId)
}

export const markAlipayRedpackOrderReturned = async (
  id,
  {
    reason,
    operatorUserId = null,
    operatorUsername = null,
  } = {}
) => {
  const normalizedId = toPositiveInt(id)
  if (!normalizedId) {
    throw new AlipayRedpackOrderError('无效订单ID', 400, 'alipay_redpack_invalid_id')
  }

  const db = await getDatabase()
  const existing = getOrderRowById(db, normalizedId)
  if (!existing) {
    throw new AlipayRedpackOrderError('订单不存在', 404, 'alipay_redpack_not_found')
  }

  const existingStatus = String(existing[6] || '').trim().toLowerCase()
  if (existingStatus === 'redeemed') {
    throw new AlipayRedpackOrderError('已兑换订单不支持退回', 409, 'alipay_redpack_return_redeemed_forbidden')
  }
  if (existingStatus === 'returned') {
    return mapOrderRow(existing)
  }

  const existingOrder = mapOrderRow(existing)
  const releaseResult = releaseAlipayRedpackOrderCodeReservation(db, existingOrder, {
    recoverRedeemed: true
  })
  if (releaseResult.released || releaseResult.restoredFromRedeemed) {
    markOrderRedemptionCodeRedeemedAt(db, normalizedId, null)
  }

  const trimmedReason = String(reason ?? '').trim()
  const inviteResult = trimmedReason ? `订单已退回：${trimmedReason}` : '订单已退回：口令不可用'

  db.run(
    `
      UPDATE alipay_redpack_orders
      SET status = 'returned',
          invite_result = ?,
          invited_account_id = NULL,
          invited_account_email = NULL,
          invite_sent_at = NULL,
          redeemed_at = NULL,
          redemption_code_redeemed_at = NULL,
          operator_user_id = ?,
          operator_username = ?,
          updated_at = DATETIME('now', 'localtime')
      WHERE id = ?
    `,
    [
      inviteResult,
      toPositiveInt(operatorUserId, 0) || null,
      String(operatorUsername ?? '').trim() || null,
      normalizedId
    ]
  )
  await saveDatabase()
  return getOrderByIdInternal(db, normalizedId)
}

export const updateAlipayRedpackOrderInviteResult = async (
  id,
  {
    inviteResult,
    operatorUserId = null,
    operatorUsername = null,
  } = {}
) => {
  const normalizedId = toPositiveInt(id)
  if (!normalizedId) {
    throw new AlipayRedpackOrderError('无效订单ID', 400, 'alipay_redpack_invalid_id')
  }

  const db = await getDatabase()
  const existing = getOrderRowById(db, normalizedId)
  if (!existing) {
    throw new AlipayRedpackOrderError('订单不存在', 404, 'alipay_redpack_not_found')
  }

  db.run(
    `
      UPDATE alipay_redpack_orders
      SET invite_result = ?,
          operator_user_id = ?,
          operator_username = ?,
          updated_at = DATETIME('now', 'localtime')
      WHERE id = ?
    `,
    [
      String(inviteResult ?? '').trim() || null,
      toPositiveInt(operatorUserId, 0) || null,
      String(operatorUsername ?? '').trim() || null,
      normalizedId
    ]
  )
  await saveDatabase()
  return getOrderByIdInternal(db, normalizedId)
}

export const updateAlipayRedpackOrderNote = async (
  id,
  {
    note,
    operatorUserId = null,
    operatorUsername = null,
  } = {}
) => {
  const normalizedId = toPositiveInt(id)
  if (!normalizedId) {
    throw new AlipayRedpackOrderError('无效订单ID', 400, 'alipay_redpack_invalid_id')
  }

  const normalizedNote = normalizeNote(note)
  if (normalizedNote.length > 1000) {
    throw new AlipayRedpackOrderError('备注长度不能超过1000字符', 400, 'alipay_redpack_note_too_long')
  }

  const db = await getDatabase()
  const existing = getOrderRowById(db, normalizedId)
  if (!existing) {
    throw new AlipayRedpackOrderError('订单不存在', 404, 'alipay_redpack_not_found')
  }

  db.run(
    `
      UPDATE alipay_redpack_orders
      SET note = ?,
          operator_user_id = ?,
          operator_username = ?,
          updated_at = DATETIME('now', 'localtime')
      WHERE id = ?
    `,
    [
      normalizedNote || null,
      toPositiveInt(operatorUserId, 0) || null,
      String(operatorUsername ?? '').trim() || null,
      normalizedId
    ]
  )
  await saveDatabase()
  return getOrderByIdInternal(db, normalizedId)
}
