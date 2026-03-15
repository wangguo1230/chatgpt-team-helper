import test from 'node:test'
import assert from 'node:assert/strict'
import axios from 'axios'

import { redeemCardByCode } from '../src/services/ldc-card-provider.js'

const withMockedAxios = async (handler, fn) => {
  const original = axios.request
  axios.request = handler
  try {
    await fn()
  } finally {
    axios.request = original
  }
}

test('redeemCardByCode: provider not supported', async () => {
  const result = await redeemCardByCode({ code: 'TEST-CODE', provider: 'other' })
  assert.equal(result.ok, false)
  assert.equal(result.errorCode, 'provider_not_supported')
})

test('redeemCardByCode: validate returns card directly', async () => {
  let callCount = 0
  await withMockedAxios(async (config) => {
    callCount += 1
    assert.equal(config.method, 'GET')
    return {
      status: 200,
      data: {
        data: {
          cards: [
            {
              cardNumber: '5481087115222519',
              cardData: {
                expiry: '0332',
                cvv: '745'
              },
              cardTemplate: '姓名: Test User\\n街道: Main St\\n城市: New York\\n州: NY\\n邮编: 10001\\n国家: United States'
            }
          ]
        }
      }
    }
  }, async () => {
    const result = await redeemCardByCode({ code: 'TEST-CODE', provider: 'yyl' })
    assert.equal(result.ok, true)
    assert.equal(callCount, 1)
    assert.equal(result.card.number, '5481087115222519')
    assert.match(result.card.formattedContent, /卡号:/)
    assert.match(result.card.formattedContent, /CVV:/)
  })
})

test('redeemCardByCode: validate marks invalid code', async () => {
  await withMockedAxios(async () => ({
    status: 200,
    data: {
      data: {
        isUsed: true,
        valid: false
      }
    }
  }), async () => {
    const result = await redeemCardByCode({ code: 'INVALID-CODE', provider: 'yyl' })
    assert.equal(result.ok, false)
    assert.equal(result.invalid, true)
    assert.equal(result.errorCode, 'redeem_code_invalid')
  })
})

test('redeemCardByCode: async task polling success', async () => {
  const responses = [
    {
      status: 200,
      data: {
        data: {
          valid: true,
          isUsed: false,
          cards: []
        }
      }
    },
    {
      status: 200,
      data: {
        data: {
          valid: true,
          isUsed: false,
          taskId: 'task-123'
        }
      }
    },
    {
      status: 200,
      data: {
        data: {
          status: 1,
          cards: []
        }
      }
    },
    {
      status: 200,
      data: {
        data: {
          status: 2,
          cards: [
            {
              cardNumber: '4242424242424242',
              cardData: {
                expiry: '1230',
                cvv: '999'
              },
              cardTemplate: '姓名: Async User\\n街道: 1 Infinite Loop\\n城市: Cupertino\\n州: CA\\n邮编: 95014\\n国家: United States'
            }
          ]
        }
      }
    }
  ]

  await withMockedAxios(async () => {
    const next = responses.shift()
    assert.ok(next)
    return next
  }, async () => {
    const result = await redeemCardByCode({ code: 'ASYNC-CODE', provider: 'yyl' })
    assert.equal(result.ok, true)
    assert.equal(result.card.number, '4242424242424242')
    assert.match(result.card.formattedContent, /Cupertino/)
  })
})
