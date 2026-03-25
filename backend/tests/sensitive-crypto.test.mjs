import assert from 'node:assert/strict'
import test from 'node:test'

import { decryptSensitiveText, encryptSensitiveText } from '../src/utils/sensitive-crypto.js'

test('sensitive-crypto: 支持加解密回环', () => {
  const prev = process.env.GPT_ACCOUNT_SECRET_KEY
  try {
    process.env.GPT_ACCOUNT_SECRET_KEY = 'unit-test-secret-key'
    const cipher = encryptSensitiveText('Pass@123456')
    assert.ok(cipher)
    assert.equal(decryptSensitiveText(cipher), 'Pass@123456')
  } finally {
    if (prev === undefined) delete process.env.GPT_ACCOUNT_SECRET_KEY
    else process.env.GPT_ACCOUNT_SECRET_KEY = prev
  }
})

test('sensitive-crypto: 空值与非法密文返回 null', () => {
  assert.equal(encryptSensitiveText('   '), null)
  assert.equal(decryptSensitiveText(''), null)
  assert.equal(decryptSensitiveText('v1:broken-data'), null)
  assert.equal(decryptSensitiveText('v1:00:00:00'), null)
})
