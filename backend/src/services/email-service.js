import nodemailer from 'nodemailer'
import { getSmtpSettings } from '../utils/smtp-settings.js'

const parseRecipients = (value) => {
  const raw = String(value || '')
  return raw
    .split(',')
    .map(email => String(email || '').trim())
    .filter(Boolean)
}

const buildSmtpConfig = (settings) => {
  const host = String(settings?.smtp?.host || '').trim()
  const port = Number(settings?.smtp?.port || 0)
  const secure = Boolean(settings?.smtp?.secure)
  const user = String(settings?.smtp?.user || '').trim()
  const pass = String(settings?.smtp?.pass || '')

  if (!host || !user || !pass) {
    return null
  }

  return {
    host,
    port: Number.isFinite(port) && port > 0 ? port : 465,
    secure,
    auth: {
      user,
      pass
    }
  }
}

const escapeHtml = (value) => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')

export async function sendAdminAlertEmail({ subject, text, html } = {}) {
  const settings = await getSmtpSettings()
  const smtpConfig = buildSmtpConfig(settings)
  if (!smtpConfig) {
    console.warn('[AdminAlert] SMTP 配置不完整，跳过发送告警邮件')
    return false
  }

  const recipients = parseRecipients(settings?.adminAlertEmail)
  if (recipients.length === 0) {
    console.warn('[AdminAlert] ADMIN_ALERT_EMAIL 未配置，跳过发送告警邮件')
    return false
  }

  const resolvedSubject = String(subject || '').trim() || '系统告警'
  const from = String(settings?.smtp?.from || '').trim() || smtpConfig.auth.user
  const resolvedText = typeof text === 'string' ? text : (text != null ? String(text) : '')
  const resolvedHtml = typeof html === 'string' ? html : ''

  const transporter = nodemailer.createTransport(smtpConfig)

  try {
    await transporter.sendMail({
      from,
      to: recipients.join(','),
      subject: resolvedSubject,
      text: resolvedText || undefined,
      html: resolvedHtml || undefined
    })
    console.log('[AdminAlert] 告警邮件已发送', { subject: resolvedSubject })
    return true
  } catch (error) {
    console.warn('[AdminAlert] 发送告警邮件失败', error?.message || error)
    return false
  }
}

