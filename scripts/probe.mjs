#!/usr/bin/env node
// scripts/probe.mjs —— 真实例**只读**探针：RPC 调用 / 会话日志解帧 / 事件分析
//
// 被 scripts/ 下的验证脚本 import 复用；**不参与插件运行**（lib/ 零依赖、不引它）。
// 除 runTurn 外全部只读：不发 prompt、不 append 事件、不改任何文件。
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const PLUGIN = 'dsh-session-title-live';
export const MARK_PROVIDER = `${PLUGIN}#turn-mark`;
export const MARK_RE = /^【(运行|完成|待续|待命|已中断)】\s*/;
export const prefixOf = (t) => (typeof t === 'string' ? (MARK_RE.exec(t)?.[1] ?? null) : null);
/** 基名 = 去掉回合前缀后的正文。 */
export const baseOf = (t) => (typeof t === 'string' ? t.replace(MARK_RE, '').trim() : '');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const typeOf = (e) => e.type ?? e.data?.type;

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 会话日志定位（sessions 树下按目录名递归找）。 */
export function findSessionLog(home, sessionId) {
  const stack = [path.join(home, 'sessions')];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const p = path.join(dir, entry.name);
      if (entry.name === sessionId) {
        const f = path.join(p, 'session.jsonl.zstd');
        if (fs.existsSync(f)) return f;
      } else stack.push(p);
    }
  }
  return null;
}

/** 多帧 zstd 拼接的 append-only 日志 → 事件数组。 */
export function readEvents(file) {
  const buf = fs.readFileSync(file);
  const offsets = [];
  let idx = buf.indexOf(MAGIC);
  while (idx >= 0) { offsets.push(idx); idx = buf.indexOf(MAGIC, idx + 4); }
  const chunks = [];
  for (let i = 0; i < offsets.length; i++) {
    const start = offsets[i];
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length;
    try { chunks.push(zlib.zstdDecompressSync(buf.subarray(start, end))); }
    catch (e) { if (i !== offsets.length - 1) throw e; }
  }
  const out = [];
  for (const line of Buffer.concat(chunks).toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn tail */ }
  }
  return out;
}

/** 一条 user/message 的纯文本正文（与插件 humanTextOf 同口径）。 */
export function humanTextOfEvent(e) {
  const c = e.data?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n');
}

/** 事件流分析：生成型标题 / mark 标题 / 人类消息 / GENREQ。 */
export function analyze(events) {
  const titles = events.filter((e) => typeOf(e) === 'session/title');
  const humans = events.filter((e) => typeOf(e) === 'user/message' && e.data?.source?.kind === 'user');
  return {
    titles,
    humans: humans.map((e) => ({ seq: e.seq, chars: [...humanTextOfEvent(e)].length })),
    generated: titles.filter((e) => e.data.source?.kind === 'provider' && e.data.source.provider === PLUGIN)
      .map((e) => ({ seq: e.seq, title: e.data.title, base: baseOf(e.data.title), messageSeqs: [...(e.data.messageSeqs ?? [])] })),
    marks: titles.filter((e) => e.data.source?.provider === MARK_PROVIDER)
      .map((e) => ({ seq: e.seq, title: e.data.title, state: prefixOf(e.data.title) })),
    genreqs: events.filter((e) => typeOf(e) === 'session/title-llm-request')
      .map((e) => ({ seq: e.seq, scheduler: e.data?.scheduler ?? null, messageSeqs: [...(e.data?.messageSeqs ?? [])] })),
    userTitles: titles.filter((e) => e.data.source?.kind === 'user'),
  };
}

export function createProbe({ base, home, timeoutMs = 240000, pollMs = 1500 }) {
  async function rpc(method, payload, ms = 60000) {
    const res = await fetch(`${base}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', method, rpcId: `probe-${method}-${randomUUID().slice(0, 8)}`, payload }),
      signal: AbortSignal.timeout(ms),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || body?.result?.ok !== true) {
      throw new Error(`${method} failed: ${body?.result?.error?.message ?? body?.result?.error?.code ?? `HTTP ${res.status}`}`);
    }
    return body.result.value;
  }

  async function summary(sessionId) {
    const list = await rpc('session.list', {});
    const item = (list?.items ?? []).find((it) => it?.sessionId === sessionId);
    return { title: item?.projections?.values?.title ?? null, running: item?.running ?? null, exists: item !== undefined };
  }

  /**
   * 发一条 prompt，等到回合收尾（running=false 且标题稳定 8 秒）。
   * ⚠️ 这是**写操作**（真的会往会话里发消息）——只在你自己的隔离实例上用，别对生产实例调它。
   */
  async function runTurn(sessionId, text, { log = console.log } = {}) {
    log(`  prompt: ${JSON.stringify(text)}`);
    await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text }] });
    const deadline = Date.now() + timeoutMs;
    let lastTitle = null;
    let lastChange = Date.now();
    while (Date.now() < deadline) {
      await sleep(pollMs);
      const s = await summary(sessionId);
      if (s.title !== lastTitle) { lastTitle = s.title; lastChange = Date.now(); log(`  title=${JSON.stringify(s.title)} running=${s.running}`); }
      if (s.running === false && Date.now() - lastChange > 8000) break;
    }
    return lastTitle;
  }

  async function eventsOf(sessionId) {
    let file = null;
    for (let i = 0; i < 20 && file === null; i++) { await sleep(500); file = findSessionLog(home, sessionId); }
    if (file === null) throw new Error(`找不到会话日志：${sessionId}（home=${home}）`);
    return { file, events: readEvents(file) };
  }

  return { rpc, summary, runTurn, eventsOf, analyze };
}
