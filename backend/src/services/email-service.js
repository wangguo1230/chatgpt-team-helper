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

export async function sendInviteDomainRiskAlertEmail(payload = {}) {
  const domain = String(payload?.domain || '').trim().toLowerCase()
  if (!domain) {
    console.warn('[InviteDomainRisk] 缺少域名，跳过发送告警邮件')
    return false
  }

  const triggerAccountId = Number(payload?.triggerAccountId || 0)
  const triggerAccountEmail = String(payload?.triggerAccountEmail || '').trim()
  const closedAccountCount = Number(payload?.closedAccountCount || 0)
  const deletedUnusedCodeCount = Number(payload?.deletedUnusedCodeCount || 0)
  const reason = String(payload?.reason || '').trim()
  const triggeredAt = payload?.triggeredAt ? new Date(payload.triggeredAt) : new Date()
  const resolvedTriggeredAt = Number.isNaN(triggeredAt.getTime()) ? new Date() : triggeredAt

  const affectedAccounts = Array.isArray(payload?.affectedAccounts)
    ? payload.affectedAccounts
      .map(item => {
        const id = Number(item?.id || 0)
        const email = String(item?.email || '').trim()
        const wasOpen = Boolean(item?.wasOpen)
        if (!email) return null
        return { id: Number.isFinite(id) && id > 0 ? id : 0, email, wasOpen }
      })
      .filter(Boolean)
    : []

  const affectedText = affectedAccounts.length > 0
    ? affectedAccounts
      .map(item => `- ${item.email}${item.id ? ` (ID=${item.id})` : ''}${item.wasOpen ? ' [已关闭开放]' : ''}`)
      .join('\n')
    : '无'

  const affectedHtml = affectedAccounts.length > 0
    ? `<ul>${affectedAccounts
      .map(item => `<li>${escapeHtml(item.email)}${item.id ? ` (ID=${item.id})` : ''}${item.wasOpen ? ' [已关闭开放]' : ''}</li>`)
      .join('')}</ul>`
    : '<p>无</p>'

  const subject = String(
    process.env.INVITE_DOMAIN_RISK_ALERT_EMAIL_SUBJECT || `开放账号域名风控告警 @${domain}`
  ).trim() || `开放账号域名风控告警 @${domain}`

  const text = [
    '检测到开放账号邀请域名疑似被风控，已执行自动处置。',
    `触发时间：${resolvedTriggeredAt.toLocaleString()}`,
    `疑似风控域名：${domain}`,
    triggerAccountEmail ? `触发账号：${triggerAccountEmail}${triggerAccountId > 0 ? ` (ID=${triggerAccountId})` : ''}` : null,
    reason ? `触发原因：${reason}` : null,
    `关闭开放账号数：${closedAccountCount}`,
    `删除未使用兑换码数：${deletedUnusedCodeCount}`,
    '',
    '涉及账号：',
    affectedText
  ].filter(Boolean).join('\n')

  const html = [
    '<div style="font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, PingFang SC, Microsoft YaHei, sans-serif; line-height: 1.6;">',
    '<h2 style="margin: 0 0 12px;">开放账号域名风控告警</h2>',
    '<p style="margin: 0 0 8px;">检测到开放账号邀请域名疑似被风控，已执行自动处置。</p>',
    `<p style="margin: 0 0 6px;">触发时间：<strong>${escapeHtml(resolvedTriggeredAt.toLocaleString())}</strong></p>`,
    `<p style="margin: 0 0 6px;">疑似风控域名：<strong>${escapeHtml(domain)}</strong></p>`,
    triggerAccountEmail
      ? `<p style="margin: 0 0 6px;">触发账号：<strong>${escapeHtml(triggerAccountEmail)}${triggerAccountId > 0 ? ` (ID=${triggerAccountId})` : ''}</strong></p>`
      : '',
    reason ? `<p style="margin: 0 0 6px;">触发原因：${escapeHtml(reason)}</p>` : '',
    `<p style="margin: 0 0 6px;">关闭开放账号数：<strong>${closedAccountCount}</strong></p>`,
    `<p style="margin: 0 0 6px;">删除未使用兑换码数：<strong>${deletedUnusedCodeCount}</strong></p>`,
    '<h4 style="margin: 12px 0 6px;">涉及账号</h4>',
    affectedHtml,
    '</div>'
  ].join('\n')

  return sendAdminAlertEmail({ subject, text, html })
}

