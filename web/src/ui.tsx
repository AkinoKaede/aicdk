import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { ArrowLeft, ArrowUpRight, Check, CircleAlert, CircleHelp, LoaderCircle, LockKeyhole, RefreshCw, ShieldCheck } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { locale } from './i18n'
import { displayDate, isCompleted, isTerminal, statusLabel } from './model'
import { useProgress } from './hooks'
import { APIError, errorMessage } from './api'

export function Button({ children, busy, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return <button className={`button ${className}`} {...props} disabled={busy || props.disabled} aria-busy={busy}>
    {busy && <LoaderCircle size={17} className="spin" aria-hidden="true" />}{children}
  </button>
}

export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'error' | 'success' | 'warning' }) {
  return <div className={`notice ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
    {tone === 'success' ? <ShieldCheck size={18} /> : <CircleAlert size={18} />}
    <div>{children}</div>
  </div>
}

export function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  const { t } = useTranslation()
  return <div className="page-heading">
    <div><Link to="/" className="back-link"><ArrowLeft size={14} /> {t('服务首页')}</Link><p className="eyebrow">{eyebrow}</p><h1>{title}<span className="title-dot">.</span></h1><p className="page-description">{description}</p></div>
    {action}
  </div>
}

export function PrivacyNote() {
  const { t } = useTranslation()
  return <div className="privacy-note"><LockKeyhole size={15} /><span>{t('凭证会经本站服务器发送给服务提供方，用于本次操作，不保存在本地历史中。')}</span></div>
}

export function HelpAside({ title = '每一步，心中有数。', children }: { title?: string; children?: ReactNode }) {
  const { t } = useTranslation()
  return <aside className="help-aside">
    <div className="aside-icon"><CircleHelp size={22} /></div><h3>{t(title)}</h3>
    {children || <><p>{t('先验证卡密，再核对目标账号。只有确认提交后，才会发起兑换。')}</p><ul className="aside-list"><li><Check size={15} /> {t('套餐由卡密决定')}</li><li><Check size={15} /> {t('提交前核对账号邮箱')}</li><li><Check size={15} /> {t('结果不明时先查原单')}</li></ul></>}
    <Link to="/help" className="text-link">{t('查看使用说明')} <ArrowUpRight size={15} /></Link>
    <div className="aside-bottom"><span className="tiny-label">A LITTLE REMINDER</span><p>{t('不要向任何人发送完整凭证截图。')}</p></div>
  </aside>
}

export function StatusBadge({ status }: { status?: string }) {
  useTranslation()
  return <span className={`status-badge ${isCompleted(status) ? 'good' : isTerminal(status) ? 'bad' : ''}`}><span />{statusLabel(status)}</span>
}

export function ProgressPanel({ source }: { source: { token?: string; code?: string } }) {
  const { t } = useTranslation()
  const progress = useProgress(source)
  const { data } = progress
  const lookupRejected = progress.error instanceof APIError && progress.error.code === 'UPSTREAM_REJECTED'
  return <section className="progress-panel">
    <div className="panel-top"><h2>{t('兑换状态')}</h2><StatusBadge status={data?.status} /></div>
    {lookupRejected ? <Notice tone="warning">
      <strong>{t('暂时无法确认兑换进度，请勿重新提交兑换。')}</strong>
      <p>{t('请在提交兑换时使用的浏览器中，用原卡密查询。如果仍查不到，请联系发卡方核对。')}</p>
    </Notice> : progress.error && <Notice tone="warning">{errorMessage(progress.error)} {t('未查到记录不等于没有受理，请勿重复提交。')}</Notice>}
    {data ? <>
      <div className={`progress-symbol ${isCompleted(data.status) ? 'completed' : ''}`}>{isCompleted(data.status) ? <Check size={32} /> : isTerminal(data.status) ? <CircleAlert size={32} /> : <LoaderCircle size={32} className={progress.paused ? '' : 'spin-slow'} />}</div>
      <h3 className="progress-title">{statusLabel(data.status)}</h3><p className="muted center">{data.message || t('请以最终状态为准，受理不代表充值完成。')}</p>
      <dl className="detail-list"><div><dt>{t('目标账号')}</dt><dd>{data.account_email || t('暂未提供')}</dd></div><div><dt>{t('兑换系统')}</dt><dd>{data.system_name || t('暂未提供')}</dd></div></dl>
      {Array.isArray(data.events) && !!data.events.length && <ol className="event-list">{data.events.filter((event) => typeof event === 'string' || (event && typeof event === 'object')).map((event, i) => <li key={i}><span className="event-dot" /><div>{typeof event === 'string' ? event : typeof event.message === 'string' ? event.message : statusLabel(event.status)}{typeof event !== 'string' && (event.created_at || event.timestamp) && <small>{displayDate(event.created_at || event.timestamp)}</small>}</div></li>)}</ol>}
    </> : <div className="empty-state"><RefreshCw size={30} className={progress.loading ? 'spin-slow' : ''} /><p>{t(progress.loading ? '正在查询原兑换记录…' : '暂未取得兑换结果')}</p></div>}
    <div className="progress-toolbar"><span>{progress.updatedAt ? t('更新于 {{time}}', { time: progress.updatedAt.toLocaleTimeString(locale(), { hour12: false }) }) : t('仅查询，不会重新发起充值')}{!isTerminal(data?.status) && <small>{t(progress.paused ? '自动查询已暂停' : '每 3 秒查询，失败时自动退避')}</small>}</span><div className="inline-actions">{!progress.paused && !isTerminal(data?.status) && <button className="text-button" onClick={progress.pause}>{t('暂停')}</button>}<Button className="secondary small" busy={progress.loading} onClick={progress.refresh}><RefreshCw size={15} />{t(progress.paused ? '继续查询' : '刷新')}</Button></div></div>
  </section>
}
