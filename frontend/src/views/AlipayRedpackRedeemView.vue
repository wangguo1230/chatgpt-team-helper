<template>
  <RedeemShell>
    <div class="space-y-4">
      <div class="rounded-[24px] border border-white/60 bg-white/85 backdrop-blur-lg px-5 py-5 sm:px-6 sm:py-6 shadow-[0_16px_40px_-28px_rgba(0,0,0,0.35)]">
        <div class="flex flex-col gap-4 text-center">
          <h1 class="text-[34px] sm:text-[40px] font-extrabold leading-none tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500">
            支付宝口令登记
          </h1>
          <p class="text-xs sm:text-sm text-gray-600/95">
            提交邮箱和支付宝口令后，管理员会处理邀请并回写订单状态
          </p>
          <div class="flex flex-wrap items-center justify-center gap-2 sm:gap-3">
            <span class="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700">
              当前可兑换库存：{{ stockLoading ? '加载中...' : (stock?.availableCount ?? '--') }}
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
          <AppleInput
            v-model.trim="formData.email"
            label="邮箱"
            placeholder="name@example.com"
            type="email"
            :disabled="loading"
            :error="formData.email && !isValidEmail ? '请输入有效邮箱' : ''"
            helperText="用于接收 ChatGPT Team 邀请"
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
              :disabled="loading"
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
          <div class="my-2 h-px bg-cyan-200/70"></div>
          <p class="font-semibold mb-1">处理时效</p>
          <ul class="list-disc pl-4 space-y-1 text-cyan-900/95">
            <li>工作时间：08:30-12:40、13:30-23:00（北京时间）</li>
            <li>工作时段：1 分钟~1 小时</li>
            <li>非工作时段：5 分钟~10 小时</li>
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
import { alipayRedpackService, type AlipayRedpackOrder, type AlipayRedpackStock } from '@/services/api'
import { EMAIL_REGEX } from '@/lib/validation'

const ALIPAY_PASSPHRASE_MIN_LENGTH = 8

const formData = ref({
  email: '',
  alipayPassphrase: '',
  note: ''
})

const submitting = ref(false)
const errorMessage = ref('')
const successMessage = ref('')
const lastOrder = ref<AlipayRedpackOrder | null>(null)
const stock = ref<AlipayRedpackStock | null>(null)
const stockLoading = ref(false)
const stockError = ref('')

const loading = computed(() => submitting.value)
const isValidEmail = computed(() => {
  if (!formData.value.email) return true
  return EMAIL_REGEX.test(formData.value.email)
})
const isValidAlipayPassphrase = computed(() => {
  if (!formData.value.alipayPassphrase) return true
  return formData.value.alipayPassphrase.length >= ALIPAY_PASSPHRASE_MIN_LENGTH
})

const canSubmitOrder = () => {
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
  return true
}
const statusText = (status?: string) => {
  if (status === 'pending') return '待处理'
  if (status === 'invited') return '已邀请'
  if (status === 'redeemed') return '已兑换'
  return status || '-'
}

const fetchStock = async () => {
  stockLoading.value = true
  stockError.value = ''
  try {
    stock.value = await alipayRedpackService.getPublicStock()
  } catch (err: any) {
    stockError.value = err?.response?.data?.error || '库存加载失败，请稍后重试'
  } finally {
    stockLoading.value = false
  }
}

const handleSubmit = async () => {
  if (!canSubmitOrder()) return

  submitting.value = true
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const response = await alipayRedpackService.createOrderPublic({
      email: formData.value.email,
      alipayPassphrase: formData.value.alipayPassphrase,
      note: formData.value.note || undefined,
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

onMounted(() => {
  fetchStock()
})
</script>
