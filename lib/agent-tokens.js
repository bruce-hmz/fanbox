'use strict';
const fs = require('fs');
const path = require('path');
const { parentPort, isMainThread } = require('worker_threads');
const caches = new Map();
const num = (v) => Number.isFinite(v) && v >= 0 ? v : 0;
function normalize(u, agent) {
  const cacheRead = num(agent === 'codex' ? u.cached_input_tokens : u.cache_read_input_tokens);
  const cacheCreate = num(agent === 'codex' ? u.cache_write_input_tokens : u.cache_creation_input_tokens);
  // Codex input 包含缓存，Claude input 不包含缓存。reasoning 是 output 的子集。
  const input = agent === 'codex' ? Math.max(0, num(u.input_tokens) - cacheRead - cacheCreate) : num(u.input_tokens);
  const output = num(u.output_tokens);
  const reasoningAvailable = Number.isFinite(u.reasoning_output_tokens ?? u.output_tokens_details?.thinking_tokens);
  return { reasoningAvailable, input, output, cacheRead, cacheCreate, reasoning: num(u.reasoning_output_tokens ?? u.output_tokens_details?.thinking_tokens), total: input + output + cacheRead + cacheCreate };
}
function consume(c, d, agent) {
  const t = Date.parse(d.timestamp);
  if (!Number.isFinite(t)) return;
  if (agent === 'claude') {
    const m = d.message;
    if (d.type !== 'assistant' || !m?.usage || m.model === '<synthetic>') return;
    const id = m.id ? `${d.requestId || ''}:${m.id}` : `${c.offset}:${c.events.size}`;
    const next = { t, id, ...normalize(m.usage, agent) };
    const prev = c.events.get(id);
    // 流式记录可能先写 output=1 后补最终用量；保留各字段最大值，不重复累加。
    if (prev) {
      for (const k of ['input', 'output', 'cacheRead', 'cacheCreate', 'reasoning']) next[k] = Math.max(prev[k], next[k]);
      next.total = next.input + next.output + next.cacheRead + next.cacheCreate;
      next.reasoningAvailable ||= prev.reasoningAvailable;
      next.t = prev.t;
    }
    c.events.set(id, next);
  } else {
    const p = d.payload;
    if (p?.type !== 'token_count' || !p.info?.total_token_usage) return;
    const total = p.info.total_token_usage;
    const fields = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens'];
    let delta = {};
    const reset = c.last && (num(total.input_tokens) < num(c.last.input_tokens) || num(total.output_tokens) < num(c.last.output_tokens));
    for (const k of fields) if (Number.isFinite(total[k])) delta[k] = Math.max(0, num(total[k]) - num(c.last?.[k]));
    if (reset) delta = p.info.last_token_usage || total;
    c.last = total;
    const e = normalize(delta, agent);
    if (e.total) c.events.set(c.events.size, { t, ...e });
  }
}
async function parseFile(file, st, agent) {
  let c = caches.get(file);
  if (!c || c.ino !== st.ino || st.size < c.offset || (st.size === c.offset && st.mtimeMs !== c.mtimeMs)) {
    c = { offset: 0, ino: st.ino, events: new Map(), last: null }; caches.set(file, c);
  }
  if (st.size === c.offset) return c.events.values();
  // 流式、增量、仅完整行；字节偏移不受中文跨 chunk 的 UTF-8 字符影响。
  let pending = Buffer.alloc(0);
  for await (const chunk of fs.createReadStream(file, { start: c.offset, end: st.size - 1, highWaterMark: 256 * 1024 })) {
    pending = Buffer.concat([pending, chunk]);
    let start = 0, end;
    while ((end = pending.indexOf(10, start)) !== -1) {
      const line = pending.subarray(start, end).toString('utf8');
      c.offset += end - start + 1; start = end + 1;
      if (!line.includes(agent === 'claude' ? '"usage"' : '"token_count"')) continue;
      try { consume(c, JSON.parse(line), agent); } catch { /* 单行损坏 */ }
    }
    pending = pending.subarray(start);
  }
  c.mtimeMs = st.mtimeMs;
  return c.events.values();
}
function aggregate(events, now = Date.now()) {
  const empty = () => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0, reasoning: 0, reasoningAvailable: false, reasoningPartial: false, total: 0, msgs: 0 });
  const result = { last5h: empty(), today: empty(), week: empty() };
  const day = new Date(now); day.setHours(0, 0, 0, 0);
  const starts = { last5h: now - 5 * 3600000, today: +day, week: now - 7 * 86400000 };
  for (const e of events) for (const [key, from] of Object.entries(starts)) {
    if (e.t < from || e.t > now) continue;
    for (const field of ['input', 'output', 'cacheRead', 'cacheCreate', 'reasoning', 'total']) result[key][field] += e[field];
    result[key].reasoningAvailable ||= !!e.reasoningAvailable;
    result[key].reasoningPartial ||= !e.reasoningAvailable && e.output > 0;
    result[key].msgs++;
  }
  return result;
}
async function scan(root, agent) {
  const files = [], cutoff = Date.now() - 8 * 86400000;
  async function walk(dir) {
    let entries; try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const file = path.join(dir, e.name);
      if (e.isDirectory()) await walk(file);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try { const st = await fs.promises.stat(file); if (st.mtimeMs >= cutoff) files.push({ file, st }); } catch { /* */ }
      }
    }
  }
  await walk(root);
  const live = new Set(files.map((f) => f.file));
  for (const file of caches.keys()) if (file.startsWith(root + path.sep) && !live.has(file)) caches.delete(file);
  const events = new Map(); let errors = 0;
  for (const { file, st } of files) {
    try { for (const e of await parseFile(file, st, agent)) events.set(agent === 'claude' && e.id ? e.id : `${file}:${events.size}`, e); }
    catch { errors++; }
  }
  return { ...aggregate(events.values()), files: files.length, partial: errors > 0 };
}
if (!isMainThread) parentPort.on('message', async ({ claudeRoot, codexRoot }) => {
  try { parentPort.postMessage({ claude: await scan(claudeRoot, 'claude'), codex: await scan(codexRoot, 'codex') }); }
  catch { parentPort.postMessage({ error: true }); }
});
module.exports = { normalize, consume, aggregate, parseFile, scan };
