# LDC 商品小店完整功能文档（前后端 + 配置 + 闭环）

本文档用于说明 `/redeem/open-accounts` 下新增的 **LDC 商品小店**能力，覆盖前端、后端、数据结构、环境变量、部署与验收。

## 1. 功能目标与范围

LDC 商品小店用于销售可文本交付的商品（如卡密、账号文本、密钥、卡片资料等），具备以下能力：

- 管理员可在后台定义商品、价格、交付方式。
- 管理员可维护商品条目池（库存内容）。
- 用户在前台完成 Linux DO Credit 支付后，系统自动交付（页面展示/邮件发送）。
- 系统完整记录订单链路与交付明细，形成可追溯闭环。
- 支持 `redeem_api` 自动发卡模式：管理员批量录入兑换码（一行一个），支付后自动请求发卡接口并完成交付。

非目标：

- 不改动原有 `code` 类商品兑换码购买逻辑。
- 不引入新支付网关，复用现有 Linux DO Credit。

## 2. 当前实现状态（前后端都已具备）

### 2.1 前端能力

- 用户侧页面：`/redeem/open-accounts`
  - 展示小店商品列表（价格、库存、交付方式）。
  - 下单并拉起 Credit 支付。
  - 轮询订单状态并展示交付结果。
  - 支持页面内查看交付内容（`deliveryMode=inline/both`）。
  - 展示最近订单记录。
- 管理侧页面：`/admin/settings` -> `支付商品管理`
  - 新增商品分类 `category=code|ldc_shop`。
  - 新增交付方式 `deliveryMode=inline|email|both`。
  - 新增交付来源 `fulfillmentMode=item_pool|redeem_api`。
  - 对 `ldc_shop` 商品支持两类库存管理：
    - `item_pool`：条目池（增删改查、状态管理）。
    - `redeem_api`：兑换码池（批量导入、上下线、删除）。

### 2.2 后端能力

- 用户接口：`/api/open-accounts/shop/*`
  - 商品列表、创建订单、订单列表、订单详情（含支付状态同步 + 自动交付）。
- 管理接口：`/api/admin/purchase-products*`
  - 商品配置扩展（`category/deliveryMode`）。
  - `ldc_shop` 条目池 CRUD（仅 `fulfillmentMode=item_pool` 可用）。
  - `ldc_shop` 兑换码池 CRUD（仅 `fulfillmentMode=redeem_api` 可用）。
  - 兑换码池导入时 `provider` 必须与商品 `redeemProvider` 一致（当前支持 `yyl`）。
- 支付链路
  - 复用 `credit_orders`，`scene=ldc_shop_purchase`。
- 邮件链路
  - 新增 LDC 小店交付邮件发送逻辑。

## 3. 架构总览

1. 管理员在后台创建 `ldc_shop` 商品并录入条目库存。  
2. 用户在前台发起购买，后端锁定 1 条库存为 `reserved`（`item_pool` 锁条目；`redeem_api` 锁兑换码）。  
3. 后端创建 `credit_orders` + `ldc_shop_orders`。  
4. 用户完成 Credit 支付后，后端会在 `Credit notify` 异步回调中主动同步并触发交付；订单查询接口作为兜底懒同步。  
5. 若支付成功，执行交付：
   - `inline`：交付内容写入订单并前台可见。
   - `email`：发送邮件并记录发送结果。
   - `both`：同时满足以上两项才算完成。  
6. 库存状态流转：
   - `item_pool`：`reserved -> sold`
   - `redeem_api`：`reserved -> redeemed | invalid | failed`
7. 订单状态进入 `delivered`；若失败则 `delivery_failed` 并保留错误信息。  
8. 支付失败/过期/退款时，自动释放 `reserved` 库存回 `available`。
9. 若用户已有同商品待支付订单，系统按“订单自身的 `fulfillment_mode`”校验其预留资源后复用，避免商品配置变更导致误复用或误丢弃。

## 4. 数据模型与状态机

## 4.1 商品表（`purchase_products`）

新增字段：

- `category`：`code | ldc_shop`（默认 `code`）
- `delivery_mode`：`inline | email | both`（默认 `email`）
- `fulfillment_mode`：`item_pool | redeem_api`（默认 `item_pool`）
- `redeem_provider`：发卡提供商（当前默认 `yyl`）

说明：

- `code` 类商品走兑换码库存。
- `ldc_shop` 类商品走条目池库存。

## 4.2 条目池（`purchase_product_items`）

核心字段：

- `product_key`
- `content`（实际交付内容）
- `preview_text`
- `status`：`available | reserved | sold | offline`
- `reserved_order_no` / `sold_order_no`

状态流转：

- `available -> reserved -> sold`
- `available <-> offline`
- `reserved -> available`（订单失败/过期/退款释放）

## 4.3 小店订单（`ldc_shop_orders`）

核心字段：

- 订单主键：`order_no`
- 用户：`uid / username / user_email`
- 商品快照：`product_key / product_name / amount / delivery_mode`
- 交付来源：`fulfillment_mode / redeem_provider`
- 库存关联：`item_id / redeem_code_id / item_preview`
- 交付字段：`delivery_inline_content`、`delivery_email_to`、`delivery_email_sent_at`、`delivery_error`
- 状态：`created | pending_payment | paid | delivered | delivery_failed | failed | expired | refunded`

