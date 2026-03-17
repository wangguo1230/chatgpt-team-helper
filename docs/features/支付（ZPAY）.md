# 支付（ZPAY / 易支付）从注册到上线使用完整文档

最后更新：2026-03-17 18:31:20 CST

本文覆盖当前项目里 ZPAY 支付链路的完整落地流程，按“注册平台 -> 系统配置 -> 业务配置 -> 用户使用 -> 运维排障”组织。

适用范围：
- 用户侧支付页：`/buy`（单页下单）与 `/purchase`（商品目录）
- 订单查询页：`/order`
- 支付回调：`/notify`（兼容）与 `/api/purchase/notify`
- 管理后台：`/admin/settings`、`/admin/purchase-orders`

## 1. 功能总览

支付链路的核心步骤如下：
1. 用户在公开页选择商品（含质保类型/质保天数/库存）并提交邮箱、支付方式。
2. 后端按“商品 + 渠道 + 订单类型 + 质保天数”匹配可用兑换码并预留库存。
3. 后端调用 ZPAY 下单接口，拿到支付二维码/链接。
4. 用户完成支付，ZPAY 异步回调 `/notify`。
5. 后端验签通过后将订单置为 `paid`，自动执行开通逻辑（自动兑换/邀请）并发送通知。
6. 用户或系统查询订单时可触发兜底查单，修复部分回调丢失场景。

## 2. 在支付平台注册（易支付）

先在你的易支付平台（例如 `zpayz.cn`）完成商户注册并开通支付通道。

你最终只需要拿到 3 个值：
- `ZPAY_BASE_URL`：平台接口地址，例如 `https://zpayz.cn`
- `ZPAY_PID`：商户 PID
- `ZPAY_KEY`：签名 KEY（务必保密）

建议同时确认：
- 支持支付类型至少包含 `alipay`、`wxpay`（系统仅支持这两个值）
- 平台没有拦截你业务域名的异步通知请求
- 你的服务端可被平台公网访问

## 3. 系统基础配置

## 3.1 环境变量（最小可用）

`backend/.env` 至少包含：

```env
ZPAY_BASE_URL=https://zpayz.cn
ZPAY_PID=your-pid
ZPAY_KEY=your-key

# 强烈建议配置：用于生成 notify_url
PUBLIC_BASE_URL=https://your-domain.com
```

补充建议：

```env
# 订单过期（分钟）
PURCHASE_ORDER_EXPIRE_MINUTES=15

# 查单最小间隔（毫秒）
PURCHASE_ORDER_QUERY_MIN_INTERVAL_MS=8000

# 订单查询页兜底查单延迟（毫秒）
PURCHASE_ORDER_QUERY_FALLBACK_DELAY_MS=60000
```

## 3.2 管理后台配置（推荐）

生产环境建议在后台入库配置，避免容器重建后配置漂移：
1. 登录管理后台：`/admin/settings`
2. 进入“支付与财务”分组
3. 在“ZPAY 支付配置”填写：
4. `Base URL`
5. `PID`
6. `KEY`
7. 点击“保存 ZPAY 配置”

注意：
- `PID` 非空时，`KEY` 必须存在，否则保存会报错。
- `Base URL` 只允许 `http/https`。
- 保存 `KEY` 时支持“留空不修改已存 KEY”。

## 3.3 功能开关

支付功能必须开启：
1. `管理后台 -> 系统设置 -> 功能开关`
2. 打开“支付（ZPAY）”

关闭时支付接口会直接返回功能禁用错误。

## 3.4 反向代理与回调入口

当前项目支持两种回调入口：
- `https://your-domain.com/notify`（推荐，平台兼容性最好）
- `https://your-domain.com/api/purchase/notify`

如果你使用仓库内 `default.conf`，已包含 `/notify` 代理转发到后端，需确保你的部署环境保留该规则。

## 4. 商品与库存配置（必须）

很多“支付成功但无法发放”或“无法下单”问题都源于此。

## 4.1 创建可支付商品

进入 `管理后台 -> 系统设置 -> 支付商品管理`：
- 选择 `category=code`（支付下单仅使用此类商品）
- `isActive=true`
- 配置商品字段：
- `productKey`：商品唯一标识（建议稳定，不随展示名变更）
- `productName`：展示名（公开页可见）
- `amount`：售价
- `serviceDays`：质保天数（`no_warranty` 仍建议填值，实际匹配按 0 处理）
- `orderType`：`warranty`/`no_warranty`（页面显示中文“有质保/无质保”，值保持英文）
- `codeChannels`：兑换码渠道优先级（逗号分隔）

## 4.2 准备兑换码库存

兑换码需满足（任一条件不满足都不会计入库存）：
- 未被使用
- 未被其他订单预留
- 渠道与商品 `codeChannels` 匹配
- 兑换码 `order_type` 与商品 `orderType` 匹配
- 兑换码 `service_days` 与商品 `serviceDays` 匹配（`no_warranty` 固定匹配 `service_days = 0`）

## 4.3 兑换码匹配规则（关键）

创建订单时，后端会遍历该商品的 `codeChannels`，并按以下条件查询首个可预留兑换码：

1. `channel` 匹配当前渠道；
2. `order_type` 匹配商品 `orderType`；
3. `service_days`：
4. `orderType = no_warranty` 时，强制匹配 `0`；
5. 其他类型匹配商品 `serviceDays`；
6. 兑换码未被占用且关联账号可邀请。

命中后会把兑换码信息写入订单（`codeId/code/codeAccountEmail`），订单列表可追踪“商品与兑换码一一对应”。

## 4.4 账号库存可用条件

