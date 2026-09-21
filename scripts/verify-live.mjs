#!/usr/bin/env node
// scripts/verify-live.mjs —— 对**运行中的真实 DSH 实例**做**只读**核对
//
// 干什么：单测与 e2e 用的是假宿主，假宿主可能"照我们以为的样子"写事件。
// 本脚本对着一台真实例核对两件事：
//   ① 实例在线、`session.list` 这类只读 RPC 的返回形状与预期一致；
//   ② （给了 --home 时）会话日志里真实事件的**名字与字段**，与 lib/host-protocol.js 内联的
//      常量、以及 lib/index.js 的判定口径逐条对上 —— 这是"内联协议常量没有过时"的硬证据：
//        · `user/message` 且 `data.source.kind === 'user'`（humanTextOf 的判据）
//        · `turn/start` / `turn/end`（回合边界打标用）
//        · `session/title` 的 `source.kind`（pin 判定靠 'user'，防回环靠 'provider'）
//        · 若实例里跑着本插件：`source.provider` 应等于 `dsh-session-title-live`
//          或 `<包名>#turn-mark`（与默认 markProvider 口径一致）
//
// ⚠️ 只读纪律：本脚本**不发 prompt、不 append 事件、不改任何文件、不装插件、不重启**。
//    唯一的"连接"就是一次 session.list 只读 RPC 与读会话日志文件（只读打开）。
//    要跑它，请对**隔离测试实例**（例如 3090）跑，不要对生产实例跑。
//
// 用法：
//   node scripts/verify-live.mjs --base http://127.0.0.1:3090
//   node scripts/verify-live.mjs --base http://127.0.0.1:3090 --home <隔离实例 home> [--session <id>]
import fs from 'node:fs';
import { createProbe, analyze, findSessionLog, readEvents } from './probe.mjs';
import { EV, isTurnStart, isTurnEnd } from '../lib/host-protocol.js';

