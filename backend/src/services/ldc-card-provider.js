import axios from 'axios'

const REDEEM_PROVIDER_YYL = 'yyl'

const toInt = (value, fallback, minimum = 0) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return Math.max(minimum, fallback)
  return Math.max(minimum, parsed)
}

const safeJson = (value, fallback = {}) => {
  if (value && typeof value === 'object') return value
  if (typeof value !== 'string') return fallback
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

const cutText = (value, max = 1800) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value || {})
  if (!text) return ''
  if (text.length <= max) return text
  return `${text.slice(0, max)}...(truncated)`
}

const trimString = (value) => String(value ?? '').trim()

const buildRedeemConfig = () => {
  const baseUrlRaw = trimString(process.env.LDC_SHOP_REDEEM_BASE_URL || 'https://yyl.ncet.top')
  const baseUrl = baseUrlRaw.replace(/\/+$/, '')
  return {
    baseUrl,
    validatePath: trimString(process.env.LDC_SHOP_REDEEM_VALIDATE_PATH || '/shop/shop/redeem/validate') || '/shop/shop/redeem/validate',
    submitPath: trimString(process.env.LDC_SHOP_REDEEM_SUBMIT_PATH || '/shop/shop/redeem') || '/shop/shop/redeem',
    taskStatusPath: trimString(process.env.LDC_SHOP_REDEEM_TASK_STATUS_PATH || '/shop/shop/redeem/task-status/{task_id}') || '/shop/shop/redeem/task-status/{task_id}',
    timeoutMs: toInt(process.env.LDC_SHOP_REDEEM_TIMEOUT_MS, 20000, 3000),
    requestRetries: toInt(process.env.LDC_SHOP_REDEEM_REQUEST_RETRIES, 2, 0),
    pollMaxAttempts: toInt(process.env.LDC_SHOP_REDEEM_TASK_POLL_MAX_ATTEMPTS, 8, 1),
    pollIntervalMs: toInt(process.env.LDC_SHOP_REDEEM_TASK_POLL_INTERVAL_MS, 30000, 500),
    contactEmail: trimString(process.env.LDC_SHOP_REDEEM_CONTACT_EMAIL || ''),
    visitorPrefix: trimString(process.env.LDC_SHOP_REDEEM_VISITOR_ID_PREFIX || 'visitor_') || 'visitor_',
    quantity: toInt(process.env.LDC_SHOP_REDEEM_QUANTITY, 1, 1)
  }
}

const joinUrl = (baseUrl, pathOrUrl, params = {}) => {
  let path = trimString(pathOrUrl)
  for (const [key, value] of Object.entries(params || {})) {
    path = path.replace(new RegExp(`\\{${key}\\}`, 'g'), encodeURIComponent(String(value ?? '')))
  }
  if (!path) return baseUrl
  if (path.startsWith('http://') || path.startsWith('https://')) return path
  if (!path.startsWith('/')) path = `/${path}`
  return `${baseUrl}${path}`
}

const sleep = async (ms) => {
  await new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)))
}

const extractPayloadData = (payload) => {
  if (!payload || typeof payload !== 'object') return {}
  const data = payload.data
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return data
  }
  return payload
}

