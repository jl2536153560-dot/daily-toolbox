import { useState } from 'react';
import { Bell, Check, Footprints, Pause, Play, RotateCcw, Volume2 } from 'lucide-react';
import { PageHeading } from '../App';
import { formatTime, INTERVAL } from '../core';
import { dataStore, timerStore, unlockAudio, useData, useTimer } from '../store';

export default function Reminder() {
  const { state, now } = useTimer(), { preferences } = useData();
  const [notificationStatus, setNotificationStatus] = useState(''), [busy, setBusy] = useState(false);
  const remaining = state.status === 'running' ? Math.max(0, state.deadline! - now) : state.remaining;
  const progress = Math.max(0, Math.min(1, remaining / INTERVAL));
  const permission = 'Notification' in window ? Notification.permission : 'unsupported';
  async function enableNotifications() {
    if (busy) return;
    if (!('Notification' in window)) { setNotificationStatus('此浏览器不支持系统通知，页面提醒仍会显示。'); return; }
    if (preferences.notifications) { dataStore.setPreferences({ notifications: false }); setNotificationStatus('已关闭系统通知。'); return; }
    setBusy(true);
    try {
      const result = await Notification.requestPermission();
      dataStore.setPreferences({ notifications: result === 'granted' });
      setNotificationStatus(result === 'granted' ? '已开启系统通知；系统勿扰设置仍可能影响显示。' : result === 'denied' ? '通知权限已被拒绝，可在浏览器站点设置中修改。页面提醒仍然有效。' : '暂未授权，继续使用页面提醒。');
    } catch { setNotificationStatus('系统通知暂不可用，继续使用页面提醒。'); } finally { setBusy(false); }
  }
  return <><PageHeading label="01 / MOVE" title="久坐提醒" description="专注的时候，也别忘了起来走走。" /><div className="reminder-layout"><section className="panel timer-panel"><div className="panel-label"><span className={`status-pill ${state.status === 'running' ? 'active' : ''}`}>{({ idle: '准备开始', running: '专注进行中', paused: '已暂停', due: '活动时间到' })[state.status]}</span><span className="muted">每轮 30 分钟</span></div><div className="timer-ring"><svg viewBox="0 0 300 300" aria-hidden="true"><circle className="ring-track" cx="150" cy="150" r="138" /><circle className="ring-progress" cx="150" cy="150" r="138" strokeDasharray={`${2 * Math.PI * 138}`} strokeDashoffset={`${2 * Math.PI * 138 * (1 - progress)}`} /></svg><div><span className="eyebrow">NEXT BREAK IN</span><strong id="timer-display" role="timer" aria-label={`倒计时 ${formatTime(remaining)}`}>{formatTime(remaining)}</strong><span>{state.status === 'due' ? '该给身体一点活动了' : '距离下一次起身活动'}</span></div></div><div className="timer-controls">{state.status === 'due' ? <button className="button" onClick={() => { unlockAudio(); timerStore.dispatch('next'); }}><Check size={19} />已活动，开始下一轮</button> : <button id="timer-toggle" className="button" onClick={() => { unlockAudio(); timerStore.dispatch(state.status === 'running' ? 'pause' : 'start'); }}>{state.status === 'running' ? <Pause size={19} /> : <Play size={19} />}{state.status === 'running' ? '暂停计时' : state.status === 'paused' ? '继续计时' : '开始计时'}</button>}<button id="timer-reset" className="button secondary" onClick={() => timerStore.dispatch('reset')}><RotateCcw size={18} />重置</button></div><p className="muted timer-hint">切换工具不影响计时，刷新当前标签页可恢复进度。</p></section><div className="side-panels"><section className="panel"><h2>提醒方式</h2><div className="setting-row"><Volume2 size={21} /><div><strong>提示音</strong><p>活动时间到时，轻声提醒</p></div><label className="switch"><input aria-label="提示音" type="checkbox" checked={preferences.sound} onChange={e => { unlockAudio(); dataStore.setPreferences({ sound: e.target.checked }); }} /><span /></label></div><p className="fine-print">刷新后如需声音，请点击开始、继续或提示音开关，恢复浏览器音频权限。</p><div className="setting-row"><Bell size={21} /><div><strong>系统通知</strong><p>{permission === 'unsupported' ? '当前浏览器不支持' : preferences.notifications && permission === 'granted' ? '已开启' : '需要浏览器授权'}</p></div><button id="notification-enable" className="button secondary small" disabled={busy} onClick={enableNotifications}>{busy ? '授权中' : preferences.notifications && permission === 'granted' ? '关闭' : '开启'}</button></div><div className="fine-print" role="status">{notificationStatus || timerStore.getDeliveryNotice()}</div></section><section className="movement-note"><span className="icon-tile"><Footprints size={24} /></span><h2>起身，不必很复杂</h2><p>离开椅子，走动一会儿。换个姿势、看看远处，再决定何时回来继续。</p></section><p className="fine-print">关闭网页后停止提醒。后台标签页、锁屏、设备休眠或系统勿扰模式可能导致提醒延迟或无法显示。</p></div></div></>;
}
