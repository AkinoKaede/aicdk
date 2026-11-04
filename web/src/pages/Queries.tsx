import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { ArrowRight, ArrowUpRight, ChevronDown, FileClock, FileText, Search, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useSession } from '../App'
import { api, errorMessage } from '../api'
import { useBusyGuard } from '../hooks'
import { readAttempts } from '../journal'
import type { Attempt } from '../journal'
import { credentialHelp, displayAmount, displayDate, maskCode, productName, safeInvoiceURL, validateCredential } from '../model'
import type { Billing, Invoice, LookupResult } from '../types'
import { Button, HelpAside, Notice, PageHeading, PrivacyNote, ProgressPanel, StatusBadge } from '../ui'

export function Lookup() {
  const { t, i18n } = useTranslation()
  const session = useSession()
  const [codes, setCodes] = useState('')
  const [results, setResults] = useState<LookupResult[] | null>(null)
  const [error, setError] = useState('')
  const { busy, run } = useBusyGuard()
  function lookup(event: FormEvent) {
    event.preventDefault()
    void run(async () => {
      setError(''); setResults(null)
      try {
        const input = codes.trim().replace(/\r\n/g, '\n').split('\n').map((v) => v.trim())
        if (input.length > 100 || input.some((v) => !v || new TextEncoder().encode(v).length > 256)) throw new Error(t('请输入 1 到 100 张卡密，不要留空行'))
        if (input.length === 1) setResults([await api<LookupResult>('lookup', { code: input[0] })])
        else setResults((await api<{ results: LookupResult[] }>('lookup-batch', { codes: input })).results)
      } catch (err) { setError(errorMessage(err)) }
    })
  }
  return <>
    <PageHeading eyebrow="LOOK UP / KNOW YOUR CODE" title={t('卡密查询')} description={t('查看状态与记录，不会发起任何充值。')} />
    <div className="workflow-layout"><section className="form-panel"><form onSubmit={lookup}><div className="panel-title"><span className="panel-icon"><Search size={22} /></span><h2>{t('输入要查询的卡密')}</h2></div><label className="field-label" htmlFor="lookup-codes">{t('兑换卡密')}</label><textarea id="lookup-codes" rows={5} value={codes} onChange={(event) => setCodes(event.target.value)} placeholder={t('请输入完整卡密')} autoComplete="off" spellCheck={false} disabled={busy} required /><p className="field-help">{t('每行一张，最多 100 张。')}</p>{error && <Notice tone="error">{error}</Notice>}<Button className="full" type="submit" busy={busy} disabled={!session || !codes.trim()}>{t('查询卡密')}<ArrowRight size={16} /></Button></form></section><HelpAside><p>{t('未使用不代表可以重试。请以可重新提交字段为准；结果不明时仍须先查原单。')}</p></HelpAside></div>
    {results && <section className="form-panel results-section"><div className="panel-top"><h2>{t('查询结果')}</h2><span className="count-pill">{t('{{count}} 张卡密', { count: results.length })}</span></div><div className="table-scroll"><table><thead><tr><th>{t('兑换卡密')}</th><th>{t('产品与套餐')}</th><th>{t('状态')}</th><th>{t('使用记录')}</th><th>{t('可重新提交')}</th></tr></thead><tbody>{results.map((result, index) => <tr key={index}><td><code>{maskCode(result.cdk_code)}</code><small>{result.system_name || t('未知')}</small></td><td>{result.product ? `${productName(result.product)} · ` : ''}{result.plan || '—'}</td><td><StatusBadge status={result.status} />{result.message && <small>{i18n.exists(result.message) ? t(result.message) : result.message}</small>}</td><td><span className="table-email">{result.account_email || '—'}</span><small>{displayDate(result.used_at)}</small></td><td>{t(result.can_resubmit === true ? '是' : result.can_resubmit === false ? '否' : '未知')}</td></tr>)}</tbody></table></div><p className="field-help">{t('未使用不代表可以重试。请以可重新提交字段为准；结果不明时仍须先查原单。')}</p></section>}
  </>
}

