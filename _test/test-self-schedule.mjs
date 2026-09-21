#!/usr/bin/env node
// _test/test-self-schedule.mjs —— dsh-session-title-live「自建调度（方案 A）」离线单测
//
// 背景：
//   主包 @deepseek-ai/dsh-session-title 的自动调度在首轮之后拿不到启动时机
//   （onRequestHeader 只在首轮写 header 时触发；onMainRequest 的 boundary 条件恒短路），
//   于是本插件改为自己调度：记人类消息 seq → 在 llm/stream 钩子里触发自己的生成。
//
// 本测试覆盖：
//   [1] 纯函数 humanTextOf（人类来源判定 / 空消息不计）
//   [2] createSelfScheduler 状态机：单步多轮每轮都刷、多步回合每轮一次、连发只保最新、
//       在途护栏、去重（主包已写同 seq 标题则跳过）、无新人类消息不生成
//   [3] 装载层 installSelfScheduling：通过假 dsh 环境（真 apply）跑完整事件流，
//       断言每轮都有 provider 标题、选材 seq 随轮次前进、自递归请求不再触发
//
// 运行：node _test/test-self-schedule.mjs

import {
  apply, createSelfScheduler, humanTextOf,
  // 2026-09-17 新增：主题锚 + 最小信息门槛
  planTitleInput, collectHumanMessages, lastTitleMessageSeqs, lastCoveredSeq, DEFAULT_MIN_INCREMENT_CHARS,
} from '../lib/index.js';

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ok   ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stdout.write(`  FAIL ${name}\n       ${error?.message ?? error}\n`);
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message ?? 'assertion failed');
}
function eq(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message ?? 'not equal'}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}
const delay = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await delay(); };

