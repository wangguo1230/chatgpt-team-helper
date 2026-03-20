<template>
  <RedeemShell>
    <div class="space-y-6 text-center">
      <span class="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-4 py-1.5 text-xs font-medium text-emerald-700">
        <span class="h-2 w-2 rounded-full bg-emerald-500" />
        订单补录通道 · 按质保期自动处理
      </span>
      <h1 class="text-[36px] sm:text-[42px] font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500">
        订单补录
      </h1>
      <p class="text-sm text-gray-500">先输入邮箱查询订单，再选择具体订单执行自动补录</p>
    </div>

    <AppleCard variant="glass" class="overflow-hidden border border-white/30 shadow-2xl">
      <div class="p-8 sm:p-10 space-y-6">
        <form @submit.prevent="loadCandidates" class="space-y-4">
          <AppleInput
            v-model.trim="email"
            label="下单邮箱"
            placeholder="name@example.com"
            type="email"
            :disabled="loadingCandidates || submitting"
            :error="email && !isValidEmail ? '请输入有效邮箱' : ''"
            helperText="请输入提交支付宝口令订单时使用的邮箱"
          />

          <div class="grid gap-3 sm:grid-cols-2">
            <AppleButton
              type="button"
              variant="secondary"
              size="lg"
              :loading="sendingCode"
              :disabled="sendingCode || submitting || loadingCandidates || !email || !isValidEmail"
              @click="sendAuthCode"
            >
              发送验证码
            </AppleButton>
            <AppleButton
              type="button"
              variant="secondary"
              size="lg"
              :loading="verifyingCode"
              :disabled="verifyingCode || sendingCode || submitting || !authCode"
              @click="verifyAuthCode"
            >
              验证邮箱
            </AppleButton>
          </div>

          <AppleInput
            v-model.trim="authCode"
            label="邮箱验证码"
            placeholder="请输入6位验证码"
            type="text"
            :disabled="verifyingCode || submitting || loadingCandidates"
            helperText="需先完成邮箱验证码校验，才能查询并提交补录"
          />

          <p v-if="authVerified" class="text-xs text-emerald-600">
            邮箱已验证{{ ticketExpiresAt ? `（有效期至 ${formatDate(ticketExpiresAt)}）` : '' }}
          </p>

          <AppleButton
            type="submit"
            variant="primary"
            size="lg"
            class="w-full"
            :loading="loadingCandidates"
            :disabled="loadingCandidates || submitting || (otpRequired && !authVerified)"
          >
            查询订单
          </AppleButton>
        </form>

        <div v-if="candidates.length" class="space-y-3">
          <p class="text-sm font-semibold text-gray-700">请选择需要补录的订单</p>
          <div class="space-y-2">
            <label
              v-for="item in candidates"
              :key="item.orderId"
              class="flex items-start gap-3 rounded-xl border p-3 text-left transition"
              :class="resolveCandidateCardClass(item)"
            >
              <input
                v-model.number="selectedOrderId"
                class="mt-1"
                type="radio"
                name="supplement-order"
                :value="item.orderId"
                :disabled="submitting || !isOrderSelectable(item)"
              >
              <div class="flex-1 space-y-1 text-sm">
                <p>订单号：<span class="font-mono">#{{ item.orderId }}</span></p>
                <p>创建时间：{{ formatDate(item.createdAt) }}</p>
                <p>
                  状态：{{ statusText(item.status) }}
                  <span v-if="!isOrderSelectable(item)" class="text-rose-600">（不可补录）</span>
                </p>
                <p>质保天数：{{ formatWarrantyDays(item.warrantyDays) }}</p>
                <p>
                  质保：
                  <span :class="item.withinWarranty ? 'text-emerald-600' : 'text-rose-600'">
                    {{ item.withinWarranty ? '质保内' : '已过质保' }}
                  </span>
                  <span v-if="item.windowEndsAt" class="text-gray-500">（截止 {{ formatDate(item.windowEndsAt) }}）</span>
                </p>
              </div>
            </label>
          </div>

          <AppleButton
            type="button"
            variant="primary"
            size="lg"
            class="w-full"
            :loading="submitting"
            :disabled="submitting || !selectedOrderId || !selectedOrder"
            @click="handleSubmit"
          >
            提交订单补录
          </AppleButton>
        </div>

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
          <p>邀请结果：{{ lastOrder.inviteResult || '-' }}</p>
        </div>

        <div class="rounded-2xl border border-emerald-100 bg-white/70 p-4 text-left text-xs text-gray-600 space-y-2">
          <p class="font-semibold text-gray-700">使用提示</p>
          <ul class="list-disc pl-4 space-y-1">
            <li>补录改为订单维度，必须先查询订单再选择执行。</li>
            <li>仅质保期内订单支持自动补录。</li>
            <li>若库存不足，系统会自动登记为“需人工介入”。</li>
            <li>补录有效期以原订单质保截止时间为准，不会延长。</li>
          </ul>
          <router-link
            class="inline-flex items-center text-cyan-600 hover:text-cyan-700 font-medium"
            to="/redeem/alipay-redpack"
          >
            返回口令兑换页
          </router-link>
        </div>
      </div>
    </AppleCard>
  </RedeemShell>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AppleButton from '@/components/ui/apple/Button.vue'