export function ProgressPage() {
  const { t } = useTranslation()
  const session = useSession()
  const [code, setCode] = useState('')
  const [query, setQuery] = useState('')
  const [revision, setRevision] = useState(0)
  const [attempts, setAttempts] = useState<Attempt[]>(() => { try { return readAttempts().slice().reverse() } catch { return [] } })
  useEffect(() => {
    const refresh = () => { try { setAttempts(readAttempts().slice().reverse()) } catch { /* Keep the last readable record. */ } }
    window.addEventListener('cdk-history-updated', refresh)
    window.addEventListener('storage', refresh)
    return () => { window.removeEventListener('cdk-history-updated', refresh); window.removeEventListener('storage', refresh) }
  }, [])
  function lookup(event: FormEvent) { event.preventDefault(); if (code.trim()) { setQuery(code.trim()); setRevision((v) => v + 1) } }
  return <>
    <PageHeading eyebrow="TRACK / EVERY STEP COUNTS" title={t('兑换进度')} description={t('输入原卡密，找回每一步。')} />
    <div className="workflow-layout"><div><section className="form-panel"><form onSubmit={lookup}><label className="field-label" htmlFor="progress-code">{t('原兑换卡密')}</label><input id="progress-code" value={code} onChange={(event) => setCode(event.target.value)} maxLength={256} placeholder={t('请输入完整卡密')} autoComplete="off" spellCheck={false} required /><p className="field-help">{t('请使用原兑换浏览器，保留设备 Cookie。清除 Cookie 或更换浏览器可能无法查询原凭证。')}</p><Button className="full" type="submit" disabled={!session || !code.trim()}>{t('查询原单进度')}<Search size={16} /></Button></form>{query && <div className="query-progress"><ProgressPanel key={revision} source={{ code: query }} /></div>}</section></div><HelpAside><p>{t('未查到记录不等于没有受理，请勿重复提交。')}</p><p>{t('仅查询，不会重新发起充值')}</p></HelpAside></div>
    <section className="form-panel results-section"><div className="panel-top"><div><h2>{t('本机提交记录')}</h2><p className="field-help">{t('仅保存脱敏卡密、请求编号和时间，不保存完整卡密或账号凭证。')}</p></div><FileClock size={22} /></div>{attempts.length ? <div className="table-scroll"><table><thead><tr><th>{t('兑换卡密')}</th><th>{t('提交编号')}</th><th>{t('提交时间')}</th><th>{t('状态')}</th></tr></thead><tbody>{attempts.map((attempt) => <tr key={attempt.requestId}><td><code>{attempt.maskedCode}</code></td><td><code className="request-id">{attempt.requestId}</code></td><td>{displayDate(attempt.createdAt)}</td><td><StatusBadge status={attempt.status} /></td></tr>)}</tbody></table></div> : <div className="empty-state"><FileClock size={28} /><p>{t('暂无本机记录')}</p></div>}</section>
  </>
}

