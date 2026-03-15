import { getSystemConfigValue } from './system-config.js'

export const OPEN_ACCOUNTS_CAPACITY_LIMIT_KEY = 'open_accounts_capacity_limit'
export const OPEN_ACCOUNTS_CAPACITY_LIMIT_ENV = 'OPEN_ACCOUNTS_CAPACITY_LIMIT'
export const OPEN_ACCOUNTS_CAPACITY_LIMIT_MIN = 1
export const OPEN_ACCOUNTS_CAPACITY_LIMIT_MAX = 200
export const OPEN_ACCOUNTS_CAPACITY_LIMIT_DEFAULT = 5

const parseIntStrict = (value) => {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10)
  return Number.isFinite(parsed) ? parsed : null
}

const clampCapacity = (value) => {
  if (!Number.isFinite(value)) return null
  if (value < OPEN_ACCOUNTS_CAPACITY_LIMIT_MIN) return null
  if (value > OPEN_ACCOUNTS_CAPACITY_LIMIT_MAX) return null
  return value
}

export const normalizeOpenAccountsCapacityLimit = (value, fallback = OPEN_ACCOUNTS_CAPACITY_LIMIT_DEFAULT) => {
  const parsed = parseIntStrict(value)
  const normalized = clampCapacity(parsed)
  if (normalized == null) return fallback
  return normalized
}

export const getOpenAccountsCapacityLimitFromEnv = () => {
  return normalizeOpenAccountsCapacityLimit(
    process.env[OPEN_ACCOUNTS_CAPACITY_LIMIT_ENV],
    OPEN_ACCOUNTS_CAPACITY_LIMIT_DEFAULT
  )
}

export const getOpenAccountsCapacitySettings = (database) => {
  const envCapacityLimit = getOpenAccountsCapacityLimitFromEnv()
  const storedRaw = getSystemConfigValue(database, OPEN_ACCOUNTS_CAPACITY_LIMIT_KEY)
  const storedParsed = clampCapacity(parseIntStrict(storedRaw))

  if (storedParsed != null) {
    return {
      capacityLimit: storedParsed,
      source: 'db',
      stored: {
        capacityLimit: storedParsed
      },
      env: {
        capacityLimit: envCapacityLimit
      }
    }
  }

  return {
    capacityLimit: envCapacityLimit,
    source: process.env[OPEN_ACCOUNTS_CAPACITY_LIMIT_ENV] ? 'env' : 'default',
    stored: {
      capacityLimit: null
    },
    env: {
      capacityLimit: envCapacityLimit
    }
  }
}

export const getOpenAccountsCapacityLimit = (database) => {
  return getOpenAccountsCapacitySettings(database).capacityLimit
}
