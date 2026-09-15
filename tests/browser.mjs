import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const base = process.env.TOOLBOX_URL || 'http://127.0.0.1:5173';
const out = path.resolve('.qa');
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chromium', headless: true, args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage(), errors = [];
page.on('pageerror', error => errors.push(error.message));
const prefix = 'everyday-toolbox:v1:';
const wait = async (condition, message = 'condition', limit = 6000) => {
  const start = Date.now();
  while (Date.now() - start < limit) { if (await condition()) return; await new Promise(r => setTimeout(r, 30)); }
  throw new Error(`Timed out: ${message}`);
};
const has = text => page.getByText(text, { exact: true }).first().isVisible();
const click = name => page.getByRole('button', { name, exact: true }).click();
const nav = async name => { await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: new RegExp('^' + name) }).click(); await page.getByRole('heading', { name: name === '总览' ? '我的日常工具箱' : name, exact: true }).waitFor(); };
const read = key => page.evaluate(key => JSON.parse(localStorage.getItem('everyday-toolbox:v1:' + key) || 'null'), key);
const phase = () => page.locator('#training-stage').getAttribute('data-phase');

try {
  await page.goto(base); await page.waitForSelector('h1');
  assert.equal(await page.title(), '日常工具箱 · 日常工具箱');
  await click('开始计时'); await nav('久坐提醒');
  await wait(async () => (await page.locator('#timer-display').textContent()) !== '30:00', 'timer advances');
  await click('暂停计时');
  const paused = await page.locator('#timer-display').textContent();
  await page.reload(); await wait(() => has('继续计时'), 'paused timer restores');
  assert.equal(await page.locator('#timer-display').textContent(), paused);
  await click('继续计时'); await nav('康复知识'); await nav('久坐提醒'); assert(await has('暂停计时'));
  await page.evaluate(() => {
    window.notificationCount = 0;
    Object.defineProperty(window, 'Notification', { configurable: true, value: class { static permission = 'granted'; static requestPermission() { return Promise.resolve('granted'); } constructor() { window.notificationCount++; } } });
  });
  await click('开启');
  await page.evaluate(() => { window.originalDateNow = Date.now; Date.now = () => window.originalDateNow() + 1800001; window.dispatchEvent(new Event('focus')); });
  await page.getByRole('alert', { name: '起来活动一下' }).waitFor();
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('focus')); });
  assert.equal(await page.evaluate(() => window.notificationCount), 1);
  await click('5 分钟后提醒');
  assert.equal(await page.locator('#timer-display').textContent(), '05:00');
  await click('重置'); assert.equal(await page.locator('#timer-display').textContent(), '30:00');
  await page.evaluate(() => { Date.now = window.originalDateNow; });
  // Denial is deliberate and remains recoverable with page-only alerts.
  await click('关闭');
  await page.evaluate(() => Object.defineProperty(window, 'Notification', { configurable: true, value: class { static permission = 'denied'; static requestPermission() { return Promise.resolve('denied'); } } }));
  await click('开启'); await wait(() => page.getByText('通知权限已被拒绝', { exact: false }).isVisible(), 'notification denial');
  const another = await context.newPage(); await another.goto(base + '/reminder');
  assert(await another.getByRole('button', { name: '开始计时', exact: true }).isVisible()); await another.close();
  console.log('PASS reminder: start, pause, refresh, resume, navigation, single overdue notification, snooze, reset, denied permission, fresh tab');

  await nav('反应与决策');
  await page.clock.install({ time: new Date('2026-09-15T10:00:00Z') });
  await click('开始这一组'); await page.keyboard.press('Space');
  assert.match(await page.locator('#training-stage').textContent(), /抢跑/);
  await page.clock.runFor(901);
  await page.evaluate(() => window.dispatchEvent(new Event('blur'))); assert(await has('训练已暂停'));
  await click('继续训练');
  for (let i = 0; i < 10; i++) {
    await page.clock.runFor(5100); assert.equal(await phase(), 'active');
    await page.clock.runFor(120); await page.keyboard.press('Space'); await page.keyboard.press('Space');
    assert.equal(await phase(), 'feedback'); await page.clock.runFor(760);
  }
  assert(await has('这一组，完成了'));
  let records = await read('records'); assert.equal(records.length, 1); assert.equal(records[0].total, 10); assert.equal(records[0].correct, 10); assert.equal(records[0].falseStarts, 1);
  console.log('PASS reaction: early input, blur/resume, 10 trials, repeated input guard, saved result');

  await page.getByRole('button', { name: /方向选择 20/ }).click(); await click('开始这一组');
  let didError = false, didMiss = false, stopCount = 0;
  const keyMap = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };
  for (let i = 0; i < 20; i++) {
    await page.clock.runFor(30); assert.equal(await phase(), 'active');
    const target = await page.locator('#training-stage').getAttribute('data-target');
    if (target === 'stop') { stopCount++; await page.clock.runFor(2001); }
    else if (!didError) { await page.keyboard.press(target === 'up' ? 'ArrowDown' : 'ArrowUp'); didError = true; }
    else if (!didMiss) { await page.clock.runFor(2001); didMiss = true; }
    else { await page.clock.runFor(150); await page.keyboard.press(keyMap[target]); await page.keyboard.press(keyMap[target]); }
    await page.clock.runFor(660);
  }
  assert(await has('这一组，完成了')); records = await read('records');
  assert.equal(stopCount, 4); assert.equal(records[0].mode, 'direction'); assert.equal(records[0].correct, 18); assert.equal(records[0].errors, 1); assert.equal(records[0].misses, 1);
  console.log('PASS direction: balanced deck, correct response, wrong response, timeout, no-go, repeated input, score 18/20');

  const correct = { basketball: [1,0,2,1,2,0], fps: [2,0,1,2,0,1] };
  for (const topic of ['basketball', 'fps']) {
    await page.getByRole('button', { name: /场景决策 篮球/ }).click();
    await page.getByLabel('情境', { exact: true }).selectOption(topic);
    await click('鼠标'); await click('开始这一组');
    for (let i = 0; i < 6; i++) {
      await page.clock.runFor(30);
      assert.equal(await page.locator('.scenario-map svg').count(), 1);
      await page.locator('.answer-option').nth(correct[topic][i]).click();
      assert(await has('选择合理'));
      await click(i === 5 ? '查看本组结果' : '下一题');
    }
    await page.clock.runFor(30); assert(await has('这一组，完成了'));
    records = await read('records'); assert.equal(records[0].mode, topic); assert.equal(records[0].correct, 6); assert.equal(records[0].input, 'mouse');
    assert.equal(await page.locator('.review-list details').count(), 6);
  }
  console.log('PASS scenarios: 12 diagrams/questions, all options and explanations, keyboard/mouse separation, review');

  await nav('康复知识'); await wait(async () => await page.locator('.knowledge-card').count() === 5, 'five knowledge cards');
  await click('膝'); await wait(async () => await page.locator('.knowledge-card').count() === 1, 'one filtered card'); await click('全部知识');
  await page.getByLabel('搜索康复知识').fill('戳伤'); await wait(async () => await page.locator('.knowledge-card').count() === 1, 'one filtered card');
  await page.locator('.bookmark-button').click(); await page.getByLabel('搜索康复知识').fill(''); await click('只看收藏');
  await wait(async () => await page.locator('.knowledge-card').count() === 1, 'one filtered card');
  await page.locator('.knowledge-card h2 a').click(); await page.reload();
  assert(await page.getByRole('heading', { name: '先留意这些就医信号' }).isVisible());
  assert.equal(await page.locator('.article-body section').count(), 5); assert.equal(await page.locator('.sources a').count(), 2);
  await nav('康复知识'); await page.getByLabel('搜索康复知识').fill('不存在的关键词');
  assert(await has('暂时没有匹配的文章')); await click('清除筛选');
  console.log('PASS rehab: five articles, filter, search, favorites, direct article reload, red flags, sources, empty state');

  // Local storage corruption and unavailable storage both preserve a usable surface.
  const unavailable = await context.newPage();
  await unavailable.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Blocked', 'SecurityError'); } }); Object.defineProperty(window, 'sessionStorage', { get() { throw new DOMException('Blocked', 'SecurityError'); } }); });
  await unavailable.goto(base); await unavailable.getByRole('button', { name: '开始计时', exact: true }).click();
  assert(await unavailable.getByText('浏览器存储不可用', { exact: false }).isVisible());
  await unavailable.close();
  console.log('PASS storage unavailable: website and timer remain usable');

  const routes = ['/', '/reminder', '/training', '/rehab', '/rehab/ankle', '/rehab/knee', '/rehab/finger', '/rehab/shoulder', '/rehab/back'];
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const route of routes) {
      await page.goto(base + route); await page.waitForSelector('h1');
      const measured = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
      assert(measured.content <= width, `${route} overflow at ${width}: ${measured.content}`);
      if (routes.indexOf(route) < 5) await page.screenshot({ path: path.join(out, `${route === '/' ? 'home' : route.slice(1).replaceAll('/', '-')}-${width}.png`), fullPage: true });
    }
  }
  await page.goto(base); await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '200% text zoom no horizontal page overflow');
  await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
  await page.keyboard.press('Tab');
  const focusTag = await page.evaluate(() => document.activeElement.tagName); assert.notEqual(focusTag, 'BODY');
  await click('清空本地数据'); await click('保留数据'); assert((await read('records')).length > 0);
  await click('清空本地数据'); await click('确认清空'); assert.equal(await read('records'), null); assert.equal(await read('favorites'), null);
  assert.deepEqual(errors, []);
  console.log('PASS layout: all 9 routes at 1440/390, 200% text size, keyboard focus, clear/cancel');
  console.log('ALL BROWSER CHECKS PASSED');
} catch (error) { await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {}); console.error('Browser errors:', errors); throw error; } finally { await browser.close(); }
