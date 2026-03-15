import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeFulfillmentMode,
  normalizeRedeemProvider,
  PURCHASE_FULFILLMENT_MODE_ITEM_POOL,
  PURCHASE_FULFILLMENT_MODE_REDEEM_API,
  PURCHASE_REDEEM_PROVIDER_YYL
} from '../src/services/purchase-products.js'

test('normalizeFulfillmentMode 应仅允许 item_pool/redeem_api', () => {
  assert.equal(normalizeFulfillmentMode('item_pool', PURCHASE_FULFILLMENT_MODE_REDEEM_API), PURCHASE_FULFILLMENT_MODE_ITEM_POOL)
  assert.equal(normalizeFulfillmentMode('redeem_api', PURCHASE_FULFILLMENT_MODE_ITEM_POOL), PURCHASE_FULFILLMENT_MODE_REDEEM_API)
  assert.equal(normalizeFulfillmentMode('unknown_mode', PURCHASE_FULFILLMENT_MODE_ITEM_POOL), PURCHASE_FULFILLMENT_MODE_ITEM_POOL)
})

test('normalizeRedeemProvider 应将不支持的 provider 回退为默认值', () => {
  assert.equal(normalizeRedeemProvider('yyl', ''), PURCHASE_REDEEM_PROVIDER_YYL)
  assert.equal(normalizeRedeemProvider('', PURCHASE_REDEEM_PROVIDER_YYL), '')
  assert.equal(normalizeRedeemProvider('custom_provider', PURCHASE_REDEEM_PROVIDER_YYL), PURCHASE_REDEEM_PROVIDER_YYL)
})