const parseTemplateFields = (templateText) => {
  const result = {}
  const lines = String(templateText || '').split(/\r?\n/)
  for (const rawLine of lines) {
    const line = trimString(rawLine)
    if (!line) continue
    const lower = line.toLowerCase()
    const removePrefix = (regex) => trimString(line.replace(regex, ''))

    if (line.startsWith('姓名') || lower.startsWith('name')) {
      const value = removePrefix(/^(姓名|name)\s*[:：]?\s*/i)
      if (value) result.holderName = value
      continue
    }
    if (line.startsWith('街道') || lower.startsWith('street') || lower.startsWith('address')) {
      const value = removePrefix(/^(街道|street|address)\s*[:：]?\s*/i)
      if (value) result.street = value
      continue
    }
    if (line.startsWith('城市') || lower.startsWith('city')) {
      const value = removePrefix(/^(城市|city)\s*[:：]?\s*/i)
      if (value) result.city = value
      continue
    }
    if (line.startsWith('州') || lower.startsWith('state')) {
      const value = removePrefix(/^(州|state)\s*[:：]?\s*/i)
      if (value) result.state = value
      continue
    }
    if (line.startsWith('邮编') || lower.startsWith('zip') || lower.startsWith('postal')) {
      const value = removePrefix(/^(邮编|zip|postal code)\s*[:：]?\s*/i)
      if (value) result.postalCode = value
      continue
    }
    if (line.startsWith('国家') || lower.startsWith('country')) {
      const value = removePrefix(/^(国家|country)\s*[:：]?\s*/i)
      if (value) result.country = value
      continue
    }
    if (line.startsWith('地区') || lower.startsWith('region')) {
      const value = removePrefix(/^(地区|region)\s*[:：]?\s*/i)
      if (value) result.region = value
      continue
    }
    if (line.startsWith('开卡时间') || lower.startsWith('open card time') || lower.startsWith('created at')) {
      const value = removePrefix(/^(开卡时间|open card time|created at)\s*[:：]?\s*/i)
      if (value) result.openedAt = value
    }
  }
  return result
}

const buildCardPayload = (payloadData = {}) => {
  const cards = Array.isArray(payloadData.cards) ? payloadData.cards : []
  if (!cards.length || typeof cards[0] !== 'object' || !cards[0]) return null

  const first = cards[0]
  const number = trimString(first.cardNumber || first.number || '').replace(/\D+/g, '')
  if (!number) return null

  const cardData = safeJson(first.cardData, {})
  const expiry = trimString(cardData.expiry || first.expiry || first.expire || first.expireTime || '')
  const cvv = trimString(cardData.cvv || first.cardPassword || first.cvv || '')
  const templateFields = parseTemplateFields(payloadData.cardTemplate || first.cardTemplate || '')

  const openedAt = trimString(payloadData.openCardTime || first.openCardTime || templateFields.openedAt || '')
  const region = trimString(payloadData.region || first.region || templateFields.region || '')
  const holderName = trimString(templateFields.holderName || first.holderName || '')
  const street = trimString(templateFields.street || first.street || '')
  const city = trimString(templateFields.city || first.city || '')
  const state = trimString(templateFields.state || first.state || '')
  const postalCode = trimString(templateFields.postalCode || first.postalCode || '')
  const country = trimString(templateFields.country || first.country || 'United States')

  const lines = [
    `卡号: ${number}`,
    `有效期: ${expiry}`,
    `CVV: ${cvv}`,
    openedAt ? `开卡时间: ${openedAt}` : '',
    region ? `地区: ${region}` : '',
    holderName ? `姓名: ${holderName}` : '',
    street ? `街道: ${street}` : '',
    city ? `城市: ${city}` : '',
    state ? `州: ${state}` : '',
    postalCode ? `邮编: ${postalCode}` : '',
    country ? `国家: ${country}` : ''
  ].filter(Boolean)

  return {
    number,
    expiry,
    cvv,
    openedAt,
    region,
    holderName,
    street,
    city,
    state,
    postalCode,
    country,
    sourceOrderNo: trimString(payloadData.orderNo || ''),
    formattedContent: lines.join('\n')
  }
}

const isInvalidPayload = (payloadData = {}) => {
  const isUsed = Boolean(payloadData.isUsed)
  const valid = payloadData.valid === undefined ? true : Boolean(payloadData.valid)
  return isUsed && !valid
}

const pushStep = (steps, step) => {
  if (!Array.isArray(steps)) return
  steps.push({
    phase: trimString(step?.phase || 'unknown') || 'unknown',
    ok: Boolean(step?.ok),
    status: Number.isFinite(Number(step?.status)) ? Number(step.status) : null,
    errorCode: trimString(step?.errorCode || ''),
    errorMessage: cutText(step?.errorMessage || '', 240),
    requestPayload: cutText(step?.requestPayload || '', 1200),
    responsePayload: cutText(step?.responsePayload || '', 1200)
  })
}

