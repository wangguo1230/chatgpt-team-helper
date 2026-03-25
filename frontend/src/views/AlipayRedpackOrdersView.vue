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
const startDateFilter = ref('')
const endDateFilter = ref('')

const quickInvitingId = ref<number | null>(null)
const savingNoteId = ref<number | null>(null)
const returningOrderId = ref<number | null>(null)
const syncingStatusOrderId = ref<number | null>(null)
const quickInviteAccounts = ref<GptAccount[]>([])
const processDialogOpen = ref(false)
const processingOrder = ref<AlipayRedpackOrder | null>(null)

const noteDrafts = ref<Record<number, string>>({})
const noteSavedSnapshots = ref<Record<number, string>>({})
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null

const dateFormatOptions = computed(() => ({
  timeZone: appConfigStore.timezone,
  locale: appConfigStore.locale,
}))
const formatDate = (value?: string | null) => formatShanghaiDate(value, dateFormatOptions.value)
const parseAccountExpireAtMs = (value?: string | null) => {
  const raw = String(value || '').trim()
  if (!raw) return null
  const match = raw.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  if (match) {
    const iso = `${match[1]}-${String(Number(match[2])).padStart(2, '0')}-${String(Number(match[3])).padStart(2, '0')}T${String(Number(match[4])).padStart(2, '0')}:${match[5]}:${String(Number(match[6] || 0)).padStart(2, '0')}+08:00`
    const parsed = Date.parse(iso)
    return Number.isFinite(parsed) ? parsed : null
  }
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : null
}

const statusText = (status?: string) => {
  if (status === 'pending') return '待处理'
  if (status === 'invited') return '已邀请'
  if (status === 'redeemed') return '已兑换'
  if (status === 'returned') return '已退回'
  return status || '-'
}
const productTypeText = (order?: AlipayRedpackOrder | null) => {
  const type = String(order?.productType || '').trim().toLowerCase()
  if (type === 'gpt_parent') return 'GPT 母号'
  return 'GPT 单号'
}
const paymentMethodText = (order?: AlipayRedpackOrder | null) => {
  const method = String(order?.paymentMethod || '').trim().toLowerCase()
  if (method === 'zpay') return '易支付'
  return '支付宝口令'
}
const resolveOrderQuantity = (order?: AlipayRedpackOrder | null) => {
  const parsed = Number(order?.quantity || 1)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1
}
const resolveOrderInviteEmails = (order?: AlipayRedpackOrder | null) => {
  const raw = Array.isArray(order?.inviteEmails)
    ? order?.inviteEmails
    : []
  const deduped: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const email = String(item || '').trim().toLowerCase()
    if (!email || seen.has(email)) continue
    seen.add(email)
    deduped.push(email)
  }
  if (!deduped.length && order?.email) {
    deduped.push(String(order.email).trim().toLowerCase())
  }
  return deduped
}
const resolveInviteEmailsPreview = (order?: AlipayRedpackOrder | null, max = 3) => {
  const list = resolveOrderInviteEmails(order)
  const safeMax = Number.isFinite(max) && max > 0 ? Math.floor(max) : 3
  return {
    emails: list.slice(0, safeMax),
    extra: Math.max(0, list.length - safeMax),
    total: list.length,
  }
}
const isSingleOrderMode = (order?: AlipayRedpackOrder | null) => {
  const type = String(order?.productType || 'gpt_single').trim().toLowerCase()
  return type !== 'gpt_parent'
}
const isMotherOrderMode = (order?: AlipayRedpackOrder | null) => !isSingleOrderMode(order)
const shouldAutoSyncAfterProcess = (order?: AlipayRedpackOrder | null) => {
  if (!isSingleOrderMode(order)) return false
  if (resolveOrderQuantity(order) !== 1) return false
  return resolveOrderInviteEmails(order).length === 1
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

const accountById = computed(() => {
  const map = new Map<number, GptAccount>()
  for (const account of quickInviteAccounts.value) {
    const id = Number(account?.id || 0)
    if (id > 0) map.set(id, account)
  }
  return map
})
const resolveInvitedAccountStatus = (order?: AlipayRedpackOrder | null) => {
  const accountId = Number(order?.invitedAccountId || 0)
  if (!Number.isFinite(accountId) || accountId <= 0) {
    return { text: '未绑定邀请账号', className: 'text-gray-400' }
  }
  const account = accountById.value.get(accountId)
  if (!account) {
    return { text: '账号状态未知（待同步）', className: 'text-amber-600' }
  }
  if (Boolean(account.isBanned)) {
    return { text: '账号已封禁', className: 'text-rose-600' }
  }
  const expireAtMs = parseAccountExpireAtMs(account.expireAt || null)
  if (typeof expireAtMs === 'number' && Number.isFinite(expireAtMs) && expireAtMs < Date.now()) {
    return { text: '账号已过期', className: 'text-rose-600' }
  }
  if (!Boolean(account.isOpen)) {
    return { text: '账号未开放', className: 'text-amber-600' }
  }
  return { text: '账号正常', className: 'text-emerald-600' }
}
const invitedAccountStatusText = (order?: AlipayRedpackOrder | null) => resolveInvitedAccountStatus(order).text
const invitedAccountStatusClass = (order?: AlipayRedpackOrder | null) => resolveInvitedAccountStatus(order).className
const formatOperatorDisplay = (operatorUsername?: string | null) => {
  const raw = String(operatorUsername || '').trim()
  if (!raw) return '-'
  if (raw === 'system:alipay_redpack_invited_sync') return '系统任务：邀请状态同步'
  if (raw === 'system:alipay_redpack') return '系统任务：支付宝红包流程'
  if (raw.startsWith('system:alipay_redpack')) return '系统任务：支付宝红包流程'
  return raw
}

const handleAuthError = (err: any) => {
  if (err?.response?.status === 401 || err?.response?.status === 403) {
    authService.logout()
    router.push('/login')
    return true
  }
  return false
}

const canProcessOrder = (order?: AlipayRedpackOrder | null) => {
  const status = String(order?.status || '').trim().toLowerCase()
  return status !== 'redeemed' && status !== 'returned'
}
const canSyncOrderStatus = (order?: AlipayRedpackOrder | null) => {
  const status = String(order?.status || '').trim().toLowerCase()
  if (!shouldAutoSyncAfterProcess(order)) return false
  const accountId = Number(order?.invitedAccountId || 0)
  if (status === 'redeemed' || status === 'returned') return false
  return Number.isFinite(accountId) && accountId > 0
}
const processDialogHint = computed(() => {
  const order = processingOrder.value
  if (!order) return ''
  if (isMotherOrderMode(order)) {
    return '系统将按数量分配 GPT 母号并邮件发送账号凭据；页面仅展示交付结果，不展示账号密码明文。'
  }
  if (!shouldAutoSyncAfterProcess(order)) {
    return '系统将按邀请邮箱列表批量执行邀请，并按成功邀请数量消耗对应兑换码。'
  }
  return '系统将按订单绑定兑换码自动定位邀请账号；若兑换码失效会自动尝试重绑可用兑换码后继续处理。'
})

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
}