import AppleCard from '@/components/ui/apple/Card.vue'
import AppleInput from '@/components/ui/apple/Input.vue'
import RedeemShell from '@/components/RedeemShell.vue'
import {
  alipayRedpackService,
  type AlipayRedpackOrder,
  type AlipayRedpackSupplementCandidateOrder,
} from '@/services/api'
import { EMAIL_REGEX } from '@/lib/validation'

const email = ref('')
const authCode = ref('')
const otpRequired = ref(true)
const supplementTicket = ref('')
const ticketExpiresAt = ref<string | null>(null)
const sendingCode = ref(false)
const verifyingCode = ref(false)
const loadingCandidates = ref(false)
const submitting = ref(false)
const errorMessage = ref('')
const successMessage = ref('')
const lastOrder = ref<AlipayRedpackOrder | null>(null)
const candidates = ref<AlipayRedpackSupplementCandidateOrder[]>([])
const selectedOrderId = ref<number | null>(null)
const selectedOrder = computed(() => {
  if (!selectedOrderId.value) return null
  return candidates.value.find((item) => item.orderId === selectedOrderId.value) || null
})

const isValidEmail = computed(() => {
  if (!email.value) return true
  return EMAIL_REGEX.test(email.value)
})
const authVerified = computed(() => {
  if (!otpRequired.value) return true
  if (!supplementTicket.value) return false
  if (!ticketExpiresAt.value) return true
  const expiresMs = Date.parse(ticketExpiresAt.value)
  if (!Number.isFinite(expiresMs)) return true
  return expiresMs > Date.now()
})

const statusText = (status?: string) => {
  if (status === 'pending') return '待处理'
  if (status === 'invited') return '已邀请'
  if (status === 'redeemed') return '已兑换'
  if (status === 'returned') return '已退回'
  return status || '-'
}
const isOrderSelectable = (item?: AlipayRedpackSupplementCandidateOrder | null) => {
  const status = String(item?.status || '').trim().toLowerCase()
  return status === 'redeemed' && Boolean(item?.withinWarranty)
}
const resolveCandidateCardClass = (item: AlipayRedpackSupplementCandidateOrder) => {
  if (!isOrderSelectable(item)) {
    return 'cursor-not-allowed border-gray-200 bg-gray-50 opacity-75'
  }
  return selectedOrderId.value === item.orderId
    ? 'cursor-pointer border-emerald-300 bg-emerald-50'
    : 'cursor-pointer border-gray-200 bg-white hover:border-emerald-200'
}
const pickFirstSelectableOrderId = (items: AlipayRedpackSupplementCandidateOrder[]) => {
  for (const item of items) {
    if (isOrderSelectable(item)) return item.orderId
  }
  return null
}

const formatDate = (value?: string | null) => {
  if (!value) return '-'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return '-'
  return parsed.toLocaleString('zh-CN', { hour12: false })
}
const formatWarrantyDays = (value?: number | null) => {
  const days = Number(value)
  if (!Number.isFinite(days) || days <= 0) return '-'
  return `${Math.floor(days)} 天`
}

watch(email, () => {
  authCode.value = ''
  supplementTicket.value = ''
  ticketExpiresAt.value = null
  candidates.value = []
  selectedOrderId.value = null
})

const sendAuthCode = async () => {
  if (!email.value || !EMAIL_REGEX.test(email.value)) {
    errorMessage.value = '请输入有效邮箱地址'
    return
  }

  sendingCode.value = true
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const response = await alipayRedpackService.sendSupplementAuthCode(email.value)
    otpRequired.value = Boolean(response?.otpRequired)
    successMessage.value = response?.message || '验证码已发送，请检查邮箱'
  } catch (err: any) {
    errorMessage.value = err?.response?.data?.error || '验证码发送失败，请稍后重试'
  } finally {
    sendingCode.value = false
  }
}