// ── mock 支架：复刻主包 append 语义（先入 log 再同步派发 session/event，禁止重入）──
function makeHarness(config = {}) {
  const listeners = new Map();
  const sessions = new Map();
  const streamCalls = [];
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

  /** 真实下游流（= 真机 dsh-llm 的 adapterStream）。 */
  const terminalStream = async function* (options) {
    streamCalls.push({ purpose: options.purpose, provider: options.provider, model: options.model });
    yield { type: 'text-delta', text: `T${streamCalls.filter((c) => c.purpose === 'session-title').length}` };
    yield { type: 'finish', reason: { kind: 'stop' } };
  };
  const streamErrors = [];

  const ctx = {
    sessionTitle,
    sessions: { get: (id) => sessions.get(id) },
    llm: {
      // ⚠️ 契约同真机（见 e2e-self-schedule.mjs 同一段注释）：真机 `llm/stream` 是 waterfall，
      //    监听器必须 `(options, next) => ... return next()`；裸 return 会让结果变 undefined，
      //    调用方 for await 当场抛 Symbol.asyncIterator。这里连 validateStream 护栏一起复刻。
      stream(options) {
        const fns = listeners.get('llm/stream') ?? [];
        let chain = () => terminalStream(options);
        for (let i = fns.length - 1; i >= 0; i -= 1) {
          const fn = fns[i];
          const next = chain;
          chain = () => fn(options, next);
        }
        const result = chain();
        if (result === undefined || typeof result[Symbol.asyncIterator] !== 'function') {
          const message = 'llm/stream waterfall returned a non-iterable (missing Symbol.asyncIterator)';
          streamErrors.push(message);
          throw new TypeError(message);
        }
        return result;
      },
    },
    logger: { info() {}, warn() {}, debug() {} },
    on(name, fn) {
      const arr = listeners.get(name) ?? [];
      arr.push(fn);
      listeners.set(name, arr);
      return () => {};
    },
  };

  apply(ctx, {
    targetWords: 5, targetCjkCharacters: 10, maxInputBytes: 32768,
    maxOutputTokens: 128, timeoutMs: 30000,
    // ⚠️ 2026-09-17：把最小信息门槛在本文件的 harness 里**默认关掉**——
    //    [2]–[5] 段验的是**调度 / 去重 / pin** 语义，用例里的人类消息都是「第一轮」这类短文本，
    //    生产默认门槛（20 字）会把它们整段拦下，那些断言就不再测原来的东西了。
    //    门槛与主题锚本身由 [6] 段用**生产默认值**专测（含重启复现场景）。
    minIncrementChars: 0,
    ...config,
  });

  let seqCounter = 0;
  const makeSession = (id, header = {}) => {
    const events = [];
    const session = {
      id,
      header,
      _lastRoute: undefined,
      get events() { return events; },
      append(type, data) {
        if (session._appending) throw new Error('session append cannot reenter while another append is being published');
        const event = { type, seq: ++seqCounter, time: Date.now(), data };
        session._appending = true;
        events.push(event);
        try { fire('session/event', session, event); } finally { session._appending = false; }
        return event;
      },
    };
    sessions.set(id, session);
    return session;
  };

  /** 推入一条事件（外部事件：user/message、request/header、step/*、turn/*） */
  const push = (session, type, data) => {
    const event = { type, seq: ++seqCounter, time: Date.now(), data };
    session.events.push(event);
    fire('session/event', session, event);
    return event;
  };

  /**
   * 模拟「会话被重新打开」（= 重启后恢复）：把历史事件作为 **seed** 灌进一个新会话对象，
   * 并对齐 seq 计数器。真机语义见主包 dsh-session 的 Session 构造器：
   * seed 事件进 log 但**不 publish**，所以插件实例的订阅**收不到**它们——
   * 正是本卡根因（内存累积窗口在实例重建后骤缩）的复现手段。
   */
  const seedSession = (session, history) => {
    session.events.push(...history);
    const maxSeq = history.reduce((m, e) => (typeof e.seq === 'number' && e.seq > m ? e.seq : m), 0);
    if (maxSeq > seqCounter) seqCounter = maxSeq;
    return session;
  };

  const human = (session, text) => push(session, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text }] });
  const pluginMsg = (session, kind = 'plugin', plugin = 'time-context') => push(session, 'user/message', { source: { kind, plugin }, content: [{ type: 'text', text: 'snapshot' }] });
  const header = (session, provider, model) => push(session, 'request/header', { header: { config: { provider, model } } });
  const stepStart = (session, step) => push(session, 'step/start', { step });
  const stepEnd = (session, step) => push(session, 'step/end', { step });
  const turnStart = (session) => push(session, 'turn/start', { turn: 1 });
  const turnEnd = (session, kind = 'completed') => push(session, 'turn/end', { turn: 1, reason: { kind } });

  /** 一次 agent 主请求：真机走 `llm.stream()` → 内部 `llm/stream` waterfall 派发。 */
  const mainRequest = (session, opts = {}) => {
    ctx.llm.stream({ sessionId: session.id, provider: opts.provider ?? 'deepseek-official', model: opts.model ?? 'deepseek-flash', ...(opts.raw ?? {}) });
  };

  const titles = (session) => session.events.filter((e) => e.type === 'session/title');
  const providerTitles = (session) => titles(session).filter((e) => e.data.source.kind === 'provider' && e.data.source.provider === 'dsh-session-title-live');
  const genreqs = (session) => session.events.filter((e) => e.type === 'session/title-llm-request');
  /** 人工改名（等价于 GUI 里手动重命名：写一条 source=user 的 session/title）。 */
  const userRename = (session, title) => session.append('session/title', { title, messageSeqs: [], source: { kind: 'user' } });
  /** 模拟**主包服务通路**调用本插件 register 的 provider.generate（真机由 dsh-session-title 服务发起）。 */
  const mainPathGenerate = (session, seqs = []) => sessionTitle.provider.generate({
    session,
    messages: seqs.map((s) => ({ seq: s, text: `Q${s}` })),
    route: { provider: 'deepseek-official', model: 'deepseek-flash' },
    signal: new AbortController().signal,
  });

  return { ctx, makeSession, seedSession, push, human, pluginMsg, header, stepStart, stepEnd, turnStart, turnEnd, mainRequest, titles, providerTitles, genreqs, userRename, mainPathGenerate, streamCalls, sessionTitle, streamErrors, seqCounter: () => seqCounter };
}

// ── [1] 纯函数 ─────────────────────────────────────────────────────────
process.stdout.write('\n[1] 纯函数 humanTextOf\n');

await test('人类来源且有文本 → 返回原文', () => {
  eq(humanTextOf({ data: { source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] } }), '你好');
});

await test('非人类来源（plugin/skill-catalog/subagent）→ null', () => {
  eq(humanTextOf({ data: { source: { kind: 'plugin', plugin: 'x' }, content: [{ type: 'text', text: 'hi' }] } }), null);
  eq(humanTextOf({ data: { source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: 'hi' }] } }), null);
  eq(humanTextOf({ data: { source: { kind: 'subagent' }, content: [{ type: 'text', text: 'hi' }] } }), null);
});

await test('空消息 / 只有空白 / 无 text 块 → null（打断时的空 prompt 不计）', () => {
  eq(humanTextOf({ data: { source: { kind: 'user' }, content: [{ type: 'text', text: '' }] } }), null);
  eq(humanTextOf({ data: { source: { kind: 'user' }, content: [{ type: 'text', text: '   \n  ' }] } }), null);
  eq(humanTextOf({ data: { source: { kind: 'user' }, content: [] } }), null);
});

// ── [2] createSelfScheduler 状态机 ─────────────────────────────────────
process.stdout.write('\n[2] createSelfScheduler 状态机\n');

