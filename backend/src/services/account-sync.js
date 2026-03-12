import { getDatabase, saveDatabase } from '../database/init.js'
import axios from 'axios'
import { sendAdminAlertEmail } from './email-service.js'
import { withLocks } from '../utils/locks.js'

const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
import { loadProxyList, parseProxyConfig, pickProxyByHash } from '../utils/proxy.js'

export class AccountSyncError extends Error {
  constructor(message, status = 500) {
    super(message)
    this.name = 'AccountSyncError'
    this.status = status
  }
}

const DEFAULT_PROXY_CACHE_TTL_MS = 60_000
let defaultProxyCache = { loadedAt: 0, proxies: [] }

const getDefaultProxyList = () => {
  const now = Date.now()
  if (defaultProxyCache.loadedAt && (now - defaultProxyCache.loadedAt) < DEFAULT_PROXY_CACHE_TTL_MS) {
    return defaultProxyCache.proxies
  }

  const proxies = loadProxyList()
  defaultProxyCache = { loadedAt: now, proxies }
  return proxies
}

const pickProxyFromEnv = () => {
  const candidates = [
    process.env.CHATGPT_PROXY_URL,
    process.env.CHATGPT_PROXY,
    process.env.ALL_PROXY,
    process.env.all_proxy,
    process.env.HTTPS_PROXY,
    process.env.https_proxy,
    process.env.HTTP_PROXY,
    process.env.http_proxy
  ]

  for (const candidate of candidates) {
    const normalized = String(candidate || '').trim()
    if (!normalized) continue
    const config = parseProxyConfig(normalized)
    if (config) {
      return { url: normalized, config }
    }
  }

  return null
}

const resolveRequestProxy = (proxy, { key, attempt } = {}) => {
  if (proxy === false) return false

  const rawString = typeof proxy === 'string' ? String(proxy).trim() : ''
  if (rawString) return rawString
  if (proxy && typeof proxy === 'object') return proxy

  const entry = pickProxyByHash(getDefaultProxyList(), key, { attempt }) || pickProxyFromEnv()
  return entry ? entry.url : null
}

function mapRowToAccount(row) {
  return {
    id: row[0],
    email: row[1],
    token: row[2],
    refreshToken: row[3],
    userCount: row[4],
    inviteCount: row[5],
    chatgptAccountId: row[6],
    oaiDeviceId: row[7],
    expireAt: row[8] || null,
    isOpen: Boolean(row[9]),
    isDemoted: false,
    isBanned: Boolean(row[10]),
    createdAt: row[11],
    updatedAt: row[12]
  }
}

async function fetchAccountById(db, accountId) {
  const result = db.exec(
    `
	    SELECT id, email, token, refresh_token, user_count, invite_count, chatgpt_account_id, oai_device_id, expire_at, is_open,
	           COALESCE(is_banned, 0) AS is_banned,
	           created_at, updated_at
	    FROM gpt_accounts
	    WHERE id = ?
  `,
    [accountId]
  )

  if (result.length === 0 || result[0].values.length === 0) {
    return null
  }

  return mapRowToAccount(result[0].values[0])
}

export async function fetchAllAccounts() {
	  const db = await getDatabase()
	  const result = db.exec(`
	    SELECT id, email, token, refresh_token, user_count, invite_count, chatgpt_account_id, oai_device_id, expire_at, is_open,
	           COALESCE(is_banned, 0) AS is_banned,
	           created_at, updated_at
	    FROM gpt_accounts
	    ORDER BY created_at DESC
  `)

  if (result.length === 0) {
    return []
  }

  return result[0].values.map(mapRowToAccount)
}

/**
 * 使用 refresh token 刷新 access token
 */
