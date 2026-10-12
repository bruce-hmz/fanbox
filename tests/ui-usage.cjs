'use strict';
// 用已安装的 Playwright 运行：NODE_PATH=<含playwright的node_modules> node tests/ui-usage.cjs
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
require('fs').mkdirSync('tests/artifacts', { recursive: true });
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => { localStorage.setItem('fb_guided', '1'); localStorage.setItem('fb_usage_open', '1'); localStorage.setItem('fb_theme', 'warm'); });
  const bucket = { input: 20, output: 10, cacheRead: 80, cacheCreate: 0, reasoning: 3, total: 110 };
  const tokens = { last5h: bucket, today: bucket, week: bucket };
  const data = { ok: true, codex: { ...tokens, planType: 'pro', source: 'official', capturedAt: Date.now(), primary: { usedPercent: 87, windowMinutes: 10080 }, resets: { available: 1, applicable: 0 } }, claude: { ...tokens, official: { error: '额度接口HTTP 429', stale: true } } };
  await page.route('**/api/agent-usage', (route) => route.fulfill({ json: data }));
  await page.goto('http://localhost:4579'); await page.waitForLoadState('networkidle');
  const panel = page.locator('#usage-body');
  assert.match(await panel.innerText(), /周额度/);
  assert.doesNotMatch((await panel.innerText()).split('Claude Code')[0], /5h窗口/);
  await page.locator('.usage-detail[data-agent="codex"] summary').click();
  assert.match(await panel.innerText(), /缓存读取/);
  assert.match(await panel.innerText(), /输入缓存命中率/);
  assert.equal(await panel.evaluate((el) => el.scrollWidth > el.clientWidth), false);
  await page.locator('#sidebar').screenshot({ path: 'tests/artifacts/usage-details.png' });
  // 用真实渲染器验证Plus两个窗口、旧快照未知状态以及刷新失败保留内容。
  await page.evaluate(() => {
    const b = { input: 20, output: 10, cacheRead: 80, cacheCreate: 0, reasoning: 3, total: 110 };
    usagePanel.render({ ok: true, codex: { planType: 'plus', source: 'snapshot', capturedAt: Date.now(), primary: { usedPercent: 50, windowMinutes: 300 }, secondary: { usedPercent: 90, windowMinutes: 10080, stale: true }, today: b, last5h: b, week: b } });
  });
  assert.match(await panel.innerText(), /5h窗口/); assert.match(await panel.innerText(), /待更新/); assert.doesNotMatch(await panel.innerText(), /90%/);
  assert.equal(await page.locator('.usage-detail[data-agent="codex"]').getAttribute('open'), '');
  await page.evaluate(() => usagePanel.render(null)); assert.match(await panel.innerText(), /刷新失败，保留上次数据/); assert.match(await panel.innerText(), /50%/);
  assert.deepEqual(errors, []);
  console.log('UI checks passed: Pro weekly, Plus dual windows, cache details, unknown expired quota, retained last value, no overflow/errors');
  await browser.close();
})().catch((e) => { console.error(e); process.exitCode = 1; });
