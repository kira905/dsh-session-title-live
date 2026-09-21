// dsh-session-title-live / _test/test-kill-switch.mjs
//   标题插件活开关（kill switch）单测（2026-09-13 加）：
//     ① 解析与 fail-safe（读不到 = 保持现状，继续工作）
//     ② ≤cacheMs 缓存语义（改文件后不重启即生效的真实时延）
//     ③ mock ctx 端到端：回合打标路径 + generate 标题生成路径（两条都要被开关拦住）
//   全程在临时 home 跑（末尾断言隔离目录里只有开关文件）。
//   用法：node _test/test-kill-switch.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const INDEX = path.join(HERE, '..', 'lib', 'index.js');

const HOME = path.join(os.tmpdir(), 'title-ks-test-' + Date.now());
fs.mkdirSync(HOME, { recursive: true });
process.env.SESSION_TITLE_LIVE_HOME = HOME; // 必须在 import 之前设好（killSwitchPath 读 env）
const CFG = path.join(HOME, 'dsh-session-title-live.json');

const mod = await import('file:///' + INDEX.replace(/\\/g, '/'));

let pass = 0, fail = 0;
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  ✓ ${label}${extra ? '  → ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? '  → ' + extra : ''}`); }
};
const writeCfg = (o) => fs.writeFileSync(CFG, typeof o === 'string' ? o : JSON.stringify(o, null, 2), 'utf8');
const enable = (v, why = '单测拨闸') => writeCfg({
  schemaVersion: 1,
  modules: { 'session-title-live': { enabled: v, since: new Date().toISOString(), by: 'test', why } },
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 本测试全程只碰下面这个临时 home（不读也不写任何真实安装目录）。

// ── ① 解析 / fail-safe ────────────────────────────────────────────────
console.log('=== ① parseKillSwitch：解析与 fail-safe ===');
let r = mod.parseKillSwitch('{ not json');
ok(r.enabled === true && r.ok === false, '损坏 JSON → 保持现状（继续工作）', r.reason);
r = mod.parseKillSwitch('');
ok(r.enabled === true && r.reason === 'file-empty', '空文件 → 保持现状', r.reason);
r = mod.parseKillSwitch(JSON.stringify({ schemaVersion: 2 }));
ok(r.enabled === true && /schema-mismatch/.test(r.reason), 'schema 不符 → 保持现状', r.reason);
r = mod.parseKillSwitch(JSON.stringify({ schemaVersion: 1 }));
ok(r.enabled === true && r.source === 'baseline', '文件里没有该模块键 → baseline 开', r.source);
r = mod.parseKillSwitch(JSON.stringify({ schemaVersion: 1, modules: { 'session-title-live': { enabled: false, why: '坏了' } } }));
ok(r.enabled === false && r.source === 'file' && r.why === '坏了', '显式 enabled=false → 关（可溯源 why）', `${r.enabled}/${r.why}`);
r = mod.parseKillSwitch(JSON.stringify({ schemaVersion: 1, modules: { 'session-title-live': { enabled: true } } }));
ok(r.enabled === true && r.source === 'file', '显式 enabled=true → 开', r.source);
r = mod.parseKillSwitch(JSON.stringify({ enabled: false, why: '顶层简写' }));
ok(r.enabled === false && r.source === 'file', '顶层简写 enabled:false → 关', `${r.enabled}/${r.why}`);
r = mod.parseKillSwitch(JSON.stringify({ modules: { 'other-module': { enabled: false } } }));
ok(r.enabled === true && r.source === 'baseline', '只有别的模块键 → baseline 开（互不牵连）', r.source);

console.log('=== ② 文件缺失 / 缓存路径 ===');
mod.clearKillSwitchCache();
fs.rmSync(CFG, { force: true });
let live = mod.isTitleLiveEnabled();
ok(live.enabled === true && live.reason === 'file-missing', '配置文件不存在 → 继续工作（保命件口径）', live.reason);
enable(false, '缓存前');
mod.clearKillSwitchCache(); // 缓存语义由 ④ 专测；这里要的是"重读即生效"
live = mod.isTitleLiveEnabled();
ok(live.enabled === false, '补上 enabled=false 后（清缓存）→ 关', `${live.enabled}/${live.why}`);

console.log('=== ③ mock ctx 端到端：回合打标 + 标题生成 ===');
function makeCtx() {
  const registered = {};
  const handlers = {};
  const appends = [];
  const logs = [];
  const llmCalls = [];
  const titleState = { title: '这是一条旧标题', source: { kind: 'provider', provider: 'official' }, messageSeqs: [1], eventSeq: 7 };
  const session = {
    id: 'sess-ks-1',
    header: { origin: 'assistant' },
    append(type, data) {
      appends.push({ type, data });
      if (type === 'session/title' && data?.title) { titleState.title = data.title; titleState.source = data.source; }
    },
  };
  const ctx = {
    sessionTitle: {
      register(def) { registered.def = def; },
      get() { return { ...titleState, messageSeqs: [...titleState.messageSeqs] }; },
    },
    sessions: { get(id) { return id === session.id ? session : undefined; } },
    llm: {
      async *stream(opts) {
        llmCalls.push(opts);
        yield { type: 'text-delta', text: '新标题' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
    on(ev, fn) { (handlers[ev] ??= []).push(fn); },
    logger: { info: (m) => logs.push(m), debug: (m) => logs.push(m) },
  };
  const fire = async (type, data = {}) => {
    for (const fn of handlers['session/event'] ?? []) fn(session, { type, seq: 1, data });
    await new Promise((res) => setImmediate(res)); // 打标在 queueMicrotask 里
  };
  return { ctx, registered, appends, logs, llmCalls, session, titleState, fire };
}

// 开关开 → 打标生效
enable(true, '端到端：开');
mod.clearKillSwitchCache();
let env = makeCtx();
// minIncrementChars: 0 —— 本文件验的是**活开关**语义，不是最小信息门槛；
//   下面 generate 用例的人类消息只有 13 字、会话又有旧标题，生产默认门槛（20 字）会把那次
//   生成拦下（2026-09-17 新增的行为）。门槛本身由 test-self-schedule.mjs §[6] 专测。
mod.apply(env.ctx, { minIncrementChars: 0 });
ok(typeof env.registered.def?.generate === 'function', 'apply 注册了标题 provider');
await env.fire('turn/start');
ok(env.appends.length === 1 && env.appends[0].data.title.startsWith('【运行】'), '开关开 → turn/start 打标【运行】', env.appends[0]?.data?.title ?? '(无)');
await env.fire('turn/end');
ok(env.appends.length === 2 && env.appends[1].data.title.startsWith('【完成】'), '开关开 → turn/end 打标【完成】', env.appends[1]?.data?.title ?? '(无)');

// 开关关（清缓存即时生效）→ 打标停
enable(false, '端到端：关');
mod.clearKillSwitchCache();
await env.fire('turn/start');
ok(env.appends.length === 2, '开关关 → 不再 append（零写入）', `appends=${env.appends.length}`);
ok(env.logs.some((m) => /kill switch OFF/.test(m)), '关掉后有明确日志（可观测）');

// 开关再开 → 恢复
enable(true, '端到端：恢复');
mod.clearKillSwitchCache();
await env.fire('turn/start');
ok(env.appends.length === 3 && env.appends[2].data.title.startsWith('【运行】'), '开关重新打开 → 立即恢复打标', env.appends[2]?.data?.title ?? '(无)');

// generate：开 → 真调 LLM；关 → 抛错且不调 LLM
const request = {
  signal: AbortSignal.timeout(5000),
  messages: [{ seq: 1, text: '你好，帮我看看这个 bug' }],
  route: { provider: 'p', model: 'm' },
  session: { id: 'sess-ks-1', append() {} },
};
let genTitle = null;
try { genTitle = (await env.registered.def.generate(request)).title; } catch (e) { genTitle = `ERR:${e.message}`; }
ok(genTitle === '新标题' && env.llmCalls.length === 1, '开关开 → generate 真调 LLM 并返回标题', String(genTitle));
enable(false, '端到端：关（生成）');
mod.clearKillSwitchCache();
const callsBefore = env.llmCalls.length;
let genErr = null;
try { await env.registered.def.generate(request); } catch (e) { genErr = e.message; }
ok(genErr !== null && /kill switch/.test(genErr), '开关关 → generate 抛错（拒绝生成）', String(genErr).slice(0, 80));
ok(env.llmCalls.length === callsBefore, '开关关 → 一次 LLM 都没调（不烧 token）');

console.log('=== ④ ≤3s 热生效（真实时延，不重启） ===');
enable(true, '缓存测试：开');
mod.clearKillSwitchCache();
mod.isTitleLiveEnabled(); // 把缓存灌成"开"
enable(false, '缓存测试：关'); // 只改文件、不清缓存
const immediate = mod.isTitleLiveEnabled();
ok(immediate.enabled === true, '改文件后立刻读 → 命中 3s 缓存（仍是旧值）', `enabled=${immediate.enabled}`);
await sleep(3100);
const after3s = mod.isTitleLiveEnabled();
ok(after3s.enabled === false, '≤3.1s 后自动重读 → 关生效（**不重启**）', `enabled=${after3s.enabled} by=${after3s.by}`);

console.log('=== ⑤ 隔离性断言 ===');
ok(mod.killSwitchPath() === CFG, 'killSwitchPath 跟随 SESSION_TITLE_LIVE_HOME（隔离生效）', mod.killSwitchPath());
const leftovers = fs.readdirSync(HOME).filter((name) => name !== path.basename(CFG));
ok(leftovers.length === 0, '临时 home 里只有开关文件（无其它副作用）', leftovers.join(',') || '(无)');

fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n=== 结果：通过 ${pass} / 失败 ${fail} ===`);
if (fail > 0) process.exitCode = 1;
