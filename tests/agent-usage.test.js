'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalize, consume, aggregate, parseFile } = require('../lib/agent-tokens');
const { createWatchBatcher } = require('../lib/watch-batcher');
const state = () => ({ offset: 0, events: new Map(), last: null });
test('Claude与Codex缓存口径归一，推理不重复计入总量', () => {
  const a = normalize({ input_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 10, output_tokens: 20, output_tokens_details: { thinking_tokens: 5 } }, 'claude');
  const b = normalize({ input_tokens: 100, cached_input_tokens: 80, cache_write_input_tokens: 10, output_tokens: 20, reasoning_output_tokens: 5 }, 'codex');
  assert.deepEqual(a, b); assert.equal(a.total, 120);
});
test('Claude流式补全更新用量，交错重复消息只记一次', () => {
  const c = state();
  const row = (id, output) => ({ timestamp: new Date().toISOString(), type: 'assistant', message: { id, usage: { input_tokens: 5, output_tokens: output } } });
  consume(c, row('a', 1), 'claude'); consume(c, row('b', 3), 'claude'); consume(c, row('a', 20), 'claude'); consume(c, row('a', 1), 'claude');
  const result = aggregate(c.events.values());
  assert.equal(result.today.total, 33); assert.equal(result.today.msgs, 2);
});
test('Codex重复累计快照不会重复计数，累计重置采用最后一次请求', () => {
  const c = state();
  const row = (input, cached, output, last) => ({ timestamp: new Date().toISOString(), payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output }, last_token_usage: last } } });
  consume(c, row(100, 80, 20), 'codex'); consume(c, row(100, 80, 20), 'codex'); consume(c, row(150, 100, 30), 'codex');
  assert.equal(aggregate(c.events.values()).today.total, 180);
  consume(c, row(10, 0, 2, { input_tokens: 10, output_tokens: 2 }), 'codex');
  assert.equal(aggregate(c.events.values()).today.total, 192);
});
test('跨日窗口独立聚合，未来记录不混入', () => {
  const now = new Date(2026, 9, 12, 12).getTime();
  const e = normalize({ input_tokens: 10 }, 'claude');
  const result = aggregate([{ ...e, t: now - 6 * 3600000 }, { ...e, t: now - 2 * 86400000 }, { ...e, t: now + 1 }], now);
  assert.equal(result.last5h.total, 0); assert.equal(result.today.total, 10); assert.equal(result.week.total, 20);
});
test('半行和跨UTF-8字节写入不会丢记录，截断可重建', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fanbox-tokens-')), file = path.join(dir, 'sample.jsonl');
  const row = JSON.stringify({ timestamp: new Date().toISOString(), type: 'assistant', message: { id: '中文', usage: { input_tokens: 8, output_tokens: 2 } } });
  const bytes = Buffer.from(row + '\n'), cut = bytes.indexOf(Buffer.from('中')) + 1;
  fs.writeFileSync(file, bytes.subarray(0, cut));
  assert.equal([...await parseFile(file, fs.statSync(file), 'claude')].length, 0);
  fs.appendFileSync(file, bytes.subarray(cut));
  assert.equal(aggregate(await parseFile(file, fs.statSync(file), 'claude')).today.total, 10);
  fs.writeFileSync(file, '');
  assert.equal([...await parseFile(file, fs.statSync(file), 'claude')].length, 0);
});
test('一万次同文件事件仅一次stat，同内容通知不重绘', async () => {
  let stats = 0; const batches = [];
  const b = createWatchBatcher((x) => batches.push(x), { stat: async () => { stats++; return { ino: 1, size: 2, mtimeMs: 3 }; } });
  for (let i = 0; i < 10000; i++) b.enqueue({ dir: '/project', filename: 'a.md' });
  await b.flush(); assert.equal(stats, 1); assert.equal(batches[0].length, 1);
  b.enqueue({ dir: '/project', filename: 'a.md' }); await b.flush(); assert.equal(batches.length, 1);
});
test('大量不同文件保持有界，并保留目录刷新，stat并行不超过16', async () => {
  let active = 0, max = 0, stats = 0; const batches = [];
  const b = createWatchBatcher((x) => batches.push(x), { stat: async () => {
    active++; stats++; max = Math.max(max, active); await new Promise((r) => setImmediate(r)); active--; return { ino: 1, size: 1, mtimeMs: 1 };
  } });
  for (let i = 0; i < 10000; i++) b.enqueue({ dir: '/project', filename: `${i}.md` });
  await b.flush(); assert.equal(stats, 256); assert.ok(max <= 16); assert.equal(batches[0].length, 257); assert.equal(batches[0].at(-1).overflow, true);
});

