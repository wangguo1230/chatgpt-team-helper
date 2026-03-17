<template>
  <RedeemShell maxWidth="max-w-screen-2xl">
    <div class="relative w-full">
      <div class="w-full">
        <div
          v-if="isRedirecting || isFetchingUser"
          class="w-full rounded-3xl bg-white/70 dark:bg-black/30 border border-white/40 dark:border-white/10 backdrop-blur-2xl p-6 flex flex-col items-center text-center gap-3 shadow-xl"
        >
          <div class="h-10 w-10 rounded-full bg-[#007AFF]/10 flex items-center justify-center">
            <span class="h-5 w-5 rounded-full border-2 border-[#007AFF] border-dashed animate-spin"></span>
          </div>
          <div class="space-y-1">
            <p class="text-lg font-semibold text-[#1d1d1f] dark:text-white">
              {{ isRedirecting ? '正在前往 Linux DO 授权' : '正在连接 Linux DO' }}
            </p>
            <p class="text-sm text-[#86868b]">请稍候，我们正在确认您的身份...</p>
          </div>
        </div>

        <div
          v-else-if="oauthError && !linuxDoUser"
          class="w-full rounded-3xl bg-white/70 dark:bg-black/30 border border-white/40 dark:border-white/10 backdrop-blur-2xl p-6 flex flex-col gap-4 shadow-xl"
        >
          <div class="flex items-center gap-3 text-left">
            <div class="h-10 w-10 rounded-full bg-[#FF3B30]/10 text-[#FF3B30] flex items-center justify-center">
              <AlertCircle class="h-5 w-5" />
            </div>
            <div>
              <p class="text-base font-semibold text-[#1d1d1f] dark:text-white">授权失败</p>
              <p class="text-sm text-[#86868b]">{{ oauthError }}</p>
            </div>
          </div>
          <AppleButton variant="secondary" class="w-full justify-center" @click="handleReauthorize">
            重新连接 Linux DO
          </AppleButton>
        </div>

        <template v-else-if="linuxDoUser">
          <div class="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between mb-10">
            <div class="space-y-3">
              <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-50/50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800 text-blue-600 dark:text-blue-400 backdrop-blur-md">
                <span class="relative flex h-2 w-2">
                  <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                  <span class="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
                </span>
                <span class="text-xs font-semibold tracking-wide">Linux DO 已连接</span>
              </div>
              <h1 class="text-4xl sm:text-5xl font-extrabold tracking-tight text-[#1d1d1f] dark:text-white font-display">
                <span class="text-transparent bg-clip-text bg-gradient-to-r from-blue-600 via-purple-600 to-pink-600 dark:from-blue-400 dark:via-purple-400 dark:to-pink-400">
                  栗子LDC
                </span>
              </h1>
              <p class="text-lg text-[#86868b] max-w-lg leading-relaxed">
                实时监控账号池状态，展示当前可用的共享账号及其负载情况。
              </p>
              <!-- 规则提示 -->
              <div v-if="rules" class="flex flex-wrap gap-2 text-xs mt-1">
                <span class="relative group cursor-help inline-flex items-center gap-1 px-2 py-1 rounded-full bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 border border-blue-100 dark:border-blue-800 overflow-visible">
                  <span>消耗 {{ creditCostRange }} Credit</span>
                  <HelpCircle class="h-3 w-3" />
                  
                  <!-- Tooltip -->
                  <div class="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-48 p-2 bg-gray-900/90 dark:bg-white/90 text-white dark:text-black text-xs rounded-lg shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-50 pointer-events-none text-left">
                    <div class="font-bold mb-1 border-b border-white/20 dark:border-black/10 pb-1">折扣规则 (按剩余天数)</div>
                    <div class="space-y-0.5">
                      <div class="flex justify-between"><span>&lt; 7天</span><span class="font-mono">2折</span></div>
                      <div class="flex justify-between"><span>7~14天</span><span class="font-mono">4折</span></div>
                      <div class="flex justify-between"><span>14~20天</span><span class="font-mono">6折</span></div>
                      <div class="flex justify-between"><span>20~25天</span><span class="font-mono">8折</span></div>
                      <div class="flex justify-between"><span>&gt; 25天</span><span class="font-mono">原价</span></div>
                    </div>
                    <div class="absolute bottom-[-4px] left-1/2 -translate-x-1/2 w-2 h-2 bg-gray-900/90 dark:bg-white/90 rotate-45"></div>
                  </div>
                </span>
                <span v-if="rules.dailyLimit" class="px-2 py-1 rounded-full bg-orange-50 dark:bg-orange-900/20 text-orange-600 dark:text-orange-400 border border-orange-100 dark:border-orange-800">
                  今日名额 {{ rules.todayBoardCount }}/{{ rules.dailyLimit }}
                </span>
                <span
                  v-if="rules.userDailyLimitEnabled && rules.userDailyLimit"
                  class="px-2 py-1 rounded-full bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 border border-emerald-100 dark:border-emerald-800"
                >
                  当日购买次数 {{ rules.userDailyLimitRemaining ?? 0 }}/{{ rules.userDailyLimit }}
                </span>
		                <RouterLink
		                  to="/redeem/account-recovery"
		                  class="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300 border border-purple-100 dark:border-purple-800 hover:bg-purple-100/70 dark:hover:bg-purple-900/30 transition-colors cursor-pointer"
		                >
		                  <span>封禁补录入口</span>
		                  <ExternalLink class="h-3 w-3" />
		                </RouterLink>
	              </div>
	            </div>

            <div class="flex flex-col sm:flex-row items-start sm:items-center gap-3 w-full sm:w-auto">
              <div class="hidden sm:block text-xs font-medium text-[#86868b] bg-gray-100/50 dark:bg-white/5 px-3 py-2 rounded-lg border border-black/5 dark:border-white/5">
                {{ userEmail || '未配置邮箱' }}
              </div>
              <div class="flex items-center gap-2 w-full sm:w-auto">
                <AppleButton variant="secondary" @click="openEmailDialog" :disabled="!sessionToken || savingEmail" class="flex-1 sm:flex-none justify-center">
                  {{ userEmail ? '修改邮箱' : '配置邮箱' }}
                </AppleButton>
                <AppleButton
                  variant="primary"
                  @click="loadOpenAccounts"
                  :loading="loading"
                  :disabled="openAccountsMaintenance || !sessionToken"
                  class="flex-1 sm:flex-none justify-center"
                >
                  {{ loading ? '刷新中' : '刷新列表' }}
                </AppleButton>
              </div>
            </div>
          </div>

          <div class="mt-8">
            <div
              v-if="loading"
              class="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4"
            >
              <div v-for="i in 8" :key="i" class="h-[220px] rounded-3xl bg-gray-100/50 dark:bg-white/5 animate-pulse"></div>
            </div>

	            <div
	              v-else-if="loadError"
	              class="w-full rounded-3xl bg-red-50/50 dark:bg-red-900/10 border border-red-100 dark:border-red-900/30 backdrop-blur-2xl p-8 flex flex-col items-center justify-center gap-4 text-center min-h-[300px]"
	            >
              <div class="h-14 w-14 rounded-full bg-red-100 dark:bg-red-900/30 text-red-500 flex items-center justify-center mb-2">
                <AlertCircle class="h-7 w-7" />
              </div>
              <div class="space-y-1">
                <p class="text-lg font-bold text-[#1d1d1f] dark:text-white">无法加载账号列表</p>
                <p class="text-[#86868b]">{{ loadError }}</p>
              </div>
              <AppleButton variant="secondary" class="mt-4" @click="loadOpenAccounts">
                重试
              </AppleButton>
	            </div>

              <div
                v-else-if="openAccountsMaintenance"
                class="w-full rounded-3xl bg-amber-50/50 dark:bg-amber-900/10 border border-amber-100 dark:border-amber-900/30 backdrop-blur-2xl p-8 flex flex-col items-center justify-center gap-4 text-center min-h-[300px]"
              >
                <div class="h-14 w-14 rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-300 flex items-center justify-center mb-2">
                  <AlertCircle class="h-7 w-7" />
                </div>
                <div class="space-y-1">
                  <p class="text-lg font-bold text-[#1d1d1f] dark:text-white">{{ openAccountsMaintenanceMessage }}</p>
                  <p class="text-[#86868b]">开放账号暂不可用，请稍后再试。</p>
                </div>
              </div>

	            <div
	              v-else-if="accounts.length === 0"
	              class="w-full rounded-3xl bg-white/60 dark:bg-black/25 border border-white/40 dark:border-white/10 backdrop-blur-2xl p-12 text-center flex flex-col items-center justify-center min-h-[300px]"
	            >
              <div class="h-20 w-20 rounded-full bg-gray-50 dark:bg-white/5 flex items-center justify-center mb-4">
                <Users class="h-10 w-10 text-gray-400" />
              </div>
              <p class="text-lg font-medium text-[#1d1d1f] dark:text-white">暂无开放账号</p>
              <p class="text-[#86868b] mt-1">当前没有可用的共享账号，请稍后再来看看。</p>
            </div>

            <div v-else class="grid gap-6 sm:gap-6 lg:gap-8 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              <AppleCard
                v-for="(item, index) in sortedAccounts"
                :key="item.id"
                variant="glass"
                padding="none"
                radius="xl"
                :interactive="true"
                :class="[
                  'group relative overflow-hidden transition-all duration-500 flex flex-col h-full',
                  isCardBoarded(item.id)
                    ? 'border-2 border-blue-500/80 dark:border-blue-400/80 shadow-[0_0_30px_rgba(59,130,246,0.2)] dark:shadow-[0_0_30px_rgba(96,165,250,0.15)] bg-blue-50/40 dark:bg-blue-500/5 ring-1 ring-blue-500/20'
                    : isCardReboard(item.id)
                      ? 'border border-amber-300/80 dark:border-amber-500/40 shadow-[0_0_24px_rgba(245,158,11,0.15)] dark:shadow-[0_0_24px_rgba(245,158,11,0.1)] bg-amber-50/40 dark:bg-amber-500/5 ring-1 ring-amber-300/30 dark:ring-amber-500/30'
                    : 'border border-white/60 dark:border-white/10 shadow-sm hover:shadow-xl'
                ]"
                :style="{ animationDelay: `${index * 50}ms` }"
              >
                <div class="relative p-5 flex flex-col h-full z-10">
                   <!-- Header: Icon + Info + Status -->
                   <div class="flex items-start gap-4 mb-5">
                      <!-- Icon -->
                      <div class="h-12 w-12 shrink-0 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 shadow-lg shadow-blue-500/30 text-white flex items-center justify-center transform group-hover:scale-105 transition-transform duration-500 ring-4 ring-white/10">
                        <span class="text-lg font-bold font-mono">{{ (item.emailPrefix || 'A').charAt(0).toUpperCase() }}</span>
                      </div>

                      <!-- Name & Meta -->
                      <div class="flex-1 min-w-0 pt-0.5">
                          <div class="flex items-center justify-between gap-2 mb-1">
                              <div class="flex items-center gap-2 min-w-0">
                                <h3 class="text-lg font-bold text-[#1d1d1f] dark:text-white font-display tracking-tight truncate group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                                  {{ item.emailPrefix || 'Unknown' }}
                                </h3>
                                
                                <!-- Discount Badge -->
                                <div
                                  v-if="getDiscountInfo(item.expireAt)"
                                  :class="[
                                    'shrink-0 px-1.5 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider shadow-sm flex items-center justify-center',
                                    getDiscountInfo(item.expireAt)!.color,
                                    getDiscountInfo(item.expireAt)!.text
                                  ]"
                                >
                                  {{ getDiscountInfo(item.expireAt)!.label }}
                                </div>

	                              </div>
                              
                              <!-- Status Badge -->
                              <div
                                v-if="isCardBoarded(item.id)"
                                class="shrink-0 px-2 py-0.5 rounded-full bg-blue-500 text-white text-[10px] font-bold uppercase tracking-wider shadow-lg shadow-blue-500/20 flex items-center gap-1"
                              >
                                <div class="w-1 h-1 rounded-full bg-white animate-pulse"></div>
                                已上车
                              </div>
                              <div
                                v-else-if="isCardReboard(item.id)"
                                class="shrink-0 px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-600 dark:text-amber-400 text-[10px] font-bold uppercase tracking-wider flex items-center gap-1"
                              >
                                <div class="w-1 h-1 rounded-full bg-amber-500"></div>
                                可重新上车
                              </div>
                              <div
     v-else
                                class="shrink-0 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 dark:text-emerald-400 text-[10px] font-bold uppercase tracking-wider flex items-center gap-1"
                              >
                                <div class="w-1 h-1 rounded-full bg-emerald-500"></div>
                                可加入
                              </div>
                          </div>

                          <div class="flex items-center gap-1 text-xs text-[#86868b] dark:text-gray-400 truncate">
                            <Calendar class="h-3.5 w-3.5 shrink-0" />
                            <span class="truncate">到期：{{ item.expireAt || '未设置' }}</span>
                          </div>
                          <div class="flex items-center gap-1 text-xs text-[#86868b] dark:text-gray-400 truncate mt-1">
                            <span class="truncate">消耗：{{ item.creditCost || rules?.creditCost || '未知' }} Credit</span>
                          </div>
                      </div>
                   </div>

                   <!-- Stats Row (Compact) -->
                   <div class="grid grid-cols-2 gap-3 mb-5">
                      <div class="bg-white/50 dark:bg-white/5 rounded-xl p-2.5 flex items-center gap-3 border border-black/5 dark:border-white/5 group/stat hover:bg-blue-50/50 dark:hover:bg-blue-500/10 transition-colors">
       <div class="h-8 w-8 rounded-lg bg-blue-50 dark:bg-blue-500/20 flex items-center justify-center text-blue-500 dark:text-blue-400 shrink-0">
                            <Users class="h-4 w-4" />
                         </div>
                         <div class="min-w-0">
                            <div class="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider leading-none mb-1 truncate">Joined</div>
                            <div class="text-lg font-bold text-[#1d1d1f] dark:text-white tabular-nums leading-none">{{ item.joinedCount }}</div>
                         </div>
                      </div>
                      <div class="bg-white/50 dark:bg-white/5 rounded-xl p-2.5 flex items-center gap-3 border border-black/5 dark:border-white/5 group/stat hover:bg-purple-50/50 dark:hover:bg-purple-500/10 transition-colors">
                         <div class="h-8 w-8 rounded-lg bg-purple-50 dark:bg-purple-500/20 flex items-center justify-center text-purple-500 dark:text-purple-400 shrink-0">
                            <Clock class="h-4 w-4" />
                         </div>
                         <div class="min-w-0">
                            <div class="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider leading-none mb-1 truncate">Remaining</div>
                            <div class="text-lg font-bold text-[#1d1d1f] dark:text-white tabular-nums leading-none">{{ item.remainingCodes }}</div>
                         </div>
                      </div>
                   </div>

                   <!-- Spacer -->
                   <div class="flex-1"></div>

	                   <!-- Action Button -->
                    <AppleButton
                      :variant="isCardBoarded(item.id) ? 'secondary' : 'premium'"
                      class="w-full justify-center h-9 text-sm"
                      :disabled="!sessionToken || selectingAccountId !== null || isCardBoarded(item.id)"
                      :loading="selectingAccountId === item.id"
                      @click.stop="board(item.id)"
                    >
                      <span v-if="selectingAccountId === item.id">上车中…</span>
                      <span v-else-if="!userEmail">先配置邮箱</span>
                      <span v-else-if="isCardReboard(item.id)">重新上车</span>
                      <span v-else-if="isCardBoarded(item.id)">已上车</span>
                      <span v-else>立即上车</span>
                    </AppleButton>

                    <!-- Decorative Elements (Removed for performance) -->
                    <!-- <div class="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-blue-500/10 to-transparent rounded-bl-[100px] pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div> -->
                    <!-- <div class="absolute -bottom-20 -right-20 w-64 h-64 bg-gradient-to-t from-blue-500/10 to-purple-500/5 rounded-full blur-3xl pointer-events-none group-hover:scale-125 transition-transform duration-700"></div> -->
                </div>
              </AppleCard>
            </div>
          </div>
        </template>
      </div>

      <div v-if="linuxDoUser" class="mt-12 space-y-5">
        <div class="flex items-end justify-between gap-3">
          <div class="space-y-1">
            <p class="text-xs font-semibold uppercase tracking-wider text-[#86868b]">LDC Shop</p>
            <h2 class="text-2xl font-bold text-[#1d1d1f] dark:text-white flex items-center gap-2">
              <Store class="h-5 w-5 text-blue-600 dark:text-blue-400" />
              LDC 商品小店
            </h2>
            <p class="text-sm text-[#86868b]">可选页面直出或邮件发送。下单后自动记录订单与交付详情。</p>
          </div>
          <AppleButton variant="secondary" :loading="shopLoading" :disabled="!sessionToken" @click="loadShopProducts">
            {{ shopLoading ? '刷新中' : '刷新商品' }}
          </AppleButton>
        </div>

        <div v-if="shopError" class="rounded-2xl border border-red-200 bg-red-50/70 dark:bg-red-900/20 dark:border-red-900/40 px-4 py-3 text-sm text-red-600 dark:text-red-300">
          {{ shopError }}
        </div>

        <div v-if="shopLoading" class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div v-for="i in 3" :key="`shop-loading-${i}`" class="h-[168px] rounded-2xl bg-gray-100/60 dark:bg-white/5 animate-pulse"></div>
        </div>

        <div v-else-if="!shopProducts.length" class="rounded-2xl border border-gray-200/70 dark:border-white/10 bg-white/70 dark:bg-black/20 px-6 py-10 text-center text-[#86868b]">
          暂无上架商品
        </div>

        <div v-else class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <AppleCard
            v-for="product in shopProducts"
            :key="product.productKey"
            variant="glass"
            padding="none"
            radius="xl"
            :interactive="true"
            class="border border-white/60 dark:border-white/10 overflow-hidden"
          >
            <div class="p-5 space-y-4">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <p class="text-base font-bold text-[#1d1d1f] dark:text-white truncate">{{ product.productName }}</p>
                  <p class="text-xs text-[#86868b] font-mono">{{ product.productKey }}</p>
                </div>
                <span class="px-2 py-1 text-xs rounded-full bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 font-semibold">
                  {{ product.deliveryMode }}
                </span>
              </div>

              <div class="grid grid-cols-2 gap-3 text-sm">
                <div class="rounded-xl bg-white/60 dark:bg-white/5 px-3 py-2 border border-black/5 dark:border-white/10">
                  <p class="text-[11px] uppercase tracking-wider text-[#86868b]">价格</p>
                  <p class="font-bold text-[#1d1d1f] dark:text-white">{{ product.amount }} Credit</p>
                </div>
                <div class="rounded-xl bg-white/60 dark:bg-white/5 px-3 py-2 border border-black/5 dark:border-white/10">
                  <p class="text-[11px] uppercase tracking-wider text-[#86868b]">库存</p>
                  <p class="font-bold" :class="Number(product.availableCount || 0) > 0 ? 'text-emerald-600 dark:text-emerald-300' : 'text-red-600 dark:text-red-300'">
                    {{ product.availableCount }}
                  </p>
                </div>
              </div>

              <AppleButton
                variant="premium"
                class="w-full justify-center"
                :disabled="!sessionToken || Number(product.availableCount || 0) <= 0 || Boolean(shopCreatingProductKey)"
                :loading="shopCreatingProductKey === product.productKey"
                @click="buyShopProduct(product)"
              >
                {{ Number(product.availableCount || 0) > 0 ? '立即购买' : '已售罄' }}
              </AppleButton>
            </div>
          </AppleCard>
        </div>

        <div v-if="shopCurrentOrder" class="rounded-2xl border border-gray-200/70 dark:border-white/10 bg-white/70 dark:bg-black/20 p-5 space-y-3">
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2">
              <Receipt class="h-4 w-4 text-[#86868b]" />
              <p class="font-semibold text-[#1d1d1f] dark:text-white">当前订单</p>
            </div>
            <span class="px-2 py-1 text-xs rounded-full bg-slate-100 text-slate-700 dark:bg-white/10 dark:text-gray-200">{{ shopCurrentOrder.status }}</span>
          </div>
          <div class="text-sm text-[#86868b] space-y-1">
            <p>订单号：<span class="font-mono">{{ shopCurrentOrder.orderNo }}</span></p>
            <p>商品：{{ shopCurrentOrder.productName }}</p>
            <p>金额：{{ shopCurrentOrder.amount }} Credit</p>
            <p>交付方式：{{ shopCurrentOrder.deliveryMode }}</p>
            <p v-if="shopCurrentOrder.deliveryEmailSentAt" class="flex items-center gap-1 text-emerald-600 dark:text-emerald-300">
              <MailCheck class="h-3.5 w-3.5" /> 邮件已发送：{{ shopCurrentOrder.deliveryEmailSentAt }}
            </p>
            <p v-if="shopCurrentOrder.deliveryError" class="text-red-600 dark:text-red-300">{{ shopCurrentOrder.deliveryError }}</p>
          </div>

          <div v-if="shopInlineContent" class="rounded-xl border border-emerald-200/70 dark:border-emerald-900/40 bg-emerald-50/70 dark:bg-emerald-900/20 p-4">
            <div class="flex items-center gap-2 text-emerald-700 dark:text-emerald-300 font-semibold text-sm mb-2">
              <Eye class="h-4 w-4" />
              页面交付内容
            </div>
            <pre class="whitespace-pre-wrap break-all text-xs text-emerald-900 dark:text-emerald-100 font-mono">{{ shopInlineContent }}</pre>
          </div>
        </div>

        <div class="rounded-2xl border border-gray-200/70 dark:border-white/10 bg-white/70 dark:bg-black/20 p-5 space-y-3">
          <div class="flex items-center gap-2">
            <Package class="h-4 w-4 text-[#86868b]" />
            <p class="font-semibold text-[#1d1d1f] dark:text-white">最近订单</p>
          </div>
          <div v-if="shopOrdersLoading" class="text-sm text-[#86868b]">加载中...</div>
          <div v-else-if="!shopOrders.length" class="text-sm text-[#86868b]">暂无订单</div>
          <div v-else class="space-y-2">
            <div
              v-for="order in shopOrders"
              :key="order.orderNo"
              class="rounded-xl border border-black/5 dark:border-white/10 bg-white/70 dark:bg-white/5 px-3 py-2 flex items-center justify-between gap-2"
            >
              <div class="min-w-0">
                <p class="text-sm font-medium text-[#1d1d1f] dark:text-white truncate">{{ order.productName }}</p>
                <p class="text-xs text-[#86868b] font-mono truncate">{{ order.orderNo }}</p>
              </div>
              <div class="flex items-center gap-2">
                <span class="text-xs px-2 py-1 rounded-full bg-slate-100 text-slate-700 dark:bg-white/10 dark:text-gray-200">{{ order.status }}</span>
                <AppleButton variant="secondary" class="h-8 px-3 text-xs" :disabled="!sessionToken" @click="fetchShopOrder(order.orderNo)">
                  查看
                </AppleButton>
              </div>
            </div>
          </div>
        </div>
      </div>

	      <LinuxDoUserPopover
	        v-if="linuxDoUser"
	        :user="linuxDoUser"
	        :avatar-url="avatarUrl"
	        :display-name="linuxDoDisplayName"
	        :trust-level-label="trustLevelLabel"
	        @reauthorize="handleReauthorize"
	      />

	      <Dialog v-model:open="showEmailDialog">
	        <DialogContent :showClose="false" class="sm:max-w-[360px] p-0 overflow-hidden rounded-[20px] border-0 shadow-2xl bg-transparent">
	          <div class="absolute inset-0 bg-white/90 dark:bg-[#1c1c1e]/90 backdrop-blur-md z-0"></div>

          <div class="relative z-10 flex flex-col items-center pt-6 pb-5 px-5 text-center">
            <div class="h-12 w-12 rounded-full bg-blue-50 dark:bg-blue-500/10 flex items-center justify-center mb-3 shadow-sm">
               <Mail class="h-6 w-6 text-blue-600 dark:text-blue-500" />
            </div>

            <DialogHeader class="mb-5 space-y-1.5 w-full">
              <DialogTitle class="text-[17px] font-semibold text-[#1d1d1f] dark:text-white">配置接收邮箱</DialogTitle>
              <DialogDescription class="text-[13px] text-gray-500 dark:text-gray-400 leading-normal mx-auto">
                请输入常用邮箱以接收邀请通知。保存前会进行一次确认。
              </DialogDescription>
            </DialogHeader>

            <div class="w-full space-y-3">
              <AppleInput
                v-model.trim="emailDraft"
                placeholder="name@example.com"
                type="email"
                variant="filled"
                :disabled="savingEmail"
                :error="emailError"
                clearable
                class="bg-transparent"
              />
            </div>
          </div>

          <div class="relative z-10 flex border-t border-gray-300/30 dark:border-white/10 mt-auto divide-x divide-gray-300/30 dark:divide-white/10">
            <button
              @click="showEmailDialog = false"
              :disabled="savingEmail"
              class="flex-1 py-3 text-[15px] font-medium text-[#007AFF] hover:bg-gray-100/50 dark:hover:bg-white/5 transition-colors disabled:opacity-50 active:bg-gray-200/50"
            >
              取消
            </button>
            <button
              @click="saveEmail"
              :disabled="!sessionToken || savingEmail"
              class="flex-1 py-3 text-[15px] font-semibold text-[#007AFF] hover:bg-blue-50/50 dark:hover:bg-blue-500/10 transition-colors disabled:opacity-50 active:bg-blue-100/50 relative"
            >
              <span v-if="savingEmail" class="absolute inset-0 flex items-center justify-center">
                <span class="h-4 w-4 border-2 border-[#007AFF] border-r-transparent rounded-full animate-spin"></span>
              </span>
              <span :class="{ 'opacity-0': savingEmail }">保存</span>
            </button>
          </div>
        </DialogContent>
      </Dialog>

	      <Dialog v-model:open="showEmailSaveConfirm">
	        <DialogContent :showClose="false" class="sm:max-w-[360px] p-0 overflow-hidden rounded-[20px] border-0 shadow-2xl bg-transparent">
	          <div class="absolute inset-0 bg-white/90 dark:bg-[#1c1c1e]/90 backdrop-blur-md z-0"></div>

          <div class="relative z-10 flex flex-col items-center pt-6 pb-5 px-5 text-center">
            <div class="h-12 w-12 rounded-full bg-blue-50 dark:bg-blue-500/10 flex items-center justify-center mb-3 shadow-sm">
              <Mail class="h-6 w-6 text-blue-600 dark:text-blue-500" />
            </div>

            <DialogHeader class="mb-3 space-y-1.5 w-full">
              <DialogTitle class="text-[17px] font-semibold text-[#1d1d1f] dark:text-white">确认保存邮箱？</DialogTitle>
            </DialogHeader>

            <div class="space-y-3 text-[13px] text-gray-600 dark:text-gray-300 leading-relaxed px-1">
              <p>
                将保存为：
                <span class="font-mono text-[#1d1d1f] dark:text-white break-all">{{ emailDraft || '-' }}</span>
              </p>
            </div>
          </div>

          <div class="relative z-10 flex border-t border-gray-300/30 dark:border-white/10 mt-auto divide-x divide-gray-300/30 dark:divide-white/10">
            <button
              @click="cancelEmailSaveConfirm"
              :disabled="savingEmail"
              class="flex-1 py-3 text-[15px] font-medium text-[#007AFF] hover:bg-gray-100/50 dark:hover:bg-white/5 transition-colors disabled:opacity-50 active:bg-gray-200/50"
            >
              返回修改
            </button>
            <button
              @click="confirmEmailSave"
              :disabled="!sessionToken || savingEmail"
              class="flex-1 py-3 text-[15px] font-semibold text-[#007AFF] hover:bg-blue-50/50 dark:hover:bg-blue-500/10 transition-colors disabled:opacity-50 active:bg-blue-100/50 relative"
            >
              <span v-if="savingEmail" class="absolute inset-0 flex items-center justify-center">
                <span class="h-4 w-4 border-2 border-[#007AFF] border-r-transparent rounded-full animate-spin"></span>
              </span>
              <span :class="{ 'opacity-0': savingEmail }">确认</span>
            </button>
          </div>
        </DialogContent>
      </Dialog>

	      <Dialog v-model:open="showNoWarrantySwitchDialog">
	        <DialogContent :showClose="false" class="sm:max-w-[360px] p-0 overflow-hidden rounded-[20px] border-0 shadow-2xl bg-transparent">
	          <div class="absolute inset-0 bg-white/90 dark:bg-[#1c1c1e]/90 backdrop-blur-md z-0"></div>

          <div class="relative z-10 flex flex-col items-center pt-6 pb-5 px-5 text-center">
            <div class="h-12 w-12 rounded-full bg-blue-50 dark:bg-blue-500/10 flex items-center justify-center mb-3 shadow-sm">
              <AlertCircle class="h-6 w-6 text-blue-600 dark:text-blue-500" />
            </div>

            <DialogHeader class="mb-3 space-y-1.5 w-full">
              <DialogTitle class="text-[17px] font-semibold text-[#1d1d1f] dark:text-white">当前订阅无质保</DialogTitle>
            </DialogHeader>

            <DialogDescription class="text-[13px] text-gray-600 dark:text-gray-300 leading-relaxed px-1">
              {{ noWarrantySwitchMessage }}
            </DialogDescription>
          </div>

          <div class="relative z-10 flex border-t border-gray-300/30 dark:border-white/10 mt-auto divide-x divide-gray-300/30 dark:divide-white/10">
            <button
              @click="closeNoWarrantySwitchDialog"
              class="flex-1 py-3 text-[15px] font-medium text-[#007AFF] hover:bg-gray-100/50 dark:hover:bg-white/5 transition-colors active:bg-gray-200/50"
            >
              取消
            </button>
            <button
              @click="goToPurchase"
              class="flex-1 py-3 text-[15px] font-semibold text-[#007AFF] hover:bg-blue-50/50 dark:hover:bg-blue-500/10 transition-colors active:bg-blue-100/50"
            >
              去下单
            </button>
          </div>
        </DialogContent>
      </Dialog>

	    </div>
	  </RedeemShell>
	</template>

	<script setup lang="ts">
		import { AlertCircle, Mail, Users, Clock, Calendar, HelpCircle, ExternalLink, Store, Package, MailCheck, Eye, Receipt } from 'lucide-vue-next'
	import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
  import { useRouter } from 'vue-router'
	import AppleButton from '@/components/ui/apple/Button.vue'
	import AppleCard from '@/components/ui/apple/Card.vue'
	import AppleInput from '@/components/ui/apple/Input.vue'
	import RedeemShell from '@/components/RedeemShell.vue'
	import LinuxDoUserPopover from '@/components/LinuxDoUserPopover.vue'
	import { useLinuxDoAuthSession } from '@/composables/useLinuxDoAuthSession'
	import {
    creditService,
    openAccountsService,
    linuxDoUserService,
    type OpenAccountItem,
    type OpenAccountsResponse,
    type LdcShopProduct,
    type LdcShopOrder
  } from '@/services/api'
		import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
	import { useToast } from '@/components/ui/toast'
  import { useAppConfigStore } from '@/stores/appConfig'

	const accounts = ref<OpenAccountItem[]>([])
	const loading = ref(false)
	const loadError = ref('')
  const boardError = ref('')
  const serverMaintenance = ref(false)
  const serverMaintenanceMessage = ref('')
	const userEmail = ref('')
	const currentOpenAccountId = ref<number | null>(null)
