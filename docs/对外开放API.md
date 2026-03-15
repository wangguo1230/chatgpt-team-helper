# 对外开放 API（API Key）

本项目提供一组用于自动化/第三方对接的接口，统一使用 `x-api-key` 鉴权。

## 1) 基础信息

- Base URL：`https://<host>/api`
- 请求体：默认 `application/json`

## 2) 鉴权：`x-api-key`

所有“对外开放 API”都需要在请求头携带：

```
x-api-key: <your_api_key>
```

API Key 的读取优先级：

1. 数据库 `system_config.config_key=auto_boarding_api_key`
2. 环境变量 `AUTO_BOARDING_API_KEY`

若以上两处均未配置，则接口会返回 `503`（API Key 未配置，接口已禁用）。

建议：生产环境务必在后台系统设置或 `.env` 中配置强随机的 API Key（建议至少 16 位）。

## 3) 接口列表

| 方法 | Path | 用途 |
| --- | --- | --- |
| POST | `/api/auto-boarding` | 自动上车：创建/更新账号，可按多渠道建码并触发同步 |
| GET | `/api/auto-boarding/stats` | 自动上车统计 |
| POST | `/api/openai-accounts/generate-auth-url` | 生成 OpenAI OAuth 授权链接（PKCE，会话 10 分钟） |
| POST | `/api/openai-accounts/exchange-code` | 交换授权码，返回 token 与账号信息 |
| POST | `/api/gpt-accounts/ban` | 按邮箱批量标记封号（关闭开放） |
| GET | `/api/redemption-codes/artisan-flow/today` | 获取当天创建的 `artisan-flow` 渠道兑换码 |

## 4) 接口详情

### 4.1 POST `/api/auto-boarding`

用于“自动上车”脚本/服务添加或更新账号信息；当账号存在时更新，否则创建新账号。

**Headers**

- `x-api-key: <your_api_key>`
- `Content-Type: application/json`

**Body（JSON）**

| 字段 | 必填 | 类型 | 说明 |
| --- | --- | --- | --- |
| `email` | 是 | string | 账号邮箱（会被转小写并 trim） |
| `token` | 是 | string | access token；也支持传入 JSON 字符串（自动提取 `access_token`） |
| `refreshToken` | 否 | string | refresh token；也支持传入 JSON 字符串（自动提取 `refresh_token`） |
| `chatgptAccountId` | 否 | string | ChatGPT account id（用于优先匹配已有账号） |
| `oaiDeviceId` | 否 | string | `oai-did` |
| `expireAt` | 否 | string/number | 过期时间：支持 `YYYY/MM/DD HH:mm`、`YYYY-MM-DD HH:mm`、毫秒时间戳 |
| `isOpen` / `is_open` | 否 | boolean/number/string | 是否设为开放账号；默认 `true`（`1/true/yes` 为开，`0/false/no` 为关） |
| `codePlans` / `code_plans` | 否 | array | 按渠道批量建码计划（见下方） |
| `isDemoted`/`is_demoted` | 否 | boolean/number | **Deprecated**：已弃用（请求会被忽略；响应恒为 `false`，仅保留兼容） |

兼容别名（可直接传 OpenAI OAuth/客户端返回 JSON）：

- `access_token`、`refresh_token`
- `account_id` / `chatgpt_account_id`
- `oai_device_id`
- `expired` / `expires_at`

`codePlans` 元素字段：

| 字段 | 必填 | 类型 | 说明 |
| --- | --- | --- | --- |
| `channel` / `channelKey` / `channel_key` | 是 | string | 渠道 key（必须在 `channels` 表中存在且启用） |
| `countMode` / `count_mode` | 否 | string | `fixed` 或 `max_minus`；缺省按 `fixed` |
| `count` | `fixed` 时必填 | number | 固定生成数量（1-1000） |
| `minus` / `maxMinus` / `max_minus` | `max_minus` 时可填 | number | 从剩余可用名额中扣减（0-1000，默认 0） |
| `orderType` / `order_type` | 否 | string | `warranty` / `no_warranty` / `anti_ban`，默认 `warranty` |
| `serviceDays` / `service_days` | 条件必填 | number | `orderType=warranty` 时必填（1-3650）；`no_warranty` 时会忽略 |

