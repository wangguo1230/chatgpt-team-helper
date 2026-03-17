<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { RefreshCw, Loader2, Search } from 'lucide-vue-next'
import {
  authService,
  alipayRedpackService,
  type AlipayRedpackSupplementRecord,
} from '@/services/api'
import { formatShanghaiDate } from '@/lib/datetime'
import { useAppConfigStore } from '@/stores/appConfig'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/toast'

const router = useRouter()
const appConfigStore = useAppConfigStore()
const { success: showSuccessToast, error: showErrorToast } = useToast()

const records = ref<AlipayRedpackSupplementRecord[]>([])
const total = ref(0)
const loading = ref(false)
const refreshing = ref(false)
const pageError = ref('')
const searchQuery = ref('')
const statusFilter = ref('all')
const retryingId = ref<number | null>(null)
const manualClosingId = ref<number | null>(null)
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null

const dateFormatOptions = computed(() => ({
  timeZone: appConfigStore.timezone,
  locale: appConfigStore.locale,
}))
const formatDate = (value?: string | null) => formatShanghaiDate(value, dateFormatOptions.value)

const statusText = (status?: string) => {
  if (status === 'processing') return '处理中'
  if (status === 'auto_success') return '自动成功'
  if (status === 'manual_required') return '需人工介入'
  if (status === 'auto_failed') return '自动失败'
  if (status === 'rejected_out_of_warranty') return '超质保拒绝'
  if (status === 'skipped_no_need') return '无需补录'
  if (status === 'manual_done') return '人工已完成'
  return status || '-'
}

const statusClass = (status?: string) => {
  if (status === 'processing') return 'bg-yellow-50 text-yellow-700 border-yellow-200'
  if (status === 'auto_success') return 'bg-emerald-50 text-emerald-700 border-emerald-200'
  if (status === 'manual_required') return 'bg-orange-50 text-orange-700 border-orange-200'
  if (status === 'auto_failed') return 'bg-rose-50 text-rose-700 border-rose-200'
  if (status === 'rejected_out_of_warranty') return 'bg-gray-100 text-gray-600 border-gray-200'
  if (status === 'skipped_no_need') return 'bg-cyan-50 text-cyan-700 border-cyan-200'
  if (status === 'manual_done') return 'bg-blue-50 text-blue-700 border-blue-200'
  return 'bg-gray-50 text-gray-600 border-gray-200'
}

const handleAuthError = (err: any) => {
  if (err?.response?.status === 401 || err?.response?.status === 403) {
    authService.logout()
    router.push('/login')
    return true
  }
  return false
}

const fetchRecords = async () => {
  loading.value = true
  try {
    const response = await alipayRedpackService.adminListSupplements({
      search: searchQuery.value.trim() || undefined,
      status: statusFilter.value,
      limit: 300,
      offset: 0,
    })
    records.value = response.records || []
    total.value = Number(response.total || 0)
    pageError.value = ''
  } catch (err: any) {
    if (handleAuthError(err)) return
    const message = err?.response?.data?.error || '加载补录记录失败'
    pageError.value = message
    showErrorToast(message)
  } finally {
    loading.value = false
  }
}

const refreshAll = async () => {
  refreshing.value = true
  try {
    await fetchRecords()
  } finally {
    refreshing.value = false
  }
}

watch(searchQuery, () => {
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer)
  searchDebounceTimer = setTimeout(() => {
    fetchRecords()
    searchDebounceTimer = null
  }, 300)
})

watch(statusFilter, () => {
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer)
    searchDebounceTimer = null
  }
  fetchRecords()
})

const handleRetry = async (item: AlipayRedpackSupplementRecord) => {
  if (!item?.id) return
  retryingId.value = item.id
  try {
    const response = await alipayRedpackService.adminRetrySupplement(item.id)
    showSuccessToast(response?.message || '补录重试已触发')
    await fetchRecords()
  } catch (err: any) {
    if (handleAuthError(err)) return
    showErrorToast(err?.response?.data?.error || '补录重试失败')
  } finally {
    retryingId.value = null
  }
}

const handleManualClose = async (item: AlipayRedpackSupplementRecord) => {
  if (!item?.id) return
  const detail = prompt('请输入人工处理备注（可选）', item.detail || '已人工介入处理')
  if (detail === null) return

  manualClosingId.value = item.id
  try {
    const response = await alipayRedpackService.adminManualCloseSupplement(item.id, {
      detail: detail || undefined,
    })
    showSuccessToast(response?.message || '已标记人工完成')
    await fetchRecords()
  } catch (err: any) {
    if (handleAuthError(err)) return
    showErrorToast(err?.response?.data?.error || '标记人工处理失败')
  } finally {
    manualClosingId.value = null
  }
}

