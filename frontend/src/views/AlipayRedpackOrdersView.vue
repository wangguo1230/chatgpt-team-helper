<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { RefreshCw, Loader2, Search } from 'lucide-vue-next'
import { authService, alipayRedpackService, gptAccountService, type AlipayRedpackOrder, type GptAccount } from '@/services/api'
import { formatShanghaiDate } from '@/lib/datetime'
import { useAppConfigStore } from '@/stores/appConfig'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/toast'

const router = useRouter()
const { success: showSuccessToast, error: showErrorToast, warning: showWarningToast, info: showInfoToast } = useToast()
const appConfigStore = useAppConfigStore()

const orders = ref<AlipayRedpackOrder[]>([])
const total = ref(0)
const loading = ref(false)
const refreshing = ref(false)
const pageError = ref('')

const searchQuery = ref('')
const statusFilter = ref<'all' | 'pending' | 'invited' | 'redeemed' | 'returned'>('all')

const quickInvitingId = ref<number | null>(null)
const savingNoteId = ref<number | null>(null)
const returningOrderId = ref<number | null>(null)
const quickInviteAccounts = ref<GptAccount[]>([])
const quickInviteAccountSelections = ref<Record<number, string>>({})
const processDialogOpen = ref(false)
const processingOrder = ref<AlipayRedpackOrder | null>(null)
const processAccountSelection = ref('auto')

const noteDrafts = ref<Record<number, string>>({})
const noteSavedSnapshots = ref<Record<number, string>>({})
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null

const dateFormatOptions = computed(() => ({
  timeZone: appConfigStore.timezone,
  locale: appConfigStore.locale,
}))
const formatDate = (value?: string | null) => formatShanghaiDate(value, dateFormatOptions.value)

const statusText = (status?: string) => {
  if (status === 'pending') return '待处理'
  if (status === 'invited') return '已邀请'
  if (status === 'redeemed') return '已兑换'
  if (status === 'returned') return '已退回'
  return status || '-'
}

const statusClass = (status?: string) => {
  if (status === 'pending') return 'bg-yellow-50 text-yellow-700 border-yellow-200'
  if (status === 'invited') return 'bg-blue-50 text-blue-700 border-blue-200'
  if (status === 'redeemed') return 'bg-emerald-50 text-emerald-700 border-emerald-200'
  if (status === 'returned') return 'bg-rose-50 text-rose-700 border-rose-200'
  return 'bg-gray-50 text-gray-600 border-gray-200'
}

const redemptionCodeStateText = (order: AlipayRedpackOrder) => {
  if (order?.redemptionCodeRedeemedAt) return '已消耗'
  if (order?.redemptionCodeId) return '未消耗'
  return '未关联'
}

const handleAuthError = (err: any) => {
  if (err?.response?.status === 401 || err?.response?.status === 403) {
    authService.logout()
    router.push('/login')
    return true
  }
  return false
}

const quickInviteAccountOptions = computed(() => {
  return [...quickInviteAccounts.value]
    .filter((account) => {
      if (!Boolean(account?.isOpen) || Boolean(account?.isBanned)) return false

      if (typeof account?.quickInviteEligible === 'boolean') {
        return account.quickInviteEligible
      }

      const occupancy = Number(account?.userCount || 0) + Number(account?.inviteCount || 0)
      const capacityLimit = Number(account?.quickInviteCapacityLimit || 0)
      const underCapacity = !Number.isFinite(capacityLimit) || capacityLimit <= 0 || occupancy < capacityLimit
      const codeTotal = Number(account?.directInviteCodeTotal || 0)
      const codeAvailable = Number(account?.directInviteCodeAvailable || 0)
      const codeEligible = codeTotal <= 0 || codeAvailable > 0
      return underCapacity && codeEligible
    })
    .sort((a, b) => {
      const aLoad = Number(a.userCount || 0) + Number(a.inviteCount || 0)
      const bLoad = Number(b.userCount || 0) + Number(b.inviteCount || 0)
      if (aLoad !== bLoad) return aLoad - bLoad
      return Number(a.id || 0) - Number(b.id || 0)
    })
})