**行为说明**

- 更新逻辑：优先用 `chatgptAccountId` 查找，其次用 `email` 查找。
- `expireAt`：如果未显式传入，后端会尝试从 `token` 的 JWT `exp` 字段推导并写入。
- `isOpen`：默认 `true`；如账号已封号且请求要设为开放，会返回 `400`。
- 账号封号时不允许通过该接口创建兑换码。
- `codePlans`：可一次请求按多渠道创建兑换码；不传则只创建/更新账号，不自动建码。
- 容量上限读取优先级：`system_config.open_accounts_capacity_limit` > `OPEN_ACCOUNTS_CAPACITY_LIMIT`（`.env`）> 默认 `5`。
- `max_minus` 计算方式：`计划数量 = 当前剩余名额 - minus`，其中剩余名额 = 容量上限 - (`user_count + invite_count + 未兑换码数量`)。
- `isDemoted`/`is_demoted`：已弃用，后端会忽略该字段。
- 会触发一次账号同步（`syncResult`/`removedUsers` 字段返回）。
- `token`/`refreshToken` 支持直接粘贴 JSON；如果请求体直接包含 `access_token` 等字段，也可直接创建/更新。

**响应**

- 200：更新成功（`action=updated`）
- 201：创建成功（`action=created`）
- 400：参数错误（例如缺少 `email/token`、`expireAt` 格式不正确）
- 401：API Key 不正确

**请求示例**

```bash
curl -X POST "https://<host>/api/auto-boarding" \
  -H "Content-Type: application/json" \
  -H "x-api-key: <your_api_key>" \
  -d '{
    "email": "user@example.com",
    "token": "eyJhbGciOi...",
    "refreshToken": "rt_xxx",
    "chatgptAccountId": "acct_...",
    "oaiDeviceId": "oai-did-...",
    "expireAt": "2026/01/27 12:00",
    "isOpen": true,
    "codePlans": [
      {
        "channel": "linux-do",
        "countMode": "max_minus",
        "minus": 1,
        "orderType": "warranty",
        "serviceDays": 30
      },
      {
        "channel": "xianyu",
        "count": 2,
        "orderType": "no_warranty"
      },
      {
        "channel": "yizhifu",
        "count": 1,
        "orderType": "anti_ban",
        "serviceDays": 7
      }
    ]
  }'
```

也支持直接提交整包 JSON（后端自动提取）：

```bash
curl -X POST "https://<host>/api/auto-boarding" \
  -H "Content-Type: application/json" \
  -H "x-api-key: <your_api_key>" \
  -d '{
    "access_token": "eyJhbGciOi...",
    "refresh_token": "rt_xxx",
    "account_id": "fa337943-cf04-4eab-ad34-a9669f36a0b4",
    "email": "user@example.com",
    "expired": "2026-03-23T11:27:45+08:00",
    "oai_device_id": "oai-did-...",
    "is_open": true,
    "code_plans": [
      {
        "channel_key": "linux-do",
        "count_mode": "fixed",
        "count": 1,
        "order_type": "warranty",
        "service_days": 15
      }
    ]
  }'
```

**响应示例**

```json
{
  "success": true,
  "message": "自动上车成功！账号已添加到系统",
  "action": "created",
  "account": {
    "id": 1001,
    "email": "user@example.com",
    "userCount": 1,
    "inviteCount": 0,
    "chatgptAccountId": "acct_xxx",
    "oaiDeviceId": "oai-did-xxx",
    "expireAt": "2026/03/23 11:27",
    "isOpen": true
  },
  "generatedCodesCount": 2,
  "capacityLimit": 5,
  "remainingSlots": 2,
  "generatedCodesByChannel": {
    "linux-do": [
      {
        "code": "ABCD-EFGH-IJKL",
        "orderType": "warranty",
        "serviceDays": 30
      }
    ],
    "xianyu": [
      {
        "code": "MNOP-QRST-UVWX",
        "orderType": "no_warranty",
        "serviceDays": null
      }
    ]
  },
  "generatedCodes": [
    {
      "code": "ABCD-EFGH-IJKL",
      "channel": "linux-do",
      "orderType": "warranty",
      "serviceDays": 30
    },
    {
      "code": "MNOP-QRST-UVWX",
      "channel": "xianyu",
      "orderType": "no_warranty",
      "serviceDays": null
    }
  ],
  "syncResult": null,
  "removedUsers": []
}
```