const requestJson = async ({ method, url, payload, timeoutMs, retries, steps, phase }) => {
  const total = Math.max(1, Number(retries || 0) + 1)
  let lastResult = {
    ok: false,
    status: null,
    data: {},
    errorCode: 'request_failed',
    errorMessage: 'request_failed'
  }

  for (let attempt = 1; attempt <= total; attempt += 1) {
    try {
      const response = await axios.request({
        method,
        url,
        data: payload,
        timeout: timeoutMs,
        validateStatus: () => true,
        headers: {
          Accept: 'application/json',
          ...(payload ? { 'Content-Type': 'application/json' } : {})
        }
      })
      const status = Number(response?.status || 0)
      const rawPayload = response?.data
      const data = rawPayload && typeof rawPayload === 'object' ? rawPayload : {}
      const ok = status >= 200 && status < 300
      lastResult = {
        ok,
        status,
        data,
        errorCode: ok ? '' : `http_${status}`,
        errorMessage: ok ? '' : `http_${status}`
      }
      pushStep(steps, {
        phase,
        ok,
        status,
        requestPayload: payload ? JSON.stringify(payload) : '',
        responsePayload: JSON.stringify(data),
        errorCode: ok ? '' : `http_${status}`,
        errorMessage: ok ? '' : `http_${status}`
      })
      if (ok || attempt >= total) return lastResult
    } catch (error) {
      const status = Number(error?.response?.status || 0) || null
      const errorCode = status ? `http_${status}` : 'network_error'
      const errorMessage = trimString(error?.message || errorCode) || errorCode
      const responseData = error?.response?.data
      const payloadText = responseData != null
        ? (typeof responseData === 'string' ? responseData : JSON.stringify(responseData))
        : ''

      lastResult = {
        ok: false,
        status,
        data: responseData && typeof responseData === 'object' ? responseData : {},
        errorCode,
        errorMessage
      }
      pushStep(steps, {
        phase,
        ok: false,
        status,
        requestPayload: payload ? JSON.stringify(payload) : '',
        responsePayload: payloadText,
        errorCode,
        errorMessage
      })
      if (attempt >= total) return lastResult
    }

    await sleep(Math.min(2500, attempt * 400))
  }

  return lastResult
}

const pollTaskStatus = async ({ code, taskId, config, steps }) => {
  const taskUrl = joinUrl(config.baseUrl, config.taskStatusPath, { task_id: taskId })
  for (let attempt = 1; attempt <= config.pollMaxAttempts; attempt += 1) {
    const result = await requestJson({
      method: 'GET',
      url: taskUrl,
      payload: null,
      timeoutMs: config.timeoutMs,
      retries: config.requestRetries,
      steps,
      phase: 'task_status'
    })

    if (!result.ok) {
      if (attempt < config.pollMaxAttempts) {
        await sleep(config.pollIntervalMs)
        continue
      }
      return {
        ok: false,
        invalid: false,
        errorCode: result.errorCode || 'task_status_failed',
        errorMessage: result.errorMessage || 'task_status_failed'
      }
    }

    const data = extractPayloadData(result.data)
    if (isInvalidPayload(data)) {
      return {
        ok: false,
        invalid: true,
        errorCode: 'redeem_code_invalid',
        errorMessage: 'redeem_code_invalid'
      }
    }

    const card = buildCardPayload(data)
    if (card) {
      return { ok: true, card }
    }

    const statusValue = Number(data.status ?? data.deliveryStatus ?? -1)
    const delivering = Boolean(data.isDelivering) || statusValue === 0 || statusValue === 1
    if (delivering && attempt < config.pollMaxAttempts) {
      await sleep(config.pollIntervalMs)
      continue
    }

    if (statusValue === 2) {
      return {
        ok: false,
        invalid: false,
        errorCode: 'task_success_without_card',
        errorMessage: 'task_success_without_card'
      }
    }
  }

  return {
    ok: false,
    invalid: false,
    errorCode: 'task_status_timeout',
    errorMessage: 'task_status_timeout'
  }
}