function buildOpenAccountsSweeperBody(summary) {
  const {
    startedAt,
    finishedAt,
    maxJoined,
    scanCreatedWithinDays,
    scannedCount,
    securityCheckedCount,
    securityBlockedCount,
    offlinedCodesCount,
    totalKicked,
    results = [],
    failures = []
  } = summary || {}

  const humanStart = startedAt ? startedAt.toLocaleString() : ''
  const humanEnd = finishedAt ? finishedAt.toLocaleString() : ''

  const rows = (results || [])
    .map(item => {
      const emailPrefix = String(item.emailPrefix || '')
      const joined = item.joined ?? '未知'
      const kicked = Number(item.kicked || 0)
      const didKick = Boolean(item.didKick) || kicked > 0
      const securityStatus = String(item.securityStatus || '')
      const offlinedCodes = Number(item.offlinedCodes || 0)
      return `<tr><td>${emailPrefix}</td><td style="text-align:right;">${joined}</td><td style="text-align:center;">${didKick ? '是' : '否'}</td><td style="text-align:right;">${kicked}</td><td style="text-align:center;">${securityStatus || '-'}</td><td style="text-align:right;">${offlinedCodes}</td></tr>`
    })
    .join('')

  const failureRows = (failures || [])
    .map(item => {
      const label = item.emailPrefix ? `${item.emailPrefix} (ID=${item.accountId})` : `ID=${item.accountId}`
      return `<li>账号 ${label}：${item.error || '执行失败'}</li>`
    })
    .join('')

  const htmlParts = [
    `<p>开放账号超员扫描已完成。</p>`,
    `<p>扫描账号数：${scannedCount ?? 0}，阈值：joined &gt; ${maxJoined ?? ''}，本次踢出：${totalKicked ?? 0}</p>`,
    `<p>安全检测：${securityCheckedCount ?? 0}，不可用账号：${securityBlockedCount ?? 0}，下架兑换码：${offlinedCodesCount ?? 0}</p>`,
    ...(Number(scanCreatedWithinDays) > 0 ? [`<p>扫描范围：最近 ${scanCreatedWithinDays} 天创建的开放账号</p>`] : []),
    '<table style="border-collapse:collapse;width:100%;">',
    '<thead><tr><th style="text-align:left;border-bottom:1px solid #ccc;">邮箱前缀</th><th style="text-align:right;border-bottom:1px solid #ccc;">当前人数</th><th style="text-align:center;border-bottom:1px solid #ccc;">是否踢出</th><th style="text-align:right;border-bottom:1px solid #ccc;">踢出人数</th><th style="text-align:center;border-bottom:1px solid #ccc;">安全检测</th><th style="text-align:right;border-bottom:1px solid #ccc;">下架兑换码</th></tr></thead>',
    `<tbody>${rows || '<tr><td colspan="6">无</td></tr>'}</tbody>`,
    '</table>'
  ]

  if ((failures || []).length > 0) {
    htmlParts.push('<p>以下账号处理失败：</p>')
    htmlParts.push(`<ul>${failureRows}</ul>`)
  }

  if (humanStart || humanEnd) {
    htmlParts.push('<p>')
    if (humanStart) htmlParts.push(`开始时间：${humanStart}<br/>`)
    if (humanEnd) htmlParts.push(`结束时间：${humanEnd}`)
    htmlParts.push('</p>')
  }

  const textRows =
    results && results.length
      ? results
          .map(item => {
            const emailPrefix = String(item.emailPrefix || '')
            const joined = item.joined ?? '未知'
            const kicked = Number(item.kicked || 0)
            const didKick = Boolean(item.didKick) || kicked > 0
            const securityStatus = String(item.securityStatus || '')
            const offlinedCodes = Number(item.offlinedCodes || 0)
            return `- ${emailPrefix}: 当前人数=${joined} 是否踢出=${didKick ? '是' : '否'} 踢出人数=${kicked} 安全检测=${securityStatus || '-'} 下架兑换码=${offlinedCodes}`
          })
          .join('\n')
      : '无'

  const textFailures =
    failures && failures.length
      ? '\n\n失败：\n' +
        failures
          .map(item => {
            const label = item.emailPrefix ? `${item.emailPrefix} (ID=${item.accountId})` : `ID=${item.accountId}`
            return `- ${label}: ${item.error || '执行失败'}`
          })
          .join('\n')
      : ''

  const textTime = humanStart || humanEnd ? `\n\n开始时间：${humanStart}\n结束时间：${humanEnd}` : ''

  return {
    html: htmlParts.join('\n'),
    text: `开放账号超员扫描已完成。\n扫描账号数：${scannedCount ?? 0}，阈值：${maxJoined ?? ''}，本次踢出：${totalKicked ?? 0}\n安全检测：${securityCheckedCount ?? 0}，不可用账号：${securityBlockedCount ?? 0}，下架兑换码：${offlinedCodesCount ?? 0}${Number(scanCreatedWithinDays) > 0 ? `\n扫描范围：最近 ${scanCreatedWithinDays} 天创建的开放账号` : ''}\n\n${textRows}${textFailures}${textTime}`
  }
}

export async function sendOpenAccountsSweeperReportEmail(summary) {
  const settings = await getSmtpSettings()
  const smtpConfig = buildSmtpConfig(settings)
  if (!smtpConfig) {
    console.warn('[OpenAccountsSweeper] SMTP 配置不完整，跳过发送扫描报告')
    return false
  }

  const recipients = parseRecipients(settings?.adminAlertEmail)
  if (recipients.length === 0) {
    console.warn('[OpenAccountsSweeper] ADMIN_ALERT_EMAIL 未配置，跳过发送扫描报告')
    return false
  }

  const transporter = nodemailer.createTransport(smtpConfig)
  const { html, text } = buildOpenAccountsSweeperBody(summary)

  const subject = process.env.OPEN_ACCOUNTS_SWEEPER_REPORT_SUBJECT || '开放账号超员扫描报告'
  const from = String(settings?.smtp?.from || '').trim() || smtpConfig.auth.user

  await transporter.sendMail({
    from,
    to: recipients.join(','),
    subject,
    text,
    html
  })

  console.log('[OpenAccountsSweeper] 扫描报告邮件已发送')
  return true
}