function makeScheduler(overrides = {}) {
  const session = { id: 's', events: [] };
  const calls = [];
  const state = { events: session.events, providerId: 'dsh-session-title-live' };
  const sched = createSelfScheduler({
    getState: () => state,        // 与装载层同签名：deps.getState(session)
    now: () => Date.now(),
    maxHumans: 32,
    log: () => {},
    generate: async (view, u) => { calls.push({ throughSeq: u.throughSeq, seqs: u.messages.map((m) => m.seq) }); },
    ...overrides,
  });
  return { session, sched, calls, state };
}

await test('没有人类消息时 onMainRequest 不生成', () => {
  const { sched, session } = makeScheduler();
  eq(sched.onMainRequest(session), undefined);
  eq(sched.stats().scheduled, 0);
});

await test('有未处理人类消息 → 排一次生成，且 throughSeq = 最新人类 seq', async () => {
  const { sched, calls, session } = makeScheduler();
  sched.noteHuman(session, '第一轮', 3);
  const done = sched.onMainRequest(session);
  assert(done !== undefined, '应返回生成 Promise');
  await done;
  eq(calls.length, 1);
  eq(calls[0].throughSeq, 3);
  eq(calls[0].seqs.join(','), '3');
});

await test('同一 seq 第二次请求不重复生成（generatedSeq 去重）', async () => {
  const { sched, calls, session } = makeScheduler();
  sched.noteHuman(session, 'a', 3);
  await sched.onMainRequest(session);
  eq(sched.onMainRequest(session), undefined);
  eq(calls.length, 1);
});

await test('新一轮人类消息 → 再生成，选材包含两轮（seq 递增）', async () => {
  const { sched, calls, session } = makeScheduler();
  sched.noteHuman(session, '第一轮', 3);
  await sched.onMainRequest(session);
  sched.noteHuman(session, '第二轮', 11);
  await sched.onMainRequest(session);
  eq(calls.length, 2);
  eq(calls[1].throughSeq, 11);
  eq(calls[1].seqs.join(','), '3,11');
});

await test('事件流里已有覆盖该 seq 的 provider 标题 → 跳过（与主包通路去重）', async () => {
  const { sched, calls, state, session } = makeScheduler();
  state.events.push({ type: 'session/title', seq: 9, data: { messageSeqs: [3], source: { kind: 'provider', provider: 'dsh-session-title-live' } } });
  sched.noteHuman(session, 'a', 3);
  eq(sched.onMainRequest(session), undefined);
  eq(calls.length, 0);
  eq(sched.stats().deduped, 1);
});

await test('turn-mark 前缀标题也算已处理（去重认基名 provider）', async () => {
  const { sched, calls, state, session } = makeScheduler();
  state.events.push({ type: 'session/title', seq: 9, data: { messageSeqs: [3], source: { kind: 'provider', provider: 'dsh-session-title-live#turn-mark' } } });
  sched.noteHuman(session, 'a', 3);
  eq(sched.onMainRequest(session), undefined);
  eq(calls.length, 0);
});

await test('在途生成期间来的新人类消息：收尾时自动补一轮（只保最新）', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const calls = [];
  const { sched, session } = makeScheduler({
    generate: async (view, u) => { calls.push(u.throughSeq); if (calls.length === 1) await gate; },
  });
  sched.noteHuman(session, 'a', 3);
  const first = sched.onMainRequest(session);
  sched.noteHuman(session, 'b', 11);                  // 在途期间新消息
  eq(sched.onMainRequest(session), undefined);        // 被护栏挡住（不并发）
  release();
  await first;
  await settle();
  eq(calls.join(','), '3,11', '应补生成第二轮');
});

await test('generate 抛错不炸调度器：失败不重试该 seq，新消息仍能再生成', async () => {
  let n = 0;
  const { sched, session } = makeScheduler({
    generate: async () => { n += 1; if (n === 1) throw new Error('boom'); },
  });
  sched.noteHuman(session, 'a', 3);
  await sched.onMainRequest(session);
  await settle();
  eq(n, 1, '失败后不应自动重试同一 seq');
  sched.noteHuman(session, 'b', 11);
  await sched.onMainRequest(session);
  eq(n, 2, '新人类消息应能再次触发');
  eq(sched.stats().errors, 1);
});

await test('人类消息环形保留上限（maxHumans=2 → 只留最近 2 条）', async () => {
  const { sched, calls, session } = makeScheduler({ maxHumans: 2 });
  sched.noteHuman(session, 'a', 1);
  sched.noteHuman(session, 'b', 2);
  sched.noteHuman(session, 'c', 3);
  await sched.onMainRequest(session);
  eq(calls[0].seqs.join(','), '2,3');
});

// ── [3] 装载层：真 apply + 假 dsh 环境跑完整事件流 ──────────────────────
process.stdout.write('\n[3] installSelfScheduling（完整事件流）\n');