const normalizeRiskAttempts = (attempts) => {
  if (!Array.isArray(attempts)) return []
  return attempts
    .map((item, index) => {
      const accountId = Number(item?.accountId || 0)
      const accountEmail = String(item?.accountEmail || '').trim()
      const reason = String(item?.reason || '').trim() || '未知失败'
      const status = String(item?.status || '').trim()
      if (!accountEmail && accountId <= 0) return null
      return {
        index: index + 1,
        accountId: accountId > 0 ? accountId : null,
        accountEmail: accountEmail || '',
        reason,
        status
      }
    })
    .filter(Boolean)
}

export async function sendOpenAccountsDomainRiskUserEmail(payload = {}) {
  const settings = await getSmtpSettings()
  const smtpConfig = buildSmtpConfig(settings)
  if (!smtpConfig) {
    console.warn('[OpenAccountsRiskUserMail] SMTP 配置不完整，跳过发送用户邮件')
    return false
  }

  const to = String(payload?.to || '').trim()
  if (!to) {
    console.warn('[OpenAccountsRiskUserMail] 缺少收件邮箱，跳过发送用户邮件')
    return false
  }

  const action = String(payload?.action || '').trim().toLowerCase()
  const isRefunded = action === 'refunded'
  const isRefundFailed = action === 'refund_failed'
  if (!isRefunded && !isRefundFailed) {
    return false
  }

  const orderNo = String(payload?.orderNo || '').trim()
  const refundMessage = String(payload?.refundMessage || '').trim()

  const actionText = isRefunded ? '已自动退款' : '退款未完成，请联系管理员处理'
  const subject = String(
    payload?.subject
    || process.env.OPEN_ACCOUNTS_REFUND_USER_SUBJECT
    || '开放账号订单退款通知'
  ).trim()
  const from = String(settings?.smtp?.from || '').trim() || smtpConfig.auth.user
  const transporter = nodemailer.createTransport(smtpConfig)

  const text = [
    '您的开放账号订单退款处理结果如下：',
    `处理结果：${actionText}`,
    orderNo ? `订单号：${orderNo}` : null,
    refundMessage ? `退款说明：${refundMessage}` : null
  ].filter(Boolean).join('\n')

  const html = [
    '<div style="font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, PingFang SC, Microsoft YaHei, sans-serif; line-height: 1.6;">',
    '<h2 style="margin: 0 0 12px;">开放账号订单退款通知</h2>',
    '<p style="margin: 0 0 8px;">您的开放账号订单退款处理结果如下：</p>',
    `<p style="margin: 0 0 6px;">处理结果：<strong>${escapeHtml(actionText)}</strong></p>`,
    orderNo ? `<p style="margin: 0 0 6px;">订单号：<strong>${escapeHtml(orderNo)}</strong></p>` : '',
    refundMessage ? `<p style="margin: 0 0 6px;">退款说明：${escapeHtml(refundMessage)}</p>` : '',
    '<p style="margin: 12px 0 0;">如有疑问请联系管理员。</p>',
    '</div>'
  ].join('\n')

  try {
    await transporter.sendMail({
      from,
      to,
      subject: subject || '开放账号邀请异常处理通知',
      text,
      html
    })
    console.log('[OpenAccountsRiskUserMail] 用户通知邮件已发送', { to, orderNo, action: action || 'unknown' })
    return true
  } catch (error) {
    console.warn('[OpenAccountsRiskUserMail] 发送用户通知邮件失败', error?.message || error)
    return false
  }
}