const canProcessOrder = (order?: AlipayRedpackOrder | null) => {
  const status = String(order?.status || '').trim().toLowerCase()
  return status !== 'redeemed' && status !== 'returned'
}

const applyOrder = (updated: AlipayRedpackOrder) => {
  const index = orders.value.findIndex(item => item.id === updated.id)
  if (index === -1) {
    orders.value = [updated, ...orders.value]
  } else {
    orders.value[index] = updated
    orders.value = [...orders.value]
  }
  noteDrafts.value[updated.id] = String(updated.note || '')
  noteSavedSnapshots.value[updated.id] = String(updated.note || '')
  if (!quickInviteAccountSelections.value[updated.id]) {
    quickInviteAccountSelections.value[updated.id] = 'auto'
  }
}

const fetchOrders = async () => {
  loading.value = true
  try {
    const response = await alipayRedpackService.adminListOrders({
      search: searchQuery.value.trim() || undefined,
      status: statusFilter.value,
      limit: 1000,
      offset: 0,
    })
    orders.value = response.orders || []
    total.value = Number(response.total || 0)

    const drafts: Record<number, string> = {}
    const snapshots: Record<number, string> = {}
    for (const item of orders.value) {
      const noteValue = String(item.note || '')
      drafts[item.id] = noteValue
      snapshots[item.id] = noteValue
    }
    noteDrafts.value = drafts
    noteSavedSnapshots.value = snapshots

    const nextSelections: Record<number, string> = {}
    for (const item of orders.value) {
      nextSelections[item.id] = quickInviteAccountSelections.value[item.id] || 'auto'
    }
    quickInviteAccountSelections.value = nextSelections

    pageError.value = ''
  } catch (err: any) {
    if (handleAuthError(err)) {
      showErrorToast('登录状态已过期，请重新登录')
      return
    }
    const message = err?.response?.data?.error || '加载订单失败'
    pageError.value = message
    showErrorToast(message)
  } finally {
    loading.value = false
  }
}

const loadQuickInviteAccounts = async ({ silent = false } = {}) => {
  try {
    const response = await gptAccountService.getAll({
      page: 1,
      pageSize: 1000,
      openStatus: 'open'
    })
    quickInviteAccounts.value = response?.accounts || []
  } catch (err: any) {
    if (handleAuthError(err)) {
      if (!silent) {
        showErrorToast('登录状态已过期，请重新登录')
      }
      return
    }
    if (!silent) {
      const message = err?.response?.data?.error || '加载可邀请账号失败'
      showErrorToast(message)
    }
  }
}

const refreshAll = async () => {
  refreshing.value = true
  try {
    await fetchOrders()
  } finally {
    refreshing.value = false
  }
}

watch(searchQuery, () => {
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer)
  }
  searchDebounceTimer = setTimeout(() => {
    fetchOrders()
    searchDebounceTimer = null
  }, 300)
})

watch(statusFilter, () => {
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer)
    searchDebounceTimer = null
  }
  fetchOrders()
})

const openProcessDialog = (order: AlipayRedpackOrder) => {
  if (!order?.id) return
  if (!canProcessOrder(order)) {
    showInfoToast('该订单当前状态无需处理')
    return
  }

  processingOrder.value = order
  processAccountSelection.value = String(quickInviteAccountSelections.value[order.id] || 'auto')
  processDialogOpen.value = true
}

const closeProcessDialog = () => {
  if (quickInvitingId.value) return
  processDialogOpen.value = false
  processingOrder.value = null
  processAccountSelection.value = 'auto'
}

