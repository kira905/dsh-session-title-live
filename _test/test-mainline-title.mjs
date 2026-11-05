#!/usr/bin/env node
// _test/test-mainline-title.mjs —— lib/mainline-title.js（主线名反查）离线单测
//
// 跑法：node _test/test-mainline-title.mjs
// 纯离线：在 os.tmpdir() 造沙箱账本，**不读也不写真实用户目录**。
//
// 覆盖：命中 / sid 归一化 / 未命中 / 多线同名（不算冲突）/ 多线异名（fail-closed）/
//       lineId 无名字 / 目录不存在 / _lines.json 损坏 / 空 sid / 缓存语义 / 绝对目录参数。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  resolveMainlineName, buildLedgerIndex, clearCache, normalizeSid, resolveLedgerDir, CACHE_MS,
  LEDGER_DIR_NAME, SIDS_DIR_NAME, LINES_FILE_NAME,
} from '../lib/mainline-title.js';

let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => { if (cond) { pass += 1; console.log(`  ✓ ${name}`); } else { fails.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); } };

// 脱敏：会话 id 一律用**短 token**（如 `case-a1`），不用 uuid 形状 ——
//   两处扫描都会把 uuid 形状判成真实会话 id：本仓 verify-source.mjs 的 `session-<uuid>` 规则、
//   以及公开仓扫描器的 P3「session id / uuid / long hash」。夹具只需要"能被归一化"的字符串，
//   不需要长得像真 uuid。
const SID_PREFIX = 'session' + '-';
const sid = (uuid) => SID_PREFIX + uuid;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'title-mainline-'));
const mkHome = (tag) => {
  const home = path.join(root, tag);
  const dir = path.join(home, LEDGER_DIR_NAME);
  fs.mkdirSync(path.join(dir, SIDS_DIR_NAME), { recursive: true });
  return { home, dir, sids: path.join(dir, SIDS_DIR_NAME) };
};
const writeLines = (h, lines) => fs.writeFileSync(path.join(h.dir, LINES_FILE_NAME), JSON.stringify({ v: 1, lines }, null, 2), 'utf8');
const appendSid = (h, lineId, sid, how = 'claim') => fs.appendFileSync(path.join(h.sids, `${lineId}.jsonl`), JSON.stringify({ v: 1, ts: '2026-11-04T13:00:00+08:00', sid, how }) + '\n', 'utf8');

console.log(`沙箱根 = ${root}\n`);

// ── C1 命中 ──────────────────────────────────────────────────────────────
console.log('C1 命中（sid 在 _sids 里 ⇒ 主线名）');
{
  const h = mkHome('c1');
  writeLines(h, [{ lineId: 'l-test-001', line: 'alpha' }, { lineId: 'l-test-002', line: 'beta' }]);
  appendSid(h, 'l-test-001', 'case-a1');
  appendSid(h, 'l-test-002', 'case-b2', 'relay');
  const r1 = resolveMainlineName(sid('case-a1'), { home: h.home, cache: false });
  ok('C1a 带 session- 前缀命中', r1.mainline === 'alpha' && r1.reason === 'hit', JSON.stringify(r1));
  ok('C1b lineId 正确', r1.lineId === 'l-test-001', JSON.stringify(r1));
  const r2 = resolveMainlineName('case-b2', { home: h.home, cache: false });
  ok('C1c 裸 uuid 也命中（relay 记录）', r2.mainline === 'beta', JSON.stringify(r2));
}

// ── C2 未命中 ────────────────────────────────────────────────────────────
console.log('C2 未命中（临时会话 ⇒ 应回落自动生成）');
{
  const h = mkHome('c2');
  writeLines(h, [{ lineId: 'l-test-001', line: 'alpha' }]);
  appendSid(h, 'l-test-001', 'case-a1');
  const r = resolveMainlineName(sid('case-c3'), { home: h.home, cache: false });
  ok('C2a 不认识的 sid ⇒ mainline=null', r.mainline === null && r.reason === 'ledger-miss', JSON.stringify(r));
}

