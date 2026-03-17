import { getDatabase, saveDatabase } from '../database/init.js'

export class AlipayRedpackOrderError extends Error {
  constructor(message, statusCode = 400, code = 'alipay_redpack_bad_request') {
    super(message)
    this.name = 'AlipayRedpackOrderError'
    this.statusCode = statusCode
    this.code = code
  }
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const STATUS_SET = new Set(['pending', 'invited', 'redeemed'])
const ALIPAY_REDPACK_CHANNEL = 'alipay_redpack'
const ALIPAY_REDPACK_CHANNEL_NAME = '支付宝口令红包'

const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase()
const normalizePassphrase = (value) => String(value ?? '').trim()
const normalizeNote = (value) => String(value ?? '').trim()
const toPositiveInt = (value, fallback = 0) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}

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
})

const getOrderRowById = (db, id) => {
  const result = db.exec(
    `
      SELECT id, email, alipay_passphrase, redemption_code_id, redemption_code_redeemed_at, note, status, invite_result,
             invited_account_id, invited_account_email, invite_sent_at, redeemed_at,
             operator_user_id, operator_username, created_at, updated_at
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
             operator_user_id, operator_username, created_at, updated_at
      FROM alipay_redpack_orders
      WHERE alipay_passphrase = ?
      LIMIT 1
    `,
    [passphrase]
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
})

const getRedemptionCodeRowByCode = (db, code) => {
  const result = db.exec(
    `
      SELECT id, code, COALESCE(is_redeemed, 0), redeemed_at, redeemed_by, channel, channel_name
      FROM redemption_codes
      WHERE code = ?
      LIMIT 1
    `,
    [code]
  )
  return result?.[0]?.values?.[0] || null
}

const getRedemptionCodeRowById = (db, id) => {
  const result = db.exec(
    `
      SELECT id, code, COALESCE(is_redeemed, 0), redeemed_at, redeemed_by, channel, channel_name
      FROM redemption_codes
      WHERE id = ?
      LIMIT 1
    `,
    [id]
  )
  return result?.[0]?.values?.[0] || null
}

const isAlipayRedpackCodeChannel = (value) => String(value || '').trim().toLowerCase() === ALIPAY_REDPACK_CHANNEL

const ensureOrderRedemptionCodeLinked = (db, order) => {
  if (!db || !order?.id) {
    throw new AlipayRedpackOrderError('订单不存在', 404, 'alipay_redpack_not_found')
  }

  const passphrase = normalizePassphrase(order.alipayPassphrase)
  if (!passphrase) {
    throw new AlipayRedpackOrderError('订单缺少支付宝口令，无法关联兑换码', 500, 'alipay_redpack_missing_passphrase')
  }

  let codeRow = null
  const codeIdFromOrder = toPositiveInt(order.redemptionCodeId, 0)
  if (codeIdFromOrder) {
    const existingById = getRedemptionCodeRowById(db, codeIdFromOrder)
    if (existingById && String(existingById[1] || '') === passphrase) {
      codeRow = existingById
    }
  }

  if (!codeRow) {
    const existingByCode = getRedemptionCodeRowByCode(db, passphrase)
    if (existingByCode) {
      if (!isAlipayRedpackCodeChannel(existingByCode[5])) {
        throw new AlipayRedpackOrderError('该支付宝口令已被其他兑换码占用，无法关联订单', 409, 'alipay_redpack_code_occupied')
      }
      codeRow = existingByCode
    }
  }

  if (!codeRow) {
    db.run(
      `
        INSERT INTO redemption_codes (
          code, is_redeemed, account_email, channel, channel_name, order_type, service_days,
          created_at, updated_at
        )
        VALUES (?, 0, NULL, ?, ?, 'warranty', NULL, DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))
      `,
      [passphrase, ALIPAY_REDPACK_CHANNEL, ALIPAY_REDPACK_CHANNEL_NAME]
    )
    codeRow = getRedemptionCodeRowByCode(db, passphrase)
  }

  if (!codeRow) {
    throw new AlipayRedpackOrderError('创建兑换码记录失败，请稍后重试', 500, 'alipay_redpack_code_create_failed')
  }

  const linkedCodeId = Number(codeRow[0] || 0)
  if (linkedCodeId > 0 && linkedCodeId !== Number(order.redemptionCodeId || 0)) {
    db.run(
      `
        UPDATE alipay_redpack_orders
        SET redemption_code_id = ?,
            updated_at = DATETIME('now', 'localtime')
        WHERE id = ?
      `,
      [linkedCodeId, Number(order.id)]
    )
  }

  return mapRedemptionCodeRow(codeRow)
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

export const createAlipayRedpackOrderPublic = async ({ email, alipayPassphrase, note = '' } = {}) => {
  const { normalizedEmail, passphrase } = ensureEmailAndPassphrase({ email, alipayPassphrase })
  const normalizedNote = ensureNoteLength(note)

  const db = await getDatabase()
  db.run('BEGIN')
  try {
    const exists = getOrderRowByPassphrase(db, passphrase)
    if (exists) {
      throw new AlipayRedpackOrderError('该支付宝口令已存在，请勿重复提交', 409, 'alipay_redpack_passphrase_exists')
    }

    const codeExists = getRedemptionCodeRowByCode(db, passphrase)
    if (codeExists) {
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

  const existingId = Number(existingRow[0])
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

  await saveDatabase()

  return {
    created: false,
    order: getOrderByIdInternal(db, existingId)
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
             operator_user_id, operator_username, created_at, updated_at
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
          updated_at = DATETIME('now', 'localtime')
      WHERE id = ?
        AND is_redeemed = 0
    `,
    [finalRedeemedBy, ALIPAY_REDPACK_CHANNEL, ALIPAY_REDPACK_CHANNEL_NAME, linkedCode.id]
  )

  const modified = typeof db.getRowsModified === 'function' ? Number(db.getRowsModified() || 0) : 0
  const latestCodeRow = getRedemptionCodeRowById(db, linkedCode.id)
  const latestCode = latestCodeRow ? mapRedemptionCodeRow(latestCodeRow) : linkedCode
  const consumed = modified > 0 || Boolean(latestCode?.isRedeemed)
  if (!consumed) {
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

  const codeRow = getRedemptionCodeRowById(db, normalizedCodeId)
  if (!codeRow) return null
  const code = mapRedemptionCodeRow(codeRow)
  if (!code.isRedeemed) return { order, code, rolledBack: false }

  db.run(
    `
      UPDATE redemption_codes
      SET is_redeemed = 0,
          redeemed_at = NULL,
          redeemed_by = NULL,
          updated_at = DATETIME('now', 'localtime')
      WHERE id = ?
        AND is_redeemed = 1
    `,
    [normalizedCodeId]
  )
  const modified = typeof db.getRowsModified === 'function' ? Number(db.getRowsModified() || 0) : 0
  if (modified <= 0) {
    return {
      order: getOrderByIdInternal(db, normalizedOrderId),
      code: mapRedemptionCodeRow(getRedemptionCodeRowById(db, normalizedCodeId) || codeRow),
      rolledBack: false,
    }
  }

  markOrderRedemptionCodeRedeemedAt(db, normalizedOrderId, null)
  await saveDatabase()
  return {
    order: getOrderByIdInternal(db, normalizedOrderId),
    code: mapRedemptionCodeRow(getRedemptionCodeRowById(db, normalizedCodeId) || codeRow),
    rolledBack: true,
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