下单时后端会筛选“可发码库存”，要求关联账号满足：
- `gpt_accounts.is_open = 1`
- `gpt_accounts.user_count < 6`
- `DATE(gpt_accounts.created_at) = 今日`

不满足以上条件会表现为“今日库存不足，请稍后再试”。

## 5. 用户侧使用流程

## 5.1 创建订单

前端在 `/buy` 进行下单（`/purchase` 可作为目录入口）：
- 先选商品卡片（展示：商品名、质保类型、质保天数、库存、价格）
- 邮箱（必填，且格式合法）
- 支付方式（`alipay` 或 `wxpay`）
- 后端提交字段：`productKey` + `orderType`（均由选中商品自动带出）

接口：
- `POST /api/purchase/orders`

返回关键字段：
- `orderNo`
- `payUrl`
- `qrcode` / `img`
- `amount` / `productName`

兼容参数说明：
- 公开页支持通过 query 指定默认商品：`productKey`；
- 历史链接仍可用 `orderType` 作为兜底匹配第一个同类型商品。

## 5.2 支付与状态刷新

用户扫码支付后，前端会轮询订单状态；也可手动点击“刷新状态（sync=true）”强制查单。

接口：
- `GET /api/purchase/orders/:orderNo?email=xxx&sync=1`

## 5.3 订单状态说明

- `created`：本地订单已创建，待请求支付通道
- `pending_payment`：已拿到支付信息，待用户支付
- `paid`：支付成功，后置处理执行中/已完成
- `expired`：超时未支付，订单过期
- `failed`：下单或后续流程异常
- `refunded`：后台已执行退款

## 6. 回调与闭环处理机制

## 6.1 回调验签

`/notify` 收到回调后会校验：
- `pid` 是否匹配
- `sign` 是否匹配（MD5）
- `trade_status` 是否为 `TRADE_SUCCESS`

只有全部通过才进入支付成功处理。

## 6.2 支付成功后自动处理

订单转 `paid` 后，系统会依次尝试：
1. 自动兑换（发起邀请）
2. 发放邀请积分/购买积分
3. 发送订单邮件
4. 发送 Telegram 通知（若开启）

这些动作支持幂等更新（同一订单重复回调不会重复发奖励）。

## 6.3 兜底查单

当回调异常或延迟时，可通过订单查询接口触发查单兜底：
- 手动：`sync=1`
- 自动：订单创建一段时间后，查询接口会按配置触发兜底查单

## 7. 管理员日常操作

## 7.1 查看订单

- 页面：`/admin/purchase-orders`
- 接口：`GET /api/purchase/admin/orders`

支持按状态、关键词筛选。
列表字段包含：
- `productKey/productName/orderType/serviceDays`
- `codeChannel/codeId/code/codeAccountEmail`
- 便于排查“某商品消耗了哪条兑换码”。

## 7.2 后台退款

- 页面：支付订单列表中“退款”
- 接口：`POST /api/purchase/admin/orders/:orderNo/refund`

约束：
- 仅 `paid` 订单可退
- `no_warranty`（无质保）订单不支持退款
- 退款后状态变更为 `refunded`

## 7.3 用户绑定历史订单

接口：
- `POST /api/purchase/my/orders/bind`

用途：
- 用户先支付后登录时可补绑订单，触发该订单应发但未发的积分结算。

## 8. 上线验收清单（建议照单执行）

- 已在支付平台拿到可用 `PID/KEY`
- `PUBLIC_BASE_URL` 指向公网 HTTPS 域名
- 功能开关 `payment=true`
- 至少一个 `category=code` 且 `isActive=true` 商品
- 商品 `codeChannels` 对应的渠道已启用
- 渠道下存在与商品 `orderType + serviceDays` 匹配的可用兑换码
- 通过 `/buy` 完成一笔真实支付
- 回调日志中出现 `notify accepted` 与 `notify async handled`
- 订单最终状态为 `paid`，且 `redeemError` 为空
- 管理后台可查询到该订单并看到关联兑换码信息
- 管理后台可对可退款订单执行退款

## 9. 常见问题与排查

`支付未配置，请联系管理员`
- 检查 `PID/KEY` 是否为空
- 检查后台 ZPAY 配置是否保存成功

`今日库存不足，请稍后再试`
- 检查商品是否激活、渠道是否匹配
- 检查兑换码 `orderType/serviceDays` 是否与商品匹配
- 检查兑换码是否可用（未兑换、未被预留）
- 检查账号是否开放且人数未满

订单长期 `pending_payment`
- 先在前端点“刷新状态（sync=true）”
- 检查 `/notify` 是否可公网访问
- 检查回调签名失败日志（`pid mismatch`、`sign mismatch`）

`money_mismatch:*`
- 回调金额与本地订单金额不一致，系统会拒绝入账
- 需核对商品价格与支付平台订单金额

`支付成功，但自动开通失败`
- 查看订单字段 `redeemError`
- 多见于兑换码已失效、账号不可用、邀请接口异常

## 10. 运行日志关键字

排障时优先检索：
- `[Purchase] notify received`
- `[Purchase] notify accepted`
- `[Purchase] notify async handled`
- `[Purchase] zpay create failed`
- `[Purchase] zpay order money mismatch`
- `[Purchase] auto redeem failed`

## 11. 安全建议

- `ZPAY_KEY` 仅放服务端，禁止前端透出
- 生产环境务必使用 HTTPS
- 保留 `pid + sign + trade_status` 严格校验，不要绕过验签
- 回调地址建议固定为公网主域名，避免代理层多跳导致签名参数丢失
- 对外下单接口建议配合 WAF / 网关限流；如使用代理转发，请确保源站不直接信任客户端伪造 IP 头。
