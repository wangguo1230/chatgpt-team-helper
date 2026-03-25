<template>
  <RedeemShell>
    <div class="space-y-4">
      <div class="rounded-[24px] border border-white/60 bg-white/85 backdrop-blur-lg px-5 py-5 sm:px-6 sm:py-6 shadow-[0_16px_40px_-28px_rgba(0,0,0,0.35)]">
        <div class="flex flex-col gap-4 text-center">
          <h1 class="text-[34px] sm:text-[40px] font-extrabold leading-none tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500">
            支付宝口令登记
          </h1>
          <p class="text-xs sm:text-sm text-gray-600/95">
            支持 GPT 单号与 GPT 母号下单，管理员处理后会自动交付
          </p>
          <div class="flex flex-wrap items-center justify-center gap-2 sm:gap-3">
            <span class="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700">
              当前可用库存：{{ stockLoading ? '加载中...' : (stock?.availableCount ?? '--') }}
            </span>
            <button
              type="button"
              class="inline-flex items-center rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:text-gray-800 disabled:opacity-60"
              :disabled="loading || stockLoading"
              @click="fetchStock"
            >
              刷新库存
            </button>
          </div>
        </div>

        <p v-if="stockError" class="mt-3 text-sm text-red-500 text-center lg:text-left">{{ stockError }}</p>
      </div>
    </div>

    <AppleCard variant="glass" class="w-full overflow-hidden border border-white/40 bg-white/88 shadow-[0_20px_46px_-34px_rgba(0,0,0,0.4)]">
      <div class="p-6 sm:p-7 space-y-6">
        <form @submit.prevent="handleSubmit" class="space-y-5">
          <div class="space-y-2">
            <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">商品</Label>
            <select
              v-model="formData.productKey"
              class="h-11 w-full rounded-xl border border-gray-200 bg-gray-50 px-3 text-sm"
              :disabled="loading || productsLoading"
              @change="handleChangeProduct"
            >
              <option value="" disabled>请选择商品</option>
              <option v-for="item in products" :key="item.productKey" :value="item.productKey">
                {{ item.productName }}（¥{{ item.amount }} / {{ item.productType === 'gpt_parent' ? 'GPT母号' : 'GPT单号' }}）
              </option>
            </select>
            <p class="text-[12px] text-gray-500">
              当前类型：{{ selectedProductTypeLabel }}
            </p>
          </div>

          <AppleInput
            v-model.trim="formData.email"
            label="邮箱"
            placeholder="name@example.com"
            type="email"
            :disabled="loading"
            :error="formData.email && !isValidEmail ? '请输入有效邮箱' : ''"
            :helperText="isMotherProduct ? '用于接收母号账号凭据' : '用于接收处理状态通知'"
          />

          <AppleInput
            v-model.trim="formData.alipayPassphrase"
            label="支付宝口令"
            placeholder="请输入支付宝口令红包口令"
            type="text"
            :disabled="loading"
            :error="formData.alipayPassphrase && !isValidAlipayPassphrase ? '支付宝口令至少8位字符' : ''"
            helperText="提交订单时必填，长度至少8位"
          />

          <AppleInput
            v-model.trim="formData.quantity"
            label="购买数量"
            placeholder="请输入数量"
            type="number"
            :disabled="loading"
          />

          <div v-if="!isMotherProduct" class="space-y-2">
            <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">邀请邮箱（多行/逗号分隔）</Label>
            <textarea
              v-model.trim="formData.inviteEmailsRaw"
              class="min-h-[110px] w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm"
              :disabled="loading"
              placeholder="a@example.com&#10;b@example.com"
            />
            <p class="text-[12px] text-gray-500">
              GPT 单号按数量逐个邀请邮箱，数量需与邮箱数一致
            </p>
          </div>

          <AppleInput
            v-model.trim="formData.note"
            label="备注（可选）"
            placeholder="例如：购买渠道、需求说明"
            type="text"
            :disabled="loading"
          />

          <div class="pt-1">
            <AppleButton
              type="submit"
              variant="primary"
              size="lg"
              class="w-full"
              :loading="submitting"
              :disabled="loading || productsLoading || !selectedProduct"
            >
              提交订单
            </AppleButton>
          </div>
        </form>

        <div v-if="successMessage" class="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-700">
          {{ successMessage }}
        </div>

        <div v-if="errorMessage" class="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-600">
          {{ errorMessage }}
        </div>

        <div v-if="lastOrder" class="rounded-2xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700 space-y-1">
          <p>订单ID：<span class="font-mono">{{ lastOrder.id }}</span></p>
          <p>商品：{{ lastOrder.productName || selectedProduct?.productName || '-' }}</p>
          <p>类型：{{ (lastOrder.productType || selectedProduct?.productType) === 'gpt_parent' ? 'GPT母号' : 'GPT单号' }}</p>
          <p>数量：{{ lastOrder.quantity || formData.quantity }}</p>
          <p>状态：{{ statusText(lastOrder.status) }}</p>
          <p>邮箱：{{ lastOrder.email }}</p>
        </div>

        <div class="rounded-2xl border border-cyan-100 bg-cyan-50/70 p-4 text-left text-[12px] leading-5 text-cyan-900">
          <p class="font-semibold mb-2">售后支持</p>
          <ul class="space-y-1">
            <li>
              掉号补录请
              <router-link class="font-semibold underline underline-offset-4" to="/redeem/alipay-redpack/supplement">
                点击此处
              </router-link>
            </li>
            <li>
              TG售后群：
              <a class="font-semibold underline underline-offset-4" href="https://t.me/+fCeXgVykd7xjY2Jl" target="_blank" rel="noopener noreferrer">
                加入
              </a>
            </li>
            <li>
              TG：
              <a class="font-semibold underline underline-offset-4" href="https://t.me/liziwang" target="_blank" rel="noopener noreferrer">
                @liziwang
              </a>
            </li>
          </ul>
        </div>
      </div>
    </AppleCard>
  </RedeemShell>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import AppleButton from '@/components/ui/apple/Button.vue'
