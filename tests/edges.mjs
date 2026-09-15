import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const base = process.env.TOOLBOX_URL || 'http://127.0.0.1:5173';
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chromium', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await page.goto(base + '/training'); await page.getByRole('button', { name: '触屏', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '触屏', exact: true }).getAttribute('aria-pressed'), 'true');
  await page.clock.install();
  await page.getByRole('button', { name: '开始这一组', exact: true }).tap();
  for (let i = 0; i < 10; i++) {
    await page.clock.runFor(5100);
    await page.keyboard.press('Space'); // Wrong input method is ignored.
    assert.equal(await page.locator('#training-stage').getAttribute('data-phase'), 'active');
    await page.locator('#training-stage').tap(); await page.clock.runFor(760);
  }
  await page.getByRole('heading', { name: '这一组，完成了' }).waitFor();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('everyday-toolbox:v1:records'))[0].input), 'touch');
  console.log('PASS actual touch input: 10 trials, keyboard ignored, touch record saved');
  await page.goto(base + '/training');
  await page.getByRole('button', { name: /场景决策/ }).click();
  await page.getByRole('button', { name: '键盘', exact: true }).click();
  await page.getByRole('button', { name: '开始这一组' }).click(); await page.clock.runFor(30);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.getByRole('button', { name: '继续训练' }).click(); await page.clock.runFor(30);
  await page.keyboard.press('1'); await page.getByRole('heading', { name: '换个角度想一想' }).waitFor();
  await page.keyboard.press('2'); assert.equal(await page.locator('.answer-feedback').count(), 1);
  await page.getByRole('button', { name: '下一题', exact: true }).click(); await page.clock.runFor(30);
  assert.equal(await page.locator('.scenario-question h2').textContent(), '底角出现空位');
  console.log('PASS scenario keyboard, wrong answer, repeated input, blur restarts current question');
  // Exercise the real store (same module as UI) for retention without manufacturing 31 user sessions.
  const cap = await page.evaluate(async () => {
    const { dataStore } = await import('/src/store.ts');
    const template = dataStore.getSnapshot().records[0];
    for (let i = 0; i < 35; i++) dataStore.saveRecord({ ...template, id: `cap-${i}` });
    const list = dataStore.getSnapshot().records;
    return { count: list.length, first: list[0].id, last: list.at(-1).id, stored: JSON.parse(localStorage.getItem('everyday-toolbox:v1:records')).length };
  });
  assert.deepEqual(cap, { count: 30, first: 'cap-34', last: 'cap-5', stored: 30 });
  await page.evaluate(() => localStorage.setItem('everyday-toolbox:v1:records', '{broken'));
  await page.reload(); await page.getByText('浏览器存储不可用或记录已损坏', { exact: false }).waitFor();
  assert(await page.getByRole('button', { name: '开始这一组' }).isVisible());
  console.log('PASS 30-record cap, newest-first retention, corrupt storage fallback');
  await context.close();

  const agentContext = await browser.newContext();
  await agentContext.addInitScript(() => {
    window.registeredTools = new Map();
    Object.defineProperty(document, 'modelContext', { configurable: true, value: { registerTool(tool, options) { window.registeredTools.set(tool.name, tool); options.signal.addEventListener('abort', () => window.registeredTools.delete(tool.name)); } } });
  });
  const agentPage = await agentContext.newPage(); await agentPage.goto(base + '/reminder'); await agentPage.waitForFunction(() => window.registeredTools.has('read_toolbox_status'));
  const result = await agentPage.evaluate(() => { const t = window.registeredTools.get('read_toolbox_status'); const state = t.execute({}); let invalid = false; try { t.execute({ action: 'reset' }); } catch { invalid = true; } return { name: t.name, readOnly: t.annotations.readOnlyHint, status: state.reminder.status, invalid }; });
  assert.deepEqual(result, { name: 'read_toolbox_status', readOnly: true, status: 'idle', invalid: true });
  await agentPage.getByRole('button', { name: '开始计时', exact: true }).click();
  assert.equal(await agentPage.evaluate(() => window.registeredTools.get('read_toolbox_status').execute({}).reminder.status), 'running');
  await agentPage.reload(); await agentPage.getByRole('button', { name: '暂停计时', exact: true }).waitFor();
  const copied = await agentPage.evaluate(async () => { const { timerStore } = await import('/src/store.ts'); const s = timerStore.getSnapshot().state; sessionStorage.setItem('everyday-toolbox:v1:timer', JSON.stringify({ ...s, deadline: Date.now() - 1000 })); return s; });
  assert.equal(copied.status, 'running');
  await agentPage.reload(); await agentPage.getByRole('alert', { name: '起来活动一下' }).waitFor();
  await agentPage.getByRole('alert').getByRole('button', { name: '已活动，开始下一轮' }).click();
  await agentPage.getByRole('button', { name: '暂停计时', exact: true }).waitFor();
  const fresh = await agentContext.newPage();
  await fresh.addInitScript(() => sessionStorage.setItem('everyday-toolbox:v1:timer', JSON.stringify({ status: 'running', deadline: Date.now() + 1000, remaining: 1000, cycle: 0 })));
  await fresh.goto(base + '/reminder'); await fresh.getByRole('button', { name: '开始计时', exact: true }).waitFor();
  console.log('PASS timer running refresh, overdue recovery, next cycle, copied session ignored on new navigation');
  console.log('PASS WebMCP mocked contract: registration, read-only state readback, invalid input rejected (native context unavailable)');
  await agentContext.close();
  console.log('ALL EDGE CHECKS PASSED');
} finally { await browser.close(); }