const buildRedemptionFlowSummaryBody = (summary) => {
  const {
    source = 'unknown',
    threshold = 0,
    pendingAuthorizationOrderCount = 0,
    lowStockChannels = [],
    bannedAccounts = [],
    triggeredAt = new Date()
  } = summary || {}

  const triggerText = triggeredAt instanceof Date ? triggeredAt.toLocaleString() : String(triggeredAt || '')

  const lowStockHtml = (lowStockChannels || []).length > 0
    ? `<ul>${lowStockChannels
        .map(item => {
          const name = String(item.channelName || item.channel || 'unknown')
          const available = Number(item.availableCount || 0)
          return `<li>${name}（${item.channel}）：${available}</li>`
        })
        .join('')}</ul>`
    : '<p>无</p>'

  const bannedHtml = (bannedAccounts || []).length > 0
    ? `<ul>${bannedAccounts
        .map(item => {
          const email = String(item.accountEmail || 'unknown')
          const id = Number(item.accountId || 0)
          const deleted = Number(item.deletedUnusedCodeCount || 0)
          const reason = String(item.reason || '')
          return `<li>${email} (ID=${id})，下架兑换码=${deleted}${reason ? `，原因：${reason}` : ''}</li>`
        })
        .join('')}</ul>`
    : '<p>无</p>'

  const lowStockText = (lowStockChannels || []).length > 0
    ? lowStockChannels
        .map(item => `- ${item.channelName || item.channel}（${item.channel}）：${Number(item.availableCount || 0)}`)
        .join('\n')
    : '无'

  const bannedText = (bannedAccounts || []).length > 0
    ? bannedAccounts
        .map(item => `- ${item.accountEmail || 'unknown'} (ID=${Number(item.accountId || 0)}) 下架兑换码=${Number(item.deletedUnusedCodeCount || 0)}${item.reason ? ` 原因=${item.reason}` : ''}`)
        .join('\n')
    : '无'

  return {
    html: [
      '<p>兑换链路告警汇总</p>',
      `<p>触发来源：${source}</p>`,
      `<p>触发时间：${triggerText}</p>`,
      `<p>低库存阈值：${threshold}</p>`,
      `<p>待授权订单数（open_accounts_board）：${Number(pendingAuthorizationOrderCount || 0)}</p>`,
      '<h4>低库存渠道</h4>',
      lowStockHtml,
      '<h4>本次封号账号</h4>',
      bannedHtml
    ].join('\n'),
    text: [
      '兑换链路告警汇总',
      `触发来源：${source}`,
      `触发时间：${triggerText}`,
      `低库存阈值：${threshold}`,
      `待授权订单数（open_accounts_board）：${Number(pendingAuthorizationOrderCount || 0)}`,
      '',
      '低库存渠道：',
      lowStockText,
      '',
      '本次封号账号：',
      bannedText
    ].join('\n')
  }
}

export async function sendRedemptionFlowSummaryEmail(summary = {}) {
  const settings = await getSmtpSettings()
  const smtpConfig = buildSmtpConfig(settings)
  if (!smtpConfig) {
    console.warn('[RedemptionAlert] SMTP 配置不完整，跳过发送汇总告警')
    return false
  }

  const recipients = parseRecipients(settings?.adminAlertEmail)
  if (recipients.length === 0) {
    console.warn('[RedemptionAlert] ADMIN_ALERT_EMAIL 未配置，跳过发送汇总告警')
    return false
  }

  const transporter = nodemailer.createTransport(smtpConfig)
  const from = String(settings?.smtp?.from || '').trim() || smtpConfig.auth.user
  const subject = process.env.REDEMPTION_ALERT_EMAIL_SUBJECT || '兑换链路汇总告警'
  const { html, text } = buildRedemptionFlowSummaryBody(summary)

  try {
    await transporter.sendMail({
      from,
      to: recipients.join(','),
      subject,
      text,
      html
    })
    console.log('[RedemptionAlert] 汇总告警邮件已发送')
    return true
  } catch (error) {
    console.warn('[RedemptionAlert] 汇总告警邮件发送失败', error?.message || error)
    return false
  }
}