const currentOpenAccountEmail = ref('')
const showEmailDialog = ref(false)
const showEmailSaveConfirm = ref(false)
const showNoWarrantySwitchDialog = ref(false)
const emailDraft = ref('')
const emailError = ref('')
const savingEmail = ref(false)
const selectingAccountId = ref<number | null>(null)
const pendingCreditOrderNo = ref<string | null>(null)
const pendingCreditAccountId = ref<number | null>(null)
const creditPollingTimer = ref<number | null>(null)
const creditPollingInFlight = ref(false)
const rules = ref<OpenAccountsResponse['rules'] | null>(null)
const shopProducts = ref<LdcShopProduct[]>([])
const shopLoading = ref(false)
const shopError = ref('')
const shopCreatingProductKey = ref('')
const shopCurrentOrder = ref<LdcShopOrder | null>(null)
const shopPendingOrderNo = ref<string | null>(null)
const shopPollingTimer = ref<number | null>(null)
const shopPollingInFlight = ref(false)
const shopOrders = ref<LdcShopOrder[]>([])
const shopOrdersLoading = ref(false)

const creditCostRange = computed(() => {
  if (!rules.value?.creditCost) return '...'
  const base = parseFloat(rules.value.creditCost)
  if (isNaN(base)) return rules.value.creditCost
  // 简单的去除多余零的格式化
  const fmt = (n: number) => parseFloat(n.toFixed(2)).toString()
  return `${fmt(base * 0.2)} ~ ${fmt(base)}`
})