/** 跑一个回合：steps 个 step；人类消息只在 step 1 注入（真实形状：一轮一条人类消息） */
async function runRound(h, session, { steps = 1, first = false, headerChanged = false, interrupted = false, humanText = 'Q' }) {
  const before = h.providerTitles(session).length;
  h.turnStart(session);
  for (let s = 1; s <= steps; s++) {
    h.stepStart(session, s);
    if (s === 1) { h.human(session, `${humanText} step${s}`); h.pluginMsg(session); }
    if (first || headerChanged) h.header(session, 'deepseek-official', 'deepseek-flash');
    h.mainRequest(session);
    await settle(3);
    if (s < steps) h.stepEnd(session, s);
  }
  h.stepEnd(session, steps);
  h.turnEnd(session, interrupted ? 'aborted' : 'completed');
  await settle(6);
  return h.providerTitles(session).length - before;
}

await test('单步回合 3 轮：每轮都落 provider 标题（主包通路做不到的场景）', async () => {
  const h = makeHarness();
  const session = h.makeSession('s1');
  const g1 = await runRound(h, session, { steps: 1, first: true, humanText: '第一轮' });
  const g2 = await runRound(h, session, { steps: 1, humanText: '第二轮' });
  const g3 = await runRound(h, session, { steps: 1, humanText: '第三轮' });
  eq([g1, g2, g3].filter((n) => n > 0).length, 3, '三轮都应有标题');
  eq(h.providerTitles(session).length, 3);
});

await test('第二版基名与第一版不同（选材随对话前进）', async () => {
  const h = makeHarness();
  const session = h.makeSession('s2');
  await runRound(h, session, { steps: 1, first: true, humanText: '第一轮' });
  await runRound(h, session, { steps: 1, humanText: '第二轮' });
  const titles = h.providerTitles(session).map((e) => e.data.title);
  assert(titles.length >= 2, `应有 ≥2 条 provider 标题，实得 ${titles.length}`);
  assert(titles[0] !== titles.at(-1), `第二版应与第一版不同：${JSON.stringify(titles)}`);
  const lastSeqs = h.providerTitles(session).at(-1).data.messageSeqs;
  assert(lastSeqs.length >= 2, `最后一版选材应包含两轮人类消息，实得 [${lastSeqs}]`);
});

await test('多步回合一轮只生成一次（不是每 step 一次）', async () => {
  const h = makeHarness();
  const session = h.makeSession('s3');
  const g1 = await runRound(h, session, { steps: 3, first: true, humanText: '多步' });
  eq(g1, 1, '一轮多 step 只应生成 1 次');
});

await test('首轮多 step → 次轮单 step：两轮都刷新', async () => {
  const h = makeHarness();
  const session = h.makeSession('s4');
  const g1 = await runRound(h, session, { steps: 3, first: true, humanText: 'A' });
  const g2 = await runRound(h, session, { steps: 1, humanText: 'B' });
  assert(g1 > 0 && g2 > 0, `两轮都要刷新（got ${g1}, ${g2}）`);
});

await test('自递归护栏：purpose=session-title 的 llm/stream 不再触发新生成', async () => {
  const h = makeHarness();
  const session = h.makeSession('s5');
  await runRound(h, session, { steps: 1, first: true, humanText: 'X' });
  const before = h.providerTitles(session).length;
  const titleStreams = h.streamCalls.filter((c) => c.purpose === 'session-title').length;
  h.ctx && h.mainRequest(session, { raw: { purpose: 'session-title' } });
  await settle(4);
  eq(h.providerTitles(session).length, before, '标题请求不应再触发生成');
  eq(h.streamCalls.filter((c) => c.purpose === 'session-title').length, titleStreams, '不应多发标题流调用');
});

await test('子代理会话不参与自调度', async () => {
  const h = makeHarness();
  const session = h.makeSession('s6', { origin: 'subagent', parentSession: 'parent' });
  const g = await runRound(h, session, { steps: 1, first: true });
  eq(g, 0);
});

await test('无 request/header 且未配置路由时不炸（只告警跳过）', async () => {
  const h = makeHarness();
  const session = h.makeSession('s7');
  h.turnStart(session);
  h.stepStart(session, 1);
  h.human(session, '没有 header 的一轮');
  h.mainRequest(session);
  await settle(6);
  eq(h.providerTitles(session).length, 0);
});

await test('selfSchedule=false → 退回主包原状（钩子不生成）', async () => {
  const h = makeHarness({ selfSchedule: false });
  const session = h.makeSession('s8');
  const g = await runRound(h, session, { steps: 1, first: true, humanText: 'Z' });
  eq(g, 0);
});