const redeemCodeWithYyl = async ({ code }) => {
  const config = buildRedeemConfig()
  const normalizedCode = trimString(code)
  const steps = []

  if (!normalizedCode) {
    return {
      ok: false,
      invalid: false,
      steps,
      errorCode: 'code_empty',
      errorMessage: 'code_empty'
    }
  }

  const validateUrl = `${joinUrl(config.baseUrl, config.validatePath)}?code=${encodeURIComponent(normalizedCode)}`
  const validateResult = await requestJson({
    method: 'GET',
    url: validateUrl,
    payload: null,
    timeoutMs: config.timeoutMs,
    retries: config.requestRetries,
    steps,
    phase: 'validate'
  })

  if (!validateResult.ok) {
    return {
      ok: false,
      invalid: false,
      steps,
      errorCode: validateResult.errorCode || 'validate_failed',
      errorMessage: validateResult.errorMessage || 'validate_failed'
    }
  }

  const validateData = extractPayloadData(validateResult.data)
  if (isInvalidPayload(validateData)) {
    return {
      ok: false,
      invalid: true,
      steps,
      errorCode: 'redeem_code_invalid',
      errorMessage: 'redeem_code_invalid'
    }
  }

  const cardFromValidate = buildCardPayload(validateData)
  if (cardFromValidate) {
    return {
      ok: true,
      steps,
      card: cardFromValidate,
      source: 'validate'
    }
  }

  const submitPayload = {
    code: normalizedCode,
    contactEmail: config.contactEmail,
    visitorId: `${config.visitorPrefix}${Date.now()}${Math.floor(Math.random() * 900 + 100)}`,
    quantity: config.quantity
  }

  const submitResult = await requestJson({
    method: 'POST',
    url: joinUrl(config.baseUrl, config.submitPath),
    payload: submitPayload,
    timeoutMs: config.timeoutMs,
    retries: config.requestRetries,
    steps,
    phase: 'redeem_submit'
  })

  if (!submitResult.ok) {
    return {
      ok: false,
      invalid: false,
      steps,
      errorCode: submitResult.errorCode || 'redeem_failed',
      errorMessage: submitResult.errorMessage || 'redeem_failed'
    }
  }

  const redeemData = extractPayloadData(submitResult.data)
  if (isInvalidPayload(redeemData)) {
    return {
      ok: false,
      invalid: true,
      steps,
      errorCode: 'redeem_code_invalid',
      errorMessage: 'redeem_code_invalid'
    }
  }

  const cardFromSubmit = buildCardPayload(redeemData)
  if (cardFromSubmit) {
    return {
      ok: true,
      steps,
      card: cardFromSubmit,
      source: 'redeem_submit'
    }
  }

  const taskId = trimString(redeemData.taskId || redeemData.orderNo || '')
  if (!taskId) {
    return {
      ok: false,
      invalid: false,
      steps,
      errorCode: 'task_id_missing',
      errorMessage: 'task_id_missing'
    }
  }

  const polled = await pollTaskStatus({
    code: normalizedCode,
    taskId,
    config,
    steps
  })

  if (!polled.ok) {
    return {
      ok: false,
      invalid: Boolean(polled.invalid),
      steps,
      errorCode: polled.errorCode || 'task_status_failed',
      errorMessage: polled.errorMessage || 'task_status_failed'
    }
  }

  return {
    ok: true,
    steps,
    card: polled.card,
    source: 'task_status'
  }
}

export const redeemCardByCode = async ({ code, provider = REDEEM_PROVIDER_YYL }) => {
  const normalizedProvider = trimString(provider).toLowerCase() || REDEEM_PROVIDER_YYL
  if (normalizedProvider !== REDEEM_PROVIDER_YYL) {
    return {
      ok: false,
      invalid: false,
      errorCode: 'provider_not_supported',
      errorMessage: `provider_not_supported:${normalizedProvider}`,
      steps: []
    }
  }
  return redeemCodeWithYyl({ code })
}

export const ldcCardProviderConstants = {
  REDEEM_PROVIDER_YYL
}