export const refreshAccessTokenWithRefreshToken = async (refreshToken, options = {}) => {
  const normalized = String(refreshToken || '').trim()
  if (!normalized) {
    throw new AccountSyncError('该账号未配置 refresh token', 400)
  }

  const { proxy, accountId } = options
  const resolvedProxy = resolveRequestProxy(proxy, { key: accountId })
  const proxyConfig = normalizeProxyConfig(resolvedProxy)
  const socksProxyUrl = proxyConfig && isSocksProxyConfig(proxyConfig)
    ? (typeof resolvedProxy === 'string' ? resolvedProxy : buildProxyUrlFromConfig(proxyConfig))
    : ''
  const socksAgent = socksProxyUrl ? await getSocksAgent(socksProxyUrl, proxyConfig) : null

  const requestData = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: OPENAI_CLIENT_ID,
    refresh_token: normalized,
    scope: 'openid profile email'
  }).toString()

  const requestOptions = {
    method: 'POST',
    url: 'https://auth.openai.com/oauth/token',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': requestData.length
    },
    data: requestData,
    timeout: 60000,
    proxy: socksAgent ? false : (proxyConfig || false),
    httpAgent: socksAgent || undefined,
    httpsAgent: socksAgent || undefined,
    validateStatus: () => true
  }

  try {
    const response = await axios(requestOptions)
    if (response.status !== 200 || !response.data?.access_token) {
      throw new AccountSyncError('刷新 token 失败，未返回有效凭证', 502)
    }

    const resultData = response.data
    return {
      accessToken: resultData.access_token,
      refreshToken: resultData.refresh_token || normalized,
      idToken: resultData.id_token,
      expiresIn: resultData.expires_in || 3600
    }
  } catch (error) {
    if (error?.response) {
      // 如果 OpenAI 明确返回 400/401，说明 RefreshToken 已失效，自动下架
      const status = error.response.status
      if ((status === 400 || status === 401) && accountId) {
        const db = await getDatabase()
        await markAccountAsInvalid(db, accountId, `OAuth 刷新返回 ${status}: ${message}`)
      }

      throw new AccountSyncError(message, 502)
    }

    throw new AccountSyncError(error?.message || '刷新 token 网络错误', 503)
  }
}

/**
 * 将刷新后的 token 持久化到数据库
 */
export const persistAccountTokens = async (db, accountId, tokens) => {
  if (!tokens?.accessToken) return null
  const nextRefreshToken = tokens.refreshToken ? String(tokens.refreshToken).trim() : ''

  db.run(
    `UPDATE gpt_accounts SET token = ?, refresh_token = ?, updated_at = DATETIME('now', 'localtime') WHERE id = ?`,
    [tokens.accessToken, nextRefreshToken || null, accountId]
  )
  await saveDatabase()
  return { accessToken: tokens.accessToken, refreshToken: nextRefreshToken || null }
}

function buildHeaders(account) {
  return {
    accept: '*/*',
    'accept-language': 'zh-CN,zh;q=0.9',
    authorization: `Bearer ${account.token}`,
    'chatgpt-account-id': account.chatgptAccountId,
    'oai-client-version': 'prod-eddc2f6ff65fee2d0d6439e379eab94fe3047f72',
    'oai-device-id': account.oaiDeviceId || '',
    'oai-language': 'zh-CN',
    referer: 'https://chatgpt.com/admin/members?tab=members',
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
  }
}

const normalizeProxyConfig = (proxy) => {
  if (!proxy) return null
  if (typeof proxy === 'string') return parseProxyConfig(proxy)
  if (typeof proxy === 'object' && proxy.host && proxy.port) {
    const protocol = proxy.protocol ? String(proxy.protocol).replace(':', '').toLowerCase() : 'http'
    if (!['http', 'https', 'socks', 'socks4', 'socks4a', 'socks5', 'socks5h'].includes(protocol)) return null
    const port = Number(proxy.port)
    if (!Number.isFinite(port) || port <= 0) return null

    const auth = proxy.auth && typeof proxy.auth === 'object'
      ? {
          username: proxy.auth.username ? String(proxy.auth.username) : '',
          password: proxy.auth.password ? String(proxy.auth.password) : ''
        }
      : undefined

    return {
      protocol,
      host: String(proxy.host),
      port,
      ...(auth && auth.username ? { auth } : {})
    }
  }

  return null
}

const formatProxyConfigForLog = (proxyConfig) => {
  if (!proxyConfig) return null
  return {
    protocol: proxyConfig.protocol,
    host: proxyConfig.host,
    port: proxyConfig.port
  }
}