const normalizeEmailValue = (value: string | null | undefined) => String(value || '').trim().toLowerCase()

const needsReboardCurrentAccount = computed(() => {
  if (!currentOpenAccountId.value) return false
  const onboardedEmail = normalizeEmailValue(currentOpenAccountEmail.value)
  const currentEmail = normalizeEmailValue(userEmail.value)
  if (!onboardedEmail || !currentEmail) return false
  return onboardedEmail !== currentEmail
})

const isCardBoarded = (accountId: number) => {
  return currentOpenAccountId.value === accountId && !needsReboardCurrentAccount.value
}

const isCardReboard = (accountId: number) => {
  return currentOpenAccountId.value === accountId && needsReboardCurrentAccount.value
}

const sortedAccounts = computed(() => {
  const list = accounts.value || []
  const currentId = needsReboardCurrentAccount.value ? null : currentOpenAccountId.value
  if (!currentId) return list
  const current = list.find(item => item.id === currentId)
  if (!current) return list
  return [current, ...list.filter(item => item.id !== currentId)]
})

const shopInlineContent = computed(() => {
  const content = shopCurrentOrder.value?.delivery?.inlineContent
  return String(content || '').trim()
})

const {
  linuxDoUser,
  sessionToken,
  oauthError,
  isRedirecting,
  isFetchingUser,
  avatarUrl,
  trustLevelLabel,
  linuxDoDisplayName,
  handleReauthorize,
} = useLinuxDoAuthSession({ redirectRouteName: 'linux-do-open-accounts' })

	const { success: showSuccessToast, error: showErrorToast, info: showInfoToast } = useToast()
  const router = useRouter()
  const appConfigStore = useAppConfigStore()
  const noWarrantySwitchMessage = ref('当前订阅账号无质保，需重新下单')

  const openAccountsMaintenance = computed(() => serverMaintenance.value)
  const openAccountsMaintenanceMessage = computed(() => {
    return serverMaintenanceMessage.value || appConfigStore.openAccountsMaintenanceMessage || '平台维护中'
  })

	const validateEmail = (value: string) => {
	  const trimmed = String(value || '').trim()
	  if (!trimmed) return ''
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRegex.test(trimmed)) return '请输入有效的邮箱格式'
  return ''
}

