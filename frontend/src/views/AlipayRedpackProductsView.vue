<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Plus, RefreshCw, Trash2, Pencil } from 'lucide-vue-next'
import { authService, alipayRedpackService, type AlipayRedpackProduct } from '@/services/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/components/ui/toast'

const router = useRouter()
const { success: showSuccessToast, error: showErrorToast, warning: showWarningToast } = useToast()

const loading = ref(false)
const products = ref<AlipayRedpackProduct[]>([])
const pageError = ref('')
const dialogOpen = ref(false)
const saving = ref(false)
const editingKey = ref('')

const form = ref({
  productKey: '',
  productName: '',
  amount: '',
  productType: 'gpt_single',
  paymentMethod: 'alipay_passphrase',
  serviceDays: 30,
  sortOrder: 0,
  isActive: true,
})

const dialogTitle = computed(() => (editingKey.value ? '编辑商品' : '新增商品'))
const isActiveSelectValue = computed({
  get: () => (form.value.isActive ? '1' : '0'),
  set: (value: string) => {
    form.value.isActive = value === '1'
  },
})

const normalizeAmount = (value: string) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return ''
  return (Math.round(parsed * 100) / 100).toFixed(2)
}

const ensureAuth = () => {
  if (!authService.isAuthenticated()) {
    authService.logout()
    router.push('/login')
    return false
  }
  return true
}

const loadProducts = async () => {
  if (!ensureAuth()) return
  loading.value = true
  pageError.value = ''
  try {
    const response = await alipayRedpackService.adminListProducts()
    products.value = response.products || []
  } catch (err: any) {
    if (err?.response?.status === 401 || err?.response?.status === 403) {
      authService.logout()
      router.push('/login')
      return
    }
    pageError.value = err?.response?.data?.error || '加载商品失败'
  } finally {
    loading.value = false
  }
}

const openCreateDialog = () => {
  editingKey.value = ''
  form.value = {
    productKey: '',
    productName: '',
    amount: '',
    productType: 'gpt_single',
    paymentMethod: 'alipay_passphrase',
    serviceDays: 30,
    sortOrder: products.value.length ? Number(products.value[products.value.length - 1]?.sortOrder || 0) + 10 : 10,
    isActive: true,
  }
  dialogOpen.value = true
}

const openEditDialog = (product: AlipayRedpackProduct) => {
  editingKey.value = product.productKey
  form.value = {
    productKey: product.productKey,
    productName: product.productName,
    amount: product.amount,
    productType: product.productType || 'gpt_single',
    paymentMethod: product.paymentMethod || 'alipay_passphrase',
    serviceDays: Number(product.serviceDays || 30),
    sortOrder: Number(product.sortOrder || 0),
    isActive: Boolean(product.isActive),
  }
  dialogOpen.value = true
}

const closeDialog = () => {
  if (saving.value) return
  dialogOpen.value = false
}

const saveProduct = async () => {
  const payload = {
    productKey: String(form.value.productKey || '').trim().toLowerCase(),
    productName: String(form.value.productName || '').trim(),
    amount: normalizeAmount(String(form.value.amount || '').trim()),
    productType: String(form.value.productType || 'gpt_single'),
    paymentMethod: String(form.value.paymentMethod || 'alipay_passphrase'),
    serviceDays: Math.max(1, Number(form.value.serviceDays || 30)),
    sortOrder: Number(form.value.sortOrder || 0),
    isActive: Boolean(form.value.isActive),
  }

  if (!payload.productName) {
    showWarningToast('商品名称不能为空')
    return
  }
  if (!payload.amount) {
    showWarningToast('价格格式不正确')
    return
  }
  if (!editingKey.value && !payload.productKey) {
    showWarningToast('商品 Key 不能为空')
    return
  }

  saving.value = true
  try {
    if (editingKey.value) {
      await alipayRedpackService.adminUpdateProduct(editingKey.value, payload)
      showSuccessToast('商品已更新')
    } else {
      await alipayRedpackService.adminCreateProduct(payload)
      showSuccessToast('商品已创建')
    }
    dialogOpen.value = false
    await loadProducts()
  } catch (err: any) {
    showErrorToast(err?.response?.data?.error || '保存失败')
  } finally {
    saving.value = false
  }
}

const toggleActive = async (product: AlipayRedpackProduct) => {
  try {
    await alipayRedpackService.adminUpdateProduct(product.productKey, {
      isActive: !Boolean(product.isActive),
    })
    await loadProducts()
  } catch (err: any) {
    showErrorToast(err?.response?.data?.error || '状态更新失败')
  }
}

const deleteProduct = async (product: AlipayRedpackProduct) => {
  if (!confirm(`确认下架商品「${product.productName || product.productKey}」吗？`)) return
  try {
    await alipayRedpackService.adminDeleteProduct(product.productKey)
    showSuccessToast('商品已下架')
    await loadProducts()
  } catch (err: any) {
    showErrorToast(err?.response?.data?.error || '下架失败')
  }
}