const runAutoSyncAfterProcess = async (orderId: number, order: AlipayRedpackOrder | null) => {
  let latestOrder = order

  try {
    const syncResponse = await alipayRedpackService.adminSyncStatus(orderId)
    if (syncResponse?.order) {
      latestOrder = syncResponse.order
      applyOrder(syncResponse.order)
    }
  } catch (err: any) {
    if (handleAuthError(err)) return latestOrder
    const message = err?.response?.data?.error || '处理后状态同步失败'
    showWarningToast(message)
  }

  const accountId = Number(latestOrder?.invitedAccountId || 0)
  if (!Number.isFinite(accountId) || accountId <= 0) {
    return latestOrder
  }

  try {
    await gptAccountService.syncUserCount(accountId)
    await loadQuickInviteAccounts({ silent: true })
  } catch (err: any) {
    if (handleAuthError(err)) return latestOrder
    const message = err?.response?.data?.error || '处理后账号同步自查失败'
    showWarningToast(message)
  }

  return latestOrder
}

const handleProcessOrder = async () => {
  const order = processingOrder.value
  if (!order?.id) return
  if (!canProcessOrder(order)) {
    showWarningToast('该订单当前状态不可处理')
    return
  }

  quickInvitingId.value = order.id
  try {
    quickInviteAccountSelections.value[order.id] = processAccountSelection.value
    const selectedAccount = String(processAccountSelection.value || 'auto')
    const selectedAccountId = selectedAccount !== 'auto' ? Number(selectedAccount) : NaN
    const payload = Number.isFinite(selectedAccountId) && selectedAccountId > 0
      ? { accountId: selectedAccountId }
      : undefined

    const response = await alipayRedpackService.adminQuickInvite(order.id, payload)
    let latestOrder: AlipayRedpackOrder | null = response?.order || null
    if (latestOrder) {
      applyOrder(latestOrder)
    }

    latestOrder = await runAutoSyncAfterProcess(order.id, latestOrder)
    if (latestOrder) {
      applyOrder(latestOrder)
    }

    showSuccessToast('处理完成，已自动同步状态并执行账号同步自查')
    closeProcessDialog()
  } catch (err: any) {
    if (handleAuthError(err)) {
      showErrorToast('登录状态已过期，请重新登录')
      return
    }
    const message = err?.response?.data?.error || '处理失败'
    if (err?.response?.data?.order) {
      applyOrder(err.response.data.order)
    }
    showErrorToast(message)
  } finally {
    quickInvitingId.value = null
  }
}

const handleReturnOrder = async (order: AlipayRedpackOrder) => {
  if (!order?.id) return
  if (order.status === 'redeemed') {
    showWarningToast('已兑换订单不支持退回')
    return
  }
  if (order.status === 'returned') {
    showInfoToast('该订单已退回')
    return
  }

  const reasonInput = prompt('请输入退回原因（可选，默认：口令不可用）', '口令不可用')
  if (reasonInput === null) return

  if (!confirm(`确认退回订单 #${order.id} 吗？退回后将释放该订单占用库存。`)) {
    return
  }

  returningOrderId.value = order.id
  try {
    const response = await alipayRedpackService.adminReturnOrder(order.id, {
      reason: String(reasonInput || '').trim() || '口令不可用'
    })
    if (response?.order) {
      applyOrder(response.order)
    }
    showSuccessToast(response?.message || '订单已退回')
  } catch (err: any) {
    if (handleAuthError(err)) {
      showErrorToast('登录状态已过期，请重新登录')
      return
    }
    const message = err?.response?.data?.error || '退回订单失败'
    if (err?.response?.data?.order) {
      applyOrder(err.response.data.order)
    }
    showErrorToast(message)
  } finally {
    returningOrderId.value = null
  }
}

const handleSaveNote = async (order: AlipayRedpackOrder, { showSuccess = false } = {}) => {
  if (!order?.id) return
  const noteValue = String(noteDrafts.value[order.id] || '').trim()
  const savedValue = String(noteSavedSnapshots.value[order.id] || '')
  if (noteValue === savedValue) return

  savingNoteId.value = order.id
  try {
    const response = await alipayRedpackService.adminUpdateNote(order.id, {
      note: noteValue,
    })
    if (response?.order) {
      applyOrder(response.order)
    } else {
      noteSavedSnapshots.value[order.id] = noteValue
    }
    if (showSuccess) {
      showSuccessToast(response?.message || '备注已更新')
    }
  } catch (err: any) {
    if (handleAuthError(err)) {
      showErrorToast('登录状态已过期，请重新登录')
      return
    }
    const message = err?.response?.data?.error || '备注保存失败'
    showErrorToast(message)
  } finally {
    savingNoteId.value = null
  }
}