const getDiscountInfo = (expireAtStr?: string | null) => {
  if (!expireAtStr) return null

  const expireDate = new Date(expireAtStr)
  if (isNaN(expireDate.getTime())) return null

  const now = new Date()
  const diffTime = expireDate.getTime() - now.getTime()
  const diffDays = diffTime / (1000 * 60 * 60 * 24)

  if (diffDays < 0) return null

  if (diffDays < 7) {
    return { label: '2折', color: 'bg-rose-500', text: 'text-white' }
  } else if (diffDays < 14) {
    return { label: '4折', color: 'bg-orange-500', text: 'text-white' }
  } else if (diffDays < 20) {
    return { label: '6折', color: 'bg-amber-500', text: 'text-white' }
  } else if (diffDays < 25) {
    return { label: '8折', color: 'bg-emerald-500', text: 'text-white' }
  }

  return null
}

const loadMe = async () => {
  if (!linuxDoUser.value) return
  if (!sessionToken.value) return
  try {
    const me = await linuxDoUserService.getMe(sessionToken.value)
    userEmail.value = me.email || ''
    currentOpenAccountId.value = me.currentOpenAccountId ?? null
    currentOpenAccountEmail.value = me.currentOpenAccountEmail || ''
    emailDraft.value = userEmail.value
  } catch (error: any) {
    console.warn('读取 Linux DO 用户邮箱失败:', error?.response?.data?.error || error?.message || error)
  }
}

	const loadOpenAccounts = async () => {
	  if (!linuxDoUser.value) return
	  if (!sessionToken.value) return
	  loading.value = true
	  loadError.value = ''
    boardError.value = ''
    serverMaintenance.value = false
    serverMaintenanceMessage.value = ''
	  try {
	    const response = await openAccountsService.list(sessionToken.value)
	    accounts.value = response.items || []
	    rules.value = response.rules || null
	  } catch (error: any) {
      const code = error?.response?.data?.code
      const message = error?.response?.data?.error || '加载失败，请稍后重试'
      if (code === 'OPEN_ACCOUNTS_MAINTENANCE') {
        accounts.value = []
        rules.value = null
        loadError.value = ''
        serverMaintenance.value = true
        serverMaintenanceMessage.value = message || '平台维护中'
        return
      }
	    loadError.value = message
	  } finally {
	    loading.value = false
	  }
	}