const vm = require('vm');
const serverSource = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
function officialContext() {
  const context = { Date, Map, Promise, Error };
  vm.createContext(context);
  vm.runInContext(serverSource.slice(serverSource.indexOf('const officialCache ='), serverSource.indexOf('async function claudeOfficialLimits()')), context);
  return context;
}
test('官方额度请求合并，429保留成功值并退避，后续成功可恢复', async () => {
  const c = officialContext(); let calls = 0;
  const fetcher = async () => { calls++; await new Promise((r) => setImmediate(r)); return { fiveHour: { usedPercent: 42 } }; };
  const values = await Promise.all(Array.from({ length: 20 }, () => c.cachedOfficial('claude', fetcher)));
  assert.equal(calls, 1); assert.equal(values[0].fiveHour.usedPercent, 42);
  vm.runInContext("officialCache.get('claude').next = 0", c);
  const failed = await c.cachedOfficial('claude', async () => { throw new Error('HTTP 429'); });
  assert.equal(failed.fiveHour.usedPercent, 42); assert.equal(failed.stale, true); assert.equal(failed.error, 'HTTP 429');
  await c.cachedOfficial('claude', fetcher); assert.equal(calls, 1);
  vm.runInContext("officialCache.get('claude').next = 0", c);
  const recovered = await c.cachedOfficial('claude', fetcher); assert.equal(recovered.stale, false); assert.equal(recovered.error, null);
});
test('最新Codex快照按事件时间选择，不把过期窗口归零', async () => {
  const now = Date.now();
  const snapshot = (t, pct) => JSON.stringify({ timestamp: new Date(t).toISOString(), payload: { rate_limits: { plan_type: 'pro', primary: { used_percent: pct, window_minutes: 10080, resets_at: Math.floor(now / 1000) - 10 } } } });
  const contents = { '/sessions/old.jsonl': snapshot(now - 10000, 20), '/sessions/new.jsonl': snapshot(now - 1000, 80) };
  const context = { path, Date, Buffer, CODEX_SESS: '/sessions', fsp: {
    readdir: async () => ['old.jsonl', 'new.jsonl'].map((name) => ({ name, isDirectory: () => false, isFile: () => true })),
    stat: async (file) => ({ size: Buffer.byteLength(contents[file]), mtimeMs: file.includes('old') ? now : now - 1 }),
    open: async (file) => ({ read: async (buf) => { buf.write(contents[file]); }, close: async () => {} }),
  } };
  vm.createContext(context); vm.runInContext(serverSource.slice(serverSource.indexOf('async function codexUsage()'), serverSource.indexOf('// Claude Code 官方限额')), context);
  const d = await context.codexUsage(); assert.equal(d.primary.usedPercent, 80); assert.equal(d.primary.stale, true); assert.equal(d.primary.windowMinutes, 10080);
});

