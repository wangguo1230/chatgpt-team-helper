import express from 'express'
import { getDatabase, saveDatabase } from '../database/init.js'
import { apiKeyAuth } from '../middleware/api-key-auth.js'
import { syncAccountUserCount } from '../services/account-sync.js'
import { extractOpenAiAccountPayload } from '../utils/openai-account-payload.js'

const router = express.Router()

const EXPIRE_AT_REGEX = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/

const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase()

const normalizeBoolean = (value) => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (value === 1) return true
    if (value === 0) return false
    return null
  }
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw) return null
  if (['1', 'true', 'yes'].includes(raw)) return true
  if (['0', 'false', 'no'].includes(raw)) return false
  return null
}

const formatExpireAt = (date) => {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(date)
  } catch {
    const pad = (value) => String(value).padStart(2, '0')
    return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }
}

const normalizeExpireAt = (value) => {
  if (value == null) return null
  const raw = String(value).trim()
  if (!raw) return null
  if (EXPIRE_AT_REGEX.test(raw)) return raw

  const match = raw.match(/^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2})(?::\d{2})?$/)
  if (match) {
    return `${match[1]}/${match[2]}/${match[3]} ${match[4]}:${match[5]}`
  }

  const asNumber = Number(raw)
  if (Number.isFinite(asNumber) && asNumber > 0) {
    const date = new Date(asNumber)
    if (!Number.isNaN(date.getTime())) {
      return formatExpireAt(date)
    }
  }

  const parsedMs = Date.parse(raw)
  if (!Number.isNaN(parsedMs)) {
    return formatExpireAt(new Date(parsedMs))
  }

  return null
}

const decodeJwtPayload = (token) => {
  const raw = String(token || '').trim()
  if (!raw) return null
  const parts = raw.split('.')
  if (parts.length < 2) return null
  const payload = parts[1]
  if (!payload) return null
  try {
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=')
    const decoded = Buffer.from(padded, 'base64').toString('utf8')
    return JSON.parse(decoded)
  } catch {
    return null
  }
}

const deriveExpireAtFromToken = (token) => {
  const payload = decodeJwtPayload(token)
  if (!payload || typeof payload !== 'object') return null
  const exp = Number(payload.exp)
  if (!Number.isFinite(exp) || exp <= 0) return null
  const date = new Date(exp * 1000)
  if (Number.isNaN(date.getTime())) return null
  return formatExpireAt(date)
}

async function syncAccountAndCleanup(account) {
  let syncData = null
  const removedUsers = []

  try {
    console.log('[Auto Boarding] 准备同步账号:', {
      email: account.email,
      chatgptAccountId: account.chatgptAccountId
    })
    syncData = await syncAccountUserCount(account.id, {
      accountRecord: account
    })
    console.log('[Auto Boarding] 同步完成:', {
      email: account.email,
      syncedUserCount: syncData.syncedUserCount,
      fetchedUsers: syncData?.users?.items?.length || 0
    })
  } catch (syncError) {
    console.error('[Auto Boarding] 同步失败:', syncError)
    return {
      account,
      syncResult: null,
      removedUsers
    }
  }

  return {
    account: syncData?.account || account,
    syncResult: syncData
      ? {
        syncedUserCount: syncData.syncedUserCount,
        users: syncData.users
      }
      : null,
    removedUsers
  }
}

