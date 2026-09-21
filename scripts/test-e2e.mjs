#!/usr/bin/env node
// scripts/test-e2e.mjs —— 通用性端到端：**干净临时路径 + 一份非默认配置**
//
// 为什么要有它：单测（_test/）验的是逻辑，本脚本验的是「换一台机器、换一份配置，
// 这个插件还能不能按配置工作」——所有输入都在系统临时目录里现造，跑完删干净：
//   · 隔离 home（SESSION_TITLE_LIVE_HOME）与隔离配置文件（SESSION_TITLE_LIVE_CONFIG）
//   · 配置**全部用非默认值**（英文前缀 / 60 字节上限 / 自定义开关文件名 / 门槛关掉）
//   · 真模块（lib/index.js）+ 假宿主（复刻主包 append 语义：先入 log 再同步派发、禁重入）
// 覆盖：配置外置生效 → 打标全流程 → 预置标题固定 → 活开关拨闸 → 自调度生成全流程
//       → 最小信息门槛 → 主题锚 → 子代理跳过 → 公开配置无路径 → 环境变量一键停 → 零残留
//
// 用法：node scripts/test-e2e.mjs            跑一遍（跑完清理临时目录）
//       node scripts/test-e2e.mjs --keep     保留临时目录（排障用）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const KEEP = process.argv.includes('--keep');
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.resolve(HERE, '..');

