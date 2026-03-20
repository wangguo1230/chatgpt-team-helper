<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { AlertTriangle, BarChart3, RefreshCw } from 'lucide-vue-next'
import { authService, adminStatsService, type AdminStatsOverviewResponse } from '@/services/api'
import { useAppConfigStore } from '@/stores/appConfig'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

const router = useRouter()
const appConfigStore = useAppConfigStore()

const loading = ref(false)
const error = ref('')
const overview = ref<AdminStatsOverviewResponse | null>(null)

const locale = computed(() => appConfigStore.locale || 'zh-CN')
const numberFmt = computed(() => new Intl.NumberFormat(locale.value))

const formatNumber = (value?: number | null) => numberFmt.value.format(Number(value || 0))
const formatPercent = (value?: number | null) => `${(Number(value || 0) * 100).toFixed(1)}%`

const orderStatusRows = computed(() => {
  if (!overview.value) return []
  const status = overview.value.alipayRedpackOrders.status
  return [
    { key: 'pending', label: '待处理', ...status.pending },
    { key: 'invited', label: '已邀请', ...status.invited },
    { key: 'redeemed', label: '已兑换', ...status.redeemed },
    { key: 'returned', label: '已退回', ...status.returned },
  ]
})

const codeRows = computed(() => {
  if (!overview.value) return []
  const codes = overview.value.redemptionCodes
  return [
    { key: 'total', label: '总量', ...codes.total },
    { key: 'unused', label: '未用', ...codes.unused },
    { key: 'used', label: '已用', ...codes.used },
    { key: 'reserved', label: '占用', ...codes.reserved },
  ]
})

const hasAllZeroSourceTotals = computed(() => {
  if (!overview.value) return false
  return (
    Number(overview.value.alipayRedpackOrders.counts.total || 0) === 0 &&
    Number(overview.value.redemptionCodes.total.total || 0) === 0 &&
    Number(overview.value.gptAccounts.total || 0) === 0
  )
})

const loadOverview = async () => {
  loading.value = true
  error.value = ''
  try {
    overview.value = await adminStatsService.getOverview()
  } catch (err: any) {
    const message = err?.response?.data?.error || err?.message || '加载统计数据失败'
    error.value = message
    if (err?.response?.status === 401 || err?.response?.status === 403) {
      authService.logout()
      router.push('/login')
      return
    }
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  await appConfigStore.loadConfig()

  if (!authService.isAuthenticated()) {
    router.push('/login')
    return
  }

  await loadOverview()
})
</script>