test('CLI实时额度只接收有效窗口，丢弃提示词等无关字段', () => {
  const c = officialContext(); c.usageResultCache = { at: 1 };
  const now = Date.now() / 1000;
  const r = c.acceptClaudeLimits({ fiveHour: { usedPercent: 0, resetsAt: now + 100, prompt: 'secret' }, sevenDay: { usedPercent: 80, resetsAt: now - 1 } });
  assert.equal(r.ok, true);
  const d = vm.runInContext('claudeLiveLimits', c);
  assert.equal(d.fiveHour.usedPercent, 0); assert.equal(d.sevenDay, null); assert.equal(d.fiveHour.prompt, undefined); assert.equal(c.usageResultCache.at, 0);
  assert.equal(c.acceptClaudeLimits({ fiveHour: { usedPercent: '85', resetsAt: now + 100 } }).ok, false);
});
test('状态栏桥保留自定义输出，回传零额度且不发送正文', async () => {
  const http = require('http'), { spawn } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fanbox-statusline-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'printf original-status' } }));
  let received, token;
  const server = http.createServer((req, res) => {
    let text = ''; req.on('data', (x) => { text += x; }); req.on('end', () => { received = JSON.parse(text); token = req.headers['x-fanbox-token']; res.end('{}'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const child = spawn(process.execPath, [path.join(__dirname, '../lib/claude-statusline.cjs')], { cwd: dir, env: { ...process.env, CLAUDE_CONFIG_DIR: dir, FANBOX_CTL: `http://127.0.0.1:${server.address().port}/api/agent`, FANBOX_CTL_TOKEN: 'test-only' } });
    let output = ''; child.stdout.on('data', (s) => { output += s; });
    child.stdin.end(JSON.stringify({ cwd: dir, prompt: 'must-not-forward', rate_limits: { five_hour: { used_percentage: 0, resets_at: 2000000000 }, seven_day: { used_percentage: 87, resets_at: 2000000000 } } }));
    await new Promise((resolve, reject) => { child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(String(code)))); child.once('error', reject); });
    assert.equal(output, 'original-status'); assert.equal(received.fiveHour.usedPercent, 0); assert.equal(received.prompt, undefined); assert.equal(token, 'test-only');
  } finally { await new Promise((r) => server.close(r)); }
});
test('更新检查区分API限流并能回退发布页', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8');
  let n = 0;
  const c = { AbortSignal, net: { fetch: async () => ++n === 1 ? { ok: false, status: 403, headers: { get: () => '0' } } : { ok: true, url: 'https://github.com/alchaincyf/fanbox/releases/tag/v2.17.0' } } };
  vm.createContext(c); vm.runInContext(source.slice(source.indexOf('const REL_PAGE ='), source.indexOf('let pendingUpdate =')), c);
  const rel = await c.fetchLatestRelease(); assert.equal(rel.tag, 'v2.17.0'); assert.match(vm.runInContext('latestReleaseError', c), /限流/);
});
test('文件首次只有旧元数据通知时不制造修改提示，删除仍通知', async () => {
  const batches = [];
  let deleted = false;
  const b = createWatchBatcher((x) => batches.push(x), { stat: async () => { if (deleted) throw Object.assign(new Error(), { code: 'ENOENT' }); return { ino: 1, size: 1, mtimeMs: 1, ctimeMs: 1 }; } });
  b.enqueue({ dir: '/project', filename: 'read-only.md' }); await b.flush(); assert.equal(batches.length, 0);
  deleted = true; b.enqueue({ dir: '/project', filename: 'read-only.md' }); await b.flush(); assert.equal(batches.length, 1);
});
test('推理字段缺失与真实零值区分，混合日志标明部分记录', () => {
  const t = Date.now();
  const missing = { ...normalize({ input_tokens: 10, output_tokens: 5 }, 'claude'), t };
  const zero = { ...normalize({ input_tokens: 10, output_tokens: 5, output_tokens_details: { thinking_tokens: 0 } }, 'claude'), t };
  assert.equal(aggregate([missing]).today.reasoningAvailable, false);
  assert.equal(aggregate([zero]).today.reasoningAvailable, true);
  assert.equal(aggregate([zero]).today.reasoningPartial, false);
  assert.equal(aggregate([missing, zero]).today.reasoningPartial, true);
  const c = state();
  consume(c, { timestamp: new Date(t).toISOString(), payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 5 } } } }, 'codex');
  assert.equal(aggregate(c.events.values()).today.reasoningAvailable, false);
});