// 自动上车接口
router.post('/', apiKeyAuth, async (req, res) => {
  try {
    const body = req.body || {}
    const extracted = extractOpenAiAccountPayload(body)
    if (extracted.parseErrors.length > 0) {
      return res.status(400).json({
        error: extracted.parseErrors[0],
        message: extracted.parseErrors[0]
      })
    }

    const email = String(extracted.email || body.email || '').trim()
    const token = String(extracted.token || '').trim()
    const refreshToken = String(extracted.refreshToken || '').trim()
    const chatgptAccountId = String(extracted.chatgptAccountId || '').trim()
    const oaiDeviceId = String(extracted.oaiDeviceId || body.oaiDeviceId || '').trim()
    const hasExpireAt = extracted.hasExpireAt || Object.prototype.hasOwnProperty.call(body, 'expireAt')
    const expireAtInput = hasExpireAt
      ? (extracted.hasExpireAt ? extracted.expireAtInput : body.expireAt)
      : null
    const normalizedExpireAt = hasExpireAt ? normalizeExpireAt(expireAtInput) : null
    const shouldUpdateExpireAt = hasExpireAt || Boolean(deriveExpireAtFromToken(token))
    const derivedExpireAt = shouldUpdateExpireAt && !hasExpireAt ? deriveExpireAtFromToken(token) : null
    const expireAt = hasExpireAt ? normalizedExpireAt : (derivedExpireAt || null)
    // isDemoted/is_demoted: deprecated (ignored). Keep request compatibility.

    if (hasExpireAt && expireAtInput != null && String(expireAtInput).trim() && !normalizedExpireAt) {
      return res.status(400).json({
        error: 'Invalid expireAt format',
        message: 'expireAt 格式错误，请使用 YYYY/MM/DD HH:mm'
      })
    }

    // 验证必填字段
    if (!email || !token) {
      return res.status(400).json({
        error: 'Email and token are required',
        message: '邮箱和Token是必填项'
      })
    }

    const normalizedEmail = normalizeEmail(email)

    const db = await getDatabase()

    // 检查账号是否已存在（通过email或chatgptAccountId）
    let existingAccount = null

    if (chatgptAccountId) {
      const result = db.exec(
        'SELECT id, email FROM gpt_accounts WHERE chatgpt_account_id = ?',
        [chatgptAccountId]
      )
      if (result.length > 0 && result[0].values.length > 0) {
        existingAccount = {
          id: result[0].values[0][0],
          email: result[0].values[0][1]
        }
      }
    }

    // 如果chatgptAccountId未找到，再通过email查找
    if (!existingAccount) {
      const result = db.exec(
        'SELECT id, email FROM gpt_accounts WHERE lower(email) = ?',
        [normalizedEmail]
      )
      if (result.length > 0 && result[0].values.length > 0) {
        existingAccount = {
          id: result[0].values[0][0],
          email: result[0].values[0][1]
        }
      }
    }

    if (existingAccount) {
      // 账号已存在，更新token和其他信息
	      db.run(
	        `UPDATE gpt_accounts
	         SET token = ?,
	             refresh_token = ?,
	             chatgpt_account_id = ?,
	             oai_device_id = ?,
	             is_open = 1,
	             expire_at = CASE WHEN ? = 1 THEN ? ELSE expire_at END,
	             updated_at = DATETIME('now', 'localtime')
	         WHERE id = ?`,
	        [token, refreshToken || null, chatgptAccountId || null, oaiDeviceId || null, shouldUpdateExpireAt ? 1 : 0, expireAt, existingAccount.id]
	      )
	      saveDatabase()

	      // 获取更新后的账号信息
	      const result = db.exec(`
	        SELECT id, email, token, refresh_token, user_count, chatgpt_account_id, oai_device_id, expire_at,
	               created_at, updated_at
	        FROM gpt_accounts
	        WHERE id = ?
	      `, [existingAccount.id])

	      const row = result[0].values[0]
	      const account = {
	        id: row[0],
	        email: row[1],
	        token: row[2],
	        refreshToken: row[3],
	        userCount: row[4],
	        chatgptAccountId: row[5],
	        oaiDeviceId: row[6],
	        expireAt: row[7] || null,
	        isDemoted: false,
	        createdAt: row[8],
	        updatedAt: row[9]
	      }

      const { account: syncedAccount, syncResult, removedUsers } = await syncAccountAndCleanup(account)

      return res.json({
        success: true,
        message: '账号信息已更新',
        action: 'updated',
        account: syncedAccount,
        syncResult,
        removedUsers
      })
    } else {
	      // 创建新账号，默认人数设置为1而不是0
	      db.run(
	        `INSERT INTO gpt_accounts
	         (email, token, refresh_token, user_count, chatgpt_account_id, oai_device_id, expire_at, is_open, created_at, updated_at)
	         VALUES (?, ?, ?, ?, ?, ?, ?, 1, DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))`,
	        [normalizedEmail, token, refreshToken || null, 1, chatgptAccountId || null, oaiDeviceId || null, expireAt]
	      )

	      // 获取新创建的账号
	      const result = db.exec(`
	        SELECT id, email, token, refresh_token, user_count, chatgpt_account_id, oai_device_id, expire_at,
	               created_at, updated_at
	        FROM gpt_accounts
	        WHERE id = last_insert_rowid()
	      `)

      const row = result[0].values[0]
	      const account = {
	        id: row[0],
	        email: row[1],
	        token: row[2],
	        refreshToken: row[3],
	        userCount: row[4],
	        chatgptAccountId: row[5],
	        oaiDeviceId: row[6],
	        expireAt: row[7] || null,
	        isDemoted: false,
	        createdAt: row[8],
	        updatedAt: row[9]
	      }

      saveDatabase()

      const { account: responseAccount, syncResult, removedUsers } = await syncAccountAndCleanup(account)

      return res.status(201).json({
        success: true,
        message: '自动上车成功！账号已添加到系统',
        action: 'created',
        account: responseAccount,
        generatedCodes: [],
        codesMessage: '已关闭自动生成兑换码',
        syncResult,
        removedUsers
      })
    }
  } catch (error) {
    console.error('Auto boarding error:', error)
    res.status(500).json({
      error: 'Internal server error',
      message: '服务器错误，请稍后重试'
    })
  }
})

// 获取自动上车统计信息（可选）
router.get('/stats', apiKeyAuth, async (req, res) => {
  try {
    const db = await getDatabase()

    // 获取总账号数
    const totalResult = db.exec('SELECT COUNT(*) as count FROM gpt_accounts')
    const total = totalResult[0]?.values[0]?.[0] || 0

    // 获取最近24小时新增的账号数
    const recentResult = db.exec(`
      SELECT COUNT(*) as count
      FROM gpt_accounts
      WHERE created_at >= datetime('now', 'localtime', '-1 day')
    `)
    const recent = recentResult[0]?.values[0]?.[0] || 0

    res.json({
      success: true,
      stats: {
        totalAccounts: total,
        recentAccounts: recent
      }
    })
  } catch (error) {
    console.error('Get stats error:', error)
    res.status(500).json({
      error: 'Internal server error',
      message: '获取统计信息失败'
    })
  }
})

export default router