const loadShopProducts = async () => {
  if (!sessionToken.value) return
  shopLoading.value = true
  shopError.value = ''
  try {
    const response = await openAccountsService.shopListProducts(sessionToken.value)
    shopProducts.value = Array.isArray(response.products) ? response.products : []
  } catch (error: any) {
    shopError.value = error?.response?.data?.error || '加载商品失败，请稍后重试'
  } finally {
    shopLoading.value = false
  }
}

const loadShopOrders = async () => {
  if (!sessionToken.value) return
  shopOrdersLoading.value = true
  try {
    const response = await openAccountsService.shopListOrders(sessionToken.value, { page: 1, pageSize: 10 })
    shopOrders.value = Array.isArray(response.orders) ? response.orders : []
  } catch {
    // ignore
  } finally {
    shopOrdersLoading.value = false
  }
}

const stopShopPolling = () => {
  if (shopPollingTimer.value) {
    window.clearInterval(shopPollingTimer.value)
    shopPollingTimer.value = null
  }
  shopPendingOrderNo.value = null
}

const fetchShopOrder = async (orderNo: string, options?: { silent?: boolean }) => {
  if (!sessionToken.value || !orderNo) return
  try {
    const response = await openAccountsService.shopGetOrder(sessionToken.value, orderNo)
    shopCurrentOrder.value = response.order || null
    await loadShopOrders()
  } catch (error: any) {
    if (!options?.silent) {
      showErrorToast(error?.response?.data?.error || '查询订单失败')
    }
  }
}