<template>
  <div class="space-y-8">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-2xl bg-blue-50 flex items-center justify-center text-blue-600">
          <BarChart3 class="w-5 h-5" />
        </div>
        <div>
          <h1 class="text-xl font-semibold text-gray-900">三维统计总览</h1>
          <p class="text-xs text-gray-500">支付宝口令订单 / 兑换码 / 账号</p>
        </div>
      </div>

      <Button
        variant="outline"
        class="h-10 rounded-xl border-gray-200 bg-white w-full sm:w-auto"
        :disabled="loading"
        @click="loadOverview"
      >
        <RefreshCw class="w-4 h-4 mr-2" :class="{ 'animate-spin': loading }" />
        刷新
      </Button>
    </div>

    <div v-if="error" class="rounded-2xl border border-red-100 bg-red-50/50 p-4 flex items-center gap-3 text-red-600">
      <AlertTriangle class="h-5 w-5" />
      <span class="font-medium">{{ error }}</span>
    </div>

    <div
      v-if="overview && hasAllZeroSourceTotals"
      class="rounded-2xl border border-amber-100 bg-amber-50/60 p-4 text-amber-800"
    >
      <p class="text-sm font-semibold">统计源表当前均为 0</p>
      <p class="text-xs mt-1">
        已返回有效统计响应，但 `alipay_redpack_orders`、`redemption_codes`、`gpt_accounts` 三个源表没有数据。
        请检查服务连接的数据库文件（`DATABASE_PATH`）是否正确。
      </p>
    </div>

    <div class="bg-white rounded-[28px] shadow-sm border border-gray-100 overflow-hidden min-h-[360px]">
      <div v-if="loading && !overview" class="flex flex-col items-center justify-center py-20">
        <div class="w-10 h-10 border-4 border-blue-500/20 border-t-blue-500 rounded-full animate-spin"></div>
        <p class="text-gray-400 text-sm font-medium mt-4">正在加载统计数据...</p>
      </div>

      <div v-else-if="overview" class="p-6 lg:p-8 space-y-8">
        <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          <Card class="rounded-2xl border-gray-100">
            <CardContent class="p-5 space-y-2">
              <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider">支付宝口令订单总数</p>
              <p class="text-2xl font-bold text-gray-900">{{ formatNumber(overview.alipayRedpackOrders.counts.total) }}</p>
              <p class="text-xs text-gray-500">今日 {{ formatNumber(overview.alipayRedpackOrders.counts.today) }} / 昨日 {{ formatNumber(overview.alipayRedpackOrders.counts.yesterday) }}</p>
            </CardContent>
          </Card>

          <Card class="rounded-2xl border-gray-100">
            <CardContent class="p-5 space-y-2">
              <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider">兑换码总量</p>
              <p class="text-2xl font-bold text-gray-900">{{ formatNumber(overview.redemptionCodes.total.total) }}</p>
              <p class="text-xs text-gray-500">今日 {{ formatNumber(overview.redemptionCodes.total.today) }} / 昨日 {{ formatNumber(overview.redemptionCodes.total.yesterday) }}</p>
            </CardContent>
          </Card>

          <Card class="rounded-2xl border-gray-100">
            <CardContent class="p-5 space-y-2">
              <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider">账号总量</p>
              <p class="text-2xl font-bold text-gray-900">{{ formatNumber(overview.gptAccounts.total) }}</p>
              <p class="text-xs text-gray-500">开放 {{ formatNumber(overview.gptAccounts.open) }} / 封禁 {{ formatNumber(overview.gptAccounts.banned) }}</p>
            </CardContent>
          </Card>
        </div>

        <div class="rounded-2xl border border-gray-100 overflow-hidden">
          <div class="px-5 py-4 bg-gray-50/60 border-b border-gray-100">
            <h4 class="text-sm font-semibold text-gray-900">支付宝口令订单状态数量</h4>
            <p class="text-xs text-gray-400 mt-0.5">按创建时间维度统计（总 / 今日 / 昨日）</p>
          </div>
          <div class="p-5 overflow-x-auto">
            <table class="w-full min-w-[560px] text-sm">
              <thead class="text-xs text-gray-400 uppercase">
                <tr>
                  <th class="text-left font-semibold py-2">状态</th>
                  <th class="text-right font-semibold py-2">总</th>
                  <th class="text-right font-semibold py-2">今日</th>
                  <th class="text-right font-semibold py-2">昨日</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-50">
                <tr v-for="row in orderStatusRows" :key="row.key" class="hover:bg-gray-50/40">
                  <td class="py-3 font-medium text-gray-900">{{ row.label }}</td>
                  <td class="py-3 text-right text-gray-700">{{ formatNumber(row.total) }}</td>
                  <td class="py-3 text-right text-gray-700">{{ formatNumber(row.today) }}</td>
                  <td class="py-3 text-right text-gray-700">{{ formatNumber(row.yesterday) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="rounded-2xl border border-gray-100 overflow-hidden">
          <div class="px-5 py-4 bg-gray-50/60 border-b border-gray-100">
            <h4 class="text-sm font-semibold text-gray-900">兑换码数量统计</h4>
            <p class="text-xs text-gray-400 mt-0.5">总量 / 未用 / 已用 / 占用（总 / 今日 / 昨日）</p>
          </div>
          <div class="p-5 overflow-x-auto">
            <table class="w-full min-w-[560px] text-sm">
              <thead class="text-xs text-gray-400 uppercase">
                <tr>
                  <th class="text-left font-semibold py-2">指标</th>
                  <th class="text-right font-semibold py-2">总</th>
                  <th class="text-right font-semibold py-2">今日</th>
                  <th class="text-right font-semibold py-2">昨日</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-50">
                <tr v-for="row in codeRows" :key="row.key" class="hover:bg-gray-50/40">
                  <td class="py-3 font-medium text-gray-900">{{ row.label }}</td>
                  <td class="py-3 text-right text-gray-700">{{ formatNumber(row.total) }}</td>
                  <td class="py-3 text-right text-gray-700">{{ formatNumber(row.today) }}</td>
                  <td class="py-3 text-right text-gray-700">{{ formatNumber(row.yesterday) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="rounded-2xl border border-gray-100 overflow-hidden">
          <div class="px-5 py-4 bg-gray-50/60 border-b border-gray-100">
            <h4 class="text-sm font-semibold text-gray-900">账号与容量联动</h4>
            <p class="text-xs text-gray-400 mt-0.5">账号快照 + 可邀请库存联动数量</p>
          </div>
          <div class="p-5 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 text-sm">
            <div class="rounded-xl border border-gray-100 p-4">
              <p class="text-xs text-gray-400 uppercase tracking-wider">活跃账号</p>
              <p class="text-2xl font-bold text-gray-900 mt-1">{{ formatNumber(overview.gptAccounts.active) }}</p>
            </div>
            <div class="rounded-xl border border-gray-100 p-4">
              <p class="text-xs text-gray-400 uppercase tracking-wider">席位利用率</p>
              <p class="text-2xl font-bold text-gray-900 mt-1">{{ formatPercent(overview.gptAccounts.seatUtilization) }}</p>
              <p class="text-xs text-gray-500 mt-1">已用 {{ formatNumber(overview.gptAccounts.usedSeats) }} / 总席位 {{ formatNumber(overview.gptAccounts.totalSeats) }}</p>
            </div>
            <div class="rounded-xl border border-gray-100 p-4">
              <p class="text-xs text-gray-400 uppercase tracking-wider">待接受邀请</p>
              <p class="text-2xl font-bold text-gray-900 mt-1">{{ formatNumber(overview.gptAccounts.invitePending) }}</p>
              <p class="text-xs text-gray-500 mt-1">容量阈值 {{ formatNumber(overview.gptAccounts.capacityLimit) }}/账号</p>
            </div>
            <div class="rounded-xl border border-gray-100 p-4">
              <p class="text-xs text-gray-400 uppercase tracking-wider">可邀请账号</p>
              <p class="text-2xl font-bold text-gray-900 mt-1">{{ formatNumber(overview.gptAccounts.invitableAccounts) }}</p>
              <p class="text-xs text-gray-500 mt-1">剩余可邀请席位 {{ formatNumber(overview.gptAccounts.invitableRemainingSeats) }}</p>
            </div>

            <div class="rounded-xl border border-gray-100 p-4">
              <p class="text-xs text-gray-400 uppercase tracking-wider">可用兑换码总数</p>
              <p class="text-2xl font-bold text-gray-900 mt-1">{{ formatNumber(overview.gptAccounts.codeLinked.availableCodesTotal) }}</p>
            </div>
            <div class="rounded-xl border border-gray-100 p-4">
              <p class="text-xs text-gray-400 uppercase tracking-wider">有码账号数</p>
              <p class="text-2xl font-bold text-gray-900 mt-1">{{ formatNumber(overview.gptAccounts.codeLinked.accountWithAvailableCodes) }}</p>
            </div>
            <div class="rounded-xl border border-gray-100 p-4">
              <p class="text-xs text-gray-400 uppercase tracking-wider">可邀请账号上的可用码</p>
              <p class="text-2xl font-bold text-gray-900 mt-1">{{ formatNumber(overview.gptAccounts.codeLinked.availableCodesOnInvitableAccounts) }}</p>
            </div>
            <div class="rounded-xl border border-gray-100 p-4">
              <p class="text-xs text-gray-400 uppercase tracking-wider">可邀请且有码账号</p>
              <p class="text-2xl font-bold text-gray-900 mt-1">{{ formatNumber(overview.gptAccounts.codeLinked.invitableAccountsWithAvailableCodes) }}</p>
            </div>
          </div>
        </div>
      </div>

      <div v-else class="flex flex-col items-center justify-center py-20 px-6 text-center">
        <p class="text-base font-medium text-gray-700">暂无可展示的统计数据</p>
        <p class="text-sm text-gray-400 mt-2">请点击刷新重试；若持续失败请检查接口 `/api/admin/stats/overview`。</p>
      </div>
    </div>
  </div>
</template>
