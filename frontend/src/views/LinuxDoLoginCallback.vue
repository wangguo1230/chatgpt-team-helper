<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { authService } from '@/services/api'
import { Button } from '@/components/ui/button'

const router = useRouter()
const route = useRoute()
const loading = ref(true)
const error = ref('')

onMounted(async () => {
  const code = route.query.code as string
  if (!code) {
    error.value = '授权失败：未获取到授权码。'
    loading.value = false
    return
  }

  try {
    const redirectUri = window.location.origin + '/login/linuxdo/callback'
    const response = await authService.linuxDoLogin(code, redirectUri)
    loading.value = false
    if (response) {
      router.push('/admin')
    }
  } catch (err: any) {
    console.error('Linux DO Login Callback Error:', err)
    error.value = err.response?.data?.error || '登录或注册失败，请稍后重试。'
    loading.value = false
  }
})
</script>

<template>
  <div class="min-h-screen w-full flex flex-col items-center justify-center bg-gray-50 p-4">
    <div class="max-w-md w-full bg-white rounded-2xl shadow-sm border border-gray-100 p-8 text-center">
      <div v-if="loading" class="flex flex-col items-center justify-center py-10">
        <div class="h-12 w-12 border-4 border-gray-200 border-t-gray-800 rounded-full animate-spin mb-6"></div>
        <h2 class="text-xl font-medium text-gray-800 mb-2">正在验证...</h2>
        <p class="text-sm text-gray-500">正在与 Linux DO 进行安全验证，请稍候</p>
      </div>
      
      <div v-else-if="error" class="flex flex-col items-center py-6">
        <div class="h-16 w-16 bg-red-50 rounded-full flex items-center justify-center mb-6">
          <svg class="h-8 w-8 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>
        <h2 class="text-xl font-medium text-gray-800 mb-3">登录失败</h2>
        <p class="text-sm text-gray-500 mb-8">{{ error }}</p>
        <Button @click="router.push('/login')" class="w-full h-11 bg-gray-900 hover:bg-black text-white rounded-xl">
          返回登录页面
        </Button>
      </div>
      
      <div v-else class="flex flex-col items-center py-6">
        <div class="h-16 w-16 bg-green-50 rounded-full flex items-center justify-center mb-6">
          <svg class="h-8 w-8 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h2 class="text-xl font-medium text-gray-800 mb-2">验证成功</h2>
        <p class="text-sm text-gray-500">正在为您跳转到控制台...</p>
      </div>
    </div>
  </div>
</template>
