<template>
  <RedeemShell>
    <div class="space-y-6 text-center">
      <h1 class="text-[36px] sm:text-[42px] font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500">
        支付宝口令红包登记
      </h1>
      <p class="text-sm text-gray-500">提交邮箱和支付宝口令，管理员会处理邀请</p>
      <div class="flex items-center justify-center gap-2 text-xs">
        <span class="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-emerald-700">
          当前可邀请库存：{{ stockLoading ? '加载中...' : (stock?.availableCount ?? '--') }}
        </span>
        <button
          type="button"
          class="inline-flex items-center rounded-full border border-gray-200 bg-white px-3 py-1 text-gray-500 hover:text-gray-700 disabled:opacity-60"
          :disabled="loading || stockLoading"
          @click="fetchStock"
        >
          刷新库存
        </button>
      </div>
      <p v-if="stockError" class="text-xs text-red-500">{{ stockError }}</p>
    </div>

    <AppleCard variant="glass" class="overflow-hidden border border-white/30 shadow-2xl">
      <div class="p-8 sm:p-10 space-y-6">
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
            :error="formData.alipayPassphrase ? '' : ''"
            helperText="口令全局唯一，请勿重复提交"
          />

          <AppleInput
            v-model.trim="formData.note"
            label="备注（可选）"
            placeholder="例如：购买渠道、需求说明"
            type="text"
            :disabled="loading"
          />

          <div class="grid gap-3 sm:grid-cols-2 pt-1">
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

            <AppleButton
              type="button"
              variant="secondary"
              size="lg"
              class="w-full"
              :loading="supplementing"
              :disabled="loading"
              @click="handleSupplement"
            >
              补录
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
          <p>口令：{{ lastOrder.alipayPassphrase }}</p>
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

const formData = ref({
  email: '',
  alipayPassphrase: '',
  note: ''
})

const submitting = ref(false)
const supplementing = ref(false)
const errorMessage = ref('')
const successMessage = ref('')
const lastOrder = ref<AlipayRedpackOrder | null>(null)
const stock = ref<AlipayRedpackStock | null>(null)
const stockLoading = ref(false)
const stockError = ref('')

const loading = computed(() => submitting.value || supplementing.value)
const isValidEmail = computed(() => {
  if (!formData.value.email) return true
  return EMAIL_REGEX.test(formData.value.email)
})

const canSubmit = () => {
  if (!formData.value.email || !EMAIL_REGEX.test(formData.value.email)) {
    errorMessage.value = '请输入有效邮箱地址'
    return false
  }
  if (!formData.value.alipayPassphrase.trim()) {
    errorMessage.value = '请输入支付宝口令'
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
  if (!canSubmit()) return

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
  } catch (err: any) {
    errorMessage.value = err?.response?.data?.error || '提交失败，请稍后重试'
  } finally {
    submitting.value = false
  }
}

const handleSupplement = async () => {
  if (!canSubmit()) return

  supplementing.value = true
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const response = await alipayRedpackService.supplementPublic({
      email: formData.value.email,
      alipayPassphrase: formData.value.alipayPassphrase,
      note: formData.value.note || undefined,
    })
    lastOrder.value = response.order
    successMessage.value = response.message || '补录成功'
  } catch (err: any) {
    errorMessage.value = err?.response?.data?.error || '补录失败，请稍后重试'
  } finally {
    supplementing.value = false
  }
}

onMounted(() => {
  fetchStock()
})
</script>
