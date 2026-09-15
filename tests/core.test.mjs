import test from 'node:test';
import assert from 'node:assert/strict';
import { INTERVAL, freshTimer, timerTransition, formatTime, isTimer, median, scoreDirection, isRecord } from '../src/core.ts';

test('30 分钟开始、暂停与继续保留正确剩余时间', () => {
  const start = timerTransition(freshTimer(), 'start', 1000);
  assert.equal(start.deadline, 1000 + INTERVAL);
  const paused = timerTransition(start, 'pause', 61000);
  assert.equal(paused.remaining, INTERVAL - 60000);
  assert.equal(paused.deadline, null);
  const resumed = timerTransition(paused, 'start', 100000);
  assert.equal(resumed.deadline, 100000 + INTERVAL - 60000);
});
test('超时只转换一次，不累计补发，延后与新一轮起点准确', () => {
  const start = timerTransition(freshTimer(), 'start', 1000);
  const due = timerTransition(start, 'tick', 1000 + INTERVAL * 10);
  assert.equal(due.status, 'due');
  assert.equal(timerTransition(due, 'tick', 1000 + INTERVAL * 11), due);
  assert.equal(timerTransition(due, 'snooze', 5000).deadline, 305000);
  assert.equal(timerTransition(due, 'next', 5000).deadline, 1805000);
  assert.deepEqual(timerTransition(due, 'reset', 0), freshTimer());
});
test('恰好到期时暂停应显示到期，不能继续零秒循环', () => {
  const start = timerTransition(freshTimer(), 'start', 1000);
  assert.equal(timerTransition(start, 'pause', start.deadline).status, 'due');
});
test('刷新数据验证拒绝畸形计时状态', () => {
  assert.equal(isTimer(freshTimer()), true);
  for (const bad of [null, {}, { ...freshTimer(), remaining: -1 }, { ...freshTimer(), status: 'running' }, { ...freshTimer(), cycle: 'x' }]) assert.equal(isTimer(bad), false);
});
test('显示向上取整；统计不修改输入且正确处理空值', () => {
  assert.equal(formatTime(INTERVAL), '30:00');
  assert.equal(formatTime(59999), '01:00');
  assert.equal(formatTime(-1), '00:00');
  const times = [400, 100, 300, 200];
  assert.equal(median(times), 250);
  assert.deepEqual(times, [400, 100, 300, 200]);
  assert.equal(median([]), null);
  assert.equal(median([90, 100, 200]), 100);
});
test('方向正确、错误、漏答、禁止操作各自计分', () => {
  assert.deepEqual(scoreDirection('up', 'up', 300), { correct: true, miss: false, error: false, reaction: 300 });
  assert.deepEqual(scoreDirection('up', 'left', 300), { correct: false, miss: false, error: true, reaction: null });
  assert.deepEqual(scoreDirection('up', null, 2000), { correct: false, miss: true, error: false, reaction: null });
  assert.deepEqual(scoreDirection('stop', null, 2000), { correct: true, miss: false, error: false, reaction: null });
  assert.deepEqual(scoreDirection('stop', 'up', 500), { correct: false, miss: false, error: true, reaction: null });
  assert.equal(scoreDirection('up', 'up', 2000).miss, true);
});
test('损坏的历史记录不能进入统计', () => {
  assert.equal(isRecord({}), false);
  assert.equal(isRecord({ mode: 'unknown' }), false);
});

test('禁止题到期后送达的输入不追溯为误操作', () => { assert.deepEqual(scoreDirection('stop', 'up', 2001), { correct: true, miss: false, error: false, reaction: null }); });