export async function sendRedemptionOwnerNotificationEmail(payload = {}) {
  const settings = await getSmtpSettings()
  const smtpConfig = buildSmtpConfig(settings)
  if (!smtpConfig) {
    console.warn('[RedemptionNotify] SMTP 配置不完整，跳过发送账号通知邮件')
    return false
  }

  const recipient = String(payload?.to || '').trim()
  if (!recipient) {
    console.warn('[RedemptionNotify] 缺少收件邮箱，跳过发送账号通知邮件')
    return false
  }

  const code = String(payload?.code || '').trim()
  const channelName = String(payload?.channelName || payload?.channel || '').trim() || 'unknown'
  const channel = String(payload?.channel || '').trim() || 'unknown'
  const accountEmail = String(payload?.accountEmail || '').trim()
  const accountId = Number(payload?.accountId || 0) || null
  const redeemerEmail = String(payload?.redeemerEmail || '').trim()
  const redeemerUid = String(payload?.redeemerUid || '').trim()
  const inviteStatus = String(payload?.inviteStatus || '').trim() || '未知'
  const userCount = Number(payload?.userCount || 0)
  const inviteCountRaw = payload?.inviteCount
  const inviteCount = Number.isFinite(Number(inviteCountRaw)) ? Number(inviteCountRaw) : null
  const subject = String(process.env.REDEMPTION_OWNER_NOTIFY_SUBJECT || '兑换码使用通知').trim() || '兑换码使用通知'
  const from = String(settings?.smtp?.from || '').trim() || smtpConfig.auth.user
  const transporter = nodemailer.createTransport(smtpConfig)

  const text = [
    '您的账号兑换码已被使用，详情如下：',
    accountId ? `账号ID：${accountId}` : null,
    accountEmail ? `账号邮箱：${accountEmail}` : null,
    code ? `兑换码：${code}` : null,
    `渠道：${channelName} (${channel})`,
    redeemerEmail ? `兑换邮箱：${redeemerEmail}` : null,
    redeemerUid ? `兑换UID：${redeemerUid}` : null,
    `邀请状态：${inviteStatus}`,
    `当前用户数：${userCount}`,
    inviteCount != null ? `当前邀请数：${inviteCount}` : null,
    `通知时间：${new Date().toLocaleString()}`
  ].filter(Boolean).join('\n')

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif; line-height: 1.6;">
      <h2 style="margin: 0 0 12px;">兑换码使用通知</h2>
      <p style="margin: 0 0 8px;">您的账号兑换码已被使用，详情如下：</p>
      ${accountId ? `<p style="margin: 0 0 6px;">账号ID：<strong>${accountId}</strong></p>` : ''}
      ${accountEmail ? `<p style="margin: 0 0 6px;">账号邮箱：${escapeHtml(accountEmail)}</p>` : ''}
      ${code ? `<p style="margin: 0 0 6px;">兑换码：<strong>${escapeHtml(code)}</strong></p>` : ''}
      <p style="margin: 0 0 6px;">渠道：${escapeHtml(channelName)} (${escapeHtml(channel)})</p>
      ${redeemerEmail ? `<p style="margin: 0 0 6px;">兑换邮箱：${escapeHtml(redeemerEmail)}</p>` : ''}
      ${redeemerUid ? `<p style="margin: 0 0 6px;">兑换UID：${escapeHtml(redeemerUid)}</p>` : ''}
      <p style="margin: 0 0 6px;">邀请状态：${escapeHtml(inviteStatus)}</p>
      <p style="margin: 0 0 6px;">当前用户数：${userCount}${inviteCount != null ? `，当前邀请数：${inviteCount}` : ''}</p>
      <p style="margin: 0;">通知时间：${escapeHtml(new Date().toLocaleString())}</p>
    </div>
  `

  try {
    await transporter.sendMail({
      from,
      to: recipient,
      subject,
      text,
      html
    })
    console.log('[RedemptionNotify] 账号通知邮件已发送', {
      to: recipient,
      accountId,
      code
    })
    return true
  } catch (error) {
    console.warn('[RedemptionNotify] 发送账号通知邮件失败', error?.message || error)
    return false
  }
}

export async function sendPurchaseOrderEmail(order) {
  const settings = await getSmtpSettings()
  const smtpConfig = buildSmtpConfig(settings)
  if (!smtpConfig) {
    console.warn('[Purchase] SMTP 配置不完整，跳过发送订单邮件')
    return false
  }

  const to = String(order?.email || '').trim()
  if (!to) {
    console.warn('[Purchase] 缺少收件邮箱，跳过发送订单邮件')
    return false
  }

  const transporter = nodemailer.createTransport(smtpConfig)
  const from = String(settings?.smtp?.from || '').trim() || smtpConfig.auth.user
  const subject = process.env.PURCHASE_EMAIL_SUBJECT || '订单信息'

  const orderNo = String(order?.orderNo || '')
  const serviceDays = Number(order?.serviceDays || 30)

  const text = [
    `订单号：${orderNo}`,
    `邮箱：${to}`,
    `有效期：${serviceDays} 天（下单日起算）`,
  ].join('\n')

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif; line-height: 1.6;">
      <h2 style="margin: 0 0 12px;">订单信息</h2>
      <p style="margin: 0 0 6px;">订单号：<strong>${orderNo}</strong></p>
      <p style="margin: 0 0 6px;">邮箱：${to}</p>
      <p style="margin: 0 0 6px;">有效期：${serviceDays} 天（下单日起算）</p>
    </div>
  `

  try {
    await transporter.sendMail({
      from,
      to,
      subject,
      text,
      html,
    })
    console.log('[Purchase] order email sent', { orderNo })
    return true
  } catch (error) {
    console.warn('[Purchase] send order email failed', error?.message || error)
    return false
  }
}