const isSocksProxyConfig = (proxyConfig) => {
  if (!proxyConfig) return false
  const protocol = String(proxyConfig.protocol || '').toLowerCase()
  return protocol === 'socks' || protocol.startsWith('socks')
}

const buildProxyUrlFromConfig = (proxyConfig) => {
  if (!proxyConfig) return ''
  const protocol = String(proxyConfig.protocol || '').replace(':', '')
  const host = String(proxyConfig.host || '')
  const port = Number(proxyConfig.port || 0)
  if (!protocol || !host || !Number.isFinite(port) || port <= 0) return ''

  const auth = proxyConfig.auth && typeof proxyConfig.auth === 'object'
    ? {
        username: proxyConfig.auth.username ? String(proxyConfig.auth.username) : '',
        password: proxyConfig.auth.password ? String(proxyConfig.auth.password) : ''
      }
    : null

  const authPart = auth && auth.username
    ? `${encodeURIComponent(auth.username)}:${encodeURIComponent(auth.password || '')}@`
    : ''

  return `${protocol}://${authPart}${host}:${port}`
}

let socksProxyAgentModulePromise = null
const socksAgentCache = new Map()

async function getSocksProxyAgentModule() {
  if (!socksProxyAgentModulePromise) {
    socksProxyAgentModulePromise = import('socks-proxy-agent')
  }
  return socksProxyAgentModulePromise
}

async function getSocksAgent(proxyUrl, proxyConfigForLog) {
  const url = String(proxyUrl || '').trim()
  if (!url) return null

  const cached = socksAgentCache.get(url)
  if (cached) return cached

  let module
  try {
    module = await getSocksProxyAgentModule()
  } catch (error) {
    console.error('SOCKS 代理依赖缺失（socks-proxy-agent）', {
      proxy: formatProxyConfigForLog(proxyConfigForLog),
      message: error?.message || String(error)
    })
    throw new AccountSyncError('SOCKS5 代理需要安装依赖 socks-proxy-agent（请在 backend 执行 npm i socks-proxy-agent）', 500)
  }

  const SocksProxyAgent = module?.SocksProxyAgent || module?.default
  if (!SocksProxyAgent) {
    throw new AccountSyncError('SOCKS5 代理依赖 socks-proxy-agent 加载失败', 500)
  }

  const agent = new SocksProxyAgent(url)
  socksAgentCache.set(url, agent)
  return agent
}

async function requestChatgptText(apiUrl, { method, headers, data, proxy } = {}, logContext = {}) {
  const proxyKey = logContext?.accountId ?? logContext?.chatgptAccountId ?? ''
  const resolvedProxy = resolveRequestProxy(proxy, { key: proxyKey })
  const rawProxyUrl = typeof resolvedProxy === 'string' ? String(resolvedProxy).trim() : ''
  const proxyConfig = normalizeProxyConfig(resolvedProxy)
  const socksProxyUrl = proxyConfig && isSocksProxyConfig(proxyConfig)
    ? (rawProxyUrl || buildProxyUrlFromConfig(proxyConfig))
    : ''
  const socksAgent = socksProxyUrl ? await getSocksAgent(socksProxyUrl, proxyConfig) : null

  let response
  try {
    response = await axios.request({
      url: apiUrl,
      method: method || 'GET',
      headers,
      data,
      timeout: 60000,
      proxy: socksAgent ? false : (proxyConfig || false),
      httpAgent: socksAgent || undefined,
      httpsAgent: socksAgent || undefined,
      responseType: 'text',
      transformResponse: [d => d],
      validateStatus: () => true
    })
  } catch (error) {
    console.error('请求 ChatGPT API 网络错误', {
      ...logContext,
      proxy: formatProxyConfigForLog(proxyConfig),
      code: error?.code,
      message: error?.message || String(error)
    })
    throw new AccountSyncError('无法连接到 ChatGPT API，请检查网络连接', 503)
  }

  const text = typeof response.data === 'string' ? response.data : (response.data == null ? '' : String(response.data))
  return {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    text,
    proxyConfig
  }
}

