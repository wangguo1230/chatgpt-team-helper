import { getSystemConfigValue } from './system-config.js'

export const REDEMPTION_BATCH_CREATE_MAX_COUNT_KEY = 'redemption_batch_create_max_count'
export const REDEMPTION_BATCH_CREATE_MAX_COUNT_ENV = 'REDEMPTION_BATCH_CREATE_MAX_COUNT'
export const REDEMPTION_BATCH_CREATE_MAX_COUNT_MIN = 1
export const REDEMPTION_BATCH_CREATE_MAX_COUNT_MAX = 1000
export const REDEMPTION_BATCH_CREATE_MAX_COUNT_DEFAULT = 5

const parseCount = (value) => {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10)
  return Number.isFinite(parsed) ? parsed : null
}

const clampCount = (value) => {
  if (!Number.isFinite(value)) return null
  if (value < REDEMPTION_BATCH_CREATE_MAX_COUNT_MIN) return null
  if (value > REDEMPTION_BATCH_CREATE_MAX_COUNT_MAX) return null
  return value
}

export const normalizeRedemptionBatchCreateMaxCount = (value, fallback = REDEMPTION_BATCH_CREATE_MAX_COUNT_DEFAULT) => {
  const parsed = parseCount(value)
  const normalized = clampCount(parsed)
  if (normalized == null) return fallback
  return normalized
}

export const getRedemptionBatchCreateMaxCountFromEnv = () => {
  return normalizeRedemptionBatchCreateMaxCount(
    process.env[REDEMPTION_BATCH_CREATE_MAX_COUNT_ENV],
    REDEMPTION_BATCH_CREATE_MAX_COUNT_DEFAULT
  )
}

export const getRedemptionCodeSettings = (database) => {
  const envBatchCreateMaxCount = getRedemptionBatchCreateMaxCountFromEnv()
  const storedRaw = getSystemConfigValue(database, REDEMPTION_BATCH_CREATE_MAX_COUNT_KEY)
  const storedParsed = clampCount(parseCount(storedRaw))

  if (storedParsed != null) {
    return {
      batchCreateMaxCount: storedParsed,
      source: 'db',
      stored: {
        batchCreateMaxCount: storedParsed
      },
      env: {
        batchCreateMaxCount: envBatchCreateMaxCount
      }
    }
  }

  return {
    batchCreateMaxCount: envBatchCreateMaxCount,
    source: process.env[REDEMPTION_BATCH_CREATE_MAX_COUNT_ENV] ? 'env' : 'default',
    stored: {
      batchCreateMaxCount: null
    },
    env: {
      batchCreateMaxCount: envBatchCreateMaxCount
    }
  }
}

