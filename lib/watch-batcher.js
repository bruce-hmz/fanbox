'use strict';
const path = require('path');
const fs = require('fs');
// 有界队列：重复写入只保留一条；超量保留目录失效通知，最终列表仍会刷新。
function createWatchBatcher(send, { stat = fs.promises.stat, delay = 400, limit = 256 } = {}) {
  let pending = new Map(), overflow = new Set(), timer = null, running = false;
  const versions = new Map();
  function schedule() { if (!timer && !running) timer = setTimeout(flush, delay); }
  function enqueue(message) {
    const key = `${message.dir}\0${message.filename || ''}`;
    if (pending.size < limit || pending.has(key)) pending.set(key, message);
    else overflow.add(message.dir);
    schedule();
  }
  async function flush() {
    clearTimeout(timer); timer = null;
    if (running) return;
    running = true;
    const batch = [...pending.values()], roots = [...overflow];
    pending = new Map(); overflow = new Set();
    const out = [];
    try {
      for (let i = 0; i < batch.length; i += 16) {
        const group = await Promise.all(batch.slice(i, i + 16).map(async (m) => {
          if (!m.filename) return m;
          const key = path.join(m.dir, m.filename);
          let signature, oldMetadata = false;
          try {
            const s = await stat(key); signature = `${s.ino}:${s.size}:${s.mtimeMs}`;
            oldMetadata = Date.now() - s.mtimeMs > 3000 && Date.now() - s.ctimeMs > 3000;
          }
          catch (e) { if (e.code !== 'ENOENT') return m; signature = 'deleted'; }
          const cacheKey = `${m.dir}\0${m.filename}`;
          if (versions.get(cacheKey) === signature) return null;
          const firstOld = !versions.has(cacheKey) && oldMetadata;
          versions.delete(cacheKey); versions.set(cacheKey, signature);
          if (versions.size > 4096) versions.delete(versions.keys().next().value);
          return firstOld ? null : m;
        }));
        out.push(...group.filter(Boolean));
      }
      out.push(...roots.map((dir) => ({ dir, filename: null, overflow: true })));
      if (out.length) send(out);
    } finally { running = false; if (pending.size || overflow.size) schedule(); }
  }
  return { enqueue, flush };
}
module.exports = { createWatchBatcher };
