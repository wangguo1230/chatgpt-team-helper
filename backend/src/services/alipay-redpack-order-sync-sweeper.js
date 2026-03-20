import { getDatabase } from '../database/init.js'
import {
  markAlipayRedpackOrderInvited,
  markAlipayRedpackOrderRedeemed,
  updateAlipayRedpackOrderInviteResult,
} from './alipay-redpack-orders.js'
import {
  fetchAccountInvites,
  fetchAccountUsersList,
  syncAccountInviteCount,
  syncAccountUserCount,
} from './account-sync.js'

const LABEL = '[AlipayRedpackInvitedSyncSweeper]'
const DEFAULT_INTERVAL_MINUTES = 60
const DEFAULT_BATCH_SIZE = 100
const DEFAULT_RETRY_DELAY_MS = 1200

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const parseBoolean = (value, fallback = false) => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw) return fallback
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true
  if (['0', 'false', 'no', 'off'].includes(raw)) return false
  return fallback
}

const isEnabled = () => parseBoolean(process.env.ALIPAY_REDPACK_INVITED_SYNC_ENABLED, true)
const intervalMinutes = () => parsePositiveInt(process.env.ALIPAY_REDPACK_INVITED_SYNC_INTERVAL_MINUTES, DEFAULT_INTERVAL_MINUTES)
const batchSize = () => Math.min(500, Math.max(1, parsePositiveInt(process.env.ALIPAY_REDPACK_INVITED_SYNC_BATCH_SIZE, DEFAULT_BATCH_SIZE)))
const retryOnMissing = () => parseBoolean(process.env.ALIPAY_REDPACK_INVITED_SYNC_RETRY_ON_MISSING, true)
const retryDelayMs = () => Math.max(100, parsePositiveInt(process.env.ALIPAY_REDPACK_INVITED_SYNC_RETRY_DELAY_MS, DEFAULT_RETRY_DELAY_MS))

const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase()
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)))

const detectEmailInAccountQueues = async (accountId, email) => {
  const normalizedEmail = normalizeEmail(email)
  if (!normalizedEmail) return { isMember: false, isInvited: false }

  const [users, invites] = await Promise.all([
    fetchAccountUsersList(accountId, { userListParams: { offset: 0, limit: 25, query: normalizedEmail } }),
    fetchAccountInvites(accountId, { inviteListParams: { offset: 0, limit: 25, query: normalizedEmail } }),
  ])

  const isMember = (users?.items || []).some(item => normalizeEmail(item?.email) === normalizedEmail)
  const isInvited = (invites?.items || []).some(item => normalizeEmail(item?.email_address) === normalizedEmail)
  return { isMember, isInvited }
}

const syncAndDetectEmailQueueState = async (accountId, email, { retry = true } = {}) => {
  await Promise.allSettled([
    syncAccountUserCount(accountId, { userListParams: { offset: 0, limit: 1, query: '' } }),
    syncAccountInviteCount(accountId, { inviteListParams: { offset: 0, limit: 1, query: '' } }),
  ])

  let queueState = await detectEmailInAccountQueues(accountId, email)
  if (retry && !queueState.isMember && !queueState.isInvited) {
    await sleep(retryDelayMs())
    await Promise.allSettled([
      syncAccountUserCount(accountId, { userListParams: { offset: 0, limit: 1, query: '' } }),
      syncAccountInviteCount(accountId, { inviteListParams: { offset: 0, limit: 1, query: '' } }),
    ])
    queueState = await detectEmailInAccountQueues(accountId, email)
  }

  return queueState
}

const listInvitedOrdersBatch = async ({ afterId = 0, limit = DEFAULT_BATCH_SIZE } = {}) => {
  const db = await getDatabase()
  const normalizedAfterId = Math.max(0, Number.parseInt(String(afterId || 0), 10) || 0)
  const normalizedLimit = Math.min(500, Math.max(1, Number.parseInt(String(limit || DEFAULT_BATCH_SIZE), 10) || DEFAULT_BATCH_SIZE))

  const result = db.exec(
    `
      SELECT id, email, invited_account_id, invited_account_email, invite_result
      FROM alipay_redpack_orders
      WHERE status = 'invited'
        AND id > ?
      ORDER BY id ASC
      LIMIT ?
    `,
    [normalizedAfterId, normalizedLimit]
  )

  const rows = result?.[0]?.values || []
  return rows.map(row => ({
    id: Number(row[0] || 0),
    email: String(row[1] || '').trim(),
    invitedAccountId: Number(row[2] || 0),
    invitedAccountEmail: row[3] ? String(row[3]) : null,
    inviteResult: row[4] ? String(row[4]) : '',
  }))
}

