import { useEffect, useRef, useState } from 'react'
import { ArrowRight, FileSpreadsheet, Square, Upload, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useSession } from '../App'
import { api, APIError, errorMessage } from '../api'
import { useBusyGuard } from '../hooks'
import { findAttempt, prepareAttempt, updateAttempt } from '../journal'
import { accountEmail, blockingReason, maskCode, pairRows, parseCSV, productName, rowsFromSheet } from '../model'
import type { ImportRow } from '../model'
import type { Preflight, Preview, Progress } from '../types'
import { Button, HelpAside, Notice, PageHeading, PrivacyNote, ProgressPanel, StatusBadge } from '../ui'

interface BatchRow extends ImportRow {
  preview?: Preview
  preflight?: Preflight
  confirmed: boolean
  status: string
  error?: string
  attempted?: boolean
}

export function Batch() {
  const { t } = useTranslation()
  const sessionInfo = useSession()
  const [codes, setCodes] = useState('')
  const [credentials, setCredentials] = useState('')
  const [imported, setImported] = useState<ImportRow[] | null>(null)
  const [fileName, setFileName] = useState('')
  const [rows, setRows] = useState<BatchRow[]>([])
  const [consent, setConsent] = useState(false)
  const [error, setError] = useState('')
  const [phase, setPhase] = useState<'import' | 'review' | 'submit'>('import')
  const [selected, setSelected] = useState<BatchRow | null>(null)
  const { busy, run } = useBusyGuard()
  const stop = useRef(false)
  const fileRef = useRef<HTMLInputElement>(null)
  useEffect(() => () => { stop.current = true }, [])
  const updateRow = (row: number, patch: Partial<BatchRow>) => setRows((current) => current.map((item) => item.row === row ? { ...item, ...patch } : item))
  const ready = rows.filter((row) => row.confirmed && row.status === 'prepared' && !row.attempted)
  const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
  async function readWithBackoff<T>(operation: 'preview' | 'preflight', body: object): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      if (stop.current) throw new Error(t('当前请求完成后停止'))
      try { return await api<T>(operation, body) } catch (err) {
        if (!(err instanceof APIError) || err.status !== 429 || attempt >= 2) throw err
        setError(errorMessage(err))
        await wait(err.retryAfter * 1000)
      }
    }
  }

  async function importFile(file?: File) {
    if (!file) return
    await run(async () => {
      setError(''); setImported(null); setFileName('')
      try {
        if (file.size > 5 * 1024 * 1024) throw new Error(t('文件不能超过 5 MiB'))
        let data: unknown[][]
        if (file.name.toLowerCase().endsWith('.csv')) data = parseCSV(await file.text())
        else if (file.name.toLowerCase().endsWith('.xlsx')) {
          const { readSheet } = await import('read-excel-file/browser')
          data = await readSheet(file, 1)
        } else throw new Error(t('仅支持 .csv 和 .xlsx 文件'))
        const entries = rowsFromSheet(data)
        setImported(entries); setFileName(file.name); setCodes(''); setCredentials('')
      } catch (err) { setError(errorMessage(err)) }
      finally { if (fileRef.current) fileRef.current.value = '' }
    })
  }

  async function precheck() {
    await run(async () => {
      setError(''); stop.current = false
      try {
        const input = imported || pairRows(codes.replace(/\r\n/g, '\n').split('\n'), credentials.replace(/\r\n/g, '\n').split('\n'))
        const staged: BatchRow[] = input.map((row) => ({ ...row, confirmed: false, status: 'pending' }))
        setRows(staged); setPhase('review'); setCredentials(''); setImported(null)
        for (const row of staged) {
          if (stop.current) break
          updateRow(row.row, { status: 'checking' })
          try {
            if (await findAttempt(row.code)) throw new Error(t('此卡密已有提交记录，请先查询原单。'))
            const preview = await readWithBackoff<Preview>('preview', { code: row.code })
            if (stop.current) break
            if (!preview.redemption_token || !preview.product || !preview.plan) throw new Error(t('接口数据不完整，请查询原记录'))
            const preflight = await readWithBackoff<Preflight>('preflight', { code: row.code, redemption_token: preview.redemption_token, credential: { mode: 'session', session: row.session } })
            const blocked = blockingReason(preview, preflight)
            updateRow(row.row, {
              preview, preflight, status: blocked ? 'failed' : 'prepared', error: blocked || undefined,
              session: preview.product.toLowerCase() === 'grok' && !blocked ? row.session : '',
            })
          } catch (err) { updateRow(row.row, { status: 'failed', error: errorMessage(err), session: '' }) }
        }
      } catch (err) { setError(errorMessage(err)) }
    })
  }

  async function submit() {
    await run(async () => {
      stop.current = false; setPhase('submit'); setError('')
      for (const row of ready) {
        if (stop.current) break
        if (!row.preview || !row.preflight || blockingReason(row.preview, row.preflight)) continue
        let requestId = ''
        try {
          const attempt = await prepareAttempt(row.code, row.preview.redemption_token, row.row)
          requestId = attempt.requestId
          updateRow(row.row, { attempted: true, status: 'submitting', confirmed: false })
          const response = await api<Progress>('redeem', {
            redemption_token: row.preview.redemption_token, client_request_id: requestId,
            ...(row.preview.product.toLowerCase() === 'grok'
              ? { credential: { mode: 'session', session: row.session } }
              : { preflight_token: row.preflight.preflight_token }),
          })
          updateAttempt(requestId, response.status || 'pending')
          updateRow(row.row, { status: response.status || 'pending', session: '' })
        } catch (err) {
          if (requestId) updateAttempt(requestId, 'uncertain')
          updateRow(row.row, { status: requestId ? 'uncertain' : 'failed', error: errorMessage(err), session: '', confirmed: false })
        }
        // Stay below the server's per-device submission limit. Never retry a POST.
        if (row !== ready[ready.length - 1] && !stop.current) await wait(2100)
      }
    })
  }

  function reset() {
    setRows([]); setImported(null); setPhase('import'); setSelected(null); setConsent(false)
    setError(''); setFileName(''); setCodes(''); setCredentials('')
  }

  return <>
    <PageHeading eyebrow="REDEEM / IN GOOD ORDER" title={t('批量兑换')} description={t('从表格到兑换，逐行可控。')} />
    <div className={phase === 'import' ? 'workflow-layout' : ''}><div>
      <ol className="stepper">{['导入数据', '核对账号', '执行与跟踪'].map((name, index) => <li className={['import', 'review', 'submit'].indexOf(phase) === index ? 'current' : ''} key={name}><span>0{index + 1}</span><strong>{t(name)}</strong></li>)}</ol>
      {error && <Notice tone="error">{error}</Notice>}
      {phase === 'import' ? <section className="form-panel">
        <div className="upload-panel"><FileSpreadsheet size={34} strokeWidth={1.5} /><h2>{t('导入 CSV / Excel')}</h2><p>{t('文件仅在浏览器解析，不会整份上传。使用 code、session 两列表头，最多 100 行。')}</p>
          <input ref={fileRef} className="sr-only" type="file" accept=".csv,.xlsx" aria-label={t('选择文件')} onChange={(event) => void importFile(event.target.files?.[0])} disabled={busy} /><Button className="secondary" type="button" busy={busy} onClick={() => fileRef.current?.click()}><Upload size={16} />{t('选择文件')}</Button>
          {imported && <div className="import-summary"><span>{fileName} · {t('已准备 {{count}} 行', { count: imported.length })}</span><button className="icon-button" aria-label={t('重新导入')} onClick={() => { setImported(null); setFileName('') }}><X size={16} /></button></div>}
        </div>
        {!imported && <><div className="or-divider"><span>{t('或直接粘贴')}</span></div><div className="two-fields"><div><label className="field-label" htmlFor="batch-codes">{t('卡密，每行一张')}</label><textarea id="batch-codes" rows={7} value={codes} onChange={(event) => setCodes(event.target.value)} spellCheck={false} autoComplete="off" disabled={busy} placeholder={'ABCD-1234\nEFGH-5678'} /></div><div><label className="field-label" htmlFor="batch-credentials">{t('凭证，每行一条')}</label><textarea id="batch-credentials" rows={7} value={credentials} onChange={(event) => setCredentials(event.target.value)} spellCheck={false} autoComplete="off" disabled={busy} placeholder={'{"sessionToken":"…"}\n{"sessionToken":"…"}'} /></div></div><p className="field-help">{t('保留空行并报错，不会过滤后重新配对。多行 JSON 请使用 CSV / Excel 的单元格。')}</p></>}
        <label className="checkbox-label"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} disabled={busy} /><span>{t('我了解本站会将所填凭证发送给服务提供方，用于验证账号和兑换。')}</span></label><Button className="full" disabled={!sessionInfo || !consent || (!imported && (!codes || !credentials))} busy={busy} onClick={() => void precheck()}>{t('校验并预检全部账号')}<ArrowRight size={16} /></Button><p className="field-help center">{t('预检完成前不会提交任何兑换。')}</p>
      </section> : <section className="form-panel batch-panel">
        <div className="panel-top"><div><h2>{t(phase === 'review' ? '核对账号' : '执行与跟踪')}</h2><p className="field-help">{t('选中即表示已核对该行邮箱和套餐。未确认或预检失败的行不会提交。')}</p></div><span className="count-pill">{rows.length}</span></div>
        <div className="table-scroll"><table><thead><tr><th>{t('原始行')}</th><th>{t('卡密 / 系统')}</th><th>{t('账号 / 套餐')}</th><th>{t('状态')}</th><th>{t('确认')}</th></tr></thead><tbody>{rows.map((row) => <tr key={row.row}><td className="mono">{String(row.row).padStart(2, '0')}</td><td><code>{maskCode(row.code)}</code><small>{row.preview?.system_name || '—'}</small></td><td><strong className="table-email">{row.preflight ? accountEmail(row.preflight) || t('未知') : '—'}</strong><small>{row.preview ? `${productName(row.preview.product)} · ${row.preview.plan}` : '—'}</small></td><td><StatusBadge status={row.status} />{row.error && <small className="row-error">{row.error}</small>}</td><td>{row.attempted ? <button className="text-button" onClick={() => setSelected(row)}>{t('查看状态')}</button> : <input type="checkbox" aria-label={t('确认第 {{row}} 行账号', { row: row.row })} checked={row.confirmed} onChange={(event) => updateRow(row.row, { confirmed: event.target.checked })} disabled={busy || row.status !== 'prepared'} />}</td></tr>)}</tbody></table></div>
        <div className="batch-toolbar"><Button className="secondary" onClick={reset} disabled={busy}>{t('重新导入')}</Button>{busy ? <Button className="secondary" onClick={() => { stop.current = true }}><Square size={13} />{t('当前请求完成后停止')}</Button> : <Button disabled={!ready.length} onClick={() => void submit()}>{t('提交已确认的 {{count}} 行', { count: ready.length })}<ArrowRight size={16} /></Button>}</div><p className="field-help">{t('已提交的行请查询结果；受理不等于完成。')} {t('停止后不会重新提交已处理的行。')}</p>
      </section>}
      <PrivacyNote />
      {selected?.preview && <section className="form-panel selected-progress"><div className="panel-top"><h2>{t('行 {{row}} 的进度', { row: selected.row })}</h2><button className="icon-button" aria-label={t('关闭进度')} onClick={() => setSelected(null)}><X size={20} /></button></div><ProgressPanel source={{ token: selected.preview.redemption_token }} /></section>}
    </div>{phase === 'import' && <HelpAside title={t('行数限制与配对')}><p>{t('每批最多 100 行。空行、重复卡密和无效格式会在任何预检请求前阻止导入。')}</p><p>{t('请将卡密和对应账号的凭证放在同一行，提交前逐行核对邮箱。')}</p></HelpAside>}</div>
  </>
}
