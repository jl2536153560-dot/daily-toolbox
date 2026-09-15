import { median, scoreDirection } from './core';
import type { Direction, InputMethod, Mode, TrainingRecord } from './core';
import { scenarios } from './data/scenarios';

export type Phase = 'intro' | 'waiting' | 'active' | 'feedback' | 'paused' | 'done';
export type Answer = { questionId: string; choice: number; elapsed: number; correct: boolean };
export type TrainingState = {
  phase: Phase; mode: Mode; input: InputMethod; index: number; target: Direction;
  times: number[]; correct: number; errors: number; misses: number; falseStarts: number;
  feedback: string; answers: Answer[]; result: TrainingRecord | null;
};
const initial = (mode: Mode, input: InputMethod): TrainingState => ({ phase: 'intro', mode, input, index: 0, target: 'up', times: [], correct: 0, errors: 0, misses: 0, falseStarts: 0, feedback: '', answers: [], result: null });
export class TrainingEngine {
  private state: TrainingState;
  private listeners = new Set<() => void>();
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private frame = 0;
  private generation = 0;
  private onset = 0;
  private directionDeck: Direction[] = [];
  private accumulated = 0;
  private segmentStart = 0;
  constructor(mode: Mode, input: InputMethod, private save: (record: TrainingRecord) => void) { this.state = initial(mode, input); }
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private set(patch: Partial<TrainingState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(fn => fn()); }
  get total() { return this.state.mode === 'reaction' ? 10 : this.state.mode === 'direction' ? 20 : 6; }
  private clear() { this.generation++; if (this.timeout) clearTimeout(this.timeout); cancelAnimationFrame(this.frame); }
  private later(fn: () => void, ms: number) { const token = this.generation; this.timeout = setTimeout(() => { if (token === this.generation) fn(); }, ms); }
  start() {
    this.clear(); this.accumulated = 0; this.segmentStart = performance.now();
    this.directionDeck = Array.from({ length: 20 }, (_, i) => (['up', 'down', 'left', 'right', 'stop'] as Direction[])[i % 5]);
    for (let i = this.directionDeck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [this.directionDeck[i], this.directionDeck[j]] = [this.directionDeck[j], this.directionDeck[i]]; }
    this.set(initial(this.state.mode, this.state.input)); this.round();
  }
  private round() {
    this.clear();
    if (this.state.index >= this.total) { this.finish(); return; }
    this.set({ phase: 'waiting', feedback: '' });
    if (this.state.mode === 'reaction') this.later(() => this.activate(), 2000 + Math.random() * 3000);
    else this.activate();
  }
  private activate() {
    const token = this.generation;
    this.frame = requestAnimationFrame(() => {
      if (token !== this.generation) return;
      this.onset = performance.now();
      this.set({ phase: 'active', target: this.directionDeck[this.state.index] ?? 'up' });
      if (this.state.mode === 'direction') this.later(() => this.respond(null, this.state.input), 2000);
    });
  }
  respond(answer: Direction | number | null, input: InputMethod) {
    const s = this.state;
    if (input !== s.input) return;
    if (s.phase === 'waiting' && s.mode === 'reaction') {
      this.clear(); this.set({ phase: 'feedback', falseStarts: s.falseStarts + 1, feedback: '抢跑了，等到「现在点击」再操作。本次不计入有效次数。' });
      this.later(() => this.round(), 900); return;
    }
    if (s.phase !== 'active') return;
    const elapsed = Math.max(0, performance.now() - this.onset);
    this.clear(); // Lock the round synchronously; repeated input cannot score twice.
    if (s.mode === 'reaction') {
      const ms = Math.round(elapsed);
      this.set({ phase: 'feedback', index: s.index + 1, times: [...s.times, ms], correct: s.correct + 1, feedback: `${ms} ms · 已记录` });
      this.later(() => this.round(), 750);
    } else if (s.mode === 'direction') {
      const result = scoreDirection(s.target, answer as Direction | null, elapsed);
      this.set({ phase: 'feedback', index: s.index + 1, correct: s.correct + Number(result.correct), errors: s.errors + Number(result.error), misses: s.misses + Number(result.miss), times: result.reaction === null ? s.times : [...s.times, result.reaction], feedback: result.correct ? s.target === 'stop' ? '正确，成功抑制操作' : `${result.reaction} ms · 方向正确` : result.miss ? '超时漏答，下一题继续' : '误操作，先辨认目标再作选择' });
      this.later(() => this.round(), 650);
    } else {
      const question = scenarios.filter(q => q.topic === s.mode)[s.index];
      if (typeof answer !== 'number' || ![0, 1, 2].includes(answer)) return;
      const correct = question.correct === answer;
      this.set({ phase: 'feedback', correct: s.correct + Number(correct), errors: s.errors + Number(!correct), times: [...s.times, Math.round(elapsed)], answers: [...s.answers, { questionId: question.id, choice: answer, elapsed: Math.round(elapsed), correct }], feedback: correct ? '选择合理' : '换个角度想一想' });
    }
  }
  next() { if (this.state.phase !== 'feedback' || ['reaction', 'direction'].includes(this.state.mode)) return; this.set({ index: this.state.index + 1 }); this.round(); }
  pause() {
    if (!['waiting', 'active', 'feedback'].includes(this.state.phase)) return;
    // A scored feedback screen is safe to retain for scenarios; no active measurement exists there.
    if (this.state.phase === 'feedback' && ['basketball', 'fps'].includes(this.state.mode)) return;
    this.accumulated += performance.now() - this.segmentStart; this.clear(); this.set({ phase: 'paused' });
  }
  resume() { if (this.state.phase !== 'paused') return; this.segmentStart = performance.now(); this.round(); }
  private finish() {
    this.clear(); const s = this.state;
    const result: TrainingRecord = { id: crypto.randomUUID(), date: new Date().toISOString(), mode: s.mode, input: s.input, total: this.total, correct: s.correct, median: median(s.times), fastest: s.times.length ? Math.min(...s.times) : null, falseStarts: s.falseStarts, errors: s.errors, misses: s.misses, elapsed: Math.round(this.accumulated + performance.now() - this.segmentStart) };
    this.set({ phase: 'done', result }); this.save(result);
  }
  dispose() { this.clear(); this.listeners.clear(); }
}