await test('标题事件形状：source.kind=provider / provider=dsh-session-title-live / messageSeqs 升序', async () => {
  const h = makeHarness();
  const session = h.makeSession('s9');
  await runRound(h, session, { steps: 1, first: true, humanText: 'A' });
  await runRound(h, session, { steps: 1, humanText: 'B' });
  const last = h.providerTitles(session).at(-1);
  eq(last.data.source.kind, 'provider');
  eq(last.data.source.provider, 'dsh-session-title-live');
  const seqs = last.data.messageSeqs;
  for (let i = 1; i < seqs.length; i++) assert(seqs[i] > seqs[i - 1], `messageSeqs 必须严格升序：${seqs}`);
});

await test('llm/stream waterfall 契约：监听器必须 return next()（0 次 non-iterable）', async () => {
  // 护栏的由来：2026-09-14 真机实测，旧代码 `ctx.on('llm/stream', (options) => { ...裸 return; })`
  // 在真机上把 waterfall 结果变成 undefined → 主请求整回合崩（Symbol.asyncIterator）。
  // 旧 mock 直接调用监听器（普通事件语义），契约失真 → 21/21 全绿也没抓住。现在 mock 复刻真机语义。
  const h = makeHarness();
  const session = h.makeSession('s10');
  await runRound(h, session, { steps: 1, first: true, humanText: '契约' });
  eq(h.streamErrors.length, 0, `waterfall 契约被违反：${JSON.stringify(h.streamErrors)}`);
});

// ── [4] 收口①：自调度尊重 pin（人工改名后不再重生成基名）────────────────
// 由来：实测归因（形状 E）发现自调度路径不读 pin，
// 会在用户手动改名后继续覆盖（语义反转）。判定口径与打标路径共用同一份账本
// （createPinLedger：sawTurn / bootstrapSeq），**任务卡会话的创建期 user 标题不算 pin**。
process.stdout.write('\n[4] 收口①：自调度尊重 pin\n');

await test('人工改名后：不再生成新基名，且标题保持人工名', async () => {
  const h = makeHarness();
  const s = h.makeSession('pin-1');
  const g1 = await runRound(h, s, { steps: 1, first: true, humanText: '第一轮' });
  eq(g1, 1, '改名之前应正常生成');
  h.userRename(s, '用户自己起的名');       // GUI 手动重命名的等价物
  await settle();
  const before = h.providerTitles(s).length;
  const g2 = await runRound(h, s, { steps: 1, humanText: '第二轮' });
  eq(g2, 0, '人工改名后不得再生成基名');
  eq(h.providerTitles(s).length, before, 'provider 标题条数不得增加');
  eq(h.titles(s).at(-1).data.title, '用户自己起的名', '人工改名的标题必须原样保留（打标也不得覆盖）');
});

await test('任务卡会话：创建期 user 标题（早于第一个 turn/start）不算 pin，照常生成', async () => {
  const h = makeHarness();
  const s = h.makeSession('card-pin-1');
  // Host 建卡时的行为：先把卡片标题写成会话标题（source=user），此刻还没有任何 turn
  h.userRename(s, '升级 L2 金丝雀实例（含首检三问）');
  await settle();
  const g1 = await runRound(h, s, { steps: 1, first: true, humanText: '第一轮' });
  const g2 = await runRound(h, s, { steps: 1, humanText: '第二轮' });
  eq(g1, 1, '任务卡会话首轮必须照常生成（不许把建卡标题误判成 pin）');
  eq(g2, 1, '任务卡会话第二轮也必须照常生成');
});

await test('pin 不串台：同 harness 里改名会话停、未改名会话照常', async () => {
  const h = makeHarness();
  const a = h.makeSession('pin-a');
  const b = h.makeSession('pin-b');
  await runRound(h, a, { steps: 1, first: true, humanText: 'A1' });
  await runRound(h, b, { steps: 1, first: true, humanText: 'B1' });
  h.userRename(a, 'A 的人工名');
  await settle();
  const gA = await runRound(h, a, { steps: 1, humanText: 'A2' });
  const gB = await runRound(h, b, { steps: 1, humanText: 'B2' });
  eq(gA, 0, '被改名的会话应停');
  eq(gB, 1, '未改名的会话不受影响');
  eq(h.titles(a).at(-1).data.title, 'A 的人工名');
});

await test('pin 判定不因"同一个 seq 再触发一次"复活（连续两轮 llm/stream 都不生成）', async () => {
  const h = makeHarness();
  const s = h.makeSession('pin-2');
  await runRound(h, s, { steps: 1, first: true, humanText: 'X' });
  h.userRename(s, '停在这');
  await settle();
  await runRound(h, s, { steps: 2, humanText: 'Y' });
  await runRound(h, s, { steps: 1, humanText: 'Z' });
  eq(h.providerTitles(s).length, 1, '改名之后一条新基名都不该出现（含多步回合的两轮）');
});

