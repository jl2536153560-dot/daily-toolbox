import { useEffect, useRef } from 'react';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { ArrowUpRight, Bell, Bookmark, ChevronRight, HeartPulse, LayoutGrid, Leaf, ShieldCheck, Target, Timer, Trash2, Zap } from 'lucide-react';
import { formatTime, inputNames, modeNames } from './core';
import { dataStore, registerTools, timerStore, unlockAudio, useData, useTimer } from './store';
import { articles } from './data/rehab';
import Reminder from './pages/Reminder';
import Training from './pages/Training';
import Rehab from './pages/Rehab';

export function PageHeading({ label, title, description }: { label: string; title: string; description: string }) {
  return <header className="page-heading"><div className="eyebrow">{label}</div><h1 tabIndex={-1}>{title}</h1><p>{description}</p></header>;
}
function Home() {
  const { state, now } = useTimer(), { records, favorites } = useData();
  const remaining = state.status === 'running' ? Math.max(0, state.deadline! - now) : state.remaining;
  const recent = records[0];
  return <>
    <PageHeading label="YOUR EVERYDAY TOOLKIT" title="我的日常工具箱" description="给身体一点关照，给反应一点练习。" />
    <div className="tool-grid">
      <section className="tool-card reminder-card">
        <div className="card-top"><span className="icon-tile"><Timer size={25} /></span><span className="number">01 / MOVE</span></div>
        <h2>久坐提醒</h2><p>每 30 分钟，给自己一个起身的理由。</p>
        <div className="home-clock" aria-label={`剩余 ${formatTime(remaining)}`}>{formatTime(remaining)}<span>{({ idle: '准备好就开始', running: '距离下一次活动', paused: '计时已暂停', due: '该起来活动一下了' })[state.status]}</span></div>
        <div className="card-actions"><button className="button light" onClick={() => { unlockAudio(); timerStore.dispatch(state.status === 'running' ? 'pause' : state.status === 'due' ? 'next' : 'start'); }}>{({ idle: '开始计时', running: '暂停计时', paused: '继续计时', due: '已活动，下一轮' })[state.status]}<ArrowUpRight size={18} /></button><Link to="/reminder" className="quiet-link">设置</Link></div>
      </section>
      <section className="tool-card training-card">
        <div className="card-top"><span className="icon-tile"><Zap size={25} /></span><span className="number">02 / FOCUS</span></div>
        <h2>反应与决策</h2><p>看清，再行动。练习速度，也练习判断。</p>
        <div className="mode-preview"><div><span>01</span>变色反应<kbd>SPACE</kbd></div><div><span>02</span>方向选择<kbd>↑ ↓ ← →</kbd></div><div><span>03</span>场景决策<kbd>1 2 3</kbd></div></div>
        <Link className="button outline" to="/training">开始训练<ArrowUpRight size={18} /></Link>
      </section>
      <section className="tool-card rehab-card">
        <div className="card-top"><span className="icon-tile"><HeartPulse size={25} /></span><span className="number">03 / RECOVER</span></div>
        <h2>康复知识</h2><p>认识常见伤病，更有准备地回到球场。</p>
        <div className="parts-preview">{articles.map(a => <Link key={a.slug} to={`/rehab/${a.slug}`}>{a.part}<ChevronRight size={14} /></Link>)}</div>
        <Link className="button outline" to="/rehab">浏览知识库<ArrowUpRight size={18} /></Link>
      </section>
    </div>
    <div className="section-title"><h2>我的近况</h2><span>一点点积累，也算数</span></div>
    <div className="overview-grid">
      <section className="panel recent-panel"><div className="panel-label"><Target size={19} /><h3>最近一次训练</h3><Link to="/training">全部记录<ChevronRight size={15} /></Link></div>{recent ? <><div className="recent-result"><strong>{recent.mode === 'reaction' ? recent.median : Math.round(recent.correct / recent.total * 100)}<small>{recent.mode === 'reaction' ? 'ms' : '%'}</small></strong><div>{modeNames[recent.mode]}<p>{inputNames[recent.input]} · {new Date(recent.date).toLocaleDateString('zh-CN')}</p></div></div><p className="muted">{recent.mode === 'reaction' ? '本组有效反应的中位时间' : `答对 ${recent.correct} / ${recent.total} 题`} · 仅比较同模式、同输入方式</p></> : <div className="empty-inline"><span className="empty-mark">—</span><div><strong>还没有训练记录</strong><p>完成第一组练习，看看自己的起点。</p></div><Link className="text-link" to="/training">去练一组<ArrowUpRight size={17} /></Link></div>}</section>
      <section className="panel"><div className="panel-label"><Bookmark size={19} /><h3>收藏的知识</h3><span className="count">{favorites.length}</span></div>{favorites.length ? articles.filter(a => favorites.includes(a.slug)).slice(0, 3).map(a => <Link className="article-row" key={a.slug} to={`/rehab/${a.slug}`}><span className="part-tag">{a.part}</span><span>{a.title}</span><ChevronRight size={16} /></Link>) : <div className="empty-inline"><div><strong>把有用的知识留在手边</strong><p>阅读时点击收藏，下次从这里继续。</p><Link className="text-link" to="/rehab/ankle">先了解：崴脚后的处理<ArrowUpRight size={17} /></Link></div></div>}</section>
    </div>
    <div className="small-note"><Leaf size={19} /><span>无需完成所有事情。从一次起身，或一组练习开始。</span></div>
  </>;
}
export default function App() {
  const { warning } = useData(), { state } = useTimer(), location = useLocation(), dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => registerTools(), []);
  useEffect(() => {
    window.scrollTo(0, 0);
    const headings: Record<string, string> = { '/': '日常工具箱', '/reminder': '久坐提醒', '/training': '反应与决策', '/rehab': '康复知识' };
    const article = articles.find(a => location.pathname === `/rehab/${a.slug}`);
    document.title = `${article?.title ?? headings[location.pathname] ?? '页面未找到'} · 日常工具箱`;
    document.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true });
  }, [location.pathname]);
  return <div className="app-shell">
    <a className="skip-link" href="#main" onClick={event => { event.preventDefault(); document.getElementById("main")?.focus(); }}>跳到主要内容</a>
    <aside className="sidebar"><Link to="/" className="brand"><span className="brand-icon"><LayoutGrid size={23} /></span><span>日常工具箱<small>EVERYDAY TOOLKIT</small></span></Link><div className="nav-label">我的空间</div><nav aria-label="主导航">{[{ to: '/', text: '总览', icon: LayoutGrid }, { to: '/reminder', text: '久坐提醒', icon: Timer }, { to: '/training', text: '反应与决策', icon: Zap }, { to: '/rehab', text: '康复知识', icon: HeartPulse }].map(({ to, text, icon: Icon }) => <NavLink key={to} to={to} end={to === '/'}><Icon size={20} /><span>{text}</span>{to === '/reminder' && state.status === 'running' && <span className="running-dot" aria-label="计时中" />}</NavLink>)}</nav><div className="sidebar-bottom"><ShieldCheck size={20} /><div>只属于你的记录<small>保存在当前浏览器，无需登录</small></div></div></aside>
    <div className="main-shell"><div className="topbar"><span>个人空间 <span className="slash">/</span> 日常工具</span><time>{new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date())}</time></div><main id="main" tabIndex={-1}>{warning && <div className="notice warning" role="status">{warning}</div>}<Routes><Route path="/" element={<Home />} /><Route path="/reminder" element={<Reminder />} /><Route path="/training" element={<Training />} /><Route path="/rehab" element={<Rehab />} /><Route path="/rehab/:slug" element={<Rehab />} /><Route path="*" element={<><PageHeading label="404" title="这个页面不在工具箱里" description="回到首页，选择需要的工具。" /><Link className="button" to="/">回到总览</Link></>} /></Routes></main><footer><span>日常工具箱 <span className="footer-dot">·</span> 给日常留一点空间</span><button className="text-button" onClick={() => dialog.current?.showModal()}><Trash2 size={15} />清空本地数据</button></footer></div>
    {state.status === 'due' && <aside className="reminder-toast" role="alert" aria-label="起来活动一下"><Bell size={23} /><div><strong>起来活动一下</strong><p>离开座位走动一会儿，再回来继续。</p><div className="button-row"><button className="button small" onClick={() => { unlockAudio(); timerStore.dispatch('next'); }}>已活动，开始下一轮</button><button className="button secondary small" onClick={() => timerStore.dispatch('snooze')}>5 分钟后提醒</button></div></div></aside>}
    <dialog ref={dialog} className="confirm-dialog"><h2>清空本地数据？</h2><p>将清除这份工具箱的训练记录、收藏和偏好，并重置当前计时。此操作无法撤销。</p><div className="button-row"><button autoFocus className="button secondary" onClick={() => dialog.current?.close()}>保留数据</button><button className="button danger" onClick={() => { dataStore.clear(); dialog.current?.close(); }}>确认清空</button></div></dialog>
  </div>;
}
