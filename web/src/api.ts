import type { Operation, SessionInfo } from './types'
import i18n, { t } from './i18n'

export class APIError extends Error {
  constructor(
    message: string,
    public code = 'NETWORK_ERROR',
    public uncertain = false,
    public status = 0,
    public retryAfter = 0,
    public retryable?: boolean,
  ) {
    super(message)
    this.name = 'APIError'
  }
}

let sessionPromise: Promise<SessionInfo> | null = null

export function loadSession(reset = false): Promise<SessionInfo> {
  if (reset) sessionPromise = null
  if (!sessionPromise) {
    sessionPromise = fetch('/api/session', {
      credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    }).then(async (response) => {
      const envelope = await response.json()
      if (!response.ok || envelope.ok !== true || typeof envelope.data?.csrf_token !== 'string' || !Array.isArray(envelope.data?.systems)) {
        throw new APIError(envelope.error?.message || '无法建立安全会话，请刷新后重试')
      }
      return envelope.data as SessionInfo
    }).catch((error: unknown) => {
      sessionPromise = null
      throw error
    })
  }
  return sessionPromise
}

export async function api<T>(operation: Operation, body: object, signal?: AbortSignal): Promise<T> {
  const isRedeem = operation === 'redeem'
  const session = await loadSession()
  const serialized = JSON.stringify(body)
  if (new TextEncoder().encode(serialized).length > 256 * 1024) {
    throw new APIError('请求超过 256 KiB，请缩短凭证或分批操作', 'BODY_TOO_LARGE')
  }
  const timeout = AbortSignal.timeout(isRedeem ? 165_000 : 135_000)
  try {
    const response = await fetch(`/api/${operation}`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf_token, 'Accept-Language': i18n.language },
      body: serialized,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    const retryAfter = Math.max(3, Number(response.headers.get('Retry-After')) || 60)
    let envelope
    try { envelope = await response.json() } catch {
      throw new APIError('响应暂时无法确认，请查询原记录', 'INVALID_RESPONSE', isRedeem, response.status, retryAfter)
    }
    if (!response.ok || envelope.ok !== true) {
      throw new APIError(
        envelope.error?.message || '请求未完成，请稍后查询',
        envelope.error?.code || 'REQUEST_REJECTED',
        envelope.error?.uncertain === true || (isRedeem && response.status >= 500),
        response.status, retryAfter,
        typeof envelope.error?.retryable === 'boolean' ? envelope.error.retryable : undefined,
      )
    }
    if (!validData(operation, envelope.data)) {
      throw new APIError('接口数据不完整，请查询原记录', 'INVALID_RESPONSE', isRedeem)
    }
    return envelope.data as T
  } catch (error) {
    if (error instanceof APIError) throw error
    if (signal?.aborted) throw error
    throw new APIError(isRedeem ? '连接中断，提交结果待确认。请查询原记录，不要重新提交。' : '网络暂时无法连接，请稍后重试', 'NETWORK_ERROR', isRedeem)
  }
}

function validData(operation: Operation, data: unknown): boolean {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false
  const value = data as Record<string, unknown>
  const text = (key: string) => typeof value[key] === 'string' && !!value[key]
  if (operation === 'preview') return text('redemption_token') && text('product') && text('plan')
  if (['result', 'result-by-code', 'redeem'].includes(operation)) {
    return text('status') && (value.message === undefined || typeof value.message === 'string')
      && (value.events === undefined || Array.isArray(value.events))
  }
  if (operation === 'lookup') return text('cdk_code')
  if (operation === 'lookup-batch') {
    return Array.isArray(value.results) && value.results.every((row) => row && typeof row === 'object' && typeof row.cdk_code === 'string')
  }
  if (operation === 'billing') {
    return (value.summary == null || (typeof value.summary === 'object' && !Array.isArray(value.summary)))
      && (value.last_payment == null || (typeof value.last_payment === 'object' && !Array.isArray(value.last_payment)))
      && (value.invoices == null || (Array.isArray(value.invoices) && value.invoices.every((row) => row && typeof row === 'object' && !Array.isArray(row))))
  }
  return true
}

export function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return t('操作未完成，请稍后重试')
  if (i18n.exists(error.message)) return t(error.message)
  if (i18n.language === 'en' && /[\u4e00-\u9fff]/.test(error.message)) {
    return `${t('接口返回错误（{{code}}），请核对输入或联系发卡方。', { code: error instanceof APIError ? error.code : 'VALIDATION' })} ${t('上游原始说明')}: ${error.message}`
  }
  return error.message
}