const pollShopOrder = async () => {
  if (!sessionToken.value) return
  if (!shopPendingOrderNo.value) return
  if (shopPollingInFlight.value) return

  shopPollingInFlight.value = true
  try {
    const response = await openAccountsService.shopGetOrder(sessionToken.value, shopPendingOrderNo.value)
    const order = response.order
    shopCurrentOrder.value = order || null
    await loadShopOrders()

    if (!order) return
    if (order.status === 'delivered') {
      showSuccessToast('商品已交付')
      stopShopPolling()
      await loadShopProducts()
      return
    }
    if (['failed', 'expired', 'refunded', 'delivery_failed'].includes(order.status)) {
      showErrorToast(order.deliveryError || `订单状态异常：${order.status}`)
      stopShopPolling()
      await loadShopProducts()
      return
    }
  } catch (error: any) {
    showErrorToast(error?.response?.data?.error || '查询订单失败')
    stopShopPolling()
  } finally {
    shopPollingInFlight.value = false
  }
}

const startShopPolling = (orderNo: string) => {
  if (typeof window === 'undefined') return
  stopShopPolling()
  shopPendingOrderNo.value = orderNo
  void pollShopOrder()
  shopPollingTimer.value = window.setInterval(() => {
    void pollShopOrder()
  }, 3000)
}

