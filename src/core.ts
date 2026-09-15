export const INTERVAL = 30 * 60 * 1000;
export const PREFIX = 'everyday-toolbox:v1:';
export type TimerState = { status: 'idle' | 'running' | 'paused' | 'due'; remaining: number; deadline: number | null; cycle: number };
export const freshTimer = (): TimerState => ({ status: 'idle', remaining: INTERVAL, deadline: null, cycle: 0 });
export type TimerAction = 'start' | 'pause' | 'reset' | 'next' | 'snooze' | 'tick';
export function timerTransition(s: TimerState, action: TimerAction, now: number): TimerState {
  if (action === 'reset') return freshTimer();
  if (action === 'next' || action === 'snooze') {
    const ms = action === 'next' ? INTERVAL : 5 * 60 * 1000;
    return { status: 'running', remaining: ms, deadline: now + ms, cycle: s.cycle + 1 };
  }
  if (action === 'start' && (s.status === 'idle' || s.status === 'paused')) return { ...s, status: 'running', deadline: now + s.remaining };
  if (s.status !== 'running' || s.deadline === null) return s;
  const remaining = Math.max(0, s.deadline - now);
  if (remaining === 0) return { ...s, status: 'due', remaining: 0, deadline: null };
  if (action === 'pause') return { ...s, status: 'paused', remaining, deadline: null };
  return s;
}
export function isTimer(value: unknown): value is TimerState {
  if (!value || typeof value !== 'object') return false;
  const s = value as TimerState;
  return ['idle', 'running', 'paused', 'due'].includes(s.status) && Number.isFinite(s.remaining) && s.remaining >= 0 && s.remaining <= INTERVAL && Number.isInteger(s.cycle) && s.cycle >= 0 && (s.status === 'running' ? typeof s.deadline === 'number' && Number.isFinite(s.deadline) && s.deadline > 0 : s.deadline === null);
}
export function formatTime(ms: number): string {
  const seconds = Math.ceil(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
}
export type Mode = 'reaction' | 'direction' | 'basketball' | 'fps';
export type InputMethod = 'keyboard' | 'mouse' | 'touch';
export const modeNames: Record<Mode, string> = { reaction: '变色反应', direction: '方向选择', basketball: '篮球决策', fps: 'FPS 决策' };
export const inputNames: Record<InputMethod, string> = { keyboard: '键盘', mouse: '鼠标', touch: '触屏' };
export type TrainingRecord = { id: string; date: string; mode: Mode; input: InputMethod; total: number; correct: number; median: number | null; fastest: number | null; falseStarts: number; errors: number; misses: number; elapsed: number };
export function isRecord(v: unknown): v is TrainingRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as TrainingRecord;
  return typeof r.id === 'string' && typeof r.date === 'string' && Number.isFinite(Date.parse(r.date)) && Object.hasOwn(modeNames, r.mode) && Object.hasOwn(inputNames, r.input) && [r.total, r.correct, r.falseStarts, r.errors, r.misses, r.elapsed].every(n => Number.isFinite(n) && n >= 0) && r.total > 0 && r.correct <= r.total && [r.median, r.fastest].every(n => n === null || (Number.isFinite(n) && n >= 0));
}
export type Direction = 'up' | 'down' | 'left' | 'right' | 'stop';
export function scoreDirection(target: Direction, answer: Direction | null, elapsed: number) {
  const within = elapsed < 2000;
  if (!within) answer = null; // Input delivered after the deadline belongs to no active question.
  const correct = target === 'stop' ? answer === null : within && answer === target;
  return { correct, miss: !correct && (answer === null || !within) && target !== 'stop', error: !correct && answer !== null && (within || target === 'stop'), reaction: correct && target !== 'stop' ? Math.round(elapsed) : null };
}