// ── 结果收集 ─────────────────────────────────────────────────────────────
let pass = 0;
const failures = [];
const ok = (cond, label, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}${extra ? `  → ${extra}` : ''}`); }
  else { failures.push(label); console.log(`  ✗ ${label}${extra ? `  → ${extra}` : ''}`); }
};
const eq = (actual, expected, label) => ok(actual === expected, label, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
const delay = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await delay(); };

// ── 隔离沙箱：临时 home + 临时配置（全部非默认值）────────────────────────
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'stl-e2e-'));
const HOME = path.join(sandbox, 'home');
const CFG = path.join(sandbox, 'custom.config.json');
const SWITCH = path.join(HOME, 'switch.json');           // 自定义开关文件名（非默认）
fs.mkdirSync(HOME, { recursive: true });

const CUSTOM = {
  targetWords: 3,
  maxTitleBytes: 60,
  maxInputBytes: 4096,
  minIncrementChars: 0,                                   // 先关掉门槛，专测打标/生成
  selfScheduleMaxHumans: 4,
  themeAnchorMax: 2,
  marks: { prefix: { running: '[RUN]', done: '[DONE]' }, baseFallback: 'untitled' },
  killSwitch: { file: 'switch.json', cacheMs: 0 },
};
fs.writeFileSync(CFG, JSON.stringify(CUSTOM, null, 2), 'utf8');
process.env.SESSION_TITLE_LIVE_HOME = HOME;
process.env.SESSION_TITLE_LIVE_CONFIG = CFG;
delete process.env.SESSION_TITLE_LIVE_DISABLED;

console.log(`隔离沙箱: ${sandbox}`);
console.log(`  隔离 home : ${HOME}`);
console.log(`  隔离配置  : ${CFG}`);

// ── 假宿主（复刻主包 append 语义）────────────────────────────────────────
function makeHost({ now = () => Date.now() } = {}) {
  const listeners = new Map();
  const sessions = new Map();
  const streamCalls = [];
  const logs = [];
  const fire = (name, ...args) => {
    const results = [];
    for (const fn of listeners.get(name) ?? []) results.push(fn(...args));
    return results;
  };

  const sessionTitle = {
    provider: null,
    register(provider) { this.provider = provider; return () => {}; },
    get(session) {
      const last = [...session.events].reverse().find((e) => e.type === 'session/title');
      if (last === undefined) return undefined;
      return {
        title: last.data.title,
        messageSeqs: [...(last.data.messageSeqs ?? [])],
        source: last.data.source,
        eventSeq: last.seq,
        updatedAt: last.time,
      };
    },
  };

  const ctx = {
    sessionTitle,
    sessions: { get: (id) => sessions.get(id) },
    llm: {
      async *stream(options) {
        streamCalls.push(options);
        const text = options?.system?.includes('CUSTOM-SYSTEM') ? '自定义提示词标题' : `标题${streamCalls.length}`;
        yield { type: 'text-delta', text };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
    logger: {
      info: (m) => logs.push({ level: 'info', m }),
      warn: (m) => logs.push({ level: 'warn', m }),
      debug: (m) => logs.push({ level: 'debug', m }),
    },
    on(name, fn) {
      const arr = listeners.get(name) ?? [];
      arr.push(fn);
      listeners.set(name, arr);
      return () => {};
    },
  };

  const makeSession = (id, header = {}) => {
    const events = [];
    const session = {
      id,
      header,
      now,
      get events() { return events; },
      get titles() { return events.filter((e) => e.type === 'session/title').map((e) => e.data.title); },
      get genreqs() { return events.filter((e) => e.type === 'session/title-llm-request'); },
      append(type, data) {
        if (session._appending) throw new Error('session append cannot reenter while another append is being published');
        // seq 与真实主包一致：从 1 开始（不是 0）——插件用「seq > 0」表示"有新人类消息"，
        // 若 mock 从 0 起，首条消息会被当成"没有新消息"，自调度根本不触发（这片段就是为此写死的）。
        const event = { type, seq: events.length + 1, time: now(), data };
        session._appending = true;
        events.push(event);
        try { fire('session/event', session, event); } finally { session._appending = false; }
        return event;
      },
    };
    sessions.set(id, session);
    return session;
  };

  /** 模拟 agent 主请求：触发 llm/stream 钩子（waterfall 契约：必须传 next 并返回它的结果）。 */
  const mainRequest = async (session, { purpose } = {}) => {
    const next = () => (async function* () { /* 主请求流本身 */ })();
    const results = fire('llm/stream', { sessionId: session.id, purpose }, next);
    await settle();
    return results;
  };

  return { ctx, makeSession, fire, mainRequest, streamCalls, logs, sessionTitle };
}

const indexUrl = pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href;
const mod = await import(indexUrl);
const cfgMod = await import(pathToFileURL(path.join(ROOT, 'lib', 'config.js')).href);

// ══ [1] 配置外置生效：隔离 home / 隔离配置 / 非默认前缀 ══════════════════
console.log('\n[1] 配置外置生效');
{
  const h = makeHost();
  mod.clearKillSwitchCache();
  mod.apply(h.ctx, {});
  ok(mod.killSwitchPath({ file: 'switch.json', home: HOME }) === SWITCH, '开关路径按配置的文件名落在隔离 home', mod.killSwitchPath({ file: 'switch.json', home: HOME }));
  ok(mod.killSwitchPath().startsWith(HOME), '无参调用也落在隔离 home（跟随 SESSION_TITLE_LIVE_HOME）', mod.killSwitchPath());
  eq(path.isAbsolute(mod.killSwitchPath()), true, '开关路径是绝对路径');

  const s = h.makeSession('cfg-1');
  s.append('session/title', { title: 'base', messageSeqs: [], source: { kind: 'provider', provider: 'official' } });
  s.append('turn/start', { turn: 1 });
  await settle();
  eq(s.titles.at(-1), '[RUN]base', '配置的英文前缀生效（不是内置的【运行】）');

  s.append('turn/end', { turn: 1 });
  await settle();
  eq(s.titles.at(-1), '[DONE]base', '收尾前缀同样是配置里的');
}

// ══ [2] 预置标题固定：创建阶段写下的标题只换前缀，不被摘要顶掉 ═══════════
console.log('\n[2] 预置标题固定');
{
  const h = makeHost();
  mod.clearKillSwitchCache();
  mod.apply(h.ctx, {});
  const s = h.makeSession('pre-1');
  s.append('session/title', { title: '预置标题', messageSeqs: [], source: { kind: 'user' } });   // 早于第一个 turn/start
  s.append('turn/start', { turn: 1 });
  await settle();
  eq(s.titles.at(-1), '[RUN]预置标题', '预置标题只换前缀');

  s.append('session/title', { title: '模型摘要标题', messageSeqs: [0], source: { kind: 'provider', provider: 'official' } });
  await settle();
  eq(s.titles.at(-1), '[RUN]预置标题', '摘要写回后基名仍固定为预置标题');
}

// ══ [3] 活开关拨闸（零写入 / 零 token）+ fail-safe ═══════════════════════
console.log('\n[3] 活开关');
{
  const h = makeHost();
  mod.clearKillSwitchCache();
  mod.apply(h.ctx, {});
  const s = h.makeSession('sw-1');
  s.append('session/title', { title: 'x', messageSeqs: [], source: { kind: 'provider', provider: 'official' } });

  fs.writeFileSync(SWITCH, JSON.stringify({ modules: { 'session-title-live': { enabled: false, why: 'e2e 拨闸' } } }), 'utf8');
  const before = s.events.length;
  s.append('turn/start', { turn: 1 });
  await settle();
  eq(s.events.length, before + 1, '开关关 → 只有 turn/start 本身，零额外写入');
  ok(h.logs.some((l) => /kill switch OFF/.test(l.m)), '关掉后有明确日志（可观测）');

  fs.writeFileSync(SWITCH, JSON.stringify({ modules: { 'session-title-live': { enabled: true } } }), 'utf8');
  s.append('turn/end', { turn: 1 });
  await settle();
  eq(s.titles.at(-1), '[DONE]x', '开关重新打开 → 打标立即恢复');

  fs.rmSync(SWITCH, { force: true });
  s.append('turn/start', { turn: 2 });
  await settle();
  eq(s.titles.at(-1), '[RUN]x', '开关文件删掉 → fail-safe 继续工作（缺文件 ≠ 要求关闭）');

  fs.writeFileSync(SWITCH, '{ 坏 JSON', 'utf8');
  s.append('turn/end', { turn: 2 });
  await settle();
  eq(s.titles.at(-1), '[DONE]x', '开关文件损坏 → 同样继续工作');
  fs.rmSync(SWITCH, { force: true });
}

// ══ [4] 自调度生成全流程（真模块 + 假 llm 流）═══════════════════════════
console.log('\n[4] 自调度生成全流程');
{
  const h = makeHost();
  mod.clearKillSwitchCache();
  mod.apply(h.ctx, { systemPrompt: ['CUSTOM-SYSTEM', 'one line only'] });
  const s = h.makeSession('gen-1');
  // 自调度生成需要一条路由：真实环境里由主请求头的 request/header 事件带进来（本插件不写它）。
  s.append('request/header', { header: { config: { provider: 'mock-provider', model: 'mock-model' } } });
  s.append('user/message', { content: [{ type: 'text', text: '第一条：把标题改成实时刷新的' }], source: { kind: 'user' } });
  s.append('user/message', { content: [{ type: 'text', text: '第二条：顺便把状态前缀也自动打上' }], source: { kind: 'user' } });

  await h.mainRequest(s, { purpose: 'chat' });
  await settle(20);

  const genreq = s.genreqs.at(-1);
  ok(genreq !== undefined, '写了一条标题生成请求（GENREQ）');
  eq(genreq?.data?.scheduler, 'self', 'GENREQ 带来源标记 scheduler=self（去重对账用）');
  eq(genreq?.data?.titleProvider, 'dsh-session-title-live', 'GENREQ 记了标题 provider 名');
  const generated = [...s.events].reverse().find((e) => e.type === 'session/title' && e.data.source?.kind === 'provider' && e.data.source.provider === 'dsh-session-title-live');
  ok(generated !== undefined, '写回了一条 provider 来源的新标题', generated?.data?.title ?? '(无)');
  eq(generated?.data?.title, '自定义提示词标题', '自定义 systemPrompt 生效（走的不是内置提示词）');
  ok((generated?.data?.messageSeqs ?? []).length >= 2, '标题依据里带上了本轮人类消息 seq');
  ok(h.streamCalls.every((c) => c.purpose === 'session-title'), '所有标题流都打了 purpose=session-title（防自递归）');
  eq(Buffer.byteLength(String(generated?.data?.title), 'utf8') <= 60, true, '标题长度受 maxTitleBytes=60 约束');

  // 自递归护栏：purpose=session-title 的流不再触发新生成
  const genreqsBefore = s.genreqs.length;
  await h.mainRequest(s, { purpose: 'session-title' });
  await settle(10);
  eq(s.genreqs.length, genreqsBefore, 'purpose=session-title 的流不再触发新生成（自递归护栏）');
}

// ══ [5] 最小信息门槛（另一个实例、另一份配置）════════════════════════════
console.log('\n[5] 最小信息门槛');
{
  const h = makeHost();
  mod.clearKillSwitchCache();
  mod.apply(h.ctx, { minIncrementChars: 12, provider: 'mock-provider', model: 'mock-model' });             // 覆盖隔离配置（=0）
  const s = h.makeSession('thin-1');
  s.append('session/title', { title: '旧标题', messageSeqs: [1], messageSeqsNote: null, source: { kind: 'provider', provider: 'official' } });
  s.append('user/message', { content: [{ type: 'text', text: '好' }], source: { kind: 'user' } });
  await h.mainRequest(s, { purpose: 'chat' });
  await settle(10);
  eq(s.genreqs.length, 0, '新增消息太短（< 阈值）→ 不生成、不烧 token');
  eq(s.titles.at(-1), '旧标题', '保留旧标题');

  s.append('user/message', { content: [{ type: 'text', text: '把这条长一点的消息补上，够门槛了' }], source: { kind: 'user' } });
  await h.mainRequest(s, { purpose: 'chat' });
  await settle(20);
  ok(s.genreqs.length >= 1, '消息够长后照常生成');
}

// ══ [6] 主题锚 + 子代理跳过 ══════════════════════════════════════════════
console.log('\n[6] 主题锚 / 子代理跳过');
{
  const h = makeHost();
  mod.clearKillSwitchCache();
  mod.apply(h.ctx, { minIncrementChars: 0, provider: 'mock-provider', model: 'mock-model' });
  const s = h.makeSession('anchor-1');
  s.append('user/message', { content: [{ type: 'text', text: '会话首条：这是主题' }], source: { kind: 'user' } });
  s.append('session/title', { title: '第一版', messageSeqs: [1], source: { kind: 'provider', provider: 'dsh-session-title-live' } });
  s.append('user/message', { content: [{ type: 'text', text: '后续一条' }], source: { kind: 'user' } });
  await h.mainRequest(s, { purpose: 'chat' });
  await settle(20);
  const req = s.genreqs.at(-1);
  ok((req?.data?.messageSeqs ?? []).includes(1), '主题锚（会话首条 seq=1）被并入选材', JSON.stringify(req?.data?.messageSeqs ?? []));

  const sub = h.makeSession('sub-1', { origin: 'subagent' });
  sub.append('session/title', { title: 'sub', messageSeqs: [], source: { kind: 'provider', provider: 'official' } });
  sub.append('turn/start', { turn: 1 });
  await settle();
  eq(sub.titles.at(-1), 'sub', '子代理会话不打标');

  const child = h.makeSession('child-1', { parentSession: 'anchor-1' });
  child.append('user/message', { content: [{ type: 'text', text: '子会话消息' }], source: { kind: 'user' } });
  await h.mainRequest(child, { purpose: 'chat' });
  await settle(10);
  eq(child.genreqs.length, 0, '带父会话的会话不参与自调度');
}

// ══ [7] 人工改名（pin）：打了标也不覆盖，且此后不再重生成 ═══════════════
console.log('\n[7] 人工改名尊重（pin）');
{
  const h = makeHost();
  mod.clearKillSwitchCache();
  mod.apply(h.ctx, { minIncrementChars: 0, provider: 'mock-provider', model: 'mock-model' });
  const s = h.makeSession('pin-1');
  s.append('user/message', { content: [{ type: 'text', text: '先聊一句' }], source: { kind: 'user' } });
  s.append('turn/start', { turn: 1 });
  await settle();
  s.append('session/title', { title: '我自己改的名字', messageSeqs: [], source: { kind: 'user' } });
  s.append('turn/end', { turn: 1 });
  await settle();
  eq(s.titles.at(-1), '我自己改的名字', '人工改名后不再被自动打标覆盖');

  s.append('user/message', { content: [{ type: 'text', text: '再来一条新消息，看看还会不会重生成标题' }], source: { kind: 'user' } });
  await h.mainRequest(s, { purpose: 'chat' });
  await settle(20);
  eq(s.genreqs.length, 0, 'pin 之后自调度也不再重生成基名');
  eq(s.titles.at(-1), '我自己改的名字', '标题保持人工那一版');
}

// ══ [8] 公开配置 / 环境变量一键停 / 零残留 ═══════════════════════════════
console.log('\n[8] 边界与收尾');
{
  const pub = JSON.stringify(cfgMod.publicConfig(cfgMod.resolveConfig({ config: {} }).config));
  ok(!pub.includes(sandbox) && !/[A-Za-z]:[\\/]/.test(pub), '公开配置里没有任何绝对路径', pub.slice(0, 80));

  process.env.SESSION_TITLE_LIVE_DISABLED = '1';
  mod.clearKillSwitchCache();
  const h = makeHost();
  mod.apply(h.ctx, {});
  const s = h.makeSession('env-1');
  s.append('session/title', { title: 'env', messageSeqs: [], source: { kind: 'provider', provider: 'official' } });
  s.append('turn/start', { turn: 1 });
  await settle();
  eq(s.titles.at(-1), 'env', 'SESSION_TITLE_LIVE_DISABLED=1 → 立即停（不打标）');
  delete process.env.SESSION_TITLE_LIVE_DISABLED;

  // 生成路径也被拦
  process.env.SESSION_TITLE_LIVE_DISABLED = '1';
  mod.clearKillSwitchCache();
  const before = h.streamCalls.length;
  let genError = null;
  try {
    await h.sessionTitle.provider.generate({
      signal: AbortSignal.timeout(3000),
      messages: [{ seq: 1, text: '帮我看看这个问题' }],
      route: { provider: 'p', model: 'm' },
      session: s,
    });
  } catch (error) { genError = error.message; }
  ok(genError !== null && /kill switch/.test(genError), '开关关 → generate 抛错（拒绝生成）', String(genError).slice(0, 60));
  eq(h.streamCalls.length, before, '开关关 → 一次 LLM 都没调（不烧 token）');
  delete process.env.SESSION_TITLE_LIVE_DISABLED;

  ok(fs.existsSync(CFG), '隔离配置文件仍在原处（没有被移动/删除）');
}

// ── 收尾：清沙箱 ─────────────────────────────────────────────────────────
if (KEEP) console.log(`\n（--keep：保留沙箱 ${sandbox}）`);
else {
  fs.rmSync(sandbox, { recursive: true, force: true });
  ok(!fs.existsSync(sandbox), '沙箱已清理（不在系统里留残留）');
}

console.log(`\n=== 结果：通过 ${pass} / 失败 ${failures.length} ===`);
if (failures.length > 0) {
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
} else {
  console.log('E2E PASSED');
}
