// Serve the actual Pages output from a repository subdirectory without SPA fallback.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const root = path.resolve('pages-dist');
const prefix = '/daily-toolbox/';
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (!pathname.startsWith(prefix)) { res.writeHead(404).end(); return; }
    const target = path.resolve(root, decodeURIComponent(pathname.slice(prefix.length)) || 'index.html');
    if (!target.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    const data = await readFile(target);
    res.writeHead(200, { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream' }).end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chromium', headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  const base = `http://127.0.0.1:${server.address().port}${prefix}`;
  const cases = [
    ['/', '我的日常工具箱'], ['/reminder', '久坐提醒'], ['/training', '反应与决策'], ['/rehab', '康复知识'],
    ['/rehab/ankle', '崴脚之后，先判断再恢复'], ['/rehab/knee', '膝盖不舒服，不急着给它贴标签'],
    ['/rehab/finger', '接球戳伤，别急着把手指掰回去'], ['/rehab/shoulder', '肩部疼痛，先区分外伤与日常不适'],
    ['/rehab/back', '腰背不适：保持活动，也认识警示信号'],
  ];
  for (const [route, title] of cases) {
    await page.goto(base + '#' + route);
    await page.getByRole('heading', { level: 1, name: title, exact: true }).waitFor();
    await page.reload();
    await page.getByRole('heading', { level: 1, name: title, exact: true }).waitFor();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Layout: ${route}`);
  }
  await page.goto(base + '#/reminder');
  await page.getByRole('button', { name: '开始计时', exact: true }).click();
  await page.getByRole('navigation').getByRole('link', { name: '康复知识', exact: true }).click();
  await page.getByRole('heading', { name: '康复知识', exact: true }).waitFor();
  assert.equal(new URL(page.url()).hash, '#/rehab');
  await page.getByRole('navigation').getByRole('link', { name: /^久坐提醒/ }).click();
  await page.getByRole('button', { name: '暂停计时', exact: true }).waitFor();
  await page.reload(); await page.getByRole('button', { name: '暂停计时', exact: true }).waitFor();
  const beforeSkip = page.url();
  await page.getByRole('link', { name: '跳到主要内容' }).focus();
  await page.keyboard.press('Enter');
  assert.equal(page.url(), beforeSkip);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'main');
  assert.deepEqual(errors, []);
  console.log('PAGES CHECKS PASSED: repository subpath, 9 direct links + refresh, local assets, navigation, running timer recovery, mobile layout');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
