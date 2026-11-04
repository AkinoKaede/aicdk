import { t, locale } from './i18n'
import type { Preflight, Preview } from './types'

const terminal = new Set(['completed', 'declined', 'failed_precharge', 'cancelled', 'failed'])
export const isTerminal = (status?: string) => typeof status === 'string' && terminal.has(status.toLowerCase())
export const isCompleted = (status?: string) => typeof status === 'string' && status.toLowerCase() === 'completed'

export function statusLabel(status?: string): string {
  if (typeof status !== 'string') return t('状态未知')
  const labels: Record<string, string> = {
    completed: t('兑换完成'), queued: t('等待处理'), processing: t('处理中'), pending: t('等待确认'),
    declined: t('充值被拒绝'), failed_precharge: t('充值前失败'), cancelled: t('已取消'), failed: t('兑换失败'),
    unused: t('未使用'), used: t('已使用'), unknown: t('状态未知'), uncertain: t('结果待确认'),
    prepared: t('待确认'), submitting: t('提交中'), checking: t('预检中'),
  }
  return labels[(status || '').toLowerCase()] || (status ? t('处理中 · {{status}}', { status }) : t('状态未知'))
}

export function productName(product?: string): string {
  if (typeof product !== 'string') return t('未知产品')
  const names: Record<string, string> = { gpt: 'ChatGPT', chatgpt: 'ChatGPT', grok: 'Grok', claude: 'Claude', x: 'X' }
  return names[(product || '').toLowerCase()] || product || t('未知产品')
}

export function credentialHelp(product?: string): string {
  switch (product?.toLowerCase()) {
    case 'gpt': case 'chatgpt': return t('粘贴包含 sessionToken 或 session_token 的完整 Session JSON，仅 Access Token 不可用。')
    case 'claude': return t('粘贴登录账号的 sessionKey，不是 Anthropic API Key。')
    case 'grok': return t('粘贴目标账号的 SSO 凭证。确认账号后才会提交兑换。')
    case 'x': return t('粘贴包含 billing_email、auth_token、ct0 的 JSON，或包含邮箱与 cookieHeader 的完整凭证。')
    default: return t('请提供与卡密产品对应的完整登录凭证，并按照发卡方指引获取。')
  }
}

export const accountEmail = (preflight: Preflight) => typeof preflight.email === 'string' && preflight.email.trim()
  ? preflight.email : typeof preflight.account_email === 'string' ? preflight.account_email.trim() : ''

export function blockingReason(preview: Preview, preflight: Preflight): string | null {
  if (preflight.blocking_reason) {
    return typeof preflight.blocking_reason === 'string' ? preflight.blocking_reason : t('账号存在阻断条件，请联系发卡方核对')
  }
  if (preflight.subscription_recovery_required === true) return t('账号需要恢复原订阅，请联系人工处理；此页面不会取消或恢复订阅。')
  if (!accountEmail(preflight)) return t('未取得可供核对的账号邮箱，为避免充错账号，暂不允许提交。')
  if (preview.product?.toLowerCase() !== 'grok' && (typeof preflight.preflight_token !== 'string' || !preflight.preflight_token.trim())) return t('缺少本次预检凭证，请重新预检。')
  return null
}

export function validateCredential(value: string): string {
  if (!value.trim()) throw new Error(t('请输入完整账号凭证'))
  if (new TextEncoder().encode(value).length > 128 * 1024) throw new Error(t('账号凭证不能超过 128 KiB'))
  return value
}

export function maskCode(code: string): string {
  return code.length > 10 ? `${code.slice(0, 4)}••••${code.slice(-4)}` : '••••••••'
}

export function displayDate(value?: string | number | null): string {
  if (value === undefined || value === null || value === '') return t('未提供')
  const numeric = typeof value === 'number' || /^\d+(\.\d+)?$/.test(value) ? Number(value) : NaN
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 1e12 ? numeric * 1000 : numeric)
    : new Date(value)
  return Number.isNaN(date.getTime()) ? t('未提供') : date.toLocaleString(locale(), { hour12: false })
}

export function displayAmount(value?: number | string | null, currency?: string): string {
  if (value === undefined || value === null || value === '' || (typeof value === 'string' && !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))) return t('未提供')
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return t('未提供')
  return `${numeric.toLocaleString(locale(), { maximumFractionDigits: 8 })}${currency ? ` ${currency.toUpperCase()}` : t('（币种未提供）')}`
}

export function safeInvoiceURL(value?: string): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return undefined
    return url.href
  } catch { return undefined }
}

export interface ImportRow { row: number; code: string; session: string }

export function pairRows(codes: string[], sessions: string[], offset = 1): ImportRow[] {
  if (!codes.length || codes.length !== sessions.length) throw new Error(t('卡密和凭证行数必须相同，且不能留空；不会自动删除空行。'))
  if (codes.length > 100) throw new Error(t('每批最多 100 行，请分批操作'))
  const seen = new Set<string>()
  return codes.map((raw, i) => {
    const code = raw.trim(), session = sessions[i], row = i + offset
    if (!code || !session?.trim()) throw new Error(t('第 {{row}} 行卡密或凭证为空，请修正原始行，避免配对错位。', { row }))
    if (new TextEncoder().encode(code).length > 256) throw new Error(t('第 {{row}} 行卡密过长', { row }))
    if (seen.has(code.toUpperCase())) throw new Error(t('第 {{row}} 行卡密重复', { row }))
    seen.add(code.toUpperCase())
    validateCredential(session)
    return { row, code, session }
  })
}

export function parseCSV(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], cell = '', quoted = false, closed = false
  const input = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') { cell += '"'; i++ }
      else if (ch === '"') { quoted = false; closed = true }
      else cell += ch
    } else if (ch === ',' || ch === '\n') {
      row.push(cell); cell = ''; closed = false
      if (ch === '\n') { rows.push(row); row = [] }
    } else if (ch === '"' && cell === '' && !closed) quoted = true
    else {
      if (closed || ch === '"') throw new Error(t('CSV 引号格式错误，请使用标准 CSV 导出'))
      cell += ch
    }
  }
  if (quoted) throw new Error(t('CSV 中存在未闭合的引号'))
  if (cell || row.length || closed || !input.endsWith('\n')) { row.push(cell); rows.push(row) }
  return rows
}

export function rowsFromSheet(rows: unknown[][]): ImportRow[] {
  if (rows.length < 2) throw new Error(t('文件需要表头 code、session 和至少一行数据'))
  const headers = rows[0].map((v) => String(v ?? '').trim().toLowerCase())
  const codeIndex = headers.findIndex((v) => ['code', 'cdk', '卡密'].includes(v))
  const sessionIndex = headers.findIndex((v) => ['session', '凭证'].includes(v))
  if (codeIndex < 0 || sessionIndex < 0 || new Set(headers).size !== headers.length) throw new Error(t('表头需要唯一的 code（卡密）和 session（凭证）列'))
  const data = rows.slice(1)
  // Reject numeric cells: converting them may already have lost CDK leading zeros.
  const text = (value: unknown, row: number) => {
    if (value === null || value === undefined) return ''
    if (typeof value !== 'string') throw new Error(t('第 {{row}} 行请使用文本格式，避免卡密或凭证被 Excel 改写', { row }))
    return value
  }
  return pairRows(data.map((r, i) => text(r[codeIndex], i + 2)), data.map((r, i) => text(r[sessionIndex], i + 2)), 2)
}
