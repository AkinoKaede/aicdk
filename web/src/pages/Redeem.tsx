import { useState } from 'react'
import type { FormEvent } from 'react'
import { ArrowRight, ArrowUpRight, Check, ShieldCheck, Ticket } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useSession } from '../App'
import { api, errorMessage } from '../api'
import { useBusyGuard } from '../hooks'
import { accountEmail, blockingReason, credentialHelp, productName, validateCredential } from '../model'
import { findAttempt, prepareAttempt, updateAttempt } from '../journal'
import type { Preflight, Preview, Progress } from '../types'
import { Button, HelpAside, Notice, PageHeading, PrivacyNote, ProgressPanel } from '../ui'

export function Redeem() {
  const { t } = useTranslation()
  const sessionInfo = useSession()
  const [code, setCode] = useState('')
  const [credential, setCredential] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [preflight, setPreflight] = useState<Preflight | null>(null)
  const [consent, setConsent] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [recovery, setRecovery] = useState(false)
  const [error, setError] = useState('')
  const { busy, run } = useBusyGuard()
  const step = submitted ? 3 : preflight ? 2 : preview ? 1 : 0
  const blocked = preview && preflight ? blockingReason(preview, preflight) : null
  const isChatGPT = ['gpt', 'chatgpt'].includes(preview?.product.toLowerCase() || '')

  function verify(event: FormEvent) {
    event.preventDefault()
    void run(async () => {
      setError(''); setRecovery(false)
      try {
        if (!code.trim()) throw new Error(t('请先输入卡密'))
        if (await findAttempt(code)) { setRecovery(true); throw new Error(t('此卡密已有提交记录，请先查询原单。')) }
        const next = await api<Preview>('preview', { code: code.trim() })
        if (!next.redemption_token || !next.product || !next.plan) throw new Error(t('接口数据不完整，请查询原记录'))
        setPreview(next)
      } catch (err) { setError(errorMessage(err)) }
    })
  }
  function check(event: FormEvent) {
    event.preventDefault()
    if (!preview || !consent) return
    void run(async () => {
      setError('')
      try {
        validateCredential(credential)
        const next = await api<Preflight>('preflight', { code: code.trim(), redemption_token: preview.redemption_token, credential: { mode: 'session', session: credential } })
        setPreflight(next); setConfirmed(false)
        if (preview.product.toLowerCase() !== 'grok') setCredential('')
      } catch (err) { setError(errorMessage(err)) }
    })
  }
  function submit(event: FormEvent) {
    event.preventDefault()
    if (!preview || !preflight || !confirmed || blocked || submitted) return
    void run(async () => {
      setError('')
      let requestId = ''
      try {
        if (preview.product.toLowerCase() === 'grok') validateCredential(credential)
        const attempt = await prepareAttempt(code, preview.redemption_token)
        requestId = attempt.requestId
        // From here onward, this screen can only query, never resubmit.
        setSubmitted(true)
        const result = await api<Progress>('redeem', {
          redemption_token: preview.redemption_token,
          client_request_id: requestId,
          ...(preview.product.toLowerCase() === 'grok'
            ? { credential: { mode: 'session', session: credential } }
            : { preflight_token: preflight.preflight_token }),
        })
        updateAttempt(requestId, result.status || 'pending')
      } catch (err) {
        if (requestId) updateAttempt(requestId, 'uncertain')
        setError(errorMessage(err))
      } finally {
        if (requestId) { setCredential(''); setPreflight(null) }
      }
    })
  }
  function reset() {
    setPreview(null); setPreflight(null); setSubmitted(false); setCredential(''); setCode('')
    setConsent(false); setConfirmed(false); setRecovery(false); setError('')
  }

  return <>
    <PageHeading eyebrow="REDEEM / ONE AT A TIME" title={t('卡密兑换')} description={t('先验证卡密，再确认你要充值的账号。')} action={<Link to="/batch" className="text-link">{t('批量兑换')}<ArrowUpRight size={16} /></Link>} />
    <div className="workflow-layout"><div className="workflow-main">
      <ol className="stepper">{['输入卡密', '账号预检', '确认提交', '查看结果'].map((label, i) => <li key={label} className={i === step ? 'current' : i < step ? 'done' : ''} aria-current={i === step ? 'step' : undefined}><span>{i < step ? <Check size={14} /> : `0${i + 1}`}</span><strong>{t(label)}</strong></li>)}</ol>
      <section className="form-panel" aria-busy={busy}>
        {error && <Notice tone={submitted ? 'warning' : 'error'}>{error}</Notice>}
        {step === 0 && <form onSubmit={verify}>
          <div className="panel-title"><span className="panel-icon"><Ticket size={22} /></span><div><p className="tiny-label">LET’S GET STARTED</p><h2>{t('输入卡密')}</h2></div></div>
          <label className="field-label" htmlFor="code">{t('兑换卡密')}</label><input id="code" className="code-input" value={code} onChange={(event) => { setCode(event.target.value); setRecovery(false) }} autoComplete="off" spellCheck={false} placeholder={t('请输入完整卡密')} maxLength={256} disabled={busy} required />
          <Button type="submit" className="full" busy={busy} disabled={!sessionInfo || !code.trim()}>{t('继续，验证卡密')}<ArrowRight size={17} /></Button>
          {recovery && <div className="recovery-block"><h3>{t('查询原记录')}</h3><ProgressPanel source={{ code: code.trim() }} /></div>}
        </form>}
        {step === 1 && preview && <form onSubmit={check}>
          <div className="verified-line"><ShieldCheck size={18} />{t('卡密验证通过')}</div>
          <dl className="detail-list product-detail"><div><dt>{t('产品与套餐')}</dt><dd>{productName(preview.product)} <span className="plan-tag">{preview.plan}</span></dd></div><div><dt>{t('支付地区 / 币种')}</dt><dd>{preview.payment_country || '—'} / {preview.payment_currency || '—'}</dd></div><div><dt>{t('兑换系统')}</dt><dd>{preview.system_name}</dd></div></dl>
          <label className="field-label" htmlFor="credential">{t('账号凭证')}</label>
          {isChatGPT ? <div className="session-instructions" id="credential-help">
            <p>{t('先在当前浏览器登录要充值的 ChatGPT 账号，再获取凭证。')}</p>
            <p>{credentialHelp(preview.product)}</p>
            <a className="text-link" href="https://chatgpt.com/api/auth/session" target="_blank" rel="noopener noreferrer">{t('打开 Session 页面（新窗口）')}<ArrowUpRight size={15} aria-hidden="true" /></a>
            <p>{t('复制页面全部 JSON，回到此处粘贴，不要只复制某个字段。')}</p>
          </div> : <p className="field-help" id="credential-help">{credentialHelp(preview.product)}</p>}
          <textarea id="credential" aria-describedby={isChatGPT ? 'credential-help credential-recovery' : 'credential-help'} value={credential} onChange={(event) => setCredential(event.target.value)} placeholder={t('粘贴完整凭证，内容不会写入本地历史')} rows={6} autoComplete="off" spellCheck={false} disabled={busy} required />
          {isChatGPT && <p className="field-help" id="credential-recovery">{t('若页面为空或缺少 sessionToken，请确认已登录目标账号并刷新页面；仍无法获取时，请联系发卡方。')}</p>}
          <label className="checkbox-label"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} disabled={busy} /><span>{t('我了解本站会将凭证发送给服务提供方，用于验证账号和兑换。')}</span></label>
          <Button type="submit" className="full" busy={busy} disabled={!consent || !credential.trim()}>{t('核验账号并继续')}<ArrowRight size={17} /></Button>
          <p className="field-help center">{t('预检不会发起充值。下一步核对邮箱和套餐后，再确认提交。')}</p>
          <button className="text-button form-back" type="button" onClick={reset} disabled={busy}>{t('重新输入卡密')}</button>
        </form>}
        {step === 2 && preview && preflight && <form onSubmit={submit}>
          <p className="eyebrow">CHECK BEFORE YOU CONFIRM</p><h2>{t('核对后，再迈出最后一步。')}</h2><p className="muted">{t('本次将为以下账号兑换，请仔细检查邮箱。')}</p>
          {blocked && <Notice tone="error">{blocked}</Notice>}
          <div className="account-confirmation"><span className="account-avatar">@</span><div><span className="tiny-label">{t('目标账号')}</span><strong>{accountEmail(preflight) || t('未知')}</strong></div><ShieldCheck size={23} /></div>
          <dl className="detail-list"><div><dt>{t('当前套餐')}</dt><dd>{preflight.currentPlan || t('未知')}</dd></div><div><dt>{t('兑换套餐')}</dt><dd>{productName(preview.product)} · {preview.plan}</dd></div><div><dt>{t('兑换系统')}</dt><dd>{preview.system_name}</dd></div></dl>
          <label className="checkbox-label"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} disabled={busy || !!blocked} /><span>{t('我已确认账号邮箱和套餐正确，授权提交本次兑换。')}</span></label>
          <Button type="submit" className="full" busy={busy} disabled={!confirmed || !!blocked}>{t('确认并提交兑换')}<ArrowRight size={17} /></Button>
          <button className="text-button form-back" type="button" disabled={busy} onClick={() => { setPreflight(null); setConfirmed(false); setCredential(''); setError('') }}>{t('返回修改凭证')}</button><p className="field-help center">{t('提交后不自动重试。处理中、排队中均不代表充值完成。')}</p>
        </form>}
        {step === 3 && preview && <><Notice tone="info"><strong>{t('提交请求已发出')}</strong><br />{t('请以最终查询结果为准，不要重复提交同一卡密。')}</Notice>{!busy && <ProgressPanel source={{ token: preview.redemption_token }} />}<div className="result-actions"><Button className="secondary" onClick={reset} disabled={busy}>{t('兑换另一张卡密')}</Button><Link to="/progress" className="text-link">{t('查看全部进度')}<ArrowUpRight size={14} /></Link></div></>}
      </section><PrivacyNote />
    </div><HelpAside /></div>
  </>
}