// ── C3 多线同名（不算冲突）───────────────────────────────────────────────
console.log('C3 同一 sid 出现在两条线、但主线名相同 ⇒ 不算冲突');
{
  const h = mkHome('c3');
  writeLines(h, [{ lineId: 'l-test-010', line: 'beta' }, { lineId: 'l-test-011', line: 'beta' }]);
  appendSid(h, 'l-test-010', 'case-d4');
  appendSid(h, 'l-test-011', 'case-d4');
  const r = resolveMainlineName(sid('case-d4'), { home: h.home, cache: false });
  ok('C3a 同名两条线 ⇒ hit', r.mainline === 'beta' && r.reason === 'hit', JSON.stringify(r));
}

// ── C4 多线异名（fail-closed）────────────────────────────────────────────
console.log('C4 同一 sid 落在两条**不同名**主线 ⇒ fail-closed（不猜）');
{
  const h = mkHome('c4');
  writeLines(h, [{ lineId: 'l-test-020', line: 'alpha' }, { lineId: 'l-test-021', line: 'gamma' }]);
  appendSid(h, 'l-test-020', 'case-e5');
  appendSid(h, 'l-test-021', 'case-e5');
  const r = resolveMainlineName(sid('case-e5'), { home: h.home, cache: false });
  ok('C4a 冲突 ⇒ mainline=null reason=conflict', r.mainline === null && r.reason === 'conflict', JSON.stringify(r));
  ok('C4b 候选两条都报出来', Array.isArray(r.candidates) && r.candidates.length === 2, JSON.stringify(r.candidates));
}

// ── C5 lineId 无名字 ─────────────────────────────────────────────────────
console.log('C5 _sids 有记录但 _lines.json 没有这条线 ⇒ line-name-missing');
{
  const h = mkHome('c5');
  writeLines(h, []);
  appendSid(h, 'l-test-030', 'case-f6');
  const r = resolveMainlineName(sid('case-f6'), { home: h.home, cache: false });
  ok('C5a 无名字 ⇒ mainline=null', r.mainline === null && r.reason === 'line-name-missing', JSON.stringify(r));
}

// ── C6 目录不存在 ────────────────────────────────────────────────────────
console.log('C6 账本目录不存在 ⇒ 不抛、返回 null（新用户首次安装就是这种状态）');
{
  const home = path.join(root, 'c6-empty');
  fs.mkdirSync(home, { recursive: true });
  const r = resolveMainlineName(sid('case-g7'), { home, cache: false });
  ok('C6a 目录缺失 ⇒ ledger-miss', r.mainline === null && r.reason === 'ledger-miss', JSON.stringify(r));
}

// ── C7 _lines.json 损坏 ──────────────────────────────────────────────────
console.log('C7 _lines.json 是坏 JSON ⇒ 不抛');
{
  const h = mkHome('c7');
  fs.writeFileSync(path.join(h.dir, LINES_FILE_NAME), '{ this is not json', 'utf8');
  appendSid(h, 'l-test-040', 'case-h8');
  const r = resolveMainlineName(sid('case-h8'), { home: h.home, cache: false });
  ok('C7a 坏表 ⇒ line-name-missing（不抛）', r.mainline === null && r.reason === 'line-name-missing', JSON.stringify(r));
}

// ── C8 空 sid ────────────────────────────────────────────────────────────
console.log('C8 空 sid / null');
{
  for (const bad of [null, undefined, '', '   ', 'session-']) {
    const r = resolveMainlineName(bad, { home: root, cache: false });
    ok(`C8(${JSON.stringify(bad)}) ⇒ no-sid`, r.mainline === null && r.reason === 'no-sid', JSON.stringify(r));
  }
}