onMounted(() => {
  loadProducts()
})
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div>
        <h1 class="text-3xl font-bold tracking-tight text-gray-900">支付宝口令商品管理</h1>
        <p class="text-sm text-gray-500 mt-1">独立菜单管理 GPT 单号/母号商品</p>
      </div>

      <div class="flex items-center gap-2">
        <Button variant="outline" :disabled="loading" @click="loadProducts">
          <RefreshCw class="w-4 h-4 mr-2" :class="{ 'animate-spin': loading }" />
          刷新
        </Button>
        <Button @click="openCreateDialog">
          <Plus class="w-4 h-4 mr-2" />
          新增商品
        </Button>
      </div>
    </div>

    <div v-if="pageError" class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-600">
      {{ pageError }}
    </div>

    <div class="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
      <div v-if="loading" class="py-16 text-center text-gray-500">加载中...</div>
      <div v-else-if="!products.length" class="py-16 text-center text-gray-500">暂无商品</div>
      <div v-else class="overflow-x-auto">
        <table class="w-full min-w-[980px]">
          <thead>
            <tr class="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600">
              <th class="px-4 py-3 text-left">Key</th>
              <th class="px-4 py-3 text-left">商品名</th>
              <th class="px-4 py-3 text-left">价格</th>
              <th class="px-4 py-3 text-left">类型</th>
              <th class="px-4 py-3 text-left">支付方式</th>
              <th class="px-4 py-3 text-left">状态</th>
              <th class="px-4 py-3 text-left">排序</th>
              <th class="px-4 py-3 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in products" :key="item.productKey" class="border-b border-slate-100 text-sm">
              <td class="px-4 py-3 font-mono">{{ item.productKey }}</td>
              <td class="px-4 py-3">{{ item.productName }}</td>
              <td class="px-4 py-3 font-mono">¥{{ item.amount }}</td>
              <td class="px-4 py-3">{{ item.productType === 'gpt_parent' ? 'GPT母号' : 'GPT单号' }}</td>
              <td class="px-4 py-3">{{ item.paymentMethod === 'zpay' ? '易支付' : '支付宝口令' }}</td>
              <td class="px-4 py-3">
                <span class="inline-flex items-center rounded-full border px-2 py-1 text-xs"
                  :class="item.isActive ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-gray-200 bg-gray-50 text-gray-500'">
                  {{ item.isActive ? '上架中' : '已下架' }}
                </span>
              </td>
              <td class="px-4 py-3">{{ item.sortOrder }}</td>
              <td class="px-4 py-3 text-right">
                <div class="inline-flex items-center gap-2">
                  <Button size="sm" variant="outline" @click="toggleActive(item)">
                    {{ item.isActive ? '下架' : '上架' }}
                  </Button>
                  <Button size="icon" variant="outline" @click="openEditDialog(item)">
                    <Pencil class="w-4 h-4" />
                  </Button>
                  <Button size="icon" variant="outline" class="text-red-600" @click="deleteProduct(item)">
                    <Trash2 class="w-4 h-4" />
                  </Button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <Dialog :open="dialogOpen" @update:open="(open) => { if (!open) closeDialog() }">
      <DialogContent class="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{{ dialogTitle }}</DialogTitle>
        </DialogHeader>

        <div class="space-y-4 pt-2">
          <div class="space-y-2">
            <Label>商品 Key</Label>
            <Input v-model="form.productKey" :disabled="Boolean(editingKey)" placeholder="如：ar_gpt_single" />
          </div>

          <div class="space-y-2">
            <Label>商品名称</Label>
            <Input v-model="form.productName" placeholder="如：GPT 单号（支付宝口令）" />
          </div>

          <div class="grid grid-cols-2 gap-4">
            <div class="space-y-2">
              <Label>价格</Label>
              <Input v-model="form.amount" placeholder="9.90" />
            </div>
            <div class="space-y-2">
              <Label>排序</Label>
              <Input v-model.number="form.sortOrder" type="number" />
            </div>
          </div>

          <div class="grid grid-cols-2 gap-4">
            <div class="space-y-2">
              <Label>商品类型</Label>
              <Select v-model="form.productType">
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="gpt_single">GPT单号</SelectItem>
                  <SelectItem value="gpt_parent">GPT母号</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="space-y-2">
              <Label>支付方式</Label>
              <Select v-model="form.paymentMethod">
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="alipay_passphrase">支付宝口令</SelectItem>
                  <SelectItem value="zpay">易支付（预留）</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div class="space-y-2">
            <Label>服务天数（兼容字段）</Label>
            <Input v-model.number="form.serviceDays" type="number" min="1" />
          </div>

          <div class="space-y-2">
            <Label>上架状态</Label>
            <Select v-model="isActiveSelectValue">
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="1">上架</SelectItem>
                <SelectItem value="0">下架</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" :disabled="saving" @click="closeDialog">取消</Button>
          <Button :disabled="saving" @click="saveProduct">
            <RefreshCw v-if="saving" class="w-4 h-4 mr-2 animate-spin" />
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