const verifyAuthCode = async () => {
  if (!email.value || !EMAIL_REGEX.test(email.value)) {
    errorMessage.value = '请输入有效邮箱地址'
    return
  }
  if (!/^[0-9]{6}$/.test(authCode.value)) {
    errorMessage.value = '请输入6位数字验证码'
    return
  }

  verifyingCode.value = true
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const response = await alipayRedpackService.verifySupplementAuthCode({
      email: email.value,
      code: authCode.value,
    })
    otpRequired.value = Boolean(response?.otpRequired)
    supplementTicket.value = String(response?.ticket || '')
    ticketExpiresAt.value = response?.expiresAt || null
    if (otpRequired.value && !supplementTicket.value) {
      errorMessage.value = '邮箱验证失败，请重新发送验证码'
      return
    }
    successMessage.value = response?.message || '邮箱验证成功'
  } catch (err: any) {
    supplementTicket.value = ''
    ticketExpiresAt.value = null
    errorMessage.value = err?.response?.data?.error || '邮箱验证失败，请稍后重试'
  } finally {
    verifyingCode.value = false
  }
}

const loadCandidatesInternal = async ({ preserveMessages = false } = {}) => {
  if (!email.value || !EMAIL_REGEX.test(email.value)) {
    errorMessage.value = '请输入有效邮箱地址'
    return
  }
  if (otpRequired.value && !authVerified.value) {
    errorMessage.value = '请先完成邮箱验证码验证'
    return
  }

  loadingCandidates.value = true
  if (!preserveMessages) {
    errorMessage.value = ''
    successMessage.value = ''
  }
  lastOrder.value = null
  try {
    const response = await alipayRedpackService.getSupplementCandidatesByEmail(
      email.value,
      supplementTicket.value || undefined
    )
    candidates.value = response.orders || []
    selectedOrderId.value = pickFirstSelectableOrderId(candidates.value)
    if (!candidates.value.length) {
      errorMessage.value = '该邮箱暂无订单'
    } else if (!selectedOrderId.value) {
      errorMessage.value = '该邮箱暂无可补录订单'
    }
  } catch (err: any) {
    if (err?.response?.data?.code === 'alipay_redpack_supplement_auth_required') {
      supplementTicket.value = ''
      ticketExpiresAt.value = null
    }
    candidates.value = []
    selectedOrderId.value = null
    errorMessage.value = err?.response?.data?.error || '查询订单失败，请稍后重试'
  } finally {
    loadingCandidates.value = false
  }
}
const loadCandidates = async () => loadCandidatesInternal()

const handleSubmit = async () => {
  if (!email.value || !EMAIL_REGEX.test(email.value)) {
    errorMessage.value = '请输入有效邮箱地址'
    return
  }
  if (!selectedOrderId.value) {
    errorMessage.value = '请选择一个订单后再补录'
    return
  }
  if (!selectedOrder.value || !isOrderSelectable(selectedOrder.value)) {
    errorMessage.value = '当前订单状态不可补录，请选择已兑换且质保内订单'
    return
  }
  if (otpRequired.value && !authVerified.value) {
    errorMessage.value = '补录认证已失效，请重新验证邮箱'
    return
  }

  submitting.value = true
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const response = await alipayRedpackService.supplementPublic({
      email: email.value,
      orderId: selectedOrderId.value,
    }, supplementTicket.value || undefined)
    if (response?.error) {
      const manualRequired = Boolean(response?.manualInterventionRequired)
      errorMessage.value = manualRequired ? `${response.error}（已进入人工介入队列）` : response.error
      lastOrder.value = response?.order || null
      return
    }
    lastOrder.value = response?.order || null
    successMessage.value = response?.message || '补录成功'
    await loadCandidatesInternal({ preserveMessages: true })
  } catch (err: any) {
    const message = err?.response?.data?.error || '补录失败，请稍后重试'
    if (err?.response?.data?.code === 'alipay_redpack_supplement_auth_required') {
      supplementTicket.value = ''
      ticketExpiresAt.value = null
    }
    const manualRequired = Boolean(err?.response?.data?.manualInterventionRequired)
    errorMessage.value = manualRequired ? `${message}（已进入人工介入队列）` : message
    lastOrder.value = err?.response?.data?.order || null
  } finally {
    submitting.value = false
  }
}
</script>