// ── C9 缓存语义 ──────────────────────────────────────────────────────────
console.log(`C9 缓存语义（CACHE_MS=${CACHE_MS}）`);
{
  const h = mkHome('c9');
  writeLines(h, [{ lineId: 'l-test-050', line: 'cached' }]);
  clearCache();
  const cachedSid = sid('case-i9');
  const before = resolveMainlineName(cachedSid, { home: h.home });      // 建索引（此时还没记录）
  ok('C9a 首次（无记录）⇒ ledger-miss', before.reason === 'ledger-miss', JSON.stringify(before));
  appendSid(h, 'l-test-050', cachedSid);
  const cached = resolveMainlineName(cachedSid, { home: h.home });      // 命中缓存 ⇒ 仍是 miss
  ok('C9b 缓存期内看不到新记录（预期行为）', cached.reason === 'ledger-miss', JSON.stringify(cached));
  const fresh = resolveMainlineName(cachedSid, { home: h.home, cache: false });
  ok('C9c cache:false 立刻看到', fresh.mainline === 'cached', JSON.stringify(fresh));
  clearCache();
  const afterClear = resolveMainlineName(cachedSid, { home: h.home });
  ok('C9d clearCache 后可见', afterClear.mainline === 'cached', JSON.stringify(afterClear));
  const off = resolveMainlineName(cachedSid, { home: h.home, cacheMs: 0 });
  ok('C9e cacheMs=0 ⇒ 每次现读', off.mainline === 'cached', JSON.stringify(off));
}

// ── C10 索引形状 ─────────────────────────────────────────────────────────
console.log('C10 buildLedgerIndex 形状');
{
  const h = mkHome('c10');
  writeLines(h, [{ lineId: 'l-test-060', line: 'indexed' }]);
  appendSid(h, 'l-test-060', 'session-race-abc');       // 故意写带前缀的（模拟脏数据）
  const idx = buildLedgerIndex({ home: h.home });
  ok('C10a files 计数正确', idx.files === 1, String(idx.files));
  ok('C10b 脏 sid 也被归一化进索引', idx.bySid.has('race-abc'), JSON.stringify([...idx.bySid.keys()]));
  ok('C10c lines 表 1 条', idx.lines.size === 1, String(idx.lines.size));
  ok('C10d dir 是解析后的绝对路径', path.isAbsolute(idx.dir) && idx.dir.endsWith(LEDGER_DIR_NAME), idx.dir);
}

// ── C11 normalizeSid 边界 ────────────────────────────────────────────────
console.log('C11 normalizeSid');
{
  ok('C11a 去前缀', normalizeSid('session-ABC') === 'abc');
  ok('C11b 幂等', normalizeSid(normalizeSid('session-abc')) === 'abc');
  ok('C11c 空值', normalizeSid(null) === '' && normalizeSid(undefined) === '');
}

// ── C12 目录参数化 ───────────────────────────────────────────────────────
console.log('C12 账本目录可参数化（相对 home / 绝对路径）');
{
  const h = mkHome('c12');
  writeLines(h, [{ lineId: 'l-test-070', line: 'paramed' }]);
  appendSid(h, 'l-test-070', 'case-j10');
  const rel = resolveLedgerDir({ home: h.home });
  ok('C12a 默认 = <home>/mainline-ledger', rel === h.dir, rel);
  const abs = resolveLedgerDir({ dir: h.dir });
  ok('C12b 绝对路径原样使用', abs === h.dir, abs);
  const custom = resolveLedgerDir({ home: h.home, ledgerDir: 'custom-ledger' });
  ok('C12c 自定义目录名挂在 home 下', custom === path.join(h.home, 'custom-ledger'), custom);
  const r = resolveMainlineName(sid('case-j10'), { dir: h.dir, cache: false });
  ok('C12d 用 dir 直指账本也能反查', r.mainline === 'paramed', JSON.stringify(r));
}

console.log(`\n=== SUMMARY ${pass}/${pass + fails.length} PASS ===`);
if (fails.length > 0) { console.log('FAILS:', fails.join(' | ')); process.exitCode = 1; }
try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