const parseJsonOrThrow = (text, { logContext, message }) => {
  try {
    return JSON.parse(text)
  } catch (error) {
    console.error(message, { ...logContext, body: text }, error)
    throw new AccountSyncError(message, 500)
  }
}

/**
 * 标记账号为失效并下架（用于 401 彻底无法修复的场景）
 */
export const markAccountAsInvalid = async (db, accountId, reason) => {
  try {
    db.run(
      `
        UPDATE gpt_accounts
        SET is_open = 0,
            expire_at = '1970/01/01 00:00:00',
            updated_at = DATETIME('now', 'localtime')
        WHERE id = ?
      `,
      [accountId]
    )
    await saveDatabase()
    console.warn(`[AccountSync] 账号已标记为失效并下架: ID=${accountId}, 原因=${reason}`)

    // 触发即时邮件告警
    try {
      const account = await fetchAccountById(db, accountId)
      if (account) {
        await sendAdminAlertEmail({
          subject: `[账号失效] ${account.email}`,
          text: `账号已标记为失效并自动下架。\n账号 ID: ${accountId}\n邮箱: ${account.email}\n失效原因: ${reason}\n\n该操作会重置到期日期为 1970 年，前端管理列表将显示为“过期”状态。`
        })
      }
    } catch (mailError) {
      console.error('[AccountSync] 发送账号失效告警邮件失败', mailError)
    }
  } catch (error) {
    console.error(`[AccountSync] 标记账号失效失败: ID=${accountId}`, error)
  }
}

export async function fetchOpenAiAccountInfo(token, proxy = null) {
  const normalizedToken = String(token || '').trim().replace(/^Bearer\s+/i, '')
  if (!normalizedToken) {
    throw new AccountSyncError('缺少 access token', 400)
  }

  const apiUrl = 'https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27'
  const headers = {
    accept: '*/*',
    'accept-language': 'zh-CN,zh;q=0.9',
    authorization: `Bearer ${normalizedToken}`,
    'oai-client-version': 'prod-eddc2f6ff65fee2d0d6439e379eab94fe3047f72',
    'oai-language': 'zh-CN',
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
  }

  const logContext = { url: apiUrl }
  const { status, statusText, headers: responseHeaders, text, proxyConfig } = await requestChatgptText(
    apiUrl,
    { method: 'GET', headers, proxy },
    logContext
  )

  if (status < 200 || status >= 300) {
    console.error('OpenAI 校验 token 接口 HTTP 错误', {
      ...logContext,
      status,
      statusText,
      proxy: formatProxyConfigForLog(proxyConfig),
      headers: responseHeaders
    })
    console.error('OpenAI 校验 token 接口 HTTP body:', text)

    if (status === 401) {
      throw new AccountSyncError('Token 已过期或无效', 401)
    }
    throw new AccountSyncError(`OpenAI API 请求失败: ${status}`, status || 500)
  }

  const data = parseJsonOrThrow(text, { logContext, message: 'OpenAI 接口返回格式异常' })
  const accountsMap = data?.accounts && typeof data.accounts === 'object' ? data.accounts : {}
  const ordering = Array.isArray(data?.account_ordering) ? data.account_ordering : []

  const orderedIds = ordering
    .filter(id => typeof id === 'string')
    .filter(id => Object.prototype.hasOwnProperty.call(accountsMap, id))

  const fallbackIds = Object.keys(accountsMap).filter(id => !orderedIds.includes(id))
  const accountIds = [...orderedIds, ...fallbackIds].filter(id => id && id !== 'default')

  if (accountIds.length === 0) {
    throw new AccountSyncError('未找到关联的 ChatGPT 账号', 404)
  }

	  // Only keep team accounts (for workspace invite/admin operations).
	  return accountIds
	    .map(id => {
	      const acc = accountsMap[id]
	      return {
	        accountId: id,
	        name: acc?.account?.name || 'Unnamed Team',
	        planType: acc?.account?.plan_type || null,
	        expiresAt: acc?.entitlement?.expires_at || null,
	        hasActiveSubscription: !!acc?.entitlement?.has_active_subscription,
	        isDemoted: false
	      }
	    })
	    .filter(acc => acc.planType === 'team')
}