const syncInvitedOrder = async (order) => {
  const orderId = Number(order?.id || 0)
  const accountId = Number(order?.invitedAccountId || 0)
  const email = String(order?.email || '').trim()
  if (!orderId || !email) {
    return { processed: false, reason: 'invalid_order_payload' }
  }
  if (!accountId) {
    const existingInviteResult = String(order?.inviteResult || '').trim()
    if (existingInviteResult.includes('缺少绑定账号')) {
      return { processed: true, synced: true, nextStatus: 'invited_missing_account' }
    }
    await updateAlipayRedpackOrderInviteResult(orderId, {
      inviteResult: '定时同步：已邀请订单缺少绑定账号，请在订单页重新处理',
      operatorUsername: 'system:alipay_redpack_invited_sync',
    })
    return { processed: true, synced: true, nextStatus: 'invited_missing_account' }
  }

  const queueState = await syncAndDetectEmailQueueState(accountId, email, { retry: retryOnMissing() })
  if (queueState.isMember) {
    await markAlipayRedpackOrderRedeemed(orderId, {
      inviteResult: '定时同步：用户已入组，订单已兑换',
      invitedAccountId: accountId,
      invitedAccountEmail: order?.invitedAccountEmail || null,
      operatorUsername: 'system:alipay_redpack_invited_sync',
    })
    return { processed: true, synced: true, nextStatus: 'redeemed' }
  }

  if (queueState.isInvited) {
    await markAlipayRedpackOrderInvited(orderId, {
      inviteResult: '定时同步：邀请仍有效，等待用户接受',
      invitedAccountId: accountId,
      invitedAccountEmail: order?.invitedAccountEmail || null,
      operatorUsername: 'system:alipay_redpack_invited_sync',
    })
    return { processed: true, synced: true, nextStatus: 'invited' }
  }

  await updateAlipayRedpackOrderInviteResult(orderId, {
    inviteResult: '定时同步：未检索到邀请或成员，请在账号管理执行同步自查',
    operatorUsername: 'system:alipay_redpack_invited_sync',
  })
  return { processed: true, synced: true, nextStatus: 'invited_unknown' }
}

const runInvitedOrdersSyncOnce = async () => {
  const limit = batchSize()
  let lastId = 0
  let scanned = 0
  let synced = 0
  let redeemed = 0
  let stillInvited = 0
  let inviteUnknown = 0
  let missingAccount = 0
  let failed = 0

  while (true) {
    const orders = await listInvitedOrdersBatch({ afterId: lastId, limit })
    if (!orders.length) break

    for (const order of orders) {
      lastId = Math.max(lastId, Number(order?.id || 0))
      scanned += 1
      try {
        const result = await syncInvitedOrder(order)
        if (result?.synced) synced += 1
        if (result?.nextStatus === 'redeemed') redeemed += 1
        if (result?.nextStatus === 'invited') stillInvited += 1
        if (result?.nextStatus === 'invited_unknown') inviteUnknown += 1
        if (result?.nextStatus === 'invited_missing_account') missingAccount += 1
      } catch (error) {
        failed += 1
        console.warn(`${LABEL} sync order failed`, {
          orderId: Number(order?.id || 0),
          accountId: Number(order?.invitedAccountId || 0),
          message: error?.message || String(error),
        })
      }
    }

    if (orders.length < limit) break
  }

  return {
    scanned,
    synced,
    redeemed,
    stillInvited,
    inviteUnknown,
    missingAccount,
    failed,
  }
}

export const startAlipayRedpackInvitedOrderSyncSweeper = () => {
  if (!isEnabled()) {
    console.log(`${LABEL} disabled`)
    return () => {}
  }

  const intervalMs = Math.max(60 * 1000, intervalMinutes() * 60 * 1000)
  let running = false
  let stopped = false

  const runSafely = async (trigger) => {
    if (stopped) return
    if (running) {
      console.log(`${LABEL} previous run still active, skip`, { trigger })
      return
    }
    running = true
    const startedAt = Date.now()
    try {
      const result = await runInvitedOrdersSyncOnce()
      console.log(`${LABEL} run completed`, {
        trigger,
        durationMs: Date.now() - startedAt,
        ...result,
      })
    } catch (error) {
      console.warn(`${LABEL} run failed`, {
        trigger,
        message: error?.message || String(error),
      })
    } finally {
      running = false
    }
  }

  const initialTimer = setTimeout(() => {
    runSafely('startup')
  }, 5000)
  const intervalTimer = setInterval(() => {
    runSafely('interval')
  }, intervalMs)

  initialTimer.unref?.()
  intervalTimer.unref?.()

  console.log(`${LABEL} started`, {
    intervalMinutes: Math.round(intervalMs / 60 / 1000),
    batchSize: batchSize(),
    retryOnMissing: retryOnMissing(),
    retryDelayMs: retryDelayMs(),
  })

  return () => {
    stopped = true
    clearTimeout(initialTimer)
    clearInterval(intervalTimer)
  }
}
