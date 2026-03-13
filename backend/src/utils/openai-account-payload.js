const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key)

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const looksLikeJsonObject = (value) => {
  if (typeof value !== 'string') return false
  const raw = value.trim()
  return raw.startsWith('{') && raw.endsWith('}')
}

const normalizeText = (value) => {
  if (value == null) return ''
  const text = String(value).trim()
  return text || ''
}

const parseObjectField = (value, fieldName) => {
  if (isPlainObject(value)) {
    return { value, error: '' }
  }

  if (typeof value !== 'string') {
    return { value: null, error: '' }
  }

  const raw = value.trim()
  if (!raw) {
    return { value: null, error: '' }
  }

  if (!looksLikeJsonObject(raw)) {
    return { value: null, error: '' }
  }

  try {
    const parsed = JSON.parse(raw)
    if (!isPlainObject(parsed)) {
      return { value: null, error: `${fieldName} JSON 必须是对象` }
    }
    return { value: parsed, error: '' }
  } catch {
    return { value: null, error: `${fieldName} JSON 格式错误` }
  }
}

const readFirstValue = (sources, keys) => {
  for (const source of sources) {
    if (!isPlainObject(source)) continue
    for (const key of keys) {
      if (!hasOwn(source, key)) continue
      const value = source[key]
      if (value == null) continue
      if (typeof value === 'string') {
        const trimmed = value.trim()
        if (trimmed) return trimmed
        continue
      }
      if (typeof value === 'number' || typeof value === 'boolean') {
        return value
      }
      if (typeof value === 'object') continue
      const normalized = normalizeText(value)
      if (normalized) return normalized
    }
  }
  return null
}

const hasAnyKey = (sources, keys) => {
  for (const source of sources) {
    if (!isPlainObject(source)) continue
    for (const key of keys) {
      if (hasOwn(source, key)) return true
    }
  }
  return false
}

const decodeJwtPayload = (token) => {
  const raw = normalizeText(token)
  if (!raw) return null
  const parts = raw.split('.')
  if (parts.length < 2) return null
  const payload = parts[1]
  if (!payload) return null

  try {
    const padded = payload
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(payload.length / 4) * 4, '=')
    const decoded = Buffer.from(padded, 'base64').toString('utf8')
    const parsed = JSON.parse(decoded)
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

export const deriveChatgptAccountIdFromToken = (token) => {
  const payload = decodeJwtPayload(token)
  if (!payload) return ''

  const authClaim = payload['https://api.openai.com/auth']
  if (isPlainObject(authClaim)) {
    const fromAuth = normalizeText(authClaim.chatgpt_account_id)
    if (fromAuth) return fromAuth
  }

  const direct = normalizeText(payload.chatgpt_account_id)
  if (direct) return direct

  return normalizeText(payload.account_id)
}

export const extractOpenAiAccountPayload = (bodyInput) => {
  const body = isPlainObject(bodyInput) ? bodyInput : {}

  const parsedTokenField = parseObjectField(body.token, 'token')
  const parsedRefreshField = parseObjectField(body.refreshToken, 'refreshToken')
  const parsedTokenJsonField = parseObjectField(
    hasOwn(body, 'tokenJson') ? body.tokenJson : body.token_json,
    hasOwn(body, 'tokenJson') ? 'tokenJson' : 'token_json'
  )

  const parseErrors = [parsedTokenField.error, parsedRefreshField.error, parsedTokenJsonField.error].filter(Boolean)

  const sources = [body]
  if (parsedTokenJsonField.value) sources.push(parsedTokenJsonField.value)
  if (parsedTokenField.value) sources.push(parsedTokenField.value)
  if (parsedRefreshField.value) sources.push(parsedRefreshField.value)

  const tokenRaw = typeof body.token === 'string' ? body.token.trim() : ''
  const tokenIsJsonLike = looksLikeJsonObject(tokenRaw)
  let token = normalizeText(readFirstValue(sources, ['access_token', 'accessToken']))
  if (!token && parsedTokenField.value) {
    token = normalizeText(
      readFirstValue([parsedTokenField.value], ['access_token', 'accessToken', 'token'])
    )
  }
  if (!token && tokenRaw && !tokenIsJsonLike) {
    token = tokenRaw
  }

  const refreshRaw = typeof body.refreshToken === 'string' ? body.refreshToken.trim() : ''
  const refreshIsJsonLike = looksLikeJsonObject(refreshRaw)
  let refreshToken = normalizeText(readFirstValue(sources, ['refresh_token', 'refreshToken']))
  if (!refreshToken && parsedRefreshField.value) {
    refreshToken = normalizeText(
      readFirstValue([parsedRefreshField.value], ['refresh_token', 'refreshToken'])
    )
  }
  if (!refreshToken && refreshRaw && !refreshIsJsonLike) {
    refreshToken = refreshRaw
  }

  const email = normalizeText(readFirstValue(sources, ['email', 'account_email']))
  const oaiDeviceId = normalizeText(readFirstValue(sources, ['oaiDeviceId', 'oai_device_id']))

  let chatgptAccountId = normalizeText(
    readFirstValue(sources, ['chatgptAccountId', 'chatgpt_account_id', 'account_id'])
  )
  if (!chatgptAccountId && token) {
    chatgptAccountId = deriveChatgptAccountIdFromToken(token)
  }

  const expireAtAliases = ['expireAt', 'expire_at', 'expired', 'expiresAt', 'expires_at']
  const hasExpireAt = hasAnyKey(sources, expireAtAliases)
  const expireAtInput = readFirstValue(sources, expireAtAliases)

  return {
    parseErrors,
    token,
    refreshToken,
    email,
    chatgptAccountId,
    oaiDeviceId,
    hasExpireAt,
    expireAtInput
  }
}