// ── [5] 收口②：一条人类消息 ⇒ 恰好 1 条 GENREQ ──────────────────────────
// 由来：归因 §5 形状 F —— 同一轮两条通路（主包服务通路 + 自调度）各写一条
// session/title-llm-request，标题观感无损但多烧一次标题 token。
// 修法：两条通路在写 GENREQ / 调 LLM 之前各认领一次（判据 = 该轮最大人类 seq）。
process.stdout.write('\n[5] 收口②：一条人类消息 ⇒ 恰好 1 条 GENREQ\n');

await test('自调度先认领 → 主包通路被拦下（仍只有 1 条 GENREQ）', async () => {
  const h = makeHarness();
  const s = h.makeSession('dedup-1');
  h.turnStart(s);
  h.stepStart(s, 1);
  h.header(s, 'deepseek-official', 'deepseek-flash');
  const ev = h.human(s, '第一轮');
  h.mainRequest(s);                        // 自调度出手
  await settle(6);
  eq(h.genreqs(s).length, 1, '自调度应恰好发 1 条');
  eq(h.genreqs(s)[0].data.scheduler, 'self');

  let blocked = null;
  try { await h.mainPathGenerate(s, [ev.seq]); } catch (error) { blocked = error; }
  assert(blocked !== null, '主包通路应被轮次认领拦下（在写 GENREQ 之前退出）');
  assert(/去重/.test(String(blocked?.message)), `拦截文案要写明是去重：${blocked?.message}`);
  eq(h.genreqs(s).length, 1, '仍然只有 1 条 GENREQ');
  eq(h.providerTitles(s).length, 1, '标题也仍是 1 条（没有第二条晚到的覆盖）');
});

await test('主包通路已发出 GENREQ（标题未回）→ 自调度不重复发', async () => {
  const h = makeHarness();
  const s = h.makeSession('dedup-2');
  h.turnStart(s);
  h.stepStart(s, 1);
  h.header(s, 'deepseek-official', 'deepseek-flash');
  const ev = h.human(s, '第一轮');
  // 模拟主包通路已发起、标题尚未写回（正是两次生成并发的窗口）
  s.append('session/title-llm-request', { titleProvider: 'dsh-session-title-live', scheduler: 'service', messageSeqs: [ev.seq] });
  await settle();
  h.mainRequest(s);
  await settle(6);
  eq(h.genreqs(s).length, 1, `自调度不得重复发 GENREQ，实得 ${h.genreqs(s).length}`);
  eq(h.genreqs(s)[0].data.scheduler, 'service');
  eq(h.providerTitles(s).length, 0, '自调度不该再生成（等主包那条回来）');
});

await test('3 轮 × 两条通路都尝试 → 每轮恰好 1 条 GENREQ', async () => {
  const h = makeHarness();
  const s = h.makeSession('dedup-3');
  h.turnStart(s);
  const humanSeqs = [];
  for (let i = 1; i <= 3; i++) {
    h.stepStart(s, i);
    const ev = h.human(s, `第${i}轮`);
    humanSeqs.push(ev.seq);
    if (i === 1) h.header(s, 'deepseek-official', 'deepseek-flash');
    h.mainRequest(s);                       // 自调度
    await settle(4);
    try { await h.mainPathGenerate(s, [ev.seq]); } catch { /* 预期：被认领拦下 */ }
    await settle(2);
    h.stepEnd(s, i);
  }
  h.turnEnd(s);
  await settle(6);
  const gens = h.genreqs(s);
  eq(gens.length, 3, `3 轮应恰好 3 条 GENREQ，实得 ${gens.length}`);
  for (const seq of humanSeqs) {
    const own = gens.filter((g) => (g.data.messageSeqs ?? []).at(-1) === seq);
    eq(own.length, 1, `humanSeq=${seq} 应恰好 1 条 GENREQ，实得 ${own.length}`);
  }
});

await test('去重不误伤：只有一条通路时照常生成（每轮 1 条 GENREQ + 1 条标题）', async () => {
  const h = makeHarness();
  const s = h.makeSession('dedup-4');
  await runRound(h, s, { steps: 1, first: true, humanText: 'A' });
  await runRound(h, s, { steps: 1, humanText: 'B' });
  eq(h.genreqs(s).length, 2, '两轮应恰好 2 条 GENREQ');
  eq(h.providerTitles(s).length, 2, '两轮应恰好 2 条基名标题');
});

// ── [6] 小样本幻觉收口：主题锚 + 最小信息门槛（方案 C）────────────────────
// 复现场景（事件级证据）：会话首条是长任务消息，重启（实例重建）后用户只发了
// 「回来了」「B吧」两条短消息，自调度通路用**内存累积窗口**（只有这 2 条、5 字）驱动生成
// → 标题漂移成「恢复B站视频下载任务」。修复后：门槛拦下这两轮（保留旧标题），
// 长消息到来时选材带**主题锚**（上一版标题依据，含会话首条），不再只有最近 1–2 条。
process.stdout.write('\n[6] 小样本幻觉收口（主题锚 + 最小信息门槛）\n');