import AppleCard from '@/components/ui/apple/Card.vue'
import AppleInput from '@/components/ui/apple/Input.vue'
import RedeemShell from '@/components/RedeemShell.vue'
import { alipayRedpackService, type AlipayRedpackOrder, type AlipayRedpackProduct, type AlipayRedpackStock } from '@/services/api'
import { EMAIL_REGEX } from '@/lib/validation'
import { Label } from '@/components/ui/label'

const ALIPAY_PASSPHRASE_MIN_LENGTH = 8

const formData = ref({
  email: '',
  alipayPassphrase: '',
  note: '',
  productKey: '',
  quantity: '1',
  inviteEmailsRaw: ''
})

const products = ref<AlipayRedpackProduct[]>([])
const productsLoading = ref(false)
const submitting = ref(false)
const errorMessage = ref('')
const successMessage = ref('')
const lastOrder = ref<AlipayRedpackOrder | null>(null)
const stock = ref<AlipayRedpackStock | null>(null)
const stockLoading = ref(false)
const stockError = ref('')

const loading = computed(() => submitting.value)
const selectedProduct = computed(() => products.value.find(item => item.productKey === formData.value.productKey) || null)
const isMotherProduct = computed(() => selectedProduct.value?.productType === 'gpt_parent')
const selectedProductTypeLabel = computed(() => isMotherProduct.value ? 'GPT母号' : 'GPT单号')
const isValidEmail = computed(() => {
  if (!formData.value.email) return true
  return EMAIL_REGEX.test(formData.value.email)
})
const isValidAlipayPassphrase = computed(() => {
  if (!formData.value.alipayPassphrase) return true
  return formData.value.alipayPassphrase.length >= ALIPAY_PASSPHRASE_MIN_LENGTH
})