### 4.2 GET `/api/auto-boarding/stats`

获取自动上车的统计信息。

**Headers**

- `x-api-key: <your_api_key>`

**响应示例**

```json
{
  "success": true,
  "stats": {
    "totalAccounts": 10,
    "recentAccounts": 3
  }
}
```

### 4.3 POST `/api/openai-accounts/generate-auth-url`

生成 OpenAI 官方 OAuth 授权链接，并在服务端缓存一次性会话（默认 10 分钟有效），用于后续 `exchange-code` 校验 PKCE/state 等信息。

**Headers**

- `x-api-key: <your_api_key>`
- `Content-Type: application/json`

**Body（JSON，可选）**

| 字段 | 必填 | 类型 | 说明 |
| --- | --- | --- | --- |
| `proxy` | 否 | string | 代理 URL，例如 `http://user:pass@host:port` |

**响应示例**

```json
{
  "success": true,
  "data": {
    "authUrl": "https://auth.openai.com/oauth/authorize?...",
    "sessionId": "b3b0ad6e-...",
    "instructions": ["..."]
  }
}
```

**相关环境变量**

| 变量名 | 说明 |
| --- | --- |
| `OPENAI_BASE_URL` | 授权域名（默认 `https://auth.openai.com`） |
| `OPENAI_CLIENT_ID` | OpenAI 应用 Client ID |
| `OPENAI_REDIRECT_URI` | 回调地址（必须与 OpenAI 应用配置一致） |
| `OPENAI_SCOPE` | scope（默认 `openid profile email offline_access`） |

### 4.4 POST `/api/openai-accounts/exchange-code`

使用 `code` + `sessionId` 交换 OpenAI token，并返回解析后的账号/组织信息。会话为一次性，成功后会被删除；过期或重复使用需要重新生成授权链接。

**Headers**

- `x-api-key: <your_api_key>`
- `Content-Type: application/json`

**Body（JSON）**

| 字段 | 必填 | 类型 | 说明 |
| --- | --- | --- | --- |
| `code` | 是 | string | 授权回调 URL 中的 `code` 参数 |
| `sessionId` | 是 | string | `generate-auth-url` 返回的 `sessionId` |

### 4.5 POST `/api/gpt-accounts/ban`

按邮箱将账号标记为“封号”，会将 `is_open=0`、`is_banned=1`。支持单个或批量（最多 500 个邮箱）。

**Headers**

- `x-api-key: <your_api_key>`
- `Content-Type: application/json`

**Body（JSON）**

以下任意一种都可：

- `{"emails":["a@xx.com","b@xx.com"]}`
- `{"email":"a@xx.com"}`
- `["a@xx.com","b@xx.com"]`

**响应示例**

```json
{
  "message": "ok",
  "updated": 1,
  "matched": [{ "id": 123, "email": "a@xx.com" }],
  "notFound": ["b@xx.com"]
}
```

### 4.6 GET `/api/redemption-codes/artisan-flow/today`

获取服务器“本地时间”当天创建的 `artisan-flow` 渠道兑换码列表。

**Headers**

- `x-api-key: <your_api_key>`

**响应示例**

```json
{
  "success": true,
  "date": "2026-01-27",
  "total": 2,
  "codes": [
    {
      "id": 1,
      "code": "ABCD-EFGH-IJKL",
      "isRedeemed": false,
      "redeemedAt": null,
      "redeemedBy": null,
      "accountEmail": "owner@example.com",
      "channel": "artisan-flow",
      "channelName": "ArtisanFlow",
      "createdAt": "2026-01-27 10:00:00",
      "updatedAt": "2026-01-27 10:00:00"
    }
  ]
}
```