const LONG_FIRST = '这是一条很长的会话首条消息，用来把主题锚钉住，避免标题漂移；顺便补足长度。';
const LONG_LATER = '好，建卡吧，另外你说标题插件的小bug，也建卡修一下？';

await test('门槛：已有标题 + 新增仅 2 字（「B吧」）→ skip=thin-increment', () => {
  const plan = planTitleInput({
    humans: [{ seq: 7, text: LONG_FIRST }, { seq: 61067, text: '回来了' }, { seq: 79488, text: 'B吧' }],
    anchorSeqs: [7, 61067], lastCovered: 61067, hasExistingTitle: true,
    maxInputBytes: 32768, minIncrementChars: DEFAULT_MIN_INCREMENT_CHARS, anchorMax: 6,
  });
  eq(plan.skip, true);
  eq(plan.reason, 'thin-increment');
  eq(plan.incrementChars, 2, '增量只算 seq > lastCovered 的消息（「B吧」= 2 字，「回来了」已覆盖）');
  eq(plan.selected.length, 0, '跳过时不给选材（不调 LLM）');
});

await test('门槛不误伤首轮：还没有旧标题时，短消息也照常生成', () => {
  const plan = planTitleInput({
    humans: [{ seq: 7, text: '回来了' }], anchorSeqs: [], lastCovered: 0,
    hasExistingTitle: false, maxInputBytes: 32768, minIncrementChars: DEFAULT_MIN_INCREMENT_CHARS, anchorMax: 6,
  });
  eq(plan.skip, false);
  eq(plan.selected.map((m) => m.seq).join(','), '7');
});

await test('门槛可关：minIncrementChars=0 → 短消息照常生成（退回旧行为）', () => {
  const plan = planTitleInput({
    humans: [{ seq: 7, text: LONG_FIRST }, { seq: 79488, text: 'B吧' }],
    anchorSeqs: [7], lastCovered: 7, hasExistingTitle: true,
    maxInputBytes: 32768, minIncrementChars: 0, anchorMax: 6,
  });
  eq(plan.skip, false);
});

await test('主题锚：增量够时会话首条（上一版标题依据）必须进选材', () => {
  const plan = planTitleInput({
    humans: [
      { seq: 7, text: LONG_FIRST }, { seq: 884, text: '是有卡还是你直接动手？' },
      { seq: 6303, text: '好' }, { seq: 23668, text: '我已经忘了这个任务是要干嘛的了，你给我讲讲' },
      { seq: 61067, text: '回来了' }, { seq: 79488, text: 'B吧' }, { seq: 109118, text: LONG_LATER },
    ],
    anchorSeqs: [7, 884, 6303, 23668, 61067], lastCovered: 61067, hasExistingTitle: true,
    maxInputBytes: 32768, minIncrementChars: DEFAULT_MIN_INCREMENT_CHARS, anchorMax: 6,
  });
  eq(plan.skip, false, '增量 = 2 + 27 = 29 字 ≥ 20 → 不拦');
  eq(plan.incrementChars, 29);
  const seqs = plan.selected.map((m) => m.seq);
  assert(seqs.includes(7), `选材必须含会话首条（主题锚）seq=7，实得 [${seqs}]`);
  assert(seqs.length >= 5, `选材不应退化成 1–2 条，实得 [${seqs}]`);
});

await test('锚优先级：预算紧张时保锚、先裁最近消息', () => {
  const long = 'x'.repeat(600);                       // 撑满预算
  const plan = planTitleInput({
    humans: [{ seq: 7, text: LONG_FIRST }, { seq: 20, text: long }, { seq: 21, text: long }, { seq: 22, text: long }],
    anchorSeqs: [7], lastCovered: 7, hasExistingTitle: true,
    maxInputBytes: 1024, minIncrementChars: 1, anchorMax: 6,
  });
  const seqs = plan.selected.map((m) => m.seq);
  assert(seqs.includes(7), `预算紧张也必须保住主题锚（seq=7），实得 [${seqs}]`);
  const capped = JSON.stringify(plan.selected.map((m) => m.text));
  assert(Buffer.byteLength(capped, 'utf8') <= 1024, '选材字节数必须仍在 maxInputBytes 之内');
});

await test('collectHumanMessages：只取人类来源且 seq ≤ throughSeq', () => {
  const events = [
    { type: 'user/message', seq: 3, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'a' }] } },
    { type: 'user/message', seq: 5, data: { source: { kind: 'plugin', plugin: 'x' }, content: [{ type: 'text', text: 'b' }] } },
    { type: 'user/message', seq: 7, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'c' }] } },
    { type: 'user/message', seq: 9, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'd' }] } },
    { type: 'session/title', seq: 10, data: { title: 't', source: { kind: 'provider' } } },
  ];
  eq(collectHumanMessages(events).map((m) => m.seq).join(','), '3,7,9');
  eq(collectHumanMessages(events, 7).map((m) => m.seq).join(','), '3,7');
  eq(collectHumanMessages(events, 7).map((m) => m.text).join(''), 'ac');
});