export function BillingPage() {
  const { t } = useTranslation()
  const session = useSession()
  const [mode, setMode] = useState<'code' | 'session'>('code')
  const [input, setInput] = useState('')
  const [system, setSystem] = useState('')
  const [consent, setConsent] = useState(false)
  const [result, setResult] = useState<Billing | null>(null)
  const [error, setError] = useState('')
  const { busy, run } = useBusyGuard()
  const selectedSystem = system || session?.default_system || ''
  const bool = (value?: boolean) => t(value === true ? '是' : value === false ? '否' : '未知')
  function lookup(event: FormEvent) {
    event.preventDefault()
    void run(async () => {
      setError(''); setResult(null)
      try {
        if (mode === 'session') validateCredential(input)
        setResult(await api<Billing>('billing', mode === 'code' ? { cdk_code: input.trim() } : { token_input: input, system_id: selectedSystem }))
      } catch (err) { setError(errorMessage(err)) }
      finally { if (mode === 'session') setInput('') }
    })
  }
  return <>
    <PageHeading eyebrow="BILLING / THE FULL PICTURE" title={t('账单查询')} description={t('Session 与卡密，选择一种查询方式。')} />
    <div className="workflow-layout"><div><section className="form-panel"><div className="segmented" role="group" aria-label={t('账单查询')}>{(['code', 'session'] as const).map((value) => <button type="button" key={value} aria-pressed={mode === value} disabled={busy} className={mode === value ? 'selected' : ''} onClick={() => { setMode(value); setInput(''); setError(''); setConsent(false); setResult(null) }}>{t(value === 'code' ? '使用卡密' : '使用 Session')}</button>)}</div><form onSubmit={lookup}>
      {mode === 'session' && <><label className="field-label" htmlFor="billing-system">{t('选择查询系统')}</label><select id="billing-system" value={selectedSystem} onChange={(event) => setSystem(event.target.value)} disabled={busy} required><option value="" disabled>{t('请选择')}</option>{session?.systems.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></>}
      <label className="field-label" htmlFor="billing-input">{t(mode === 'code' ? '已绑定 Session 的卡密' : '完整 ChatGPT Session')}</label>
      {mode === 'code' ? <input id="billing-input" value={input} onChange={(event) => setInput(event.target.value)} disabled={busy} required maxLength={256} autoComplete="off" spellCheck={false} placeholder={t('请输入完整卡密')} /> : <textarea id="billing-input" rows={6} value={input} onChange={(event) => setInput(event.target.value)} disabled={busy} required autoComplete="off" spellCheck={false} placeholder={credentialHelp('gpt')} />}
      <label className="checkbox-label"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} disabled={busy} /><span>{t('凭证会经本站服务器发送给服务提供方，用于本次操作，不保存在本地历史中。')}</span></label>
      {error && <Notice tone="error">{error}</Notice>}<Button type="submit" className="full" busy={busy} disabled={!session || !input.trim() || !consent || (mode === 'session' && !selectedSystem)}>{t('查询账单与订阅')}<ArrowRight size={16} /></Button>
    </form></section><PrivacyNote /></div><HelpAside><p>{t('缺失信息会显示为未知，不推断未订阅、不续费或金额为零。')}</p></HelpAside></div>
    {result && <section className="form-panel results-section"><div className="panel-top"><h2>{t('订阅概览')}</h2><span className="soft-tag">{result.system_name}</span></div><dl className="detail-list billing-details"><div><dt>{t('账号邮箱')}</dt><dd>{result.summary?.email || t('未知')}</dd></div><div><dt>{t('订阅套餐')}</dt><dd>{result.summary?.plan_type || t('未知')}</dd></div><div><dt>{t('有效订阅')}</dt><dd>{bool(result.summary?.has_active_subscription)}</dd></div><div><dt>{t('周期结束时取消')}</dt><dd>{bool(result.summary?.cancel_at_period_end)}</dd></div><div><dt>{t('当前周期结束')}</dt><dd>{displayDate(result.summary?.current_period_end)}</dd></div></dl>
      <h3 className="subsection-title">{t('最近付款')}</h3>{result.last_payment ? <InvoiceCard invoice={result.last_payment} /> : <p className="muted">{t('未提供')}</p>}
      <h3 className="subsection-title">{t('账单记录')}</h3>{result.invoice_data_available !== true ? <Notice>{t('账单数据尚未提供，不代表没有付款。')}</Notice> : Array.isArray(result.invoices) && result.invoices.length === 0 ? <p className="muted">{t('已提供账单数据，当前列表为空。')}</p> : Array.isArray(result.invoices) ? <div className="invoice-list">{result.invoices.map((invoice, i) => <InvoiceCard invoice={invoice} key={i} />)}</div> : <p className="muted">{t('未提供')}</p>}
      {safeInvoiceURL(result.invoice_url) && <a className="button secondary invoice-link" href={safeInvoiceURL(result.invoice_url)} target="_blank" rel="noopener noreferrer">{t('打开官方账单')}<ArrowUpRight size={16} /></a>}
    </section>}
  </>
}

