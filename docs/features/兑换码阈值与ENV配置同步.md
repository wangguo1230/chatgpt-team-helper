# 兑换码阈值与 ENV 配置同步

本文档说明两项后台能力：

1. 兑换码低库存阈值设置与测试。
2. `.env` 配置可视化、在线修改与运行时同步。

## 1. 功能目标

- 管理员可在前端直接设置兑换码低库存阈值，不改代码即可生效。
- 管理员可一键测试“当前是否会触发低库存告警邮件”。
- 管理员可在前端查看当前 `.env` 配置，新增/修改后保存并同步到运行时。

## 2. 前端入口

路径：`设置 -> 系统设置`

- 卡片一：`兑换码创建与阈值`
  - 字段：`单次创建最大数量`
  - 字段：`低库存补货阈值`
  - 按钮：`保存设置`
  - 按钮：`测试阈值告警`
- 卡片二：`ENV 配置同步`
  - 显示：`ENV 文件路径`
  - 文本区：`KEY=VALUE` 配置内容
  - 按钮：`刷新 ENV`
  - 按钮：`保存 ENV 配置`
  - 按钮：`同步到运行时`

说明：
- 文本区支持 `#` 注释行。
- 重复 key 以后者为准。
- 管理员界面默认展示明文值，请注意操作环境安全。

## 3. 后端接口

以下接口均为超级管理员权限（`/api/admin/*`）。

### 3.1 兑换码阈值设置

- `GET /api/admin/redemption-code-settings`
  - 返回 `batchCreateMaxCount`、`lowStockThreshold`，以及来源（DB/ENV/default）。
- `PUT /api/admin/redemption-code-settings`
  - 支持部分更新：
    - `batchCreateMaxCount` 范围 `1-1000`
    - `lowStockThreshold` 范围 `0-100000`
- `POST /api/admin/redemption-code-settings/test-low-stock-alert`
  - 立即按当前阈值执行一次低库存检查。
  - 返回是否发送邮件、阈值、命中渠道列表。

示例：

```bash
curl -X PUT "http://localhost:3000/api/admin/redemption-code-settings" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "settings": {
      "batchCreateMaxCount": 4,
      "lowStockThreshold": 10
    }
  }'
```

### 3.2 ENV 配置管理与同步

- `GET /api/admin/env-configs`
  - 读取目标 `.env` 文件并返回配置项。
- `PUT /api/admin/env-configs`
  - 支持 `entries` 数组或 `text` 文本；用于新增/修改配置。
  - 当使用 `entries/text` 提交时按“全量替换”语义写入 `.env`（删除行会生效）。
  - 当使用单键（`key/value`）提交时按“增量 upsert”语义写入。
- `POST /api/admin/env-configs/sync`
  - 将 `.env` 当前内容同步到 `process.env`，并失效相关配置缓存。
  - 会清理“已不在 `.env` 中但此前由该能力管理过”的运行时键，避免僵尸配置残留。

示例：

```bash
curl -X PUT "http://localhost:3000/api/admin/env-configs" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "entries": [
      { "key": "REDEMPTION_LOW_STOCK_THRESHOLD", "value": "10" },
      { "key": "REDEEM_LAZY_RETRY_MAX_ATTEMPTS", "value": "8" }
    ]
  }'
```

## 4. 阈值生效逻辑

- 兑换后会按渠道统计可用兑换码库存。
- 当某渠道 `可用库存 < lowStockThreshold` 时，进入低库存告警列表。
- 告警邮件为单次流程汇总发送，避免一次兑换发送多封。

阈值读取优先级：

1. `system_config.redemption_low_stock_threshold`
2. `REDEMPTION_LOW_STOCK_THRESHOLD`（环境变量）
3. 默认值 `0`（关闭告警）

## 5. ENV 文件路径与同步说明

`/api/admin/env-configs` 使用以下优先级定位 env 文件：

1. `ENV_FILE_PATH`（绝对或相对路径）
2. `process.cwd()/.env`
3. `backend/.env`

同步到运行时后会自动失效这些配置缓存：

- SMTP
- LinuxDo
- ZPay
- Turnstile
- Telegram
- Feature Flags
- 渠道配置
- 账号恢复配置

说明：当前已将多数业务阈值改为运行时读取，保存并同步后可直接生效；仅少量启动级配置仍建议重启（见下方“重启建议”）。

## 6. 相关环境变量

- `REDEMPTION_LOW_STOCK_THRESHOLD`
  - 兑换后按渠道低库存阈值；`0` 表示关闭。
- `REDEEM_LAZY_RETRY_MAX_ATTEMPTS`
  - 自动选码在账号不可用场景下的懒重试次数。
- `ENV_FILE_PATH`
  - 后台 ENV 管理接口读取/写入的目标文件路径。

## 7. 已支持实时生效的变量（同步后无需重启）

- 兑换与补录链路
  - `ACCOUNT_RECOVERY_WINDOW_DAYS`
  - `ACCOUNT_RECOVERY_REDEEM_MAX_ATTEMPTS`
  - `ACCOUNT_RECOVERY_ACCESS_CACHE_TTL_MS`
  - `REDEEM_ORDER_STRICT_TODAY_DEFAULT`
  - `REDEEM_LAZY_RETRY_MAX_ATTEMPTS`
  - `REDEMPTION_LOW_STOCK_THRESHOLD`（当 DB 未配置阈值时作为回退）
  - `OPEN_ACCOUNTS_CAPACITY_LIMIT`（当 DB 未配置容量时作为回退）
- 候车室与自动上车
  - `WAITING_ROOM_MAX_SIZE`
  - `WAITING_ROOM_MIN_TRUST_LEVEL`
  - `WAITING_ROOM_REJOIN_COOLDOWN_DAYS`
  - `WAITING_ROOM_AUTO_BOARDING_ENABLED`
  - `WAITING_ROOM_AUTO_BOARDING_HOURS`
- 积分与提现
  - `TEAM_SEAT_COST_POINTS`
  - `INVITE_UNLOCK_COST_POINTS`
  - `WITHDRAW_MAX_POINTS_PER_REQUEST`
  - `WITHDRAW_DAILY_MAX_POINTS`
  - `WITHDRAW_DAILY_MAX_REQUESTS`
  - `WITHDRAW_MAX_PENDING`
  - `WITHDRAW_COOLDOWN_SECONDS`

## 8. 重启建议（不建议运行时热切换）

- 鉴权/安全密钥相关：`JWT_SECRET`、LinuxDo 会话密钥等。
- 进程启动参数：`PORT`、生产模式开关等。
- 跨域白名单等启动时初始化配置（如服务启动时读取并缓存）。

## 9. 验收清单

1. 在设置页修改阈值并保存，刷新后值保持一致。
2. 点击“测试阈值告警”，能看到 `sent/threshold/lowStockChannels` 结果。
3. 在 ENV 卡片新增或修改键值，保存后刷新仍存在。
4. 点击“同步到运行时”后，相关设置页面能读取到新值。
5. 真实兑换成功后，如某渠道“可兑换库存（排除预留码/不可用账号）”低于阈值，会触发汇总告警邮件。
