import { useSyncExternalStore } from 'react';
import { PREFIX, freshTimer, isTimer, isRecord, timerTransition } from './core';
import type { TimerAction, TrainingRecord } from './core';

type Preferences = { sound: boolean; notifications: boolean };
type Data = { preferences: Preferences; records: TrainingRecord[]; favorites: string[]; warning: string };
const listeners = new Set<() => void>();
let warning = '';
function read(key: string, session = false): unknown {
  try { const raw = (session ? sessionStorage : localStorage).getItem(PREFIX + key); return raw ? JSON.parse(raw) : null; }
  catch { warning = '浏览器存储不可用或记录已损坏。本次仍可使用，部分设置和记录可能无法保存。'; return null; }
}
const preferences = read('preferences') as Partial<Preferences> | null;
const records = read('records'), favorites = read('favorites'), savedTimer = read('timer', true);
let data: Data = {
  preferences: { sound: typeof preferences?.sound === 'boolean' ? preferences.sound : true, notifications: preferences?.notifications === true },
  records: Array.isArray(records) ? records.filter(isRecord).slice(0, 30) : [],
  favorites: Array.isArray(favorites) ? favorites.filter((s): s is string => typeof s === 'string') : [], warning,
};
function emit() { listeners.forEach(fn => fn()); }
function persist(key: string, value: unknown, session = false) {
  try { (session ? sessionStorage : localStorage).setItem(PREFIX + key, JSON.stringify(value)); }
  catch { data = { ...data, warning: '浏览器存储不可用。本次仍可使用，但刷新或关闭后可能丢失设置与记录。' }; emit(); }
}
export const dataStore = {
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  getSnapshot: () => data,
  setPreferences(patch: Partial<Preferences>) { data = { ...data, preferences: { ...data.preferences, ...patch } }; persist('preferences', data.preferences); emit(); },
  saveRecord(record: TrainingRecord) {
    if (data.records.some(r => r.id === record.id)) return;
    data = { ...data, records: [record, ...data.records].slice(0, 30) }; persist('records', data.records); emit();
  },
  toggleFavorite(slug: string) {
    data = { ...data, favorites: data.favorites.includes(slug) ? data.favorites.filter(s => s !== slug) : [...data.favorites, slug] };
    persist('favorites', data.favorites); emit();
  },
  clear() {
    data = { preferences: { sound: true, notifications: false }, records: [], favorites: [], warning: '' };
    for (const key of ['preferences', 'records', 'favorites']) {
      try { localStorage.removeItem(PREFIX + key); } catch { data.warning = '浏览器阻止了清除存储；本次界面已重置，原记录可能仍保留。'; }
    }
    timerStore.dispatch('reset'); emit();
  },
};
export const useData = () => useSyncExternalStore(dataStore.subscribe, dataStore.getSnapshot);

const timerListeners = new Set<() => void>();
const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
let timerSnapshot = { state: navigation?.type === 'reload' && isTimer(savedTimer) ? savedTimer : freshTimer(), now: Date.now() };
let audio: AudioContext | null = null;
let deliveryNotice = '';
export function unlockAudio() {
  try { audio ??= new AudioContext(); void audio.resume().catch(() => {}); } catch { /* Visual reminder remains available. */ }
}
function playTone() {
  if (!audio || audio.state !== 'running') return;
  try {
    const oscillator = audio.createOscillator(), gain = audio.createGain();
    oscillator.type = 'sine'; oscillator.frequency.value = 660;
    gain.gain.setValueAtTime(0.0001, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.18, audio.currentTime + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.65);
    oscillator.connect(gain); gain.connect(audio.destination); oscillator.start(); oscillator.stop(audio.currentTime + 0.7);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
  } catch { /* No audio must never prevent the reminder state. */ }
}
function notifyDue() {
  if (data.preferences.sound) playTone();
  if (data.preferences.notifications && 'Notification' in window && Notification.permission === 'granted') {
    try { new Notification('起来活动一下', { body: '放下手边的事，起身走动。活动后再开始下一轮。', tag: 'everyday-toolbox-break' }); }
    catch { deliveryNotice = '此浏览器无法显示系统通知，请留意页面提醒。'; }
  }
}
export const timerStore = {
  subscribe(fn: () => void) { timerListeners.add(fn); return () => { timerListeners.delete(fn); }; },
  getSnapshot: () => timerSnapshot,
  getDeliveryNotice: () => deliveryNotice,
  dispatch(action: TimerAction) {
    const now = Date.now(), previous = timerSnapshot.state, next = timerTransition(previous, action, now);
    timerSnapshot = { state: next, now };
    if (next !== previous) {
      persist('timer', next, true);
      if (next.status === 'due' && previous.status !== 'due') notifyDue();
    }
    timerListeners.forEach(fn => fn());
  },
};
export const useTimer = () => useSyncExternalStore(timerStore.subscribe, timerStore.getSnapshot);
window.setInterval(() => timerStore.dispatch('tick'), 250);
window.addEventListener('focus', () => timerStore.dispatch('tick'));
window.addEventListener('pageshow', event => { if (event.persisted) timerStore.dispatch('reset'); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) timerStore.dispatch('tick'); });

// Optional WebMCP support: expose only real, read-only state; no automatic permission prompts.
type ToolContext = { registerTool: (tool: object, options: { signal: AbortSignal }) => unknown };
export function registerTools() {
  const context = (document as Document & { modelContext?: ToolContext }).modelContext;
  if (!context?.registerTool) return;
  const lifecycle = new AbortController();
  try {
    void Promise.resolve(context.registerTool({
      name: 'read_toolbox_status', title: '读取工具箱状态', description: '读取当前提醒状态、最近一次训练和收藏数量，不修改数据。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute(input: unknown) {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new Error('请传入空对象。');
        const s = timerStore.getSnapshot().state;
        return { reminder: { status: s.status, remainingMs: s.status === 'running' ? Math.max(0, s.deadline! - Date.now()) : s.remaining }, latestTraining: data.records[0] ?? null, favoriteCount: data.favorites.length };
      },
    }, { signal: lifecycle.signal })).catch(() => {});
  } catch { /* Unsupported experimental API leaves all normal controls usable. */ }
  return () => lifecycle.abort();
}