function InvoiceCard({ invoice }: { invoice: Invoice }) {
  const { t } = useTranslation()
  const link = safeInvoiceURL(invoice.invoice_url || invoice.hosted_invoice_url)
  return <div className="invoice-card"><FileText size={23} /><div><strong>{displayAmount(invoice.amount ?? invoice.amount_paid, invoice.currency)}</strong><small>{displayDate(invoice.date ?? invoice.created_at)}</small></div><span>{invoice.status || t('未知')}</span>{link && <a className="text-link" href={link} target="_blank" rel="noopener noreferrer">{t('打开官方账单')}<ArrowUpRight size={14} /></a>}</div>
}

export function Help() {
  const { t } = useTranslation()
  const questions = [
    ['如何完成一次兑换？', '输入卡密，查看产品和套餐。按提示填写账号凭证，核对邮箱和套餐后再确认兑换。提交后可在「兑换进度」查看结果。'],
    ['凭证会被存到哪里？', '卡密和凭证会经本站服务器发送给服务提供方。本站不会将完整卡密、Session 或兑换令牌存入浏览器历史或本站数据库，也不记录请求内容。服务提供方如何处理凭证，请向其咨询。'],
    ['网络超时了，可以再点一次吗？', '不要。超时并不意味着未受理。请在原浏览器用原卡密查询进度，或联系发卡方核对。本系统会保存提交标识并阻止重复发送；即使查不到记录，也不能直接认定原提交失败。'],
    ['批量文件是什么格式？', '支持 CSV 和 XLSX，第一行包含 code 和 session 表头。每行一对卡密与完整凭证；请将单元格设为文本格式。空行和重复卡密会报错，不会被静默过滤。文件只在本地解析，预检不发起充值，必须核对每行账号后才能提交。'],
    ['可以一次查询多张卡密吗？', '可以。在「卡密查询」中每行输入一张卡密，最多 100 张。结果按输入顺序显示。查询不会发起兑换。'],
    ['为什么订阅或账单显示未知？', '未知表示上游未提供这个字段，不能据此推断没有订阅、没有续费或没有付款。已知空账单列表与账单不可用是不同状态。'],
    ['语言会自动选择吗？', '首次访问按浏览器首选语言选择：中文使用简体中文，其他语言使用英语。手动切换后会保存你的偏好，不刷新页面，也不改变正在进行的兑换。'],
  ]
  return <>
    <PageHeading eyebrow="A LITTLE GUIDANCE" title={t('使用帮助')} description={t('兑换不复杂，把关键步骤讲清楚。')} />
    <div className="help-layout"><div className="faq-list">{questions.map(([question, answer], i) => <details key={question} open={i === 0}><summary><span className="faq-number">0{i + 1}</span><h2>{t(question)}</h2><ChevronDown size={18} /></summary><p>{t(answer)}</p></details>)}</div><aside><section className="form-panel credential-guide"><p className="eyebrow">ACCOUNT CREDENTIALS</p><h2>{t('我应该提供哪种凭证？')}</h2>{['gpt', 'claude', 'grok', 'x'].map((product) => <div key={product}><strong>{productName(product)}</strong><p>{credentialHelp(product)}</p></div>)}</section><section className="support-note"><ShieldCheck size={21} /><h3>{t('仍然需要帮助？')}</h3><p>{t('请联系你的发卡方，并提供脱敏卡密、提交编号与错误代码。不要公开完整卡密或 Session。')}</p></section></aside></div>
  </>
}
