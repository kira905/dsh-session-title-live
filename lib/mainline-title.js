/**
 * dsh-session-title-live / lib/mainline-title.js
 *
 * 「这个会话属于哪条主线」的**只读**判据：命中 ⇒ 标题直接写主线名（不猜、不花一次模型调用）。
 *
 * 为什么需要它：自动标题是「从最近几条人类消息猜一个短标题」。如果宿主侧本来就有一份
 * 「会话 → 主线」的账本（任务卡、交接、接力这类工作流都会产生），那么标题不必猜 ——
 * 直接写主线名更稳、更省，也不会出现「同一件事的会话每轮换一个说法」。
 *
 * 判据来源**只许一处**：`<ledgerDir>/` 下的两个文件（本模块只读，不写、不猜、不拿标题倒推）
 *   · `_sids/<lineId>.jsonl` —— 该主线下认领过的会话 id（append-only；每行 `{v,ts,sid,how}`）
 *   · `_lines.json`          —— `{ lines: [{ lineId, line }] }`（lineId → 主线名，唯一名字真源）
 *
 * 失败方向（fail-open 回自动生成，而不是 fail-closed 到「标题不动」）：
 *   目录不存在 / 账本损坏 / 同一个 sid 命中多条线且名字打架 ⇒ **返回 null** ⇒ 调用方走
 *   原来的自动生成路径。理由：本模块只是「少花一次模型调用、让标题更稳」的增强，
 *   它坏了不该让标题停摆（那是退化，不是保护）。
 *
 * 零依赖：只用 node 标准库。
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveHome } from './config.js';

/** 账本目录名默认值（相对 home；可在 config.mainline.ledgerDir 覆盖）。 */
export const LEDGER_DIR_NAME = 'mainline-ledger';
/** sid 索引子目录名。 */
export const SIDS_DIR_NAME = '_sids';
/** 线名表文件名。 */
export const LINES_FILE_NAME = '_lines.json';
/** 反查结果缓存时长默认值（毫秒；可在 config.mainline.cacheMs 覆盖）。 */
export const CACHE_MS = 5000;

let cache = null; // { dir, ms, at, index }

/**
 * 账本目录绝对路径。
 * `opts.dir`/`opts.ledgerDir` 是绝对路径时直接用；否则挂在 {@link resolveHome} 之下。
 * @param {{home?:string, dir?:string, ledgerDir?:string}} [opts]
 */
export function resolveLedgerDir(opts = {}) {
  const raw = opts.dir ?? opts.ledgerDir ?? LEDGER_DIR_NAME;
  const dir = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : LEDGER_DIR_NAME;
  if (path.isAbsolute(dir)) return dir;
  return path.join(resolveHome({ home: opts.home }), dir);
}

/**
 * sid 归一化：会话接口给的是 `session-<uuid>`，账本里一般存裸 uuid ⇒ 统一成裸小写。
 * 只做「去 session- 前缀 + 小写」两步（不做全角冒号/空白折叠 —— 那是别的层的键口径）。
 */
export function normalizeSid(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return '';
  return s.startsWith('session-') ? s.slice('session-'.length) : s;
}

/** 读 `_lines.json` 的 `lineId → 主线名` 表；读不到 / 形状不对 ⇒ 空 Map（不抛）。 */
function readLinesMap(ledgerDir) {
  const out = new Map();
  try {
    const raw = fs.readFileSync(path.join(ledgerDir, LINES_FILE_NAME), 'utf8');
    const j = JSON.parse(raw);
    const rows = Array.isArray(j?.lines) ? j.lines : [];
    for (const r of rows) {
      const id = String(r?.lineId ?? '').trim();
      const line = String(r?.line ?? '').trim();
      if (id && line) out.set(id, line);
    }
  } catch { /* 读不到 ⇒ 空表（调用方据此判 null） */ }
  return out;
}

/**
 * 建立「裸 sid → lineId[]」索引（全量扫 `_sids/*.jsonl`；每个文件都是 append-only 的小文件）。
 * @param {{home?:string, dir?:string, ledgerDir?:string}} [opts]
 * @returns {{bySid: Map<string,string[]>, lines: Map<string,string>, files: number, dir: string}}
 */