const parseInviteEmails = (raw: string, fallbackEmail: string) => {
  const deduped: string[] = []
  const seen = new Set<string>()
  const list = String(raw || '')
    .split(/[\n,;]+/)
    .map(item => String(item || '').trim().toLowerCase())
    .filter(Boolean)
  for (const item of list) {
    if (!EMAIL_REGEX.test(item) || seen.has(item)) continue
    seen.add(item)
    deduped.push(item)
  }
  if (!deduped.length && EMAIL_REGEX.test(fallbackEmail)) {
    deduped.push(fallbackEmail.toLowerCase())
  }
  return deduped
}

const ensureProducts = async () => {
  productsLoading.value = true
  try {
    const response = await alipayRedpackService.getPublicProducts()
    products.value = (response.products || []).filter(item => item.paymentMethod === 'alipay_passphrase')
    const firstProduct = products.value[0]
    if (!formData.value.productKey && firstProduct) {
      formData.value.productKey = firstProduct.productKey
    }
  } catch (err: any) {
    errorMessage.value = err?.response?.data?.error || '商品加载失败，请稍后重试'
  } finally {
    productsLoading.value = false
  }
}

const statusText = (status?: string) => {
  if (status === 'pending') return '待处理'
  if (status === 'invited') return '处理中'
  if (status === 'redeemed') return '已交付'
  if (status === 'returned') return '已退回'
  return status || '-'
}

const fetchStock = async () => {
  stockLoading.value = true
  stockError.value = ''
  try {
    stock.value = await alipayRedpackService.getPublicStock(formData.value.productKey || undefined)
  } catch (err: any) {
    stockError.value = err?.response?.data?.error || '库存加载失败，请稍后重试'
  } finally {
    stockLoading.value = false
  }
}

const handleChangeProduct = async () => {
  const quantityDefault = '1'
  formData.value.quantity = quantityDefault
  if (isMotherProduct.value) {
    formData.value.inviteEmailsRaw = ''
  }
  await fetchStock()
}

const canSubmitOrder = () => {
  if (!selectedProduct.value) {
    errorMessage.value = '请先选择商品'
    return false
  }
  if (!formData.value.email || !EMAIL_REGEX.test(formData.value.email)) {
    errorMessage.value = '请输入有效邮箱地址'
    return false
  }
  if (!formData.value.alipayPassphrase.trim()) {
    errorMessage.value = '请输入支付宝口令'
    return false
  }
  if (formData.value.alipayPassphrase.trim().length < ALIPAY_PASSPHRASE_MIN_LENGTH) {
    errorMessage.value = '支付宝口令至少8位字符'
    return false
  }
  if (!Number.isFinite(Number(formData.value.quantity)) || Number(formData.value.quantity) < 1) {
    errorMessage.value = '购买数量必须大于 0'
    return false
  }
  if (!isMotherProduct.value) {
    const inviteEmails = parseInviteEmails(formData.value.inviteEmailsRaw, formData.value.email.trim())
    if (!inviteEmails.length) {
      errorMessage.value = '请至少填写一个邀请邮箱'
      return false
    }
    if (inviteEmails.length !== Number(formData.value.quantity)) {
      errorMessage.value = 'GPT 单号订单数量需与邀请邮箱数量一致'
      return false
    }
  }
  return true
}

const handleSubmit = async () => {
  if (!canSubmitOrder()) return

  submitting.value = true
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const inviteEmails = isMotherProduct.value
      ? []
      : parseInviteEmails(formData.value.inviteEmailsRaw, formData.value.email.trim())

    const response = await alipayRedpackService.createOrderPublic({
      email: formData.value.email.trim(),
      alipayPassphrase: formData.value.alipayPassphrase.trim(),
      note: formData.value.note || undefined,
      productKey: formData.value.productKey,
      quantity: Math.max(1, Math.floor(Number(formData.value.quantity))),
      productType: selectedProduct.value?.productType,
      paymentMethod: selectedProduct.value?.paymentMethod,
      inviteEmails,
    })
    lastOrder.value = response.order
    successMessage.value = response.message || '提交成功'
    await fetchStock()
  } catch (err: any) {
    errorMessage.value = err?.response?.data?.error || '提交失败，请稍后重试'
  } finally {
    submitting.value = false
  }
}

onMounted(async () => {
  await ensureProducts()
  await fetchStock()
})
</script>