const throwChatgptApiStatusError = async ({ status, errorText, logContext, label }) => {
  console.error(label, {
    ...logContext,
    status,
    body: String(errorText || '').slice(0, 2000)
  })

  const rawErrorText = String(errorText || '').trim()
  if (rawErrorText) {
    try {
      const parsed = JSON.parse(rawErrorText)
      const code = parsed?.error?.code || parsed?.code
      if (code === 'account_deactivated') {
        const accountId = Number(logContext?.accountId)
        if (Number.isFinite(accountId)) {
          try {
            const db = await getDatabase()
            db.run(
              `
                UPDATE gpt_accounts
                SET is_open = 0,
                    is_banned = 1,
                    ban_processed = 0,
                    updated_at = DATETIME('now', 'localtime')
                WHERE id = ?
              `,
              [accountId]
            )
            await saveDatabase()
            console.warn('[AccountSync] upstream account_deactivated; auto-banned', { accountId })

            // 触发即时邮件告警
            try {
              const account = await fetchAccountById(db, accountId)
              if (account) {
                await sendAdminAlertEmail({
                  subject: `[账号封号] ${account.email}`,
                  text: `系统检测到 OpenAI 账号已停用 (account_deactivated)。\n账号 ID: ${accountId}\n邮箱: ${account.email}\n系统已自动将该账号标记为封号并下架，请及时核查。`
                })
              }
            } catch (mailError) {
              console.error('[AccountSync] 发送封号告警邮件失败', mailError)
            }
          } catch (error) {
            console.error('[AccountSync] auto-ban failed', {
              accountId,
              message: error?.message || String(error)
            })
          }
        }

        throw new AccountSyncError('OpenAI 账号已停用（account_deactivated），已自动标记为封号', 401)
      }
    } catch {
      // ignore parse errors
    }
  }

  if (status === 401 || status === 403) {
    throw new AccountSyncError('Token 已过期或无效，请更新账号 token', status)
  }
  if (status === 404) {
    throw new AccountSyncError('ChatGPT 账号不存在或无权访问', 404)
  }
  if (status === 429) {
    throw new AccountSyncError('API 请求过于频繁，请稍后重试', 429)
  }

  throw new AccountSyncError(`ChatGPT API 请求失败: ${status}`, status || 500)
}

