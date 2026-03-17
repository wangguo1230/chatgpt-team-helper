import jwt from 'jsonwebtoken'

const ADMIN_JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this-in-production'
const LINUXDO_SESSION_SECRET = process.env.LINUXDO_SESSION_SECRET || `${ADMIN_JWT_SECRET}::linuxdo`
const LINUXDO_SESSION_ALGORITHMS = ['HS256']

const normalizeString = (value) => String(value ?? '').trim()
const normalizeTrustLevel = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : null
}

export function signLinuxDoSessionToken(payload, options = {}) {
  const uid = payload?.uid ? normalizeString(payload.uid) : ''
  const username = payload?.username ? normalizeString(payload.username) : ''
  if (!uid || !username) {
    throw new Error('无法生成 Linux DO session token：缺少 uid 或 username')
  }

  const name = payload?.name ? normalizeString(payload.name) : ''
  const trustLevelValue = payload?.trustLevel ?? payload?.trust_level
  const trustLevel = normalizeTrustLevel(trustLevelValue)

  const tokenPayload = { uid, username }
  if (name) tokenPayload.name = name
  if (trustLevel != null) tokenPayload.trustLevel = trustLevel

  const expiresIn = options.expiresIn || '24h'
  return jwt.sign(
    tokenPayload,
    LINUXDO_SESSION_SECRET,
    { expiresIn, algorithm: 'HS256' }
  )
}

export function verifyLinuxDoSessionToken(rawToken) {
  const token = normalizeString(rawToken)
  if (!token) return null
  try {
    return jwt.verify(token, LINUXDO_SESSION_SECRET, { algorithms: LINUXDO_SESSION_ALGORITHMS })
  } catch {
    return null
  }
}

export function authenticateLinuxDoSession(req, res, next) {
  const rawToken = req.headers['x-linuxdo-token']
  const token = typeof rawToken === 'string' ? rawToken.trim() : ''

  if (!token) {
    console.warn(`[LinuxDoSession] 鉴权失败: 头部缺少 x-linuxdo-token, 路径: ${req.path}`)
    return res.status(401).json({ error: '缺少 Linux DO session token' })
  }

  try {
    const decoded = jwt.verify(token, LINUXDO_SESSION_SECRET, { algorithms: LINUXDO_SESSION_ALGORITHMS })
    req.linuxdo = decoded
    next()
  } catch (error) {
    console.warn(`[LinuxDoSession] 鉴权失败: Token 无效或已过期, 路径: ${req.path}, 错误: ${error.message}`)
    return res.status(403).json({ error: 'Linux DO session token 无效或已过期' })
  }
}
