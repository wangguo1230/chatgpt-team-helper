import assert from 'node:assert/strict'
import test from 'node:test'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

import { __adminEnvTestUtils } from '../src/routes/admin.js'

const {
  parseEnvEntriesFromText,
  upsertEnvEntriesToFile,
  replaceEnvEntriesInFile,
  syncEnvEntriesToRuntime,
} = __adminEnvTestUtils

const makeTempEnvFile = (initial = '') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-env-test-'))
  const filePath = path.join(dir, '.env')
  fs.writeFileSync(filePath, initial, 'utf-8')
  return { dir, filePath }
}

const cleanupTempDir = (dir) => {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

const withPreservedEnv = async (keys, fn) => {
  const snapshot = new Map()
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(process.env, key)) {
      snapshot.set(key, process.env[key])
    } else {
      snapshot.set(key, null)
    }
  }

  try {
    await fn()
  } finally {
    for (const key of keys) {
      const original = snapshot.get(key)
      if (original === null) {
        delete process.env[key]
      } else {
        process.env[key] = original
      }
    }
  }
}

test('parseEnvEntriesFromText strict 模式应拒绝非法行', () => {
  assert.throws(
    () => parseEnvEntriesFromText('A=1\nINVALID_LINE\nB=2', { strict: true }),
    /Invalid env assignment at line 2/
  )
})

test('replaceEnvEntriesInFile 在全量替换模式下可删除旧键', () => {
  const { dir, filePath } = makeTempEnvFile('A=1\nB=2\n')
  try {
    const result = replaceEnvEntriesInFile(filePath, [{ key: 'B', value: '3' }])
    assert.deepEqual(result.updatedKeys, ['B'])
    assert.equal(fs.readFileSync(filePath, 'utf-8'), 'B=3\n')
  } finally {
    cleanupTempDir(dir)
  }
})

test('upsertEnvEntriesToFile 在增量模式下保留未更新键', () => {
  const { dir, filePath } = makeTempEnvFile('A=1\nB=2\n')
  try {
    upsertEnvEntriesToFile(filePath, [{ key: 'B', value: '20' }])
    assert.equal(fs.readFileSync(filePath, 'utf-8'), 'A=1\nB=20\n')
  } finally {
    cleanupTempDir(dir)
  }
})

test('syncEnvEntriesToRuntime 会清理不再存在的托管键', async () => {
  const keyA = `ADMIN_ENV_TEST_A_${Date.now()}`
  const keyB = `ADMIN_ENV_TEST_B_${Date.now()}`
  const { dir, filePath } = makeTempEnvFile(`${keyA}=1\n${keyB}=2\n`)

  try {
    await withPreservedEnv([keyA, keyB], async () => {
      syncEnvEntriesToRuntime(filePath, [
        { key: keyA, value: '1' },
        { key: keyB, value: '2' },
      ], { clearMissing: true })

      process.env[keyA] = '1'
      process.env[keyB] = '2'

      const result = syncEnvEntriesToRuntime(filePath, [
        { key: keyA, value: '10' },
      ], { clearMissing: true })

      assert.equal(process.env[keyA], '10')
      assert.equal(Object.prototype.hasOwnProperty.call(process.env, keyB), false)
      assert.ok(result.removedKeys.includes(keyB))
    })
  } finally {
    cleanupTempDir(dir)
  }
})