export async function sendLdcShopDeliveryEmail({ to, orderNo, productName, content }) {
  const settings = await getSmtpSettings()
  const smtpConfig = buildSmtpConfig(settings)
  if (!smtpConfig) {
    console.warn('[LdcShop] SMTP 配置不完整，跳过发送交付邮件')
    return false
  }

  const recipient = String(to || '').trim()
  if (!recipient) {
    console.warn('[LdcShop] 缺少收件邮箱，跳过发送交付邮件')
    return false
  }

  const bodyContent = String(content || '').trim()
  if (!bodyContent) {
    console.warn('[LdcShop] 缺少交付内容，跳过发送交付邮件')
    return false
  }

  const transporter = nodemailer.createTransport(smtpConfig)
  const from = String(settings?.smtp?.from || '').trim() || smtpConfig.auth.user
  const subject = String(process.env.LDC_SHOP_EMAIL_SUBJECT || 'LDC 商品交付通知').trim() || 'LDC 商品交付通知'

  const normalizedOrderNo = String(orderNo || '').trim()
  const normalizedProductName = String(productName || '').trim()
  const text = [
    '您的 LDC 商品已交付，请妥善保管以下信息：',
    normalizedOrderNo ? `订单号：${normalizedOrderNo}` : null,
    normalizedProductName ? `商品：${normalizedProductName}` : null,
    '',
    bodyContent
  ].filter(Boolean).join('\n')

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif; line-height: 1.6;">
      <h2 style="margin: 0 0 12px;">LDC 商品交付通知</h2>
      ${normalizedOrderNo ? `<p style="margin: 0 0 6px;">订单号：<strong>${escapeHtml(normalizedOrderNo)}</strong></p>` : ''}
      ${normalizedProductName ? `<p style="margin: 0 0 12px;">商品：${escapeHtml(normalizedProductName)}</p>` : ''}
      <p style="margin: 0 0 6px;">交付内容：</p>
      <pre style="margin: 0; white-space: pre-wrap; word-break: break-word; background: #f5f7fa; border: 1px solid #e5e7eb; border-radius: 10px; padding: 12px;">${escapeHtml(bodyContent)}</pre>
    </div>
  `

  try {
    await transporter.sendMail({
      from,
      to: recipient,
      subject,
      text,
      html
    })
    console.log('[LdcShop] delivery email sent', { orderNo: normalizedOrderNo || null })
    return true
  } catch (error) {
    console.warn('[LdcShop] send delivery email failed', error?.message || error)
    return false
  }
}

export async function sendVerificationCodeEmail(email, code, options = {}) {
  const settings = await getSmtpSettings()
  const smtpConfig = buildSmtpConfig(settings)
  if (!smtpConfig) {
    console.warn('[VerifyCode] SMTP 配置不完整，跳过发送验证码邮件')
    return false
  }

  const to = String(email || '').trim()
  if (!to) {
    console.warn('[VerifyCode] 缺少收件邮箱，跳过发送验证码邮件')
    return false
  }

  const resolvedCode = String(code || '').trim()
  if (!resolvedCode) {
    console.warn('[VerifyCode] 缺少验证码，跳过发送验证码邮件')
    return false
  }

  const minutes = Number(options?.expiresMinutes || 10)
  const subject = options?.subject || process.env.EMAIL_VERIFICATION_SUBJECT || '邮箱验证码'
  const from = String(settings?.smtp?.from || '').trim() || smtpConfig.auth.user
  const transporter = nodemailer.createTransport(smtpConfig)

  const text = `您的验证码为：${resolvedCode}\n有效期：${minutes} 分钟\n如非本人操作请忽略本邮件。`
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif; line-height: 1.6;">
      <h2 style="margin: 0 0 12px;">邮箱验证码</h2>
      <p style="margin: 0 0 8px;">您的验证码为：</p>
      <p style="margin: 0 0 12px; font-size: 20px; font-weight: 700; letter-spacing: 2px;">${resolvedCode}</p>
      <p style="margin: 0 0 6px;">有效期：${minutes} 分钟</p>
      <p style="margin: 0; color: #666;">如非本人操作请忽略本邮件。</p>
    </div>
  `

  try {
    await transporter.sendMail({
      from,
      to,
      subject,
      text,
      html,
    })
    console.log('[VerifyCode] 验证码邮件已发送', { to })
    return true
  } catch (error) {
    console.warn('[VerifyCode] 发送验证码邮件失败', error?.message || error)
    return false
  }
}