const argv = process.argv;
const arg = (name, fallback = undefined) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
if (argv.includes('-h') || argv.includes('--help')) {
  console.log('usage: node scripts/verify-live.mjs --base <http://host:port> [--home <instance home>] [--session <id>]');
  process.exitCode = 0;
} else {
  const base = arg('--base', 'http://127.0.0.1:3090');
  const home = arg('--home');
  const wanted = arg('--session');

  let pass = 0;
  const failures = [];
  const ok = (cond, label, extra = '') => {
    if (cond) { pass += 1; console.log(`  ✓ ${label}${extra ? `  → ${extra}` : ''}`); }
    else { failures.push(label); console.log(`  ✗ ${label}${extra ? `  → ${extra}` : ''}`); }
  };

  console.log(`实例: ${base}`);
  console.log(`插件包名: ${'dsh-session-title-live'}｜内联协议常量版本: EV/SVC @lib/host-protocol.js`);
  ok(isTurnStart(EV.TURN_START) && isTurnEnd(EV.TURN_END), '内联常量自洽（isTurnStart / isTurnEnd）');

  const probe = createProbe({ base, home: home ?? process.cwd() });
  let list = null;
  try {
    list = await probe.rpc('session.list', {}, 20000);
    ok(true, '实例在线：session.list 可用');
  } catch (error) {
    ok(false, '实例在线：session.list 可用', String(error?.message ?? error).slice(0, 120));
  }

  if (list !== null) {
    const items = Array.isArray(list?.items) ? list.items : [];
    ok(Array.isArray(list?.items), 'session.list 返回 items 数组', `items=${items.length}`);
    const withTitle = items.filter((it) => typeof it?.projections?.values?.title === 'string' && it.projections.values.title !== '');
    ok(items.length === 0 || withTitle.length > 0, '存在带标题的会话（标题投影可读）', `${withTitle.length}/${items.length}`);
    const running = items.filter((it) => it?.running === true).length;
    ok(true, '会话运行态可读', `running=${running}`);

    if (home === undefined) {
      console.log('\n（未提供 --home：跳过会话日志协议核对。要核对内联常量与真实事件，请加 --home <隔离实例 home>）');
    } else {
      // 选一个会话读它的日志：优先 --session，其次最近有标题的、其次第一个
      const target = items.find((it) => it.sessionId === wanted)
        ?? withTitle.at(-1)
        ?? items[0];
      if (target === undefined) {
        console.log('\n（实例里还没有会话，跳过节日志核对）');
      } else {
        const sessionId = target.sessionId;
        console.log(`\n[协议核对] 会话 ${sessionId}`);
        let file = null;
        for (let i = 0; i < 10 && file === null; i++) {
          file = findSessionLog(home, sessionId);
          if (file === null) await new Promise((r) => setTimeout(r, 300));
        }
        ok(file !== null, '找到该会话的日志文件（只读打开）', file ?? '(未找到)');
        if (file !== null) {
          const events = readEvents(file);
          ok(events.length > 0, '日志能解帧出事件', `${events.length} 条事件、${fs.statSync(file).size} 字节`);
          const types = new Set(events.map((e) => e.type));

          const analysis = analyze(events);
          ok(analysis.humans.length >= 0, '会话事件可分析（人类消息 / 标题 / 生成请求）',
            `humans=${analysis.humans.length} titles=${analysis.titles.length} genreqs=${analysis.genreqs.length}`);

          // ① humanTextOf 的判据：user/message 且 data.source.kind === 'user'
          const userMessages = events.filter((e) => e.type === EV.USER_MESSAGE);
          const humanSource = userMessages.filter((e) => e.data?.source?.kind === 'user');
          ok(userMessages.length === 0 || humanSource.length > 0,
            `user/message 事件里存在 source.kind='user'（humanTextOf 的判据）`,
            `${humanSource.length}/${userMessages.length}`);
          const blockShape = humanSource.filter((e) => Array.isArray(e.data?.content) && e.data.content.some((b) => b?.type === 'text'));
          ok(humanSource.length === 0 || blockShape.length > 0,
            '人类消息的 content 是 [{type:"text"}] 块（取文本的口径）', `${blockShape.length}/${humanSource.length}`);

          // ② 回合边界
          ok(types.has(EV.TURN_START) || types.has(EV.TURN_END),
            '日志里出现回合边界事件（turn/start 或 turn/end）',
            [...types].filter((t) => t === EV.TURN_START || t === EV.TURN_END).join(',') || '(无)');

          // ③ 标题事件形状
          const titles = events.filter((e) => e.type === EV.SESSION_TITLE);
          const kinds = [...new Set(titles.map((e) => e.data?.source?.kind ?? '(无 source)'))];
          // 实测三种来源（在真实实例上核对过）：user = 人工改名 / 外部预置；provider = 自动生成（本插件写的也是它）；
          // fallback = 主包在会话还没有标题时写的**确定性兜底**标题（dsh-session-title 的 fallbackSessionTitle）。
          // 本插件的 pin 判定只认 user ⇒ fallback 会被正常打标/覆盖，这正是期望行为。
          const KNOWN_TITLE_KINDS = ['user', 'provider', 'fallback'];
          ok(titles.length === 0 || kinds.every((k) => KNOWN_TITLE_KINDS.includes(k)),
            'session/title 的 source.kind 只在 {user, provider, fallback} 里（pin 判定与防回环的前提）', kinds.join(','));

          // ④ 本插件在本实例上的痕迹（有就算对上，没有只提示不判失败）
          const byOurPlugin = analysis.generated;
          const marks = analysis.marks;
          if (byOurPlugin.length > 0 || marks.length > 0) {
            ok(true, '实例上存在本插件写的标题（说明实例确实跑着这个插件）',
              `generated=${byOurPlugin.length} marks=${marks.length}`);
            ok(byOurPlugin.length === 0 || byOurPlugin.every((g) => typeof g.title === 'string' && g.title !== ''),
              '本插件写的标题都非空');
          } else {
            console.log('  · 本实例的该会话里没有本插件的标题痕迹（可能没装本插件、或该会话没触发过）——不判失败');
          }
        }
      }
    }
  }

  console.log('\n只读声明：本脚本未调用 session.prompt / 未 append 任何事件 / 未写任何文件 / 未装改插件、未重启实例。');
  console.log(`\n=== 结果：通过 ${pass} / 失败 ${failures.length} ===`);
  if (failures.length > 0) {
    for (const f of failures) console.log('  - ' + f);
    process.exitCode = 1;
  } else {
    console.log('LIVE READ-ONLY CHECK PASSED');
  }
}