await test('lastCoveredSeq：取最后一版 provider 标题（含 #turn-mark）的依据最大 seq', () => {
  const events = [
    { type: 'session/title', seq: 4, data: { title: 'A', messageSeqs: [3], source: { kind: 'provider', provider: 'dsh-session-title-live' } } },
    { type: 'session/title', seq: 6, data: { title: '人工', messageSeqs: [], source: { kind: 'user' } } },
    { type: 'session/title', seq: 8, data: { title: '【运行】B', messageSeqs: [3, 7], source: { kind: 'provider', provider: 'dsh-session-title-live#turn-mark' } } },
  ];
  eq(lastCoveredSeq(events), 7);
  eq(lastTitleMessageSeqs(events).join(','), '3,7');
  eq(lastCoveredSeq([]), 0);
});

await test('装载层·重启复现：实例重建后两条短消息不再重写标题；随后长消息带锚恢复', async () => {
  // ① 原实例：首条长消息 → 一轮（带 route/header）
  const h1 = makeHarness({ minIncrementChars: DEFAULT_MIN_INCREMENT_CHARS });
  const s1 = h1.makeSession('restart-src');
  await runRound(h1, s1, { steps: 1, first: true, humanText: LONG_FIRST });
  const firstHumanSeq = s1.events.find((e) => e.type === 'user/message' && e.data.source?.kind === 'user').seq;
  assert(h1.providerTitles(s1).length === 1, `原实例应产出 1 条基名标题，实得 ${h1.providerTitles(s1).length}`);

  // ② 实例重建（= 重启）：新 harness + 新会话对象 + seed 历史（真机 seed 不 publish →
  //    插件的内存累积窗口清空，正是漂移的触发条件）
  const h2 = makeHarness({ minIncrementChars: DEFAULT_MIN_INCREMENT_CHARS });
  const s2 = h2.makeSession('restart-dst');
  h2.seedSession(s2, [...s1.events]);
  const gensSeeded = h2.genreqs(s2).length;
  const titlesSeeded = h2.providerTitles(s2).length;

  // ③ 两条短消息：门槛拦下 → 不写 GENREQ、不写新标题（旧标题保留，不再漂移）
  await runRound(h2, s2, { steps: 1, first: true, humanText: '回来了' });
  await runRound(h2, s2, { steps: 1, humanText: 'B吧' });
  eq(h2.genreqs(s2).length, gensSeeded, '短消息不应触发新的 GENREQ（最小信息门槛）');
  eq(h2.providerTitles(s2).length, titlesSeeded, '不应产生新基名标题（保留旧标题 = 不漂移）');

  // ④ 长消息：恢复生成，选材带主题锚（会话首条），不再是「最近 1–2 条」
  await runRound(h2, s2, { steps: 1, humanText: LONG_LATER });
  eq(h2.genreqs(s2).length, gensSeeded + 1, '长消息应驱动一次生成');
  const seqs = h2.genreqs(s2).at(-1).data.messageSeqs;
  assert(seqs.includes(firstHumanSeq), `选材必须含会话首条（主题锚）seq=${firstHumanSeq}，实得 [${seqs}]`);
  assert(seqs.length >= 4, `选材不应退化成 1–2 条，实得 [${seqs}]`);
  eq(h2.providerTitles(s2).length, titlesSeeded + 1, '应落一条新基名标题');
});

await test('长上下文不退化：每轮长消息都刷新标题，且首条锚一直在', async () => {
  const h = makeHarness({ minIncrementChars: DEFAULT_MIN_INCREMENT_CHARS });
  const s = h.makeSession('long-context');
  const texts = [LONG_FIRST, '再加一个画廊保留策略，保留最近三十天的作品', '把保留策略落成一个可以手动重跑的清理脚本'];
  for (let i = 0; i < texts.length; i++) await runRound(h, s, { steps: 1, first: i === 0, humanText: texts[i] });
  eq(h.providerTitles(s).length, 3, '三轮长消息都应刷新标题');
  const firstHumanSeq = s.events.find((e) => e.type === 'user/message' && e.data.source?.kind === 'user').seq;
  for (const t of h.providerTitles(s)) {
    assert((t.data.messageSeqs ?? []).includes(firstHumanSeq), `每版选材都该含首条锚，实得 [${t.data.messageSeqs}]`);
  }
});

// ── 汇总 ───────────────────────────────────────────────────────────────
process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) {
  for (const f of failures) process.stdout.write(`  FAIL ${f.name}: ${f.error?.stack ?? f.error}\n`);
  process.exitCode = 1;
}