onMounted(() => {
  if (!authService.isAuthenticated()) {
    router.push('/login')
    return
  }
  fetchRecords()
})
</script>

<template>
  <div class="space-y-6 p-6 md:p-8">
    <div class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div class="space-y-1">
        <h1 class="text-2xl font-bold tracking-tight text-gray-900">支付宝口令补录管理</h1>
        <p class="text-sm text-gray-500">查看自动补录结果，处理“需人工介入”的补录任务。</p>
      </div>

      <Button type="button" variant="outline" :disabled="refreshing || loading" @click="refreshAll">
        <RefreshCw class="mr-2 h-4 w-4" :class="(refreshing || loading) ? 'animate-spin' : ''" />
        刷新
      </Button>
    </div>

    <div class="grid gap-4 rounded-2xl border border-gray-200 bg-white p-4 md:grid-cols-2">
      <div class="space-y-2">
        <Label for="supplement-search">搜索</Label>
        <div class="relative">
          <Search class="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <Input
            id="supplement-search"
            v-model="searchQuery"
            class="pl-9"
            placeholder="订单号/邮箱/状态/详情"
          />
        </div>
      </div>

      <div class="space-y-2">
        <Label for="supplement-status">状态筛选</Label>
        <select
          id="supplement-status"
          v-model="statusFilter"
          class="h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-sm"
        >
          <option value="all">全部</option>
          <option value="processing">处理中</option>
          <option value="auto_success">自动成功</option>
          <option value="manual_required">需人工介入</option>
          <option value="auto_failed">自动失败</option>
          <option value="rejected_out_of_warranty">超质保拒绝</option>
          <option value="skipped_no_need">无需补录</option>
          <option value="manual_done">人工已完成</option>
        </select>
      </div>
    </div>

    <div v-if="pageError" class="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
      {{ pageError }}
    </div>

    <div class="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
      <div class="flex items-center justify-between border-b border-gray-100 px-4 py-3 text-sm text-gray-500">
        <span>共 {{ total }} 条补录记录</span>
        <span v-if="loading" class="inline-flex items-center gap-2"><Loader2 class="h-4 w-4 animate-spin" />加载中...</span>
      </div>

      <div class="overflow-x-auto">
        <table class="min-w-full divide-y divide-gray-100 text-sm">
          <thead class="bg-gray-50 text-gray-500">
            <tr>
              <th class="px-4 py-3 text-left font-semibold">记录ID</th>
              <th class="px-4 py-3 text-left font-semibold">订单ID</th>
              <th class="px-4 py-3 text-left font-semibold">邮箱</th>
              <th class="px-4 py-3 text-left font-semibold">状态</th>
              <th class="px-4 py-3 text-left font-semibold">详情</th>
              <th class="px-4 py-3 text-left font-semibold">补录码</th>
              <th class="px-4 py-3 text-left font-semibold">创建时间</th>
              <th class="px-4 py-3 text-left font-semibold">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100 bg-white text-gray-700">
            <tr v-for="item in records" :key="item.id">
              <td class="px-4 py-3 font-mono">#{{ item.id }}</td>
              <td class="px-4 py-3 font-mono">#{{ item.orderId }}</td>
              <td class="px-4 py-3">{{ item.email }}</td>
              <td class="px-4 py-3">
                <span class="inline-flex rounded-full border px-2 py-0.5 text-xs" :class="statusClass(item.status)">
                  {{ statusText(item.status) }}
                </span>
              </td>
              <td class="px-4 py-3 max-w-xs truncate" :title="item.detail || '-'">{{ item.detail || '-' }}</td>
              <td class="px-4 py-3 font-mono">{{ item.redemptionCode || '-' }}</td>
              <td class="px-4 py-3">{{ formatDate(item.createdAt) }}</td>
              <td class="px-4 py-3">
                <div class="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    :disabled="retryingId === item.id || manualClosingId === item.id"
                    @click="handleRetry(item)"
                  >
                    {{ retryingId === item.id ? '重试中...' : '重试自动补录' }}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    :disabled="manualClosingId === item.id || retryingId === item.id"
                    @click="handleManualClose(item)"
                  >
                    {{ manualClosingId === item.id ? '处理中...' : '标记人工完成' }}
                  </Button>
                </div>
              </td>
            </tr>

            <tr v-if="!loading && records.length === 0">
              <td class="px-4 py-10 text-center text-gray-400" colspan="8">
                暂无补录记录
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
