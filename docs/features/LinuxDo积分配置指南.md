# LinuxDo Credit (积分体系) 配置指南

本文档介绍如何正确配置 LinuxDo Credit (LDC) 积分体系，用于“开放账号上车”功能。

---

## 1. 回调接口配置 (Notify URL)

在 LinuxDo Credit 平台或相关支付网关配置时，**异步回调地址 (Notify URL)** 是系统确认订单支付成功的核心。

### 填写建议
本系统在后端提供了专门的兼容路径，你可以根据你的公网域名填写以下任一地址：

- **推荐地址**：`https://你的域名/credit/notify`
- **备选地址**：`https://你的域名/api/credit/notify`

> [!TIP]
> 1. 请确保你的域名在公网可访问，否则积分平台无法将回调发送至你的服务器。
> 2. 系统会自动处理签名校验，只要 `PID` 和 `KEY` 配置正确即可。

---

## 2. 核心环境变量说明

在 `backend/.env` 中，各项配置的含义如下：

### 基础凭证
- `LINUXDO_CREDIT_PID`: **合作伙伴 ID**。需在 LinuxDo Credit 平台获取。
- `LINUXDO_CREDIT_KEY`: **安全密钥**。需在 LinuxDo Credit 平台获取。
- `LINUXDO_CREDIT_BASE_URL`: 网关基础地址。默认已预设为 `https://credit.linux.do/epay`，通常无需修改。

### 价格与业务逻辑
- `OPEN_ACCOUNTS_CREDIT_COST`: **上车单价**。默认 30，即每次上车扣除 30 LDC 积分。
- `OPEN_ACCOUNTS_CREDIT_TITLE`: **订单标题**。用户支付时在积分平台看到的商品名称。
- `CREDIT_ORDER_EXPIRE_MINUTES`: **支付超时**。默认 15 分钟。超过此时间未支付，订单会自动关闭并释放预留名额。

### 进阶开关 (与 Cloudflare 拦截有关)
由于 `credit.linux.do` 受到 Cloudflare 保护，部分服务端直连请求可能会被拦截：

- `CREDIT_GATEWAY_SERVER_SUBMIT_ENABLED`: **建议设为 `false`**。关闭后，系统将使用“前端 Form POST”方式发起支付，由用户浏览器跳转至支付页，避开服务端被拦截的问题。
- `CREDIT_GATEWAY_SERVER_QUERY_ENABLED`: **主动查单开关**。若开启，系统会尝试定时从服务端查询订单状态。若你的服务器被 CF 拦截导致 403，建议关闭。
- `CREDIT_GATEWAY_SERVER_REFUND_ENABLED`: **后台退款开关**。开启后，管理员可在后台点击“退款”直接将积分退还用户。

---

## 3. 配置步骤建议

1. **配置域名**：确保 `backend/.env` 中的 `PUBLIC_BASE_URL` 填写正确（例如 `https://example.com`）。
2. **填写凭证**：在管理后台的「系统设置」或 `.env` 中填写 `PID` 和 `KEY`。
3. **设置回调**：在积分平台后台将回调地址设置为 `https://你的域名/credit/notify`。
4. **验证流程**：去前端 `/redeem/open-accounts` 尝试发起一笔上车，检查能否正常跳转到支付页，以及支付后状态是否自动更新。

---

## 常见问题 (FAQ)

#### Q: 支付成功了，但系统里订单状态一直是“待支付”？
**A**: 这通常说明回调接口没调通。请检查：
1. 你的服务器公网是否可访问。
2. 回调地址填写是否正确。
3. `PID` 和 `KEY` 是否正确（签名失败会导致回调被忽略）。

#### Q: 发起支付提示 403 Forbidden？
**A**: 这是积分平台的 Cloudflare 拦截了服务器请求。请确保 `CREDIT_GATEWAY_SERVER_SUBMIT_ENABLED` 设为 `false`。