const handleNoteBlur = (order: AlipayRedpackOrder) => {
  handleSaveNote(order, { showSuccess: false })
}

onMounted(async () => {
  await Promise.all([
    fetchOrders(),
    loadQuickInviteAccounts(),
  ])
})

onUnmounted(() => {
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer)
    searchDebounceTimer = null
  }
})
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div>
        <h1 class="text-3xl font-bold tracking-tight text-gray-900">支付宝口令红包订单</h1>
        <p class="text-sm text-gray-500 mt-1">订单总数：{{ total }}</p>
      </div>

      <div class="flex flex-wrap gap-2 items-end">
        <div class="space-y-1">
          <Label class="text-xs text-gray-500">搜索</Label>
          <Input v-model.trim="searchQuery" placeholder="邮箱 / 口令 / 兑换码 / 备注 / 邀请结果" class="w-[280px]" />
        </div>

        <div class="space-y-1">
          <Label class="text-xs text-gray-500">状态</Label>
          <select v-model="statusFilter" class="h-10 rounded-md border border-input bg-background px-3 text-sm">
            <option value="all">全部</option>
            <option value="pending">待处理</option>
            <option value="invited">已邀请</option>
            <option value="redeemed">已兑换</option>
            <option value="returned">已退回</option>
          </select>
        </div>

        <Button variant="outline" :disabled="refreshing" @click="refreshAll" class="h-10">
          <RefreshCw class="w-4 h-4 mr-2" :class="{ 'animate-spin': refreshing }" />
          刷新
        </Button>
      </div>
    </div>

    <div v-if="pageError" class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-600">
      {{ pageError }}
    </div>

    <div class="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      <div v-if="loading" class="py-16 flex flex-col items-center justify-center text-gray-500">
        <Loader2 class="w-6 h-6 animate-spin" />
        <p class="mt-3 text-sm">加载中...</p>
      </div>

      <div v-else-if="!orders.length" class="py-16 flex flex-col items-center justify-center text-gray-500">
        <Search class="w-8 h-8" />
        <p class="mt-3 text-sm">暂无订单</p>
      </div>

      <div v-else class="overflow-x-auto">
        <table class="w-full min-w-[1180px]">
          <thead>
            <tr class="bg-gray-50 border-b border-gray-100 text-xs uppercase tracking-wide text-gray-400">
              <th class="px-4 py-3 text-left">邮箱</th>
              <th class="px-4 py-3 text-left">支付宝口令</th>
              <th class="px-4 py-3 text-left">兑换码记录</th>
              <th class="px-4 py-3 text-left">状态</th>
              <th class="px-4 py-3 text-left">邀请结果</th>
              <th class="px-4 py-3 text-left">备注</th>
              <th class="px-4 py-3 text-left">操作人</th>
              <th class="px-4 py-3 text-left">时间</th>
              <th class="px-4 py-3 text-left">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-50 text-sm">
            <tr v-for="order in orders" :key="order.id" class="hover:bg-gray-50/60">
              <td class="px-4 py-3">
                <div class="font-medium text-gray-900">{{ order.email }}</div>
                <div class="text-xs text-gray-400">ID: {{ order.id }}</div>
              </td>
              <td class="px-4 py-3">
                <span class="font-mono text-gray-800">{{ order.alipayPassphrase }}</span>
              </td>
              <td class="px-4 py-3 text-xs">
                <p class="text-gray-700">兑换码Code：{{ order.redemptionCode || '-' }}</p>
                <p class="text-gray-500 mt-1">兑换码ID：{{ order.redemptionCodeId || '-' }}</p>
                <p class="text-gray-500 mt-1">状态：{{ redemptionCodeStateText(order) }}</p>
                <p v-if="order.redemptionCodeRedeemedAt" class="text-gray-400 mt-1">消耗：{{ formatDate(order.redemptionCodeRedeemedAt) }}</p>
              </td>
              <td class="px-4 py-3">
                <span class="inline-flex px-2.5 py-1 rounded-full border text-xs font-semibold" :class="statusClass(order.status)">
                  {{ statusText(order.status) }}
                </span>
              </td>
              <td class="px-4 py-3 max-w-[300px]">
                <p class="text-gray-700 break-words">{{ order.inviteResult || '-' }}</p>
                <p v-if="order.invitedAccountEmail" class="text-xs text-gray-400 mt-1">账号：{{ order.invitedAccountEmail }}</p>
              </td>
              <td class="px-4 py-3 w-[220px]">
                <div class="relative">
                  <Input
                    v-model="noteDrafts[order.id]"
                    placeholder="填写备注"
                    class="h-9"
                    :disabled="savingNoteId === order.id"
                    @blur="handleNoteBlur(order)"
                  />
                  <Loader2
                    v-if="savingNoteId === order.id"
                    class="absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-gray-400"
                  />
                </div>
              </td>
              <td class="px-4 py-3">
                {{ order.operatorUsername || '-' }}
              </td>
              <td class="px-4 py-3 text-xs text-gray-500">
                <p>创建：{{ formatDate(order.createdAt) }}</p>
                <p>更新：{{ formatDate(order.updatedAt) }}</p>
              </td>
              <td class="px-4 py-3">
                <div class="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    :disabled="quickInvitingId === order.id || !canProcessOrder(order)"
                    @click="openProcessDialog(order)"
                  >
                    <Loader2 v-if="quickInvitingId === order.id" class="w-3.5 h-3.5 animate-spin mr-1" />
                    处理
                  </Button>

                  <Button
                    size="sm"
                    variant="outline"
                    :disabled="returningOrderId === order.id || order.status === 'redeemed' || order.status === 'returned'"
                    @click="handleReturnOrder(order)"
                  >
                    <Loader2 v-if="returningOrderId === order.id" class="w-3.5 h-3.5 animate-spin mr-1" />
                    退回订单
                  </Button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <Dialog :open="processDialogOpen" @update:open="(open) => { if (!open) closeProcessDialog() }">
      <DialogContent class="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle class="text-xl font-bold text-gray-900">处理支付宝口令订单</DialogTitle>
          <DialogDescription>
            处理后会自动执行：邀请处理、订单状态同步、账号同步自查（不跳转账号管理页）。
          </DialogDescription>
        </DialogHeader>

        <div v-if="processingOrder" class="space-y-4 pt-2">
          <div class="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700 space-y-1">
            <p>订单ID：<span class="font-mono">#{{ processingOrder.id }}</span></p>
            <p>邮箱：{{ processingOrder.email }}</p>
            <p>当前状态：{{ statusText(processingOrder.status) }}</p>
          </div>

          <div class="space-y-2">
            <Label class="text-xs text-gray-500">邀请账号</Label>
            <select
              v-model="processAccountSelection"
              class="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              :disabled="quickInvitingId === processingOrder.id"
            >
              <option value="auto">自动选择可邀请账号（推荐）</option>
              <option
                v-for="account in quickInviteAccountOptions"
                :key="account.id"
                :value="String(account.id)"
              >
                {{ account.email }}（邀请码 {{ Number(account.directInviteCodeAvailable || 0) }}/{{ Number(account.directInviteCodeTotal || 0) }}）
              </option>
            </select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" :disabled="Boolean(quickInvitingId)" @click="closeProcessDialog">取消</Button>
          <Button :disabled="Boolean(quickInvitingId) || !processingOrder || !canProcessOrder(processingOrder)" @click="handleProcessOrder">
            <Loader2 v-if="Boolean(quickInvitingId)" class="w-3.5 h-3.5 animate-spin mr-1" />
            处理
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