async function requestAccountInvites(account, params = {}, requestOptions = {}) {
  const parsedLimit = Number.parseInt(params.limit, 10)
  const parsedOffset = Number.parseInt(params.offset, 10)
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 25
  const offset = Number.isFinite(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0
  const query = typeof params.query === 'string' ? params.query : ''

  const apiUrl = `https://chatgpt.com/backend-api/accounts/${account.chatgptAccountId}/invites?offset=${offset}&limit=${limit}&query=${encodeURIComponent(query)}`
  const logContext = {
    accountId: account.id,
    chatgptAccountId: account.chatgptAccountId,
    limit,
    offset,
    url: apiUrl
  }

  const { status, text } = await requestChatgptText(
    apiUrl,
    {
      method: 'GET',
      headers: {
        ...buildHeaders(account),
        referer: 'https://chatgpt.com/admin/members?tab=invites'
      },
      proxy: requestOptions.proxy
    },
    logContext
  )

  if (status < 200 || status >= 300) {
    await throwChatgptApiStatusError({
      status,
      errorText: text,
      logContext,
      label: 'ChatGPT API 错误: 获取邀请列表失败'
    })
  }

  const data = parseJsonOrThrow(text, { logContext, message: 'ChatGPT 邀请响应 JSON 解析失败' })

  if (typeof data.total !== 'number') {
    console.error('ChatGPT 邀请响应缺少 total 字段', {
      ...logContext,
      responseSample: JSON.stringify(data).slice(0, 500)
    })
    throw new AccountSyncError('ChatGPT API 响应格式异常，缺少 total 字段', 500)
  }

  if (!Array.isArray(data.items)) {
    console.error('ChatGPT 邀请响应 items 字段异常', {
      ...logContext,
      responseSample: JSON.stringify(data).slice(0, 500)
    })
    data.items = []
  }

  return {
    items: data.items.map(item => ({
      id: item.id,
      email_address: item.email_address,
      role: item.role,
      created_time: item.created_time,
      is_scim_managed: item.is_scim_managed
    })),
    total: data.total,
    limit: typeof data.limit === 'number' ? data.limit : limit,
    offset: typeof data.offset === 'number' ? data.offset : offset
  }
}

async function requestDeleteAccountInvite(account, emailAddress, requestOptions = {}) {
  const trimmedEmail = String(emailAddress || '').trim().toLowerCase()
  if (!trimmedEmail) {
    throw new AccountSyncError('请提供邀请邮箱地址', 400)
  }

  const apiUrl = `https://chatgpt.com/backend-api/accounts/${account.chatgptAccountId}/invites`
  const logContext = {
    accountId: account.id,
    chatgptAccountId: account.chatgptAccountId,
    email: trimmedEmail,
    url: apiUrl
  }

  const { status, text } = await requestChatgptText(
    apiUrl,
    {
      method: 'DELETE',
      headers: {
        ...buildHeaders(account),
        'content-type': 'application/json',
        origin: 'https://chatgpt.com',
        referer: 'https://chatgpt.com/admin/members?tab=invites'
      },
      data: { email_address: trimmedEmail },
      proxy: requestOptions.proxy
    },
    logContext
  )

  if (status < 200 || status >= 300) {
    await throwChatgptApiStatusError({
      status,
      errorText: text,
      logContext,
      label: 'ChatGPT API 错误: 删除邀请失败'
    })
  }

  // 上游可能返回空 body
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function requestAccountUsers(account, params = {}, requestOptions = {}) {
  const parsedLimit = Number.parseInt(params.limit, 10)
  const parsedOffset = Number.parseInt(params.offset, 10)
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 25
  const offset = Number.isFinite(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0
  const query = typeof params.query === 'string' ? params.query : ''
  const apiUrl = `https://chatgpt.com/backend-api/accounts/${account.chatgptAccountId}/users?offset=${offset}&limit=${limit}&query=${encodeURIComponent(query)}`
  const logContext = {
    accountId: account.id,
    chatgptAccountId: account.chatgptAccountId,
    limit,
    offset,
    query,
    url: apiUrl
  }

  const { status, text } = await requestChatgptText(
    apiUrl,
    {
      method: 'GET',
      headers: buildHeaders(account),
      proxy: requestOptions.proxy
    },
    logContext
  )

  if (status < 200 || status >= 300) {
    await throwChatgptApiStatusError({
      status,
      errorText: text,
      logContext,
      label: 'ChatGPT API 错误: 获取成员失败'
    })
  }

  const data = parseJsonOrThrow(text, { logContext, message: 'ChatGPT 成员响应 JSON 解析失败' })

  if (typeof data.total !== 'number') {
    console.error('ChatGPT 成员响应缺少 total 字段', {
      ...logContext,
      responseSample: JSON.stringify(data).slice(0, 500)
    })
    throw new AccountSyncError('ChatGPT API 响应格式异常，缺少 total 字段', 500)
  }

  if (!Array.isArray(data.items)) {
    console.error('ChatGPT 成员响应 items 字段异常', {
      ...logContext,
      responseSample: JSON.stringify(data).slice(0, 500)
    })
    data.items = []
  }

  return {
    total: data.total,
    limit: typeof data.limit === 'number' ? data.limit : limit,
    offset: typeof data.offset === 'number' ? data.offset : offset,
    items: data.items.map(item => ({
      id: item.id,
      account_user_id: item.account_user_id,
      email: item.email,
      role: item.role,
      name: item.name,
      created_time: item.created_time,
      is_scim_managed: item.is_scim_managed
    }))
  }
}

/**
 * 集中化处理需要 Token 自动刷新的操作
 * @param {number|string} accountId 账号 ID
 * @param {Function} operation (account) => Promise<any>
 * @param {Object} options 其他选项
 */
async function executeWithTokenRefresh(accountId, operation, options = {}) {
  const db = await getDatabase()
  let account = options.accountRecord || (await fetchAccountById(db, accountId))

  if (!account) {
    throw new AccountSyncError('账号不存在', 404)
  }

  if (!account.token || !account.chatgptAccountId) {
    throw new AccountSyncError('账号信息不完整，缺少 token 或 chatgpt_account_id', 400)
  }

  try {
    return await operation(account)
  } catch (error) {
    // 如果是 401，尝试刷新
    if (error?.status === 401) {
      // 获取账号锁，防止并发刷新
      return await withLocks([`acct_sync:${accountId}`], async () => {
        // 锁定后重新从数据库加载，检查 Token 是否已被其他请求修复
        const currentAccount = await fetchAccountById(db, accountId)
        if (!currentAccount) throw new AccountSyncError('账号不存在', 404)

        // 如果 Token 已经变了，说明并发请求已经刷过 Token 了，直接用新 Token 重试即可
        if (currentAccount.token !== account.token) {
          console.info(`[AccountSync] 检测到并发 Token 刷新，跳过重复刷新并使用新 Token 重试: ${currentAccount.email}`)
          return await operation(currentAccount)
        }

        // 确定需要刷新
        if (currentAccount.refreshToken) {
          console.info(`[AccountSync] executeWithTokenRefresh 触发 Token 自动刷新: ${currentAccount.email}`)
          try {
            const tokens = await refreshAccessTokenWithRefreshToken(currentAccount.refreshToken, {
              proxy: currentAccount.proxy || null,
              accountId: currentAccount.id
            })
            const persisted = await persistAccountTokens(db, currentAccount.id, tokens)
            const nextAccount = { ...currentAccount, token: persisted.accessToken, refreshToken: persisted.refreshToken }

            // 使用新 token 重试
            return await operation(nextAccount)
          } catch (refreshError) {
            console.error(`[AccountSync] executeWithTokenRefresh 自动刷新失败: ${currentAccount.email}`, refreshError.message || refreshError)
            // 彻底失效，下架账号
            await markAccountAsInvalid(db, currentAccount.id, `Token 自动刷新失败: ${refreshError.message || '未知错误'}`)
            throw error // 抛出原始 401 错误
          }
        }

        // 确定无法刷新且没有 refresh_token
        await markAccountAsInvalid(db, currentAccount.id, 'Token 已过期且未配置 Refresh Token')
        throw error
      })
    }
    throw error
  }
}

export async function fetchAccountUsersList(accountId, options = {}) {
  return executeWithTokenRefresh(accountId, (acc) =>
    requestAccountUsers(acc, options.userListParams, { proxy: options.proxy }),
    options
  )
}

export async function syncAccountUserCount(accountId, options = {}) {
  return executeWithTokenRefresh(accountId, async (acc) => {
    const db = await getDatabase()
    const usersData = await requestAccountUsers(acc, { ...(options.userListParams || {}), query: '' }, { proxy: options.proxy })

    db.run(
      `UPDATE gpt_accounts SET user_count = ?, updated_at = DATETIME('now', 'localtime') WHERE id = ?`,
      [usersData.total, acc.id]
    )
    await saveDatabase()

    const updatedAccount = await fetchAccountById(db, acc.id)

    return {
      account: updatedAccount,
      syncedUserCount: usersData.total,
      users: usersData
    }
  }, options)
}

export async function fetchAccountInvites(accountId, options = {}) {
  return executeWithTokenRefresh(accountId, (acc) =>
    requestAccountInvites(acc, options.inviteListParams, { proxy: options.proxy }),
    options
  )
}

export async function syncAccountInviteCount(accountId, options = {}) {
  return executeWithTokenRefresh(accountId, async (acc) => {
    const db = await getDatabase()
    const invitesData = await requestAccountInvites(acc, options.inviteListParams, { proxy: options.proxy })

    db.run(
      `UPDATE gpt_accounts SET invite_count = ?, updated_at = DATETIME('now', 'localtime') WHERE id = ?`,
      [invitesData.total, acc.id]
    )
    await saveDatabase()

    const updatedAccount = await fetchAccountById(db, acc.id)

    return {
      account: updatedAccount,
      inviteCount: invitesData.total,
      invites: invitesData
    }
  }, options)
}

export async function deleteAccountInvite(accountId, emailAddress, options = {}) {
  return executeWithTokenRefresh(accountId, async (acc) => {
    const trimmedEmail = String(emailAddress || '').trim()
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(trimmedEmail)) {
      throw new AccountSyncError('邮箱格式不正确', 400)
    }

    const result = await requestDeleteAccountInvite(acc, trimmedEmail, { proxy: options.proxy })
    const synced = await syncAccountInviteCount(acc.id, {
      accountRecord: acc,
      inviteListParams: { offset: 0, limit: 1, query: '' },
      proxy: options.proxy
    })

    return {
      message: '邀请删除成功',
      result,
      account: synced.account,
      inviteCount: synced.inviteCount
    }
  }, options)
}

export async function deleteAccountUser(accountId, userId, options = {}) {
  return executeWithTokenRefresh(accountId, async (acc) => {
    if (!userId) {
      throw new AccountSyncError('缺少用户ID', 400)
    }

    const normalizedUserId = userId.startsWith('user-') ? userId : `user-${userId}`
    const apiUrl = `https://chatgpt.com/backend-api/accounts/${acc.chatgptAccountId}/users/${normalizedUserId}`
    const deleteLogContext = {
      accountId: acc.id,
      chatgptAccountId: acc.chatgptAccountId,
      userId: normalizedUserId,
      url: apiUrl
    }

    console.info('开始删除 ChatGPT 成员', deleteLogContext)
    const { status, text } = await requestChatgptText(
      apiUrl,
      { method: 'DELETE', headers: buildHeaders(acc), proxy: options.proxy },
      deleteLogContext
    )

    if (status < 200 || status >= 300) {
      await throwChatgptApiStatusError({
        status,
        errorText: text,
        logContext: deleteLogContext,
        label: 'ChatGPT API 错误: 删除成员失败'
      })
    }

    const usersData = await requestAccountUsers(acc, options.userListParams, { proxy: options.proxy })

    const db = await getDatabase()
    db.run(
      `UPDATE gpt_accounts SET user_count = ?, updated_at = DATETIME('now', 'localtime') WHERE id = ?`,
      [usersData.total, acc.id]
    )
    await saveDatabase()

    const updatedAccount = await fetchAccountById(db, acc.id)

    return {
      account: updatedAccount,
      syncedUserCount: usersData.total,
      users: usersData
    }
  }, options)
}

export async function inviteAccountUser(accountId, email, options = {}) {
  return executeWithTokenRefresh(accountId, async (acc) => {
    if (!email || typeof email !== 'string') {
      throw new AccountSyncError('请提供邀请邮箱地址', 400)
    }

    const trimmedEmail = email.trim()
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(trimmedEmail)) {
      throw new AccountSyncError('邮箱格式不正确', 400)
    }

    const apiUrl = `https://chatgpt.com/backend-api/accounts/${acc.chatgptAccountId}/invites`
    const payload = {
      email_addresses: [trimmedEmail],
      role: 'standard-user',
      resend_emails: true
    }

    const headers = {
      ...buildHeaders(acc),
      'content-type': 'application/json',
      origin: 'https://chatgpt.com',
      referer: 'https://chatgpt.com/admin/members'
    }

    const inviteLogContext = {
      accountId: acc.id,
      chatgptAccountId: acc.chatgptAccountId,
      email: trimmedEmail,
      url: apiUrl
    }

    const { status, text } = await requestChatgptText(
      apiUrl,
      { method: 'POST', headers, data: payload, proxy: options.proxy },
      inviteLogContext
    )

    if (status < 200 || status >= 300) {
      await throwChatgptApiStatusError({
        status,
        errorText: text,
        logContext: inviteLogContext,
        label: 'ChatGPT API 错误: 发送邀请失败'
      })
    }

    const data = parseJsonOrThrow(text, { logContext: inviteLogContext, message: '邀请接口返回格式异常，无法解析' })

    return {
      message: '邀请已发送',
      invite: data
    }
  }, options)
}