const fetchOrders = async () => {
  if (startDateFilter.value && endDateFilter.value && startDateFilter.value > endDateFilter.value) {
    pageError.value = '开始日期不能晚于结束日期'
    orders.value = []
    total.value = 0
    return
  }

  loading.value = true
  try {
    const response = await alipayRedpackService.adminListOrders({
      search: searchQuery.value.trim() || undefined,
      status: statusFilter.value,
      startDate: startDateFilter.value || undefined,
      endDate: endDateFilter.value || undefined,
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

const clearDateFilter = async () => {
  if (!startDateFilter.value && !endDateFilter.value) return
  startDateFilter.value = ''
  endDateFilter.value = ''
  await fetchOrders()
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
  processDialogOpen.value = true
}

const closeProcessDialog = () => {
  if (quickInvitingId.value) return
  processDialogOpen.value = false
  processingOrder.value = null
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
  let shouldCloseDialog = false
  try {
    const response = await alipayRedpackService.adminQuickInvite(order.id)
    let latestOrder: AlipayRedpackOrder | null = response?.order || null
    if (latestOrder) {
      applyOrder(latestOrder)
    }

    if (shouldAutoSyncAfterProcess(latestOrder || order)) {
      latestOrder = await runAutoSyncAfterProcess(order.id, latestOrder)
      if (latestOrder) {
        applyOrder(latestOrder)
      }
    }

    const summary = response?.summary
    if (summary && Number(summary.total || 0) > 0) {
      showSuccessToast(`批量处理完成：成功 ${Number(summary.success || 0)} / ${Number(summary.total || 0)}`)
      if (Number(summary.failed || 0) > 0) {
        showWarningToast(`有 ${Number(summary.failed || 0)} 个邮箱处理失败，请补充邀请码后重试`)
      }
    } else if (Array.isArray(response?.motherAccounts)) {
      const deliveredCount = response.motherAccounts.length
      const deletedCodeCount = Number(response?.deletedCodeCount || 0)
      showSuccessToast(`${response?.message || '母号交付完成'}（交付 ${deliveredCount} 个母号）`)
      if (deletedCodeCount > 0) {
        showInfoToast(`已删除母号兑换码 ${deletedCodeCount} 个`)
      }
    } else if (shouldAutoSyncAfterProcess(latestOrder || order)) {
      showSuccessToast('处理完成，已自动同步状态并执行账号同步自查')
    } else {
      showSuccessToast(response?.message || '处理完成')
    }
    shouldCloseDialog = true
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
    if (shouldCloseDialog) {
      closeProcessDialog()
    }
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
    const rollbackMother = response?.rollbackMother
    if (rollbackMother && (Number(rollbackMother.reopenedCount || 0) > 0 || Number(rollbackMother.deliveredCount || 0) > 0)) {
      showInfoToast(
        `母号回滚：重新开放 ${Number(rollbackMother.reopenedCount || 0)} 个，已交付保持关闭 ${Number(rollbackMother.deliveredCount || 0)} 个`
      )
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

const handleSyncOrderStatus = async (order: AlipayRedpackOrder) => {
  if (!order?.id) return
  if (!canSyncOrderStatus(order)) {
    showInfoToast('该订单当前不可同步状态')
    return
  }

  syncingStatusOrderId.value = order.id
  try {
    const response = await alipayRedpackService.adminSyncStatus(order.id)
    const updatedOrder = response?.order || null
    if (updatedOrder) {
      applyOrder(updatedOrder)
    }

    const currentOrder = updatedOrder || order
    const accountId = Number(currentOrder?.invitedAccountId || 0)
    if (Number.isFinite(accountId) && accountId > 0) {
      try {
        await gptAccountService.syncUserCount(accountId)
        await loadQuickInviteAccounts({ silent: true })
      } catch (syncErr: any) {
        if (!handleAuthError(syncErr)) {
          const warningMessage = syncErr?.response?.data?.error || '账号同步失败，已保留订单最新状态'
          showWarningToast(warningMessage)
        }
      }
    }

    const queueState = response?.queueState
    if (queueState?.isMember) {
      showSuccessToast('同步完成：该邮箱已在母账号内（已上车）')
    } else if (queueState?.isInvited) {
      showSuccessToast('同步完成：该邮箱仍处于邀请中')
    } else {
      showSuccessToast('同步完成：未检索到邀请或成员记录')
    }
  } catch (err: any) {
    if (handleAuthError(err)) {
      showErrorToast('登录状态已过期，请重新登录')
      return
    }
    if (err?.response?.data?.order) {
      applyOrder(err.response.data.order)
    }
    const message = err?.response?.data?.error || '同步订单状态失败'
    showErrorToast(message)
  } finally {
    syncingStatusOrderId.value = null
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

        <div class="space-y-1">
          <Label class="text-xs text-gray-500">开始日期</Label>
          <Input
            v-model="startDateFilter"
            type="date"
            class="w-[165px]"
            @change="fetchOrders"
          />
        </div>

        <div class="space-y-1">
          <Label class="text-xs text-gray-500">结束日期</Label>
          <Input
            v-model="endDateFilter"
            type="date"
            class="w-[165px]"
            @change="fetchOrders"
          />
        </div>

        <Button
          variant="outline"
          class="h-10"
          :disabled="!startDateFilter && !endDateFilter"
          @click="clearDateFilter"
        >
          清空日期
        </Button>

        <Button variant="outline" :disabled="refreshing" @click="refreshAll" class="h-10">
          <RefreshCw class="w-4 h-4 mr-2" :class="{ 'animate-spin': refreshing }" />
          刷新
        </Button>
      </div>
    </div>

    <div v-if="pageError" class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-600">
      {{ pageError }}
    </div>

    <div class="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
      <div v-if="loading" class="py-16 flex flex-col items-center justify-center text-gray-500">
        <Loader2 class="w-6 h-6 animate-spin" />
        <p class="mt-3 text-sm">加载中...</p>
      </div>

      <div v-else-if="!orders.length" class="py-16 flex flex-col items-center justify-center text-gray-500">
        <Search class="w-8 h-8" />
        <p class="mt-3 text-sm">暂无订单</p>
      </div>

      <div v-else class="overflow-x-auto">
        <table class="w-full min-w-[2380px] table-fixed">
          <colgroup>
            <col class="w-[210px]" />
            <col class="w-[220px]" />
            <col class="w-[220px]" />
            <col class="w-[260px]" />
            <col class="w-[260px]" />
            <col class="w-[330px]" />
            <col class="w-[210px]" />
            <col class="w-[220px]" />
            <col class="w-[170px]" />
            <col class="w-[140px]" />
          </colgroup>
          <thead class="sticky top-0 z-10">
            <tr class="bg-slate-50 border-b border-slate-200 text-xs font-semibold tracking-wide text-slate-600">
              <th class="px-4 py-3 text-left whitespace-nowrap">邮箱</th>
              <th class="px-4 py-3 text-left whitespace-nowrap">商品</th>
              <th class="px-4 py-3 text-left whitespace-nowrap">支付与口令</th>
              <th class="px-4 py-3 text-left whitespace-nowrap">邀请邮箱</th>
              <th class="px-4 py-3 text-left whitespace-nowrap">兑换码 / 母号交付</th>
              <th class="px-4 py-3 text-left whitespace-nowrap">状态与结果</th>
              <th class="px-4 py-3 text-left whitespace-nowrap">时间</th>
              <th class="px-4 py-3 text-left whitespace-nowrap">备注</th>
              <th class="px-4 py-3 text-left whitespace-nowrap">操作人</th>
              <th class="px-4 py-3 text-left whitespace-nowrap sticky right-0 z-30 bg-slate-50 border-l border-slate-200 shadow-[-4px_0_8px_-8px_rgba(15,23,42,0.5)]">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100 text-sm">
            <tr v-for="order in orders" :key="order.id" class="group hover:bg-cyan-50/40 transition-colors">
              <td class="px-4 py-3 align-top">
                <div class="font-medium text-gray-900 truncate" :title="order.email">{{ order.email }}</div>
                <div class="text-xs text-gray-400">ID: {{ order.id }}</div>
              </td>
              <td class="px-4 py-3 text-xs leading-5 align-top">
                <div class="rounded-lg border border-slate-100 bg-slate-50 p-2.5 space-y-1">
                  <p class="font-medium text-slate-700 break-words">{{ order.productName || order.productKey || '-' }}</p>
                  <p class="text-slate-500">类型：{{ productTypeText(order) }}</p>
                  <p class="text-slate-500">数量：{{ resolveOrderQuantity(order) }}</p>
                  <p class="text-slate-500">金额：{{ order.amount || '-' }}</p>
                </div>
              </td>
              <td class="px-4 py-3 text-xs leading-5 align-top">
                <div class="rounded-lg border border-slate-100 bg-slate-50 p-2.5 space-y-1">
                  <p class="text-slate-700">支付方式：{{ paymentMethodText(order) }}</p>
                  <p class="text-slate-500">口令：</p>
                  <p class="font-mono text-slate-700 break-all">{{ order.alipayPassphrase || '-' }}</p>
                </div>
              </td>
              <td class="px-4 py-3 text-xs leading-5 align-top">
                <div class="rounded-lg border border-slate-100 bg-slate-50 p-2.5">
                  <template v-if="isSingleOrderMode(order)">
                    <p class="text-slate-500 mb-1">
                      共 {{ resolveInviteEmailsPreview(order).total }} 个
                    </p>
                    <div class="space-y-1">
                      <p
                        v-for="mail in resolveInviteEmailsPreview(order).emails"
                        :key="`${order.id}-${mail}`"
                        class="text-slate-700 break-all"
                      >
                        {{ mail }}
                      </p>
                      <p v-if="resolveInviteEmailsPreview(order).extra > 0" class="text-slate-400">
                        另有 {{ resolveInviteEmailsPreview(order).extra }} 个邮箱
                      </p>
                    </div>
                  </template>
                  <template v-else>
                    <p class="text-slate-500">母号订单无需邀请邮箱列表</p>
                    <p class="text-slate-700 break-all mt-1">收件邮箱：{{ order.email }}</p>
                  </template>
                </div>
              </td>
              <td class="px-4 py-3 text-xs leading-5 align-top">
                <div v-if="isSingleOrderMode(order)" class="rounded-lg border border-slate-100 bg-slate-50 p-2.5">
                  <p class="text-slate-700">兑换码 Code：{{ order.redemptionCode || '-' }}</p>
                  <p class="text-slate-500">兑换码 ID：{{ order.redemptionCodeId || '-' }}</p>
                  <p class="text-slate-500">状态：{{ redemptionCodeStateText(order) }}</p>
                  <p v-if="order.redemptionCodeRedeemedAt" class="text-slate-400">消耗：{{ formatDate(order.redemptionCodeRedeemedAt) }}</p>
                </div>
                <div v-else class="rounded-lg border border-slate-100 bg-slate-50 p-2.5">
                  <p class="text-slate-700">母号交付：{{ order.motherDeliverySentAt ? '已发送' : '未发送' }}</p>
                  <p class="text-slate-500">收件邮箱：{{ order.motherDeliveryMailTo || order.email }}</p>
                  <p v-if="order.motherDeliverySentAt" class="text-slate-400">发送时间：{{ formatDate(order.motherDeliverySentAt) }}</p>
                </div>
              </td>
              <td class="px-4 py-3 align-top">
                <span class="inline-flex items-center px-2.5 py-1 rounded-full border text-[11px] font-semibold" :class="statusClass(order.status)">
                  {{ statusText(order.status) }}
                </span>
                <p class="text-gray-700 leading-5 break-words mt-2">{{ order.inviteResult || '-' }}</p>
                <p v-if="order.invitedAccountEmail" class="text-xs text-gray-400 mt-1">账号：{{ order.invitedAccountEmail }}</p>
                <p v-if="order.invitedAccountId" class="text-xs mt-1" :class="invitedAccountStatusClass(order)">状态：{{ invitedAccountStatusText(order) }}</p>
                <div v-if="canSyncOrderStatus(order)" class="mt-2">
                  <Button
                    size="sm"
                    variant="outline"
                    class="h-7 px-2 text-xs"
                    :disabled="syncingStatusOrderId === order.id"
                    @click="handleSyncOrderStatus(order)"
                  >
                    <Loader2 v-if="syncingStatusOrderId === order.id" class="w-3 h-3 animate-spin mr-1" />
                    同步状态
                  </Button>
                </div>
              </td>
              <td class="px-4 py-3 text-xs text-gray-500 leading-5 align-top">
                <p class="whitespace-nowrap">创建：{{ formatDate(order.createdAt) }}</p>
                <p class="whitespace-nowrap">更新：{{ formatDate(order.updatedAt) }}</p>
              </td>
              <td class="px-4 py-3 align-top">
                <div class="relative">
                  <Input
                    v-model="noteDrafts[order.id]"
                    placeholder="填写备注"
                    class="h-9 bg-slate-50 border-slate-200"
                    :disabled="savingNoteId === order.id"
                    @blur="handleNoteBlur(order)"
                  />
                  <Loader2
                    v-if="savingNoteId === order.id"
                    class="absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-gray-400"
                  />
                </div>
              </td>
              <td class="px-4 py-3 text-xs text-slate-700 leading-5 align-top">
                <p class="truncate" :title="order.operatorUsername || '-'">
                  {{ formatOperatorDisplay(order.operatorUsername) }}
                </p>
              </td>
              <td class="px-4 py-3 align-top sticky right-0 z-20 bg-white border-l border-slate-100 group-hover:bg-cyan-50/40">
                <div class="flex flex-col items-start gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    class="w-[96px] whitespace-nowrap"
                    :disabled="quickInvitingId === order.id || !canProcessOrder(order)"
                    @click="openProcessDialog(order)"
                  >
                    <Loader2 v-if="quickInvitingId === order.id" class="w-3.5 h-3.5 animate-spin mr-1" />
                    处理
                  </Button>

                  <Button
                    size="sm"
                    variant="outline"
                    class="w-[96px] whitespace-nowrap"
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
            按商品类型执行单号邀请或母号交付，兼容历史单号订单流程。
          </DialogDescription>
        </DialogHeader>

        <div v-if="processingOrder" class="space-y-4 pt-2">
          <div class="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700 space-y-1">
            <p>订单ID：<span class="font-mono">#{{ processingOrder.id }}</span></p>
            <p>邮箱：{{ processingOrder.email }}</p>
            <p>商品类型：{{ productTypeText(processingOrder) }}（数量 {{ resolveOrderQuantity(processingOrder) }}）</p>
            <p>当前状态：{{ statusText(processingOrder.status) }}</p>
          </div>

          <div class="rounded-lg border border-cyan-100 bg-cyan-50 p-3 text-xs leading-6 text-cyan-800">
            {{ processDialogHint }}
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