const buyShopProduct = async (product: LdcShopProduct) => {
  if (!sessionToken.value) return
  if (!product?.productKey) return
  if (Number(product.availableCount || 0) <= 0) {
    showErrorToast('该商品已售罄')
    return
  }

  shopCreatingProductKey.value = product.productKey
  shopError.value = ''
  try {
    const response = await openAccountsService.shopCreateOrder(sessionToken.value, { productKey: product.productKey })
    showInfoToast(response.reused ? '已复用未支付订单，请完成授权' : '订单已创建，请在新窗口完成 Credit 授权')
    openCreditPayPage(response.creditOrder)
    startShopPolling(response.orderNo)
    await fetchShopOrder(response.orderNo, { silent: true })
    await loadShopProducts()
  } catch (error: any) {
    const message = error?.response?.data?.error || '创建订单失败，请稍后重试'
    shopError.value = message
    showErrorToast(message)
  } finally {
    shopCreatingProductKey.value = ''
  }
}

watch([linuxDoUser, sessionToken], ([user, token]) => {
  if (!user) return
  if (!token) {
    handleReauthorize()
    return
  }
  loadOpenAccounts()
  loadMe()
  loadShopProducts()
  loadShopOrders()
})

const openEmailDialog = () => {
  emailError.value = ''
  emailDraft.value = userEmail.value
  showEmailDialog.value = true
}

const cancelEmailSaveConfirm = () => {
  showEmailSaveConfirm.value = false
  showEmailDialog.value = true
}

const openNoWarrantySwitchDialog = (message?: string) => {
  noWarrantySwitchMessage.value = message || '当前订阅账号无质保，需重新下单'
  showNoWarrantySwitchDialog.value = true
}

const closeNoWarrantySwitchDialog = () => {
  showNoWarrantySwitchDialog.value = false
}

const goToPurchase = () => {
  showNoWarrantySwitchDialog.value = false
  router.push('/purchase')
}

const doSaveEmail = async () => {
  if (!sessionToken.value) return
  try {
    const me = await linuxDoUserService.updateEmail(sessionToken.value, emailDraft.value)
    userEmail.value = me.email || ''
    currentOpenAccountId.value = me.currentOpenAccountId ?? null
    currentOpenAccountEmail.value = me.currentOpenAccountEmail || ''
    showEmailDialog.value = false
    showEmailSaveConfirm.value = false
    showSuccessToast('邮箱已更新')
  } catch (error: any) {
    emailError.value = error.response?.data?.error || '保存失败，请稍后重试'
    showEmailSaveConfirm.value = false
  }
}

const saveEmail = async () => {
  if (!sessionToken.value) return
  emailError.value = validateEmail(emailDraft.value)
  if (emailError.value) return

  const oldNormalized = String(userEmail.value || '').trim().toLowerCase()
  const newNormalized = String(emailDraft.value || '').trim().toLowerCase()
  if (oldNormalized !== newNormalized) {
    showEmailDialog.value = false
    showEmailSaveConfirm.value = true
    return
  }

  savingEmail.value = true
  try {
    await doSaveEmail()
  } finally {
    savingEmail.value = false
  }
}

const confirmEmailSave = async () => {
  if (!sessionToken.value) return
  emailError.value = validateEmail(emailDraft.value)
  if (emailError.value) return
  savingEmail.value = true
  try {
    await doSaveEmail()
  } finally {
    savingEmail.value = false
  }
}

watch(emailDraft, () => {
  if (emailError.value) emailError.value = validateEmail(emailDraft.value)
})

