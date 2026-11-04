import { useEffect, useRef, useState } from 'react'
import { api, APIError } from './api'
import { isTerminal } from './model'
import type { Progress } from './types'
import { recordProgress } from './journal'

export function useProgress(source: { token?: string; code?: string } | null) {
  const [data, setData] = useState<Progress | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(false)
  const [paused, setPaused] = useState(false)
  const [revision, setRevision] = useState(0)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
  const key = source?.token || source?.code || ''
  const kind = source?.token ? 'result' : 'result-by-code'
  const refresh = () => { setPaused(false); setRevision((v) => v + 1) }
  useEffect(() => { setData(null); setError(null); setUpdatedAt(null); setPaused(false) }, [key, kind])
  useEffect(() => {
    if (!key || paused) return
    let stopped = false, timer: ReturnType<typeof setTimeout>, checks = 0, failures = 0
    const controller = new AbortController()
    const poll = async () => {
      if (stopped) return
      if (document.visibilityState === 'hidden') { timer = setTimeout(poll, 3000); return }
      setLoading(true)
      let delay = 3000
      try {
        const next = await api<Progress>(kind, kind === 'result' ? { token: key } : { code: key }, controller.signal)
        if (stopped) return
        setData(next); setError(null); setUpdatedAt(new Date()); failures = 0
        void recordProgress(key, kind === 'result', next.status)
        if (isTerminal(next.status)) return
      } catch (err) {
        if (stopped) return
        setError(err instanceof Error ? err : new Error('操作未完成，请稍后重试'))
        failures++
        delay = err instanceof APIError && err.status === 429 ? err.retryAfter * 1000 : Math.min(60_000, 3000 * 2 ** failures)
        if (err instanceof APIError && err.status !== 429 &&
            (err.code === 'UPSTREAM_REJECTED' ? err.retryable !== true : [400, 401, 403, 404, 422].includes(err.status))) { setPaused(true); return }
        if (failures >= 5) { setPaused(true); return }
      } finally { if (!stopped) setLoading(false) }
      if (++checks >= 200) { setPaused(true); return }
      timer = setTimeout(poll, delay)
    }
    void poll()
    return () => { stopped = true; controller.abort(); clearTimeout(timer) }
  }, [key, kind, paused, revision])
  return { data, error, loading, paused, updatedAt, refresh, pause: () => setPaused(true) }
}

export function useBusyGuard() {
  const active = useRef(false)
  const [busy, setBusy] = useState(false)
  async function run(fn: () => Promise<void>) {
    if (active.current) return
    active.current = true; setBusy(true)
    try { await fn() } finally { active.current = false; setBusy(false) }
  }
  return { busy, run }
}