export async function sendOpenAccountsDomainRiskAdminEmail(payload = {}) {
  const action = String(payload?.action || '').trim().toLowerCase()
  const actionText = action === 'transfer'
    ? '自动转移成功'
    : action === 'refunded'
      ? '自动退款成功'
      : action === 'refund_failed'
        ? '自动退款失败'
        : '已处理'

  const orderNo = String(payload?.orderNo || '').trim()
  const uid = String(payload?.uid || '').trim()
  const username = String(payload?.username || '').trim()
  const userEmail = String(payload?.userEmail || '').trim()
  const triggerDomain = String(payload?.triggerDomain || '').trim()
  const triggerAccountEmail = String(payload?.triggerAccountEmail || '').trim()
  const triggerAccountId = Number(payload?.triggerAccountId || 0)
  const transferAccountEmail = String(payload?.transferAccountEmail || '').trim()
  const transferAccountId = Number(payload?.transferAccountId || 0)
  const closedAccountCount = Number(payload?.closedAccountCount || 0)
  const deletedUnusedCodeCount = Number(payload?.deletedUnusedCodeCount || 0)
  const fallbackAttempted = Number(payload?.fallbackAttempted || 0)
  const refundMessage = String(payload?.refundMessage || '').trim()
  const attempts = normalizeRiskAttempts(payload?.attempts)

  const attemptsText = attempts.length > 0
    ? attempts.map(item => {
      const label = item.accountEmail || `ID=${item.accountId || 'unknown'}`
      const status = item.status ? `${item.status} / ` : ''
      return `- [${item.index}] ${label}${item.accountId ? ` (ID=${item.accountId})` : ''} => ${status}${item.reason}`
    }).join('\n')
    : '无'

  const attemptsHtml = attempts.length > 0
    ? `<ul>${attempts.map(item => {
      const label = item.accountEmail || `ID=${item.accountId || 'unknown'}`
      const status = item.status ? `${escapeHtml(item.status)} / ` : ''
      return `<li>[${item.index}] ${escapeHtml(label)}${item.accountId ? ` (ID=${item.accountId})` : ''} =&gt; ${status}${escapeHtml(item.reason)}</li>`
    }).join('')}</ul>`
    : '<p>无</p>'

  const subject = String(
    payload?.subject
    || process.env.OPEN_ACCOUNTS_DOMAIN_RISK_ADMIN_SUBJECT
    || `开放账号域名风控订单处置：${actionText}${orderNo ? ` #${orderNo}` : ''}`
  ).trim()

  const text = [
    '开放账号订单触发域名风控后的自动处置结果如下：',
    `结果：${actionText}`,
    orderNo ? `订单号：${orderNo}` : null,
    uid ? `用户UID：${uid}` : null,
    username ? `用户名：${username}` : null,
    userEmail ? `邀请邮箱：${userEmail}` : null,
    triggerDomain ? `疑似风控域名：${triggerDomain}` : null,
    triggerAccountEmail
      ? `触发账号：${triggerAccountEmail}${triggerAccountId > 0 ? ` (ID=${triggerAccountId})` : ''}`
      : null,
    transferAccountEmail
      ? `转移账号：${transferAccountEmail}${transferAccountId > 0 ? ` (ID=${transferAccountId})` : ''}`
      : null,
    `关闭账号数：${closedAccountCount}`,
    `删除未使用兑换码数：${deletedUnusedCodeCount}`,
    `后备账号尝试次数：${Math.max(0, fallbackAttempted)}`,
    refundMessage ? `退款信息：${refundMessage}` : null,
    '',
    '后备账号尝试明细：',
    attemptsText
  ].filter(Boolean).join('\n')

  const html = [
    '<div style="font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, PingFang SC, Microsoft YaHei, sans-serif; line-height: 1.6;">',
    '<h2 style="margin: 0 0 12px;">开放账号域名风控订单处置</h2>',
    `<p style="margin: 0 0 6px;">结果：<strong>${escapeHtml(actionText)}</strong></p>`,
    orderNo ? `<p style="margin: 0 0 6px;">订单号：<strong>${escapeHtml(orderNo)}</strong></p>` : '',
    uid ? `<p style="margin: 0 0 6px;">用户UID：${escapeHtml(uid)}</p>` : '',
    username ? `<p style="margin: 0 0 6px;">用户名：${escapeHtml(username)}</p>` : '',
    userEmail ? `<p style="margin: 0 0 6px;">邀请邮箱：${escapeHtml(userEmail)}</p>` : '',
    triggerDomain ? `<p style="margin: 0 0 6px;">疑似风控域名：<strong>${escapeHtml(triggerDomain)}</strong></p>` : '',
    triggerAccountEmail
      ? `<p style="margin: 0 0 6px;">触发账号：<strong>${escapeHtml(triggerAccountEmail)}${triggerAccountId > 0 ? ` (ID=${triggerAccountId})` : ''}</strong></p>`
      : '',
    transferAccountEmail
      ? `<p style="margin: 0 0 6px;">转移账号：<strong>${escapeHtml(transferAccountEmail)}${transferAccountId > 0 ? ` (ID=${transferAccountId})` : ''}</strong></p>`
      : '',
    `<p style="margin: 0 0 6px;">关闭账号数：<strong>${closedAccountCount}</strong></p>`,
    `<p style="margin: 0 0 6px;">删除未使用兑换码数：<strong>${deletedUnusedCodeCount}</strong></p>`,
    `<p style="margin: 0 0 6px;">后备账号尝试次数：<strong>${Math.max(0, fallbackAttempted)}</strong></p>`,
    refundMessage ? `<p style="margin: 0 0 6px;">退款信息：${escapeHtml(refundMessage)}</p>` : '',
    '<h4 style="margin: 12px 0 6px;">后备账号尝试明细</h4>',
    attemptsHtml,
    '</div>'
  ].join('\n')

  return sendAdminAlertEmail({
    subject: subject || '开放账号域名风控订单处置',
    text,
    html
  })
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

const resolveAlipayRedpackSupportLinks = () => {
  const afterSalesUrl = String(
    process.env.ALIPAY_REDPACK_SUPPORT_SELF_SERVICE_URL || 'http://ldc.lizitool.de5.net/redeem/alipay-redpack'
  ).trim() || 'http://ldc.lizitool.de5.net/redeem/alipay-redpack'
  const supportGroupUrl = String(
    process.env.ALIPAY_REDPACK_SUPPORT_GROUP_URL || 'https://t.me/+fCeXgVykd7xjY2Jl'
  ).trim() || 'https://t.me/+fCeXgVykd7xjY2Jl'
  const telegramUrl = String(
    process.env.ALIPAY_REDPACK_SUPPORT_TG_URL || 'https://t.me/liziwang'
  ).trim() || 'https://t.me/liziwang'
  return {
    afterSalesUrl,
    supportGroupUrl,
    telegramUrl,
  }
}

export async function sendAlipayRedpackOrderProcessedEmail({ to, orderId } = {}) {
  const settings = await getSmtpSettings()
  const smtpConfig = buildSmtpConfig(settings)
  if (!smtpConfig) {
    console.warn('[AlipayRedpackOrderEmail] SMTP 配置不完整，跳过发送订单处理通知邮件')
    return false
  }

  const recipient = String(to || '').trim()
  if (!recipient) {
    console.warn('[AlipayRedpackOrderEmail] 缺少收件邮箱，跳过发送订单处理通知邮件')
    return false
  }

  const subject = String(
    process.env.ALIPAY_REDPACK_ORDER_PROCESSED_EMAIL_SUBJECT || '支付宝口令订单已处理通知'
  ).trim() || '支付宝口令订单已处理通知'
  const {
    afterSalesUrl,
    supportGroupUrl,
    telegramUrl,
  } = resolveAlipayRedpackSupportLinks()

  const normalizedOrderId = Number(orderId || 0)
  const orderLabel = Number.isFinite(normalizedOrderId) && normalizedOrderId > 0
    ? `订单ID：#${Math.floor(normalizedOrderId)}`
    : ''
  const text = [
    '您好，您的订单已处理，请查收邮箱是否有GPT邀请。',
    orderLabel || null,
    `售后：访问 ${afterSalesUrl} 自助补录。`,
    `TG售后群: ${supportGroupUrl}`,
    `TG: ${telegramUrl}`,
  ].filter(Boolean).join('\n')

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif; line-height: 1.7;">
      <h2 style="margin: 0 0 12px;">支付宝口令订单通知</h2>
      <p style="margin: 0 0 10px;">您好，您的订单已处理，请查收邮箱是否有 GPT 邀请。</p>
      ${orderLabel ? `<p style="margin: 0 0 10px;">${escapeHtml(orderLabel)}</p>` : ''}
      <p style="margin: 0 0 6px;">售后：访问 <a href="${escapeHtml(afterSalesUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(afterSalesUrl)}</a> 自助补录。</p>
      <p style="margin: 0 0 6px;">TG售后群：<a href="${escapeHtml(supportGroupUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(supportGroupUrl)}</a></p>
      <p style="margin: 0;">TG：<a href="${escapeHtml(telegramUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(telegramUrl)}</a></p>
    </div>
  `

  const from = String(settings?.smtp?.from || '').trim() || smtpConfig.auth.user
  const transporter = nodemailer.createTransport(smtpConfig)

  try {
    await transporter.sendMail({
      from,
      to: recipient,
      subject,
      text,
      html,
    })
    console.log('[AlipayRedpackOrderEmail] 订单处理通知邮件已发送', {
      to: recipient,
      orderId: orderLabel || null,
    })
    return true
  } catch (error) {
    console.warn('[AlipayRedpackOrderEmail] 订单处理通知邮件发送失败', error?.message || error)
    return false
  }
}

export async function sendAlipayRedpackOrderReturnedEmail({ to, orderId, reason } = {}) {
  const settings = await getSmtpSettings()
  const smtpConfig = buildSmtpConfig(settings)
  if (!smtpConfig) {
    console.warn('[AlipayRedpackOrderEmail] SMTP 配置不完整，跳过发送订单退回通知邮件')
    return false
  }

  const recipient = String(to || '').trim()
  if (!recipient) {
    console.warn('[AlipayRedpackOrderEmail] 缺少收件邮箱，跳过发送订单退回通知邮件')
    return false
  }

  const subject = String(
    process.env.ALIPAY_REDPACK_ORDER_RETURNED_EMAIL_SUBJECT || '支付宝口令订单退回通知'
  ).trim() || '支付宝口令订单退回通知'
  const {
    afterSalesUrl,
    supportGroupUrl,
    telegramUrl,
  } = resolveAlipayRedpackSupportLinks()

  const normalizedOrderId = Number(orderId || 0)
  const orderLabel = Number.isFinite(normalizedOrderId) && normalizedOrderId > 0
    ? `订单ID：#${Math.floor(normalizedOrderId)}`
    : ''
  const normalizedReason = String(reason || '').trim() || '口令不可用'
  const text = [
    '您好，您的支付宝口令订单已退回。',
    orderLabel || null,
    `退回原因：${normalizedReason}`,
    '如需继续处理，请重新提交有效口令。',
    `售后：访问 ${afterSalesUrl} 自助补录。`,
    `TG售后群: ${supportGroupUrl}`,
    `TG: ${telegramUrl}`,
  ].filter(Boolean).join('\n')

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif; line-height: 1.7;">
      <h2 style="margin: 0 0 12px;">支付宝口令订单退回通知</h2>
      <p style="margin: 0 0 10px;">您好，您的支付宝口令订单已退回。</p>
      ${orderLabel ? `<p style="margin: 0 0 10px;">${escapeHtml(orderLabel)}</p>` : ''}
      <p style="margin: 0 0 10px;">退回原因：${escapeHtml(normalizedReason)}</p>
      <p style="margin: 0 0 10px;">如需继续处理，请重新提交有效口令。</p>
      <p style="margin: 0 0 6px;">售后：访问 <a href="${escapeHtml(afterSalesUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(afterSalesUrl)}</a> 自助补录。</p>
      <p style="margin: 0 0 6px;">TG售后群：<a href="${escapeHtml(supportGroupUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(supportGroupUrl)}</a></p>
      <p style="margin: 0;">TG：<a href="${escapeHtml(telegramUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(telegramUrl)}</a></p>
    </div>
  `

  const from = String(settings?.smtp?.from || '').trim() || smtpConfig.auth.user
  const transporter = nodemailer.createTransport(smtpConfig)

  try {
    await transporter.sendMail({
      from,
      to: recipient,
      subject,
      text,
      html,
    })
    console.log('[AlipayRedpackOrderEmail] 订单退回通知邮件已发送', {
      to: recipient,
      orderId: orderLabel || null,
    })
    return true
  } catch (error) {
    console.warn('[AlipayRedpackOrderEmail] 订单退回通知邮件发送失败', error?.message || error)
    return false
  }
}

export async function sendAlipayRedpackMotherDeliveryEmail({ to, orderId, productName, accounts = [] } = {}) {
  const settings = await getSmtpSettings()
  const smtpConfig = buildSmtpConfig(settings)
  if (!smtpConfig) {
    console.warn('[AlipayRedpackMotherEmail] SMTP 配置不完整，跳过发送母号交付邮件')
    return false
  }

  const recipient = String(to || '').trim()
  if (!recipient) {
    console.warn('[AlipayRedpackMotherEmail] 缺少收件邮箱，跳过发送母号交付邮件')
    return false
  }

  const normalizedAccounts = Array.isArray(accounts)
    ? accounts
      .map((item) => ({
        email: String(item?.email || '').trim().toLowerCase(),
        gptPassword: String(item?.gptPassword || '').trim(),
        emailPassword: String(item?.emailPassword || '').trim(),
      }))
      .filter(item => item.email)
    : []

  if (!normalizedAccounts.length) {
    console.warn('[AlipayRedpackMotherEmail] 缺少可交付母号，跳过发送母号交付邮件')
    return false
  }

  const subject = String(
    process.env.ALIPAY_REDPACK_MOTHER_DELIVERY_SUBJECT || 'GPT 母号交付通知'
  ).trim() || 'GPT 母号交付通知'
  const orderLabel = Number(orderId || 0) > 0 ? `#${Math.floor(Number(orderId))}` : '-'
  const productLabel = String(productName || '').trim() || 'GPT 母号'

  const accountLines = normalizedAccounts.map((item, index) => {
    return [
      `${index + 1}. 账号邮箱：${item.email}`,
      `   GPT 密码：${item.gptPassword || '(未配置)'}`,
      `   邮箱密码：${item.emailPassword || '(未配置)'}`,
    ].join('\n')
  })

  const text = [
    '您的 GPT 母号订单已完成交付，账号信息如下：',
    `订单ID：${orderLabel}`,
    `商品：${productLabel}`,
    '',
    ...accountLines,
    '',
    '请妥善保存以上凭据，避免泄露。',
  ].join('\n')

  const accountHtml = normalizedAccounts.map((item, index) => `
    <div style="border:1px solid #e5e7eb;border-radius:10px;padding:10px;margin-bottom:10px;background:#f9fafb;">
      <p style="margin:0 0 6px;"><strong>${index + 1}. 账号邮箱：</strong>${escapeHtml(item.email)}</p>
      <p style="margin:0 0 6px;"><strong>GPT 密码：</strong>${escapeHtml(item.gptPassword || '(未配置)')}</p>
      <p style="margin:0;"><strong>邮箱密码：</strong>${escapeHtml(item.emailPassword || '(未配置)')}</p>
    </div>
  `).join('\n')

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif; line-height: 1.7;">
      <h2 style="margin: 0 0 12px;">GPT 母号交付通知</h2>
      <p style="margin: 0 0 8px;">您的 GPT 母号订单已完成交付，账号信息如下：</p>
      <p style="margin: 0 0 6px;">订单ID：<strong>${escapeHtml(orderLabel)}</strong></p>
      <p style="margin: 0 0 12px;">商品：${escapeHtml(productLabel)}</p>
      ${accountHtml}
      <p style="margin: 12px 0 0;color:#374151;">请妥善保存以上凭据，避免泄露。</p>
    </div>
  `

  const from = String(settings?.smtp?.from || '').trim() || smtpConfig.auth.user
  const transporter = nodemailer.createTransport(smtpConfig)
  try {
    await transporter.sendMail({
      from,
      to: recipient,
      subject,
      text,
      html,
    })
    console.log('[AlipayRedpackMotherEmail] 母号交付邮件已发送', {
      to: recipient,
      orderId: orderLabel,
      accountCount: normalizedAccounts.length,
    })
    return true
  } catch (error) {
    console.warn('[AlipayRedpackMotherEmail] 母号交付邮件发送失败', error?.message || error)
    return false
  }
}
