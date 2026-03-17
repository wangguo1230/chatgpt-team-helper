<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { RefreshCw, Loader2, Search } from 'lucide-vue-next'
import { authService, alipayRedpackService, type AlipayRedpackOrder } from '@/services/api'
import { formatShanghaiDate } from '@/lib/datetime'
import { useAppConfigStore } from '@/stores/appConfig'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/toast'

const router = useRouter()
const { success: showSuccessToast, error: showErrorToast, warning: showWarningToast } = useToast()
const appConfigStore = useAppConfigStore()

const orders = ref<AlipayRedpackOrder[]>([])
const total = ref(0)
const loading = ref(false)
const refreshing = ref(false)
const pageError = ref('')

const searchQuery = ref('')
const statusFilter = ref<'all' | 'pending' | 'invited' | 'redeemed'>('all')

const quickInvitingId = ref<number | null>(null)
const syncingStatusId = ref<number | null>(null)
const savingNoteId = ref<number | null>(null)

const noteDrafts = ref<Record<number, string>>({})
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
  return status || '-'
}

const statusClass = (status?: string) => {
  if (status === 'pending') return 'bg-yellow-50 text-yellow-700 border-yellow-200'
  if (status === 'invited') return 'bg-blue-50 text-blue-700 border-blue-200'
  if (status === 'redeemed') return 'bg-emerald-50 text-emerald-700 border-emerald-200'
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

const applyOrder = (updated: AlipayRedpackOrder) => {
  const index = orders.value.findIndex(item => item.id === updated.id)
  if (index === -1) {
    orders.value = [updated, ...orders.value]
  } else {
    orders.value[index] = updated
    orders.value = [...orders.value]
  }
  noteDrafts.value[updated.id] = String(updated.note || '')
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
    for (const item of orders.value) {
      drafts[item.id] = String(item.note || '')
    }
    noteDrafts.value = drafts
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

const handleQuickInvite = async (order: AlipayRedpackOrder) => {
  if (!order?.id) return
  quickInvitingId.value = order.id
  try {
    const response = await alipayRedpackService.adminQuickInvite(order.id)
    if (response?.order) {
      applyOrder(response.order)
    }
    showSuccessToast(response?.message || '快速邀请完成')
  } catch (err: any) {
    if (handleAuthError(err)) {
      showErrorToast('登录状态已过期，请重新登录')
      return
    }
    const message = err?.response?.data?.error || '快速邀请失败'
    if (err?.response?.data?.order) {
      applyOrder(err.response.data.order)
    }
    showErrorToast(message)
  } finally {
    quickInvitingId.value = null
  }
}

const handleSyncStatus = async (order: AlipayRedpackOrder) => {
  if (!order?.id) return
  syncingStatusId.value = order.id
  try {
    const response = await alipayRedpackService.adminSyncStatus(order.id)
    if (response?.order) {
      applyOrder(response.order)
    }
    showSuccessToast(response?.message || '状态同步完成')
  } catch (err: any) {
    if (handleAuthError(err)) {
      showErrorToast('登录状态已过期，请重新登录')
      return
    }
    const message = err?.response?.data?.error || '状态同步失败'
    showErrorToast(message)
  } finally {
    syncingStatusId.value = null
  }
}

const handleSaveNote = async (order: AlipayRedpackOrder) => {
  if (!order?.id) return
  savingNoteId.value = order.id
  try {
    const response = await alipayRedpackService.adminUpdateNote(order.id, {
      note: String(noteDrafts.value[order.id] || '').trim(),
    })
    if (response?.order) {
      applyOrder(response.order)
    }
    showSuccessToast(response?.message || '备注已更新')
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

const goAccountSync = (order: AlipayRedpackOrder) => {
  const accountId = Number(order.invitedAccountId || 0)
  if (!Number.isFinite(accountId) || accountId <= 0) {
    showWarningToast('该订单暂未绑定邀请账号，无法执行账号同步自查')
    return
  }

  router.push({
    name: 'accounts',
    query: {
      syncAccountId: String(accountId)
    }
  })
}

onMounted(async () => {
  await fetchOrders()
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
        <table class="w-full min-w-[1320px]">
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
              <th class="px-4 py-3 text-right">操作</th>
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
                <p class="text-gray-700">编码ID：{{ order.redemptionCodeId || '-' }}</p>
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
              <td class="px-4 py-3 w-[240px]">
                <div class="flex gap-2 items-center">
                  <Input
                    v-model="noteDrafts[order.id]"
                    placeholder="填写备注"
                    class="h-9"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    :disabled="savingNoteId === order.id"
                    @click="handleSaveNote(order)"
                  >
                    <Loader2 v-if="savingNoteId === order.id" class="w-3.5 h-3.5 animate-spin" />
                    <span v-else>保存</span>
                  </Button>
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
                <div class="flex justify-end gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    :disabled="quickInvitingId === order.id || order.status === 'redeemed'"
                    @click="handleQuickInvite(order)"
                  >
                    <Loader2 v-if="quickInvitingId === order.id" class="w-3.5 h-3.5 animate-spin mr-1" />
                    快速邀请
                  </Button>

                  <Button
                    size="sm"
                    variant="outline"
                    :disabled="syncingStatusId === order.id"
                    @click="handleSyncStatus(order)"
                  >
                    <Loader2 v-if="syncingStatusId === order.id" class="w-3.5 h-3.5 animate-spin mr-1" />
                    同步状态
                  </Button>

                  <Button
                    size="sm"
                    variant="outline"
                    @click="goAccountSync(order)"
                  >
                    账号同步自查
                  </Button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