export function buildLedgerIndex(opts = {}) {
  const ledgerDir = resolveLedgerDir(opts);
  const sidsDir = path.join(ledgerDir, SIDS_DIR_NAME);
  const lines = readLinesMap(ledgerDir);
  const bySid = new Map();
  let files = 0;
  let names = [];
  try { names = fs.readdirSync(sidsDir); } catch { names = []; }
  for (const f of names) {
    if (!f.endsWith('.jsonl')) continue;
    files += 1;
    let text = '';
    try { text = fs.readFileSync(path.join(sidsDir, f), 'utf8'); } catch { continue; }
    for (const ln of text.split('\n')) {
      const t = ln.trim();
      if (!t) continue;
      let row = null;
      try { row = JSON.parse(t); } catch { continue; }
      const sid = normalizeSid(row?.sid);
      if (!sid) continue;
      const lineId = String(row?.lineId ?? f.slice(0, -'.jsonl'.length)).trim();
      if (!lineId) continue;
      const arr = bySid.get(sid);
      if (arr === undefined) bySid.set(sid, [lineId]);
      else if (!arr.includes(lineId)) arr.push(lineId);   // 同一 sid 在同一份里重复出现不算冲突
    }
  }
  return { bySid, lines, files, dir: ledgerDir };
}

/** 取（可缓存）索引；`opts.cache === false` 强制现读（单测用）。 */
function indexFor(opts = {}) {
  const dir = resolveLedgerDir(opts);
  const ms = Number.isFinite(Number(opts.cacheMs)) && Number(opts.cacheMs) >= 0 ? Number(opts.cacheMs) : CACHE_MS;
  const now = Date.now();
  if (opts.cache !== false && cache !== null && cache.dir === dir && cache.ms === ms && now - cache.at < ms) return cache.index;
  const index = buildLedgerIndex({ ...opts, dir });
  cache = { dir, ms, at: now, index };
  return index;
}

/** 清缓存（单测 / 排障用）。 */
export function clearCache() { cache = null; }

/**
 * 反查：这个会话属于哪条主线。
 *
 * @param {string} sid 会话 id（`session-<uuid>` 或裸 uuid 都行）
 * @param {{home?:string, dir?:string, ledgerDir?:string, cache?:boolean, cacheMs?:number}} [opts]
 * @returns {{mainline:string|null, lineId:string|null, reason:string, candidates?:string[]}}
 *   `reason` 取值：`hit` / `no-sid` / `ledger-miss` / `line-name-missing` / `conflict` / `error`
 *   —— 只有 `hit` 带非空 `mainline`；其余一律让调用方回落到自动生成。
 */
export function resolveMainlineName(sid, opts = {}) {
  const key = normalizeSid(sid);
  if (!key) return { mainline: null, lineId: null, reason: 'no-sid' };
  let index;
  try { index = indexFor(opts); } catch { return { mainline: null, lineId: null, reason: 'error' }; }
  const lineIds = index.bySid.get(key);
  if (lineIds === undefined || lineIds.length === 0) return { mainline: null, lineId: null, reason: 'ledger-miss' };
  // 每条 lineId 映射到名字；名字取不到的线**不算冲突**（只是没名字），直接排除。
  const named = [];
  for (const id of lineIds) {
    const name = index.lines.get(id);
    if (typeof name === 'string' && name.length > 0) named.push({ lineId: id, name });
  }
  if (named.length === 0) return { mainline: null, lineId: null, reason: 'line-name-missing', candidates: lineIds };
  const uniq = [...new Set(named.map((n) => n.name))];
  // 多条线名字打架 ⇒ **fail-closed 不猜**（宁可走自动生成，也不把标题写成错的那条线）。
  if (uniq.length > 1) return { mainline: null, lineId: null, reason: 'conflict', candidates: uniq };
  return { mainline: uniq[0], lineId: named[0].lineId, reason: 'hit' };
}