## 4.4 自动发卡兑换码池（`ldc_shop_redeem_codes`）

核心字段：

- `product_key / redeem_code / provider`
- `status`：`available | reserved | redeemed | invalid | failed | offline`
- `reserved_order_no / used_order_no`
- `card_snapshot / last_error / attempt_count`

## 4.5 自动发卡尝试日志（`ldc_shop_delivery_attempts`）

记录每次调用阶段（`validate/redeem_submit/task_status/email_delivery`）的请求与结果，便于追溯与排障。

## 5. 对外接口（后端）

## 5.1 用户侧接口（需 `x-linuxdo-token`）

统一前置：

- 功能开关 `openAccounts` 必须开启。
- Header 必须包含 `x-linuxdo-token`。

### 1) 获取商品列表

- `GET /api/open-accounts/shop/products`
- 返回：仅 `category=ldc_shop` 且上架商品，并附带实时 `availableCount`。

### 2) 创建订单

- `POST /api/open-accounts/shop/orders`
- Body：

```json
{
  "productKey": "ldc-card-demo"
}
```

- 返回：`orderNo` + `creditOrder.payRequest`（前端据此拉起支付页）。
- 特性：
  - 同用户同商品存在未过期待支付单时复用旧订单（避免重复占库存）。
  - 自动锁定 1 条可用库存为 `reserved`。

### 3) 查询订单列表

- `GET /api/open-accounts/shop/orders?page=1&pageSize=20`

### 4) 查询单个订单（核心闭环入口）

- `GET /api/open-accounts/shop/orders/:orderNo`
- 该接口会触发：
  - 支付状态懒同步（节流）。
  - 已支付订单自动交付。
  - 失败场景自动释放库存。

## 5.2 管理侧接口（需管理员 JWT）

商品管理：

- `GET /api/admin/purchase-products`
- `POST /api/admin/purchase-products`
- `PATCH /api/admin/purchase-products/:productKey`
- `DELETE /api/admin/purchase-products/:productKey`

条目池管理（仅 `ldc_shop`）：

- `GET /api/admin/purchase-products/:productKey/items`
- `POST /api/admin/purchase-products/:productKey/items`
- `PATCH /api/admin/purchase-products/:productKey/items/:itemId`
- `DELETE /api/admin/purchase-products/:productKey/items/:itemId`

兑换码池管理（仅 `ldc_shop + fulfillmentMode=redeem_api`）：

- `GET /api/admin/purchase-products/:productKey/redeem-codes`
- `POST /api/admin/purchase-products/:productKey/redeem-codes/import`
- `PATCH /api/admin/purchase-products/:productKey/redeem-codes/:codeId`
- `DELETE /api/admin/purchase-products/:productKey/redeem-codes/:codeId`

补充约束：

- 兑换码导入接口 `provider` 必须是受支持值（当前仅 `yyl`）。
- 兑换码导入接口 `provider` 必须与商品 `redeemProvider` 一致，避免导入后无法被该商品消费。

创建商品请求示例：

```json
{
  "productKey": "ldc-card-demo",
  "productName": "LDC 卡片示例",
  "amount": "20.00",
  "serviceDays": 30,
  "orderType": "warranty",
  "category": "ldc_shop",
  "deliveryMode": "both",
  "codeChannels": "",
  "isActive": true,
  "sortOrder": 0
}
```

## 6. 环境变量说明（它是干嘛的）

环境变量用于将“可变配置”和“敏感信息”从代码中分离出来，便于：

- 不改代码即可调整行为（价格、阈值、轮询节流、调度等）。
- 区分开发/测试/生产环境配置。
- 安全管理密钥（OAuth、支付密钥、SMTP 账号密码）。

与 LDC 小店相关的关键变量如下：

