import { createContext, useContext, useEffect, useState } from 'react'
import { ArrowRight, ArrowUpRight, BookOpen, Check, ChevronDown, CircleHelp, Command, FileText, Globe2, Layers3, LockKeyhole, Search, ShieldCheck, Ticket, Workflow } from 'lucide-react'
import { BrowserRouter, Link, NavLink, Route, Routes, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { loadSession } from './api'
import type { SessionInfo } from './types'
import { Notice } from './ui'
import { Redeem } from './pages/Redeem'
import { Batch } from './pages/Batch'
import { BillingPage, Help, Lookup, ProgressPage } from './pages/Queries'

const SessionContext = createContext<SessionInfo | null>(null)
export const useSession = () => useContext(SessionContext)

export function App() {
  const [session, setSession] = useState<SessionInfo | null>(null)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(true)
  const connect = async (reset = false) => {
    setLoading(true); setError(false)
    try { setSession(await loadSession(reset)) } catch { setError(true) } finally { setLoading(false) }
  }
  useEffect(() => { void connect() }, [])
  return <SessionContext.Provider value={session}><BrowserRouter><Layout loading={loading} error={error} reconnect={() => void connect(true)} /></BrowserRouter></SessionContext.Provider>
}

function Layout({ loading, error, reconnect }: { loading: boolean; error: boolean; reconnect: () => void }) {
  const { t, i18n } = useTranslation()
  const location = useLocation()
  useEffect(() => {
    window.scrollTo(0, 0)
    document.getElementById('main-content')?.focus({ preventScroll: true })
  }, [location.pathname])
  return <div className="site-shell">
    <a className="skip-link" href="#main-content">{t('跳到主要内容')}</a>
    <header className="site-header">
      <Link to="/" className="brand" aria-label={`CDK ${t('兑换中心')}`}><span className="brand-mark"><Command size={23} strokeWidth={2} /></span><span className="brand-word">cdk<span className="brand-period">.</span></span><span className="brand-divider" /><span className="brand-subtitle">{t('兑换中心')}</span></Link>
      <nav className="primary-nav" aria-label={t('兑换中心')}>
        <NavLink to="/" end>{t('服务首页')}</NavLink><NavLink to="/redeem">{t('卡密兑换')}</NavLink><NavLink to="/batch">{t('批量兑换')}</NavLink><NavLink to="/lookup">{t('查询中心')}</NavLink>
      </nav>
      <div className="header-tools"><Link to="/help" className="header-help"><CircleHelp size={17} /><span>{t('使用帮助')}</span></Link><label className="language-switch"><Globe2 size={16} /><span className="sr-only">{t('切换语言')}</span><select aria-label={t('切换语言')} value={i18n.language} onChange={(event) => void i18n.changeLanguage(event.target.value)}><option value="zh-CN">简体中文</option><option value="en">English</option></select><ChevronDown size={12} /></label></div>
    </header>
    <main id="main-content" className="main" tabIndex={-1}>
      {loading && <div className="connection-status"><span className="loading-dot" />{t('建立安全会话中…')}</div>}
      {error && <div className="connection-error"><Notice tone="error">{t('无法连接本站服务，请确认后端正在运行。')} <button className="text-button" onClick={reconnect}>{t('重新连接')}</button></Notice></div>}
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/redeem" element={<Redeem />} />
        <Route path="/batch" element={<Batch />} />
        <Route path="/lookup" element={<Lookup />} />
        <Route path="/progress" element={<ProgressPage />} />
        <Route path="/billing" element={<BillingPage />} />
        <Route path="/help" element={<Help />} />
        <Route path="*" element={<section className="not-found"><span className="eyebrow">404</span><h1>{t('服务首页')}</h1><Link className="button" to="/">{t('服务首页')} <ArrowRight size={16} /></Link></section>} />
      </Routes>
    </main>
    <footer className="site-footer"><div><span className="footer-brand">cdk.</span><span>{t('兑换有序，订阅轻松。')}</span></div><span className="footer-note"><LockKeyhole size={13} />{t('凭证仅用于兑换与查询，请勿公开分享。')}</span><Link to="/help">{t('使用帮助')} <ArrowUpRight size={13} /></Link></footer>
  </div>
}

function Home() {
  const { t } = useTranslation()
  const session = useSession()
  const services = [
    { to: '/redeem', icon: Ticket, no: '01', title: '卡密兑换', tagline: '有卡密，从这里开始。', description: '验证你的卡密，确认目标账号，开启订阅。', action: '进入兑换', color: 'featured' },
    { to: '/batch', icon: Layers3, no: '02', title: '批量兑换', tagline: '多个账号，一次安排。', description: '本地导入表格，逐行核对，依次提交。', action: '导入与兑换', color: 'orange' },
    { to: '/lookup', icon: Search, no: '03', title: '卡密查询', tagline: '每一张卡，都有答案。', description: '查看卡密状态、对应套餐与使用记录。', action: '开始查询', color: 'blue' },
    { to: '/progress', icon: Workflow, no: '04', title: '兑换进度', tagline: '进度不猜，随时可查。', description: '凭原卡密恢复记录，不会重复发起兑换。', action: '跟踪进度', color: 'olive' },
  ]
  return <>
    <section className="hero">
      <div className="hero-copy">
        <p className="eyebrow hero-eyebrow"><span className="status-dot" />{t('订阅自助服务')}<span className="eyebrow-line" /></p>
        <h1>{t('你的订阅，')}<br /><span>{t('轻松兑换。')}<svg className="headline-underline" viewBox="0 0 360 17" aria-hidden="true"><path d="M3 11Q160 -2 355 8M42 15Q214 5 321 12" /></svg></span></h1>
        <p className="hero-description">{t('从一张卡密，到你的会员。')}<br />{t('验证、确认、跟踪，让每一步都清晰可见。')}</p>
        <div className="hero-actions"><Link className="button" to="/redeem">{t('开始兑换')}<ArrowUpRight size={19} /></Link><Link className="quiet-link" to="/progress">{t('查询已有兑换')}<ArrowRight size={16} /></Link></div>
        <div className="hero-trust"><span><ShieldCheck size={15} />{t('服务端安全中转')}</span><span><Check size={15} />{t('无需注册本站账号')}</span></div>
      </div>
      <div className="hero-art">
        <div className="orbit orbit-one" /><div className="orbit orbit-two" /><span className="art-plus plus-one">+</span><span className="art-plus plus-two">+</span>
        <div className="ticket-back" />
        <div className="journey-card">
          <div className="journey-heading"><span className="tiny-label">YOUR NEXT CHAPTER</span><span className="journey-star">✳</span></div>
          <h2>{t('三步，开启下一程。')}</h2>
          <div className="journey-rule" />
          {[['验证卡密', '识别产品与套餐'], ['确认账号', '预检信息，核对目标账号'], ['完成兑换', '提交后随时跟踪进度']].map(([title, subtitle], i) => <div className={`journey-step step-${i}`} key={title}><span className="journey-number">0{i + 1}</span><div><strong>{t(title)}</strong><small>{t(subtitle)}</small></div><span className="journey-check">{i === 0 ? <Check size={15} /> : <ArrowRight size={14} />}</span></div>)}
          <div className="ticket-perforation" />
          <div className="journey-bottom"><span className="barcode" aria-hidden="true" /><span>VERIFY. CONFIRM. ENJOY.</span><span className="ticket-logo">cdk.</span></div>
        </div>
        <div className="floating-stamp"><ShieldCheck size={19} /><div><strong>{t('确认提交')}</strong><small>YOU’RE IN CONTROL</small></div></div>
      </div>
    </section>
    <div className="home-divider"><span>{t('准备好你的卡密，剩下的交给流程。')}</span><span className="tiny-label">LESS FRICTION. MORE POSSIBILITY.</span></div>
    <section className="services-section">
      <div className="section-heading"><div><p className="eyebrow">THE SERVICE DESK</p><h2>{t('选择一项服务')}</h2></div><p>{t('兑换、查询，各得其所。')}</p></div>
      <div className="service-grid">{services.map(({ to, icon: Icon, no, title, tagline, description, action, color }) => <Link className={`service-card ${color}`} key={to} to={to}><div className="service-top"><span className="service-icon"><Icon size={24} strokeWidth={1.65} /></span><span className="service-number">/ {no}</span></div><h3>{t(title)}</h3><strong className="service-tagline">{t(tagline)}</strong><p>{t(description)}</p><span className="service-action">{t(action)}<ArrowUpRight size={18} /></span></Link>)}</div>
    </section>
    <section className="billing-banner"><div className="billing-icon"><FileText size={25} strokeWidth={1.5} /></div><div><p className="tiny-label">A CLEARER PICTURE</p><h2>{t('账单与订阅，一目了然。')}</h2><p>{t('查询 ChatGPT 订阅摘要、最近付款与可用账单。')}</p></div><Link to="/billing" className="button secondary">{t('查看账单')}<ArrowUpRight size={16} /></Link></section>
    <section className="help-banner"><BookOpen size={24} strokeWidth={1.5} /><div><h3>{t('第一次使用？我们陪你走一遍。')}</h3><p>{t('了解账号凭证、兑换步骤和常见问题。')}</p></div><Link to="/help" className="text-link">{t('阅读使用说明')}<ArrowRight size={16} /></Link></section>
    {session && <div className="home-session"><span className="status-dot" />{t('安全会话就绪')}<span>/</span><span>REDEEM WITH CLARITY</span></div>}
  </>
}
