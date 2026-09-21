#!/usr/bin/env node
// _test/test-mark.mjs —— dsh-session-title-live 回合边界自动前缀的离线单测
//
// 覆盖：纯函数（前缀识别/裁剪/兜底/子代理判定）+ 事件流（turn/start 打【运行】、
// turn/end 打【完成】、provider 异步写回对账、子代理跳过、人工改名跳过、无标题跳过、
// 防回环、幂等、disposed 清理、关闭开关）。
//
// 用 mock 复刻主包的会话语义：append 期间禁止重入 append（"session append cannot
// reenter while another append is being published"）+ 事件先入 log 再同步派发
// session/event —— 这一步是"必须异步 append"的硬约束来源。
//
// 运行：node _test/test-mark.mjs

import {
  apply,
  MARK_PREFIX,
  stripTitleMark,
  titleMarkState,
  computeMarkedTitle,
  isSubagentSession,
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
const bytes = (s) => Buffer.byteLength(s, 'utf8');
const delay = () => new Promise((resolve) => setTimeout(resolve, 0));

// ── mock 支架 ──────────────────────────────────────────────────────────
function makeHarness(config = {}) {
  const listeners = new Map();
  const sessions = new Map();
  const fire = (name, ...args) => {
    for (const fn of listeners.get(name) ?? []) fn(...args);
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
    llm: { stream: async function* () { /* unused in offline test */ } },
    logger: { info() {}, warn() {}, debug() {} },
    on(name, fn) {
      const arr = listeners.get(name) ?? [];
      arr.push(fn);
      listeners.set(name, arr);
      return () => {};
    },
  };

  apply(ctx, {
    targetWords: 5,
    targetCjkCharacters: 10,
    maxInputBytes: 32768,
    maxOutputTokens: 128,
    timeoutMs: 30000,
    ...config,
  });

  const makeSession = (id, header = {}) => {
    const events = [];
    const session = {
      id,
      header,
      get events() { return events; },
      get marks() { return events.filter((e) => e.type === 'session/title').map((e) => e.data.title); },
      append(type, data) {
        if (session._appending) throw new Error('session append cannot reenter while another append is being published');
        const event = { type, seq: events.length, time: Date.now(), data };
        session._appending = true;
        events.push(event);
        try {
          fire('session/event', session, event);
        } finally {
          session._appending = false;
        }
        return event;
      },
    };
    sessions.set(id, session);
    return session;
  };

  const dispose = (session) => {
    sessions.delete(session.id);
    fire('session/disposed', session);
  };

  /** 模拟官方 provider 写入一条无前缀标题（异步 LLM 结果）。 */
  const providerTitle = (session, title, seqs = [1]) => session.append('session/title', {
    title,
    messageSeqs: seqs,
    source: { kind: 'provider', provider: 'dsh-session-title-live', model: { provider: 'deepseek', model: 'x' } },
  });

  return { ctx, makeSession, dispose, providerTitle, sessionTitle };
}

const lastTitle = (session) => session.events.filter((e) => e.type === 'session/title').at(-1)?.data.title;

// ── 1. 纯函数 ──────────────────────────────────────────────────────────
process.stdout.write('\n[1] 纯函数\n');

await test('前缀表与外部会话脚本口径一致（【运行】/【完成】各 12 字节）', () => {
  eq(MARK_PREFIX.running, '【运行】');
  eq(MARK_PREFIX.done, '【完成】');
  eq(bytes(MARK_PREFIX.running), 12);
  eq(bytes(MARK_PREFIX.done), 12);
});

await test('stripTitleMark 去掉前缀；无前缀保持原样', () => {
  eq(stripTitleMark('【运行】修标题'), '修标题');
  eq(stripTitleMark('【完成】修标题'), '修标题');
  eq(stripTitleMark('普通标题'), '普通标题');
  eq(stripTitleMark(undefined), '');
});

await test('titleMarkState 识别四类前缀并忽略空白，无前缀返回 null', () => {
  eq(titleMarkState('【运行】x'), 'running');
  eq(titleMarkState('【完成】 x'), 'done');
  eq(titleMarkState('【待命】x'), 'idle');
  eq(titleMarkState('【已中断】x'), 'interrupted');
  eq(titleMarkState('普通标题'), null);
  eq(titleMarkState(null), null);
});

await test('computeMarkedTitle：保留基名、去旧前缀、替换状态', () => {
  eq(computeMarkedTitle('干活中', 'running', 64), '【运行】干活中');
  eq(computeMarkedTitle('【运行】干活中', 'done', 64), '【完成】干活中');
});

await test('computeMarkedTitle：基名按字节预算裁剪（不切断多字节字符）', () => {
  const long = '汉'.repeat(100);
  const out = computeMarkedTitle(long, 'running', 64);
  eq(out, `【运行】${'汉'.repeat(21)}`);       // 21×3 = 63 ≤ 64
  assert(bytes(out) <= 80, `加前缀后必须不超主包 maxTitleBytes 80，实测 ${bytes(out)}`);
  const emoji = computeMarkedTitle('🐳'.repeat(30) + 'x', 'done', 64); // 4 字节字符也不能被切
  assert(!emoji.includes('\uFFFD'), '不得出现替换字符（切断了码点）');
  assert(bytes(emoji) <= 80, `emoji 标题超限：${bytes(emoji)}`);
});

await test('computeMarkedTitle：标题只剩前缀时兜底为「会话」', () => {
  eq(computeMarkedTitle('【运行】', 'done', 64), '【完成】会话');
  eq(computeMarkedTitle('', 'running', 64), '【运行】会话');
});

await test('computeMarkedTitle：非法状态抛错', () => {
  let threw = false;
  try { computeMarkedTitle('x', 'paused', 64); } catch { threw = true; }
  assert(threw, 'expect throw for unknown state');
});

await test('isSubagentSession：父会话 / origin=subagent 判为子代理，普通会话不算', () => {
  eq(isSubagentSession({ header: {} }), false);
  eq(isSubagentSession({ header: { parentSession: 'session-1' } }), true);
  eq(isSubagentSession({ header: { origin: 'subagent' } }), true);
  eq(isSubagentSession({}), false);
});

// ── 2. 事件流 ──────────────────────────────────────────────────────────
process.stdout.write('\n[2] 事件流\n');

await test('turn/start + provider 写标题 → 【运行】', async () => {
  const h = makeHarness();
  const s = h.makeSession('s1');
  s.append('turn/start', { turn: 1 });
  await delay();
  eq(lastTitle(s), undefined, '此时还没有标题，必须跳过');
  h.providerTitle(s, '修标题前缀');
  await delay();
  eq(lastTitle(s), '【运行】修标题前缀');
});

await test('turn/end → 【完成】', async () => {
  const h = makeHarness();
  const s = h.makeSession('s2');
  s.append('turn/start', { turn: 1 });
  h.providerTitle(s, '修标题前缀');
  await delay();
  s.append('turn/end', { turn: 1, reason: 'success' });
  await delay();
  eq(lastTitle(s), '【完成】修标题前缀');
});

await test('对账：provider 在 turn/end 之后才写回新标题 → 补【完成】', async () => {
  const h = makeHarness();
  const s = h.makeSession('s3');
  s.append('turn/start', { turn: 1 });
  h.providerTitle(s, '第一版');
  await delay();
  s.append('turn/end', { turn: 1, reason: 'success' });
  await delay();
  eq(lastTitle(s), '【完成】第一版');
  h.providerTitle(s, '第二版（慢标题）', [1, 2]); // LLM 慢，回合结束后才回来
  await delay();
  eq(lastTitle(s), '【完成】第二版（慢标题）');
});

await test('对账：provider 在回合中写回 → 补当前状态【运行】', async () => {
  const h = makeHarness();
  const s = h.makeSession('s4');
  s.append('turn/start', { turn: 1 });
  h.providerTitle(s, 'A');
  await delay();
  eq(lastTitle(s), '【运行】A');
  h.providerTitle(s, 'B');
  await delay();
  eq(lastTitle(s), '【运行】B', '每轮新标题都要按当前状态补前缀');
});

await test('幂等：重复 turn/start 不产生多余 title 事件', async () => {
  const h = makeHarness();
  const s = h.makeSession('s5');
  s.append('turn/start', { turn: 1 });
  h.providerTitle(s, '干活');
  await delay();
  const before = s.marks.length;
  s.append('turn/start', { turn: 2 });
  await delay();
  eq(s.marks.length, before, '状态没变就不该再写事件');
});

await test('防回环：自己写的 mark 事件不再触发第二次打标', async () => {
  const h = makeHarness();
  const s = h.makeSession('s6');
  s.append('turn/start', { turn: 1 });
  h.providerTitle(s, '干活');
  await delay();
  const after = s.marks.length; // 【运行】干活
  s.append('session/title', {
    title: '【运行】干活',
    messageSeqs: [],
    source: { kind: 'provider', provider: 'dsh-session-title-live#turn-mark' },
  });
  await delay();
  eq(s.marks.length, after + 1, '只应多出我们自己 append 的那一条');
});

await test('边界：子代理会话完全不打标（parentSession / origin）', async () => {
  const h = makeHarness();
  const a = h.makeSession('sub-1', { parentSession: 'parent' });
  const b = h.makeSession('sub-2', { origin: 'subagent' });
  for (const s of [a, b]) {
    s.append('turn/start', { turn: 1 });
    h.providerTitle(s, '子代理标题');
    await delay();
    s.append('turn/end', { turn: 1, reason: 'success' });
    await delay();
    eq(lastTitle(s), '子代理标题', '子代理会话标题必须保持原样');
  }
});

await test('边界：人工改名（source=user）→ 不覆盖，且此后不再自动打标', async () => {
  const h = makeHarness();
  const s = h.makeSession('s7');
  s.append('turn/start', { turn: 1 });
  h.providerTitle(s, '自动标题');
  await delay();
  s.append('session/title', { title: '【运行】我自己起的名', messageSeqs: [], source: { kind: 'user' } });
  await delay();
  eq(lastTitle(s), '【运行】我自己起的名');
  s.append('turn/end', { turn: 1, reason: 'success' });
  await delay();
  eq(lastTitle(s), '【运行】我自己起的名', '人工 pin 后 turn/end 也不得改写');
  h.providerTitle(s, '另一个自动标题');
  await delay();
  eq(lastTitle(s), '另一个自动标题', 'provider 自己写的照写（我们只是不再插手）');
});

await test('边界：无标题的会话（turn 全程没有 title 事件）→ 不写任何 title', async () => {
  const h = makeHarness();
  const s = h.makeSession('s8');
  s.append('turn/start', { turn: 1 });
  await delay();
  s.append('turn/end', { turn: 1, reason: 'success' });
  await delay();
  eq(s.marks.length, 0, '没有标题就不该造标题');
});

await test('边界：超长标题加前缀后不超 80 字节', async () => {
  const h = makeHarness();
  const s = h.makeSession('s9');
  s.append('turn/start', { turn: 1 });
  h.providerTitle(s, '汉'.repeat(80) + 'ABCDEFGHIJ');
  await delay();
  const title = lastTitle(s);
  assert(title.startsWith('【运行】'), `前缀缺失：${title}`);
  assert(bytes(title) <= 80, `超限：${bytes(title)} 字节`);
});

await test('disposed：清掉状态表，之后重放的标题不再被补前缀', async () => {
  const h = makeHarness();
  const s = h.makeSession('s10');
  s.append('turn/start', { turn: 1 });
  h.providerTitle(s, '干活');
  await delay();
  eq(lastTitle(s), '【运行】干活');
  h.dispose(s);
  const s11 = h.makeSession('s10'); // 复用 id 重新入场（模拟重启后重放）
  h.providerTitle(s11, '新一轮标题');
  await delay();
  eq(lastTitle(s11), '新一轮标题', 'disposed 后状态已清，无 turn 状态不得打标');
});

await test('配置开关：turnMarks=false 时完全不打标', async () => {
  const h = makeHarness({ turnMarks: false });
  const s = h.makeSession('s12');
  s.append('turn/start', { turn: 1 });
  h.providerTitle(s, '干活');
  await delay();
  s.append('turn/end', { turn: 1, reason: 'success' });
  await delay();
  eq(lastTitle(s), '干活');
});

await test('append 重入保护：所有打标都经微任务，绝不在 append 派发中重入', async () => {
  const h = makeHarness();
  const s = h.makeSession('s13');
  h.providerTitle(s, '干活'); // 先有标题
  s.append('turn/start', { turn: 1 }); // 派发中 schedule，微任务里才 append
  eq(s.marks.filter((t) => t.startsWith('【运行】')).length, 0, '同步阶段不应已打标（否则就是重入）');
  await delay();
  eq(lastTitle(s), '【运行】干活');
});

await test('多会话隔离：各自状态互不串台', async () => {
  const h = makeHarness();
  const a = h.makeSession('m1');
  const b = h.makeSession('m2');
  h.providerTitle(a, 'A工作');
  h.providerTitle(b, 'B工作');
  a.append('turn/start', { turn: 1 });
  b.append('turn/start', { turn: 1 });
  await delay();
  b.append('turn/end', { turn: 1, reason: 'success' });
  await delay();
  eq(lastTitle(a), '【运行】A工作');
  eq(lastTitle(b), '【完成】B工作');
});

await test('任务卡会话：创建阶段写下的卡片标题（user source、早于 turn/start）不 pin，照常打标', async () => {
  const h = makeHarness();
  const s = h.makeSession('card-1');
  // 模拟 Host 建卡会话时的行为：先把卡片标题 rename 进会话（seq 最早，早于任何 turn）
  s.append('session/title', { title: '升级 L2 金丝雀实例（复用测试环境机制 · 含首检三问）', messageSeqs: [], source: { kind: 'user' } });
  await delay();
  eq(s.marks.length, 1, '还没开回合，不该打标');
  s.append('turn/start', { turn: 1 });
  await delay();
  const t1 = lastTitle(s);
  eq(titleMarkState(t1), 'running', `卡片会话第一轮应打【运行】，实际=${JSON.stringify(t1)}`);
  assert(bytes(t1) <= 80, `加前缀后不得超 80 字节，实际 ${bytes(t1)}`);
  s.append('turn/end', { turn: 1, reason: 'success' });
  await delay();
  eq(titleMarkState(lastTitle(s)), 'done', `收尾应为【完成】，实际=${JSON.stringify(lastTitle(s))}`);
});

await test('任务卡会话：卡标题固定——provider 的自动摘要不顶掉卡片标题，只换状态前缀', async () => {
  const h = makeHarness();
  const s = h.makeSession('card-2');
  s.append('session/title', { title: '升级 L2 金丝雀实例', messageSeqs: [], source: { kind: 'user' } });
  s.append('turn/start', { turn: 1 });
  await delay();
  eq(titleMarkState(lastTitle(s)), 'running');
  h.providerTitle(s, '金丝雀实例搭建与首检', [1, 2]); // 主包 provider 想改标题
  await delay();
  eq(lastTitle(s), '【运行】升级 L2 金丝雀实例', '卡片会话基名必须保持卡片标题');
  s.append('turn/end', { turn: 1, reason: 'success' });
  await delay();
  eq(lastTitle(s), '【完成】升级 L2 金丝雀实例', '收尾也只换前缀');
});

await test('任务卡会话：回合开始之后的人工改名仍然 pin（不是所有 user 标题都放行）', async () => {
  const h = makeHarness();
  const s = h.makeSession('card-3');
  s.append('session/title', { title: '卡片标题', messageSeqs: [], source: { kind: 'user' } });
  s.append('turn/start', { turn: 1 });
  await delay();
  eq(titleMarkState(lastTitle(s)), 'running');
  s.append('session/title', { title: '我自己改的名字', messageSeqs: [], source: { kind: 'user' } });
  await delay();
  eq(lastTitle(s), '我自己改的名字', '回合中的人工改名不得被覆盖');
  s.append('turn/end', { turn: 1, reason: 'success' });
  await delay();
  eq(lastTitle(s), '我自己改的名字', 'pin 之后 turn/end 也不得改写');
  s.append('turn/start', { turn: 2 });
  await delay();
  eq(lastTitle(s), '我自己改的名字', 'pin 之后下一轮也不得改写');
});

// ── 汇总 ───────────────────────────────────────────────────────────────
process.stdout.write(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}: ${passed} passed / ${failures.length} failed\n`);
for (const f of failures) process.stdout.write(`  - ${f.name}: ${f.error?.stack ?? f.error}\n`);
process.exit(failures.length === 0 ? 0 : 1);
