import { t } from './i18n'
import { maskCode } from './model'

const storageKey = 'cdk-attempts-v1'
export interface Attempt {
  codeHash: string
  tokenHash: string
  requestId: string
  maskedCode: string
  row?: number
  createdAt: string
  status: string
}

export function readAttempts(): Attempt[] {
  const raw = localStorage.getItem(storageKey)
  if (!raw) return []
  const entries: unknown = JSON.parse(raw)
  if (!Array.isArray(entries) || entries.some((entry) => !entry || typeof entry.codeHash !== 'string' || typeof entry.requestId !== 'string')) {
    throw new Error(t('本地提交记录损坏，请先使用原卡密查询进度，不要重复提交'))
  }
  return entries as Attempt[]
}

async function hash(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error(t('当前环境不支持安全持久化，请使用 HTTPS 或 localhost 访问'))
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes), (v) => v.toString(16).padStart(2, '0')).join('')
}

export async function findAttempt(code: string): Promise<Attempt | undefined> {
  const codeHash = await hash(code.trim().toUpperCase())
  return readAttempts().find((v) => v.codeHash === codeHash)
}

export async function prepareAttempt(code: string, token: string, row?: number): Promise<Attempt> {
  const [codeHash, tokenHash] = await Promise.all([hash(code.trim().toUpperCase()), hash(token)])
  const persist = () => {
    const entries = readAttempts()
    if (entries.some((v) => v.codeHash === codeHash || v.tokenHash === tokenHash)) {
      throw new Error(t('此卡密已有本地提交记录，请到「兑换进度」查询原单，不要重新提交'))
    }
    if (entries.length >= 2000) throw new Error(t('本地提交记录已达上限，请联系管理员后再操作'))
    const attempt: Attempt = {
      codeHash, tokenHash, requestId: `web-${crypto.randomUUID()}`,
      maskedCode: maskCode(code), row, createdAt: new Date().toISOString(), status: 'submitting',
    }
    localStorage.setItem(storageKey, JSON.stringify([...entries, attempt]))
    if (!readAttempts().some((v) => v.requestId === attempt.requestId)) throw new Error(t('无法保存提交记录，本次不会发起兑换'))
    return attempt
  }
  try {
    return navigator.locks ? await navigator.locks.request(`cdk-${codeHash}`, persist) : persist()
  } catch (error) {
    if (error && typeof error === 'object' && 'name' in error && error.name === 'QuotaExceededError') throw new Error(t('浏览器无法保存记录，本次不会提交。请允许本站本地存储。'))
    throw error
  }
}

export function updateAttempt(requestId: string, status: string): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(readAttempts().map((v) => v.requestId === requestId ? { ...v, status } : v)))
    window.dispatchEvent(new Event('cdk-history-updated'))
  } catch {
    // The pre-submit record remains the source of truth; never replay on failure.
  }
}

export async function recordProgress(value: string, byToken: boolean, status?: string) {
  if (!status) return
  try {
    const digest = await hash(byToken ? value : value.trim().toUpperCase())
    const attempt = readAttempts().find((entry) => (byToken ? entry.tokenHash : entry.codeHash) === digest)
    if (attempt) updateAttempt(attempt.requestId, status)
  } catch { /* Querying must still work when local storage is unavailable. */ }
}
