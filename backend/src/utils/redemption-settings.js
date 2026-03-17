import { getSystemConfigValue } from './system-config.js'

export const REDEMPTION_BATCH_CREATE_MAX_COUNT_KEY = 'redemption_batch_create_max_count'
export const REDEMPTION_BATCH_CREATE_MAX_COUNT_ENV = 'REDEMPTION_BATCH_CREATE_MAX_COUNT'
export const REDEMPTION_BATCH_CREATE_MAX_COUNT_MIN = 1
export const REDEMPTION_BATCH_CREATE_MAX_COUNT_MAX = 1000
export const REDEMPTION_BATCH_CREATE_MAX_COUNT_DEFAULT = 5
export const REDEMPTION_LOW_STOCK_THRESHOLD_KEY = 'redemption_low_stock_threshold'
export const REDEMPTION_LOW_STOCK_THRESHOLD_ENV = 'REDEMPTION_LOW_STOCK_THRESHOLD'
export const REDEMPTION_LOW_STOCK_THRESHOLD_MIN = 0
export const REDEMPTION_LOW_STOCK_THRESHOLD_MAX = 100000
export const REDEMPTION_LOW_STOCK_THRESHOLD_DEFAULT = 0

const parseCount = (value) => {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10)
  return Number.isFinite(parsed) ? parsed : null
}

const parseThreshold = (value) => {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10)
  return Number.isFinite(parsed) ? parsed : null
}

const clampCount = (value) => {
  if (!Number.isFinite(value)) return null
  if (value < REDEMPTION_BATCH_CREATE_MAX_COUNT_MIN) return null
  if (value > REDEMPTION_BATCH_CREATE_MAX_COUNT_MAX) return null
  return value
}

const clampThreshold = (value) => {
  if (!Number.isFinite(value)) return null
  if (value < REDEMPTION_LOW_STOCK_THRESHOLD_MIN) return null
  if (value > REDEMPTION_LOW_STOCK_THRESHOLD_MAX) return null
  return value
}

export const normalizeRedemptionBatchCreateMaxCount = (value, fallback = REDEMPTION_BATCH_CREATE_MAX_COUNT_DEFAULT) => {
  const parsed = parseCount(value)
  const normalized = clampCount(parsed)
  if (normalized == null) return fallback
  return normalized
}

export const normalizeRedemptionLowStockThreshold = (value, fallback = REDEMPTION_LOW_STOCK_THRESHOLD_DEFAULT) => {
  const parsed = parseThreshold(value)
  const normalized = clampThreshold(parsed)
  if (normalized == null) return fallback
  return normalized
}

export const getRedemptionBatchCreateMaxCountFromEnv = () => {
  return normalizeRedemptionBatchCreateMaxCount(
    process.env[REDEMPTION_BATCH_CREATE_MAX_COUNT_ENV],
    REDEMPTION_BATCH_CREATE_MAX_COUNT_DEFAULT
  )
}

export const getRedemptionLowStockThresholdFromEnv = () => {
  return normalizeRedemptionLowStockThreshold(
    process.env[REDEMPTION_LOW_STOCK_THRESHOLD_ENV],
    REDEMPTION_LOW_STOCK_THRESHOLD_DEFAULT
  )
}

export const getRedemptionCodeSettings = (database) => {
  const envBatchCreateMaxCount = getRedemptionBatchCreateMaxCountFromEnv()
  const envLowStockThreshold = getRedemptionLowStockThresholdFromEnv()
  const storedRaw = getSystemConfigValue(database, REDEMPTION_BATCH_CREATE_MAX_COUNT_KEY)
  const storedThresholdRaw = getSystemConfigValue(database, REDEMPTION_LOW_STOCK_THRESHOLD_KEY)
  const storedParsed = clampCount(parseCount(storedRaw))
  const storedThresholdParsed = clampThreshold(parseThreshold(storedThresholdRaw))
  const batchSource = storedParsed != null
    ? 'db'
    : (process.env[REDEMPTION_BATCH_CREATE_MAX_COUNT_ENV] ? 'env' : 'default')
  const thresholdSource = storedThresholdParsed != null
    ? 'db'
    : (process.env[REDEMPTION_LOW_STOCK_THRESHOLD_ENV] ? 'env' : 'default')
  const resolvedBatchCreateMaxCount = storedParsed != null ? storedParsed : envBatchCreateMaxCount
  const resolvedLowStockThreshold = storedThresholdParsed != null ? storedThresholdParsed : envLowStockThreshold

  return {
    batchCreateMaxCount: resolvedBatchCreateMaxCount,
    lowStockThreshold: resolvedLowStockThreshold,
    source: batchSource,
    sources: {
      batchCreateMaxCount: batchSource,
      lowStockThreshold: thresholdSource
    },
    stored: {
      batchCreateMaxCount: storedParsed,
      lowStockThreshold: storedThresholdParsed
    },
    env: {
      batchCreateMaxCount: envBatchCreateMaxCount,
      lowStockThreshold: envLowStockThreshold
    }
  }
}
