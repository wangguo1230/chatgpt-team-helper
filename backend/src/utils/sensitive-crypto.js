import crypto from 'crypto'

const CIPHER_VERSION = 'v1'
const ALGORITHM = 'aes-256-gcm'
const IV_BYTE_LENGTH = 12
const AUTH_TAG_BYTE_LENGTH = 16
const SEPARATOR = ':'

const resolveSecret = () => {
  const raw = String(
    process.env.GPT_ACCOUNT_SECRET_KEY
    || process.env.ACCOUNT_PASSWORD_SECRET_KEY
    || process.env.JWT_SECRET
    || ''
  ).trim()
  return raw || 'dev-insecure-secret-change-me'
}

const deriveKey = () => crypto.createHash('sha256').update(resolveSecret()).digest()

const toNormalizedPlainText = (value) => {
  if (value == null) return ''
  return String(value).trim()
}

export const encryptSensitiveText = (value) => {
  const plain = toNormalizedPlainText(value)
  if (!plain) return null

  const iv = crypto.randomBytes(IV_BYTE_LENGTH)
  const cipher = crypto.createCipheriv(ALGORITHM, deriveKey(), iv)
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return [
    CIPHER_VERSION,
    iv.toString('hex'),
    authTag.toString('hex'),
    encrypted.toString('hex'),
  ].join(SEPARATOR)
}

export const decryptSensitiveText = (ciphertext) => {
  const raw = String(ciphertext || '').trim()
  if (!raw) return null

  const parts = raw.split(SEPARATOR)
  if (parts.length !== 4 || parts[0] !== CIPHER_VERSION) {
    return null
  }

  const [, ivHex, authTagHex, encryptedHex] = parts
  if (!ivHex || !authTagHex || !encryptedHex) return null

  try {
    const iv = Buffer.from(ivHex, 'hex')
    const authTag = Buffer.from(authTagHex, 'hex')
    const encrypted = Buffer.from(encryptedHex, 'hex')
    if (iv.length !== IV_BYTE_LENGTH || authTag.length !== AUTH_TAG_BYTE_LENGTH || !encrypted.length) {
      return null
    }

    const decipher = crypto.createDecipheriv(ALGORITHM, deriveKey(), iv)
    decipher.setAuthTag(authTag)
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
    return decrypted ? String(decrypted) : null
  } catch {
    return null
  }
}