const stopCreditPolling = () => {
  if (creditPollingTimer.value) {
    window.clearInterval(creditPollingTimer.value)
    creditPollingTimer.value = null
  }
  pendingCreditOrderNo.value = null
  pendingCreditAccountId.value = null
}

const openCreditPayPage = (creditOrder?: { payUrl?: string | null; payRequest?: { method?: 'POST' | 'GET'; url: string; fields?: Record<string, string> } }) => {
  if (typeof window === 'undefined') return
  const payUrl = creditOrder?.payUrl ? String(creditOrder.payUrl) : ''
  if (payUrl) {
    console.info('[OpenAccounts][Credit] open payUrl', { payUrl })
    window.open(payUrl, '_blank')
    return
  }

  const request = creditOrder?.payRequest
  if (!request?.url) return

  const fields = request.fields || {}
  console.info('[OpenAccounts][Credit] submit pay form', {
    method: request.method === 'GET' ? 'GET' : 'POST',
    url: request.url,
    payload: {
      pid: fields.pid,
      type: fields.type,
      out_trade_no: fields.out_trade_no,
      name: fields.name,
      money: fields.money,
      notify_url: fields.notify_url,
      device: fields.device,
      sign_type: fields.sign_type,
      signPrefix: typeof fields.sign === 'string' ? fields.sign.slice(0, 8) : null,
      signLength: typeof fields.sign === 'string' ? fields.sign.length : null
    }
  })

  const form = document.createElement('form')
  form.method = request.method === 'GET' ? 'GET' : 'POST'
  form.action = request.url
  form.target = '_blank'
  form.style.display = 'none'

  Object.entries(fields).forEach(([name, value]) => {
    const input = document.createElement('input')
    input.type = 'hidden'
    input.name = name
    input.value = String(value ?? '')
    form.appendChild(input)
  })

  document.body.appendChild(form)
  form.submit()
  form.remove()
}

	const pollCreditOrder = async () => {
	  if (!sessionToken.value) return
	  if (!pendingCreditOrderNo.value) return
	  if (!pendingCreditAccountId.value) return
	  if (creditPollingInFlight.value) return

  creditPollingInFlight.value = true
  try {
    const response = await creditService.getOrder(sessionToken.value, pendingCreditOrderNo.value)
    const order = response.order

    if (order.status === 'paid') {
      const result = await openAccountsService.board(sessionToken.value, pendingCreditAccountId.value, {
        creditOrderNo: order.orderNo
      })

	      if ('requiresCredit' in result) {
	        showErrorToast('Credit 订单状态异常，请刷新后重试')
	        stopCreditPolling()
	        return
      }

      currentOpenAccountId.value = result.currentOpenAccountId
      currentOpenAccountEmail.value = userEmail.value || ''
      await loadOpenAccounts()
      await loadMe()
      showSuccessToast(result.message || '上车成功')
      stopCreditPolling()
      return
    }

    if (['failed', 'expired', 'refunded'].includes(order.status)) {
      showErrorToast(order.actionMessage || order.refundMessage || `Credit 订单状态异常：${order.status}`)
      stopCreditPolling()
    }
  } catch (error: any) {
    const message = error?.response?.data?.error || error?.message || '查询 Credit 订单失败'
    const code = error?.response?.data?.code
    const autoRefunded = Boolean(error?.response?.data?.autoRefunded)
    if (error?.response?.data?.code === 'OPEN_ACCOUNTS_MAINTENANCE') {
      serverMaintenance.value = true
      serverMaintenanceMessage.value = message
    }
    if (code === 'NO_WARRANTY_ORDER') {
      openNoWarrantySwitchDialog(message)
      stopCreditPolling()
      return
    }
    if (code === 'OPEN_ACCOUNTS_INVITE_DOMAIN_RISK' && autoRefunded) {
      const text = /自动退回|自动退款/.test(message) ? message : `${message}（积分已自动退回）`
      showErrorToast(text)
      stopCreditPolling()
      return
    }
    showErrorToast(message)
    stopCreditPolling()
  } finally {
	    creditPollingInFlight.value = false
	  }
}

const startCreditPolling = (orderNo: string, accountId: number) => {
  if (typeof window === 'undefined') return
  stopCreditPolling()
  pendingCreditOrderNo.value = orderNo
  pendingCreditAccountId.value = accountId
  void pollCreditOrder()
  creditPollingTimer.value = window.setInterval(() => {
    void pollCreditOrder()
  }, 3000)
}

const doBoard = async (accountId: number) => {
  if (!sessionToken.value) return
  if (!userEmail.value) {
    showErrorToast('请先配置接收邮箱')
    openEmailDialog()
    return
  }
  selectingAccountId.value = accountId
  loadError.value = ''
  try {
    const result = await openAccountsService.board(sessionToken.value, accountId)

	    if ('requiresCredit' in result) {
	      showInfoToast(result.message || '请在新窗口完成 Credit 授权')
	      openCreditPayPage(result.creditOrder)
	      startCreditPolling(result.creditOrder.orderNo, accountId)
	      return
    }

    currentOpenAccountId.value = result.currentOpenAccountId
    currentOpenAccountEmail.value = userEmail.value || ''
    await loadOpenAccounts()
    await loadMe()
    showSuccessToast(result.message || '上车成功')
  } catch (error: any) {
      const code = error?.response?.data?.code
      const message = error.response?.data?.error || error?.message || '上车失败，请稍后重试'
      const autoRefunded = Boolean(error?.response?.data?.autoRefunded)
      if (code === 'OPEN_ACCOUNTS_MAINTENANCE') {
        accounts.value = []
        rules.value = null
        loadError.value = ''
        serverMaintenance.value = true
        serverMaintenanceMessage.value = message
        return
      }
      if (code === 'NO_WARRANTY_ORDER') {
        loadError.value = ''
        openNoWarrantySwitchDialog(message)
        return
      }
      if (code === 'OPEN_ACCOUNTS_INVITE_DOMAIN_RISK' && autoRefunded) {
        boardError.value = /自动退回|自动退款/.test(message) ? message : `${message}（积分已自动退回）`
        showErrorToast(boardError.value)
        return
      }
      boardError.value = message
      showErrorToast(message)
    } finally {
      selectingAccountId.value = null
    }
  }

const board = async (accountId: number) => {
  await doBoard(accountId)
}

onMounted(() => {
  // useLinuxDoAuthSession 会处理授权流程，这里只需等待即可
})

onBeforeUnmount(() => {
  stopCreditPolling()
  stopShopPolling()
})
</script>