| 变量名 | 默认值 | 作用 | 是否必填 |
|---|---:|---|---|
| `OPEN_ACCOUNTS_ENABLED` | `true` | 开放账号主功能开关，关闭后小店不可用 | 否 |
| `LINUXDO_CLIENT_ID` | 无 | Linux DO OAuth 客户端 ID | 是（生产） |
| `LINUXDO_CLIENT_SECRET` | 无 | Linux DO OAuth 密钥 | 是（生产） |
| `LINUXDO_REDIRECT_URI` | 无 | Linux DO OAuth 回调地址 | 是（生产） |
| `LINUXDO_CREDIT_BASE_URL` | `https://credit.linux.do/epay` | Credit 网关地址 | 否 |
| `LINUXDO_CREDIT_PID` | 无 | Credit 商户 PID | 是（小店下单） |
| `LINUXDO_CREDIT_KEY` | 无 | Credit 商户密钥 | 是（小店下单） |
| `CREDIT_ORDER_EXPIRE_MINUTES` | `15`（最小 5） | 小店待支付订单有效期（分钟） | 否 |
| `LDC_SHOP_ORDER_QUERY_MIN_INTERVAL_MS` | `8000`（最小 2000） | 订单查询触发网关查单的最小间隔，防止高频打网关 | 否 |
| `LDC_SHOP_EMAIL_SUBJECT` | `LDC 商品交付通知` | 小店交付邮件标题 | 否 |
| `LDC_SHOP_REDEEM_BASE_URL` | `https://yyl.ncet.top` | 自动发卡服务根地址 | 否 |
| `LDC_SHOP_REDEEM_VALIDATE_PATH` | `/shop/shop/redeem/validate` | 发卡校验接口路径 | 否 |
| `LDC_SHOP_REDEEM_SUBMIT_PATH` | `/shop/shop/redeem` | 发卡提交接口路径 | 否 |
| `LDC_SHOP_REDEEM_TASK_STATUS_PATH` | `/shop/shop/redeem/task-status/{task_id}` | 发卡异步任务查询路径 | 否 |
| `LDC_SHOP_REDEEM_TIMEOUT_MS` | `20000` | 外部发卡接口超时（毫秒） | 否 |
| `LDC_SHOP_REDEEM_REQUEST_RETRIES` | `2` | 外部发卡请求重试次数 | 否 |
| `LDC_SHOP_REDEEM_TASK_POLL_MAX_ATTEMPTS` | `8` | 异步任务最大轮询次数 | 否 |
| `LDC_SHOP_REDEEM_TASK_POLL_INTERVAL_MS` | `30000` | 异步任务轮询间隔（毫秒） | 否 |
| `LDC_SHOP_REDEEM_CONTACT_EMAIL` | 空 | 发卡请求 contactEmail 参数 | 否 |
| `LDC_SHOP_REDEEM_VISITOR_ID_PREFIX` | `visitor_` | 发卡请求 visitorId 前缀 | 否 |
| `LDC_SHOP_REDEEM_QUANTITY` | `1` | 发卡请求 quantity 参数 | 否 |
| `LDC_SHOP_REDEEM_CODE_MAX_SWITCH_ATTEMPTS` | `3` | 单订单自动切换失效兑换码最大次数 | 否 |
| `PUBLIC_BASE_URL` | 自动推导 | 生成支付回调地址基准域名 | 否（推荐生产配置） |
| `SMTP_HOST/PORT/SECURE/USER/PASS/FROM` | 无 | 邮件发送配置；`email/both` 交付必须可用 | `email/both` 时必填 |

注意：

- `deliveryMode=email/both` 的商品，下单前必须先配置有效邮箱，否则后端会拒绝创建订单。
- `deliveryMode=email/both` 时，若历史订单邮箱为空或邮箱后续失效，交付阶段可能进入 `delivery_failed`。
- 用户邮箱通过 `PUT /api/linuxdo/me/email` 维护（前端“配置邮箱”按钮已接入）。
- 当前自动发卡 `redeemProvider` 仅支持 `yyl`；如后续新增 provider，需要同时扩展后端 provider 实现与管理端校验白名单。

## 7. 部署与联调步骤（前后端一起）

1. 后端配置 `.env`（至少 OAuth + Credit；如用邮件交付还需 SMTP）。  
2. 启动/重启后端服务。  
3. 管理后台启用 `openAccounts` 功能开关。  
4. 在“支付商品管理”创建 `category=ldc_shop` 商品并配置 `deliveryMode`、`fulfillmentMode`。  
5. 录入库存：
   - `item_pool` 商品：在“条目池”录入 `available` 条目。
   - `redeem_api` 商品：在“兑换码池”批量导入兑换码（一行一个）。  
6. 前端访问 `/redeem/open-accounts`，登录 Linux DO，刷新小店商品并下单验证。  
7. 验证订单状态从 `pending_payment -> paid -> delivered`，并核对页面/邮件交付结果。

## 8. 验收清单

- [ ] 前台可看到小店商品，库存显示正确。
- [ ] 下单后可拉起 Credit 支付，重复下单可复用待支付订单。
- [ ] 支付成功后可自动交付，订单落库完整。
- [ ] `inline` 商品页面可查看交付内容。
- [ ] `email` 商品邮件可收到，失败会记录 `delivery_error`。
- [ ] 支付失败/过期/退款时，`reserved` 库存会释放回 `available`。
- [ ] 后台可维护条目池（新增/编辑/下线/删除）且受状态约束。
- [ ] `redeem_api` 商品可批量导入兑换码，失效码会自动切换且不重复扣减。

## 9. 常见问题

1. 为什么下单报“库存不足”？
   - 该商品无 `available` 条目，或条目都在 `reserved/sold/offline`。
2. 为什么支付成功但显示 `delivery_failed`？
   - 常见为邮箱未配置/格式错误，或 SMTP 配置不可用（`email/both` 模式）。
3. 为什么频繁查询订单状态变化慢？
   - 后端有查单节流（`LDC_SHOP_ORDER_QUERY_MIN_INTERVAL_MS`），用于保护网关与服务稳定性。
4. 可以上架敏感文本吗？
   - 可以，但建议在业务层加脱敏、权限审计与加密存储策略，避免明文泄露风险。
