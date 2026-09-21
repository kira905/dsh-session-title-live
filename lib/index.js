/**
 * dsh-session-title-live — 会话标题实时更新 provider（零依赖）
 *
 * 为什么存在：官方默认的 session-title-first-prompt-llm 只对第一条用户消息
 * 生成标题（automatic: "first-prompt"），十几轮后标题和实际内容脱节。
 * 本插件注册 automatic: "all-prompts" 的 provider：每次用户发消息后，
 * 用「字节预算内最近的人类消息」重新生成标题，让侧边栏标题始终跟得上
 * 会话最新内容。
 *
 * 零依赖设计：不 import 任何 @deepseek-ai/* 包（那些包在全局 npm 主包里，
 * profile 侧解析不到、跨设备路径不同），LLM 流式调用与文本规范化全部内联
 * 实现，协议对齐官方 dsh-session-title-llm / dsh-session-title。
 *
 * 挂载：profile cordis.patch.yml 里 disable 官方 `session-title-llm` 行 +
 * insert 本插件（id: session-title-live）。核心 `session-title` 服务不动。
 *
 * ── 自建调度（方案 A，2026-09-13 加）────────────────────────────────────
 * 为什么必须自建：主包 `@deepseek-ai/dsh-session-title` 的自动调度**在首轮之后拿不到启动时机**。
 * 两条通路实测（真实主包代码沙箱，5 个回合形状）：
 *   · `onRequestHeader` 只在会话第一次主请求写 header 时触发 → 后续轮次无事发生；
 *   · `onMainRequest` 要求 `boundary.type==='step/start' && boundary.seq > pending.throughSeq`，
 *     而 boundary 取「最后一个 step/start|step/end」，主请求发起时它必然 ≤ 本轮人类消息 seq
 *     → **恒短路**；被挡的 pending 还会被下一条人类消息 supersede 覆盖（该轮标题永久丢失）。
 * 官方 0.1.5-rc.2（最新 next）把 boundary 改成读 turnBoundary 投影，但那条判定条件逐字未变
 * → 升级主包不解决。
 *
 * 所以本插件自己调度（selfSchedule 默认开）：
 *   ① session/event 记下每个人类消息的 seq（capped 环形，防内存膨胀）；
 *   ② llm/stream 钩子里**排除 purpose==='session-title'**（防自递归）后，检查是否有未处理的人类消息；
 *   ③ 有则调自己的 generate 并 append `source.kind:'provider'` 标题；
 *   ④ 去重：该 seq 若已落过 provider 标题就跳过（不会与仍能触发的 request/header 通路重复生成
 *      同一 seq）；在途生成只保最新一轮（pending 覆盖语义）；
 *   ⑤ 选材用「到该 seq 为止」的人类消息，基名随对话前进，不会固定在第一轮。
 * 关掉自调度（selfSchedule:false）= 退回主包调度原状，用于对照与兜底。
 *
 * ── 两处收口（2026-09-14）──────────────────────────────────────────
 * 依据归因实测（形状 E / F）：
 *   ① **自调度尊重 pin**：人工改名（source=user、且非创建期那条）之后，自调度**不再重生成基名**。
 *      判定与打标路径共用同一份账本（createPinLedger 的 sawTurn / bootstrapSeq），不新增标记。
 *      **任务卡会话的建卡标题（早于第一个 turn/start 的那条 user 标题）不算 pin**，照常生成。
 *   ② **一条人类消息 ⇒ 恰好 1 条 GENREQ**：两条通路（主包服务通路 / 自调度）在写
 *      `session/title-llm-request` **之前**用轮次认领（claimRound，判据 = 该轮最大人类 seq）
 *      互斥，谁先谁赢，后者退出（不写事件、不调 LLM）。GENREQ 带 `scheduler:'service'|'self'`
 *      来源标记，便于对账。
 *   两条收口都有单测与「变异体」验证（_test/test-self-schedule.mjs §[4][5]；
 *   临时删掉守卫后测试当场变红）。
 *
 * ── 小样本幻觉收口（2026-09-17 · 方案 C）──────────────────────────────
 * 证据（真实会话事件）：
 *   seq 61070（service 通路，喂 6 条、含会话首条）→ 标题命中会话主题 ✔
 *   seq 79490（self 通路，只喂 2 条短消息、共 5 字、无主题锚）
 *          → 标题与会话主题完全无关 ✘
 * 根因：self 通路的选材来自**插件实例内存**累积的 st.humans（createSelfScheduler）——
 *   1) **易失**：实例在重启/热重载后重建，窗口骤缩成「重启后这几条」（会话重开时主包会补写
 *      session/end-seed；seed 事件不 publish → 插件收不到历史）；
 *   2) **无主题锚**：窗口里没有会话首条消息，两句短消息无法定主题 → 模型自由联想。
 * 修法（两条，都可在 config 关掉）：
 *   ① **主题锚 + 持久窗口**（themeAnchorMax，默认 6）：人类消息改从 `session.events`
 *      （持久、含 seed 全量）读取（collectHumanMessages）；选材 = 上一版标题依据
 *      （lastTitleMessageSeqs，**恒定并上会话首条人类消息**）+ 最近消息，按字节预算收拢，
 *      锚优先（预算不足时先裁最近消息）。
 *   ② **最小信息门槛**（minIncrementChars，默认 20）：已有标题时，本轮**新增**人类消息
 *      合计字符数 < 阈值 → 不重生成（保留旧标题），避免短噪声驱动重写。
 * 回归：_test/test-self-schedule.mjs §[6]（门槛 / 锚 / 重启复现 / 长上下文不退化）。
 * 取舍：短消息轮不再刷新标题（例如只发「好」）——旧标题仍准确，且避免噪声驱动；要退回旧行为
 *   把 minIncrementChars 设为 0。
 *
 * ── 回合边界自动状态前缀（2026-09-11 加）──────────────────────────────
 * 背景：「干活写【运行】、收尾写【完成】」这类状态前缀，若只靠 agent 自觉去写，
 * 实测绝大多数会话都没有标记（靠自觉 = 大概率漏）。这里把它
 * 做成回合边界的自动行为，不再依赖自觉：
 *
 *   turn/start → 标题置 【运行】xxx
 *   turn/end   → 标题置 【完成】xxx
 *   session/title（provider 刚写完新标题、无前缀）→ 按当前回合状态补前缀
 *   session/disposed → 清掉内存状态表
 *
 * 写回姿势：用 session.append('session/title', { source: { kind: 'provider' } })
 * **绝不用 sessionTitle.rename()** —— rename 写 source=user，会把标题 pin 住，
 * 官方/本插件的自动标题从此不再调度（GUI 里标题就永远停在那一版）。
 * 用 provider source 追加则只覆盖"最后一条 title"的显示值，自动生成照旧。
 *
 * 内存状态表 sessionId → { state, pinned } 用于对账：provider 的标题是异步
 * LLM 生成，常常在 turn/end 之后才写回来，那时按当前 state 补前缀才对得上。
 *
 * 边界：子代理会话跳过（header.parentSession / origin === 'subagent'）；
 * source=user（人工改名）→ 该会话此后不再自动打标；无标题跳过；基名按
 * markBaseBudgetBytes（默认 64）裁剪，加上 12 字节前缀不超过主包
 * maxTitleBytes（默认 80）。
 *
 * ── 配置 ───────────────────────────────────────────────────────────────
 * 三层合并：lib/config.js 的默认值 ← `SESSION_TITLE_LIVE_CONFIG` 指向的 JSON ←
 * 宿主 `cordis.patch.yml` 里该插件 insert 项的 `config:`（后者覆盖前者）。
 * 全部键与默认值见 lib/config.js 的 DEFAULT_CONFIG 与
 * examples/session-title-live.config.example.json（README 有逐项说明）。
 * 目录解析（home）走 `SESSION_TITLE_LIVE_HOME` > `DSH_HOME` > `~/.dsh`，无机器路径硬编码。
 */
import fs from 'node:fs';
import path from 'node:path';
// 主包协议常量（事件名 / 服务名）集中在 lib/host-protocol.js：
// 刻意内联而不 import @deepseek-ai/* 包 —— 插件在 profile 侧解析不到那些包。
import { EV, SVC, isTurnStart } from './host-protocol.js';
import { DEFAULT_CONFIG, DEFAULT_MARKS, resolveConfig, resolveHome, describeConfig } from './config.js';

export const name = 'dsh-session-title-live';
export const inject = [SVC.sessionTitle, SVC.llm, SVC.sessions];

/** 最小信息门槛默认值（字符数；0 = 关闭门槛）。见 planTitleInput 段注释。 */
export const DEFAULT_MIN_INCREMENT_CHARS = DEFAULT_CONFIG.minIncrementChars;

// ── 活开关（kill switch）───────────────────────────────────────────────
// 为什么有这一段：本插件原先**只在加载时读一次 config**，想停掉打标 / 停止烧 token
//   只能改宿主配置或重启；现在每次**回合事件 / 生成请求**都现读开关，于是"出问题直接
//   关掉"对标题插件也成立（关掉后零写入、零 token）。
//
// 真相源 = 一个 JSON 开关文件（默认 `<home>/dsh-session-title-live.json`，可配绝对路径）：
//   `{ "modules": { "session-title-live": { "enabled": false, "why": "…" } } }`
//   也支持顶层简写 `{ "enabled": false }`；`enabled:true` = 开。
//   若你已经有别的自治 / 熔断文件（结构相同），把 `killSwitch.file` 指过去即可。
// 读盘走 **cacheMs 时窗缓存**（默认 3s）→ 手改文件 ≤3s 生效，**不必重启宿主**。
//
// fail-safe 方向：读不到 / 损坏 / 没有该模块键 → **保持现状（= 继续工作）**。理由：开关是
//   "显式拨的闸"，读不到 ≠ 要求关闭；本插件是既有能力，配置坏了不该把它静默关掉。
//   只有**显式写进文件的 enabled:false**（可带 since/by/why）才真停。
//   另有环境变量 `SESSION_TITLE_LIVE_DISABLED=1` = 立即停（容器 / CI 用，优先于文件）。
export const KILL_SWITCH_CACHE_MS = DEFAULT_CONFIG.killSwitch.cacheMs;
export const KILL_SWITCH_MODULE_ID = DEFAULT_CONFIG.killSwitch.moduleId;
export const KILL_SWITCH_FILE = DEFAULT_CONFIG.killSwitch.file;
/** 恢复提示（打进错误信息，排障时一眼能照抄）。 */
export const KILL_SWITCH_RESUME_HINT = DEFAULT_CONFIG.killSwitch.resumeHint;

let killCache = { at: 0, file: null, value: null };

/** 环境变量是否显式要求关闭（`SESSION_TITLE_LIVE_DISABLED=1|true|yes|on`）。 */
export function killSwitchEnvDisabled(env = process.env) {
  const v = String(env.SESSION_TITLE_LIVE_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * 开关文件绝对路径。
 * home 解析：显式 `opts.home` > `SESSION_TITLE_LIVE_HOME` > `DSH_HOME` > `~/.dsh`；
 * `opts.file` 是绝对路径时直接用它。
 */
export function killSwitchPath(opts = {}) {
  const file = opts.file ?? KILL_SWITCH_FILE;
  if (path.isAbsolute(file)) return file;
  return path.join(resolveHome({ home: opts.home }), file);
}

/**
 * 纯解析（不碰 fs，便于单测）。
 * 两种形状都认：`{modules:{<moduleId>:{enabled:boolean, why?, by?, since?}}}` 与顶层 `{enabled:boolean}`。
 * @param {string} text 文件内容
 * @param {string} [moduleId] 模块键（默认 `session-title-live`）
 * @returns {{ok:boolean, reason:string, enabled:boolean, source:'file'|'baseline'|'fail-safe', by?:string|null, why?:string|null, since?:string|null}}
 */
export function parseKillSwitch(text, moduleId = KILL_SWITCH_MODULE_ID) {
  const keep = { enabled: true, source: 'fail-safe' };
  if (typeof text !== 'string' || !text.trim()) return { ...keep, ok: false, reason: 'file-empty' };
  let j;
  try { j = JSON.parse(text); } catch (e) { return { ...keep, ok: false, reason: `parse-error:${e?.message ?? e}` }; }
  if (!j || typeof j !== 'object') return { ...keep, ok: false, reason: 'file-not-object' };
  if (typeof j.enabled === 'boolean') {                       // 顶层简写
    return { ok: true, reason: 'ok', enabled: j.enabled, source: 'file', by: j.by ?? null, why: j.why ?? null, since: j.since ?? null };
  }
  if (j.schemaVersion !== undefined && Number(j.schemaVersion) !== 1) {
    return { ...keep, ok: false, reason: `schema-mismatch:${j.schemaVersion}` };
  }
  const cell = j.modules && typeof j.modules === 'object' ? j.modules[moduleId] : null;
  if (cell && typeof cell === 'object' && typeof cell.enabled === 'boolean') {
    return {
      ok: true, reason: 'ok', enabled: cell.enabled, source: 'file',
      by: cell.by ?? null, why: cell.why ?? null, since: cell.since ?? null,
    };
  }
  return { ok: true, reason: 'ok', enabled: true, source: 'baseline' }; // 文件里没这个键 = 现状（开）
}

/**
 * 读开关（**绝不抛**；≤`opts.cacheMs` 缓存命中直接返回）。
 * @param {object} [opts] 通常直接传 `cfg.killSwitch`（含 file / moduleId / cacheMs / home）。
 */
export function isTitleLiveEnabled(opts = {}) {
  const env = opts.env ?? process.env;
  if (opts.enabled === false) {
    return { ok: true, reason: 'explicit-off', enabled: false, source: 'config', file: null, by: 'config', why: null, since: null };
  }
  if (killSwitchEnvDisabled(env)) {
    return { ok: true, reason: 'env-disabled', enabled: false, source: 'env', file: null, by: 'env', why: null, since: null };
  }
  const file = killSwitchPath(opts);
  const now = Date.now();
  const ttl = opts.cacheMs ?? KILL_SWITCH_CACHE_MS;
  if (killCache.value && killCache.file === file && now - killCache.at < ttl) return killCache.value;
  let value;
  try {
    value = { ...parseKillSwitch(fs.readFileSync(file, 'utf8'), opts.moduleId ?? KILL_SWITCH_MODULE_ID), file };
  } catch (e) {
    value = { ok: false, reason: e?.code === 'ENOENT' ? 'file-missing' : `read-error:${e?.message ?? e}`, enabled: true, source: 'fail-safe', file };
  }
  killCache = { at: now, file, value };
  return value;
}

/** 清缓存（单测 / 需要立即重读时用）。 */
export function clearKillSwitchCache() { killCache = { at: 0, file: null, value: null }; }

/** 人类可读摘要（排障用）。 */
export function describeKillSwitch(opts = {}) {
  const r = isTitleLiveEnabled(opts);
  return {
    file: r.file, ok: r.ok, reason: r.reason, enabled: r.enabled === true,
    source: r.source, by: r.by ?? null, why: r.why ?? null, since: r.since ?? null,
  };
}

// ── 标题文本规范化（内联官方 normalizeSessionTitle 精简版）──────────────
const OSC_SEQUENCE = /(?:\u001B\]|\u009D)(?:(?!\u0007|\u001B\\)[\s\S])*(?:\u0007|\u001B\\|$)/gu;
const CSI_SEQUENCE = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu;
const ESC_SEQUENCE = /\u001B[@-_]/gu;
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
const DIRECTIONAL_CONTROL = /[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu;

function cleanTitleText(input) {
  return input
    .replace(OSC_SEQUENCE, '').replace(CSI_SEQUENCE, '').replace(ESC_SEQUENCE, '')
    .replace(CONTROL_CHARACTER, '').replace(DIRECTIONAL_CONTROL, '')
    .replace(/\s+/gu, ' ').trim();
}

function truncateUtf8(input, maxBytes) {
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input;
  let used = 0;
  let output = '';
  for (const ch of input) {
    const bytes = Buffer.byteLength(ch, 'utf8');
    if (used + bytes > maxBytes) break;
    output += ch;
    used += bytes;
  }
  return output;
}

function normalizeTitle(input, maxBytes) {
  return truncateUtf8(cleanTitleText(input), maxBytes).trimEnd();
}

// ── 回合边界状态前缀：纯函数（单测直接 import 这几个）──────────────────
// 文案字典来自配置（lib/config.js 的 DEFAULT_MARKS，可被 config.marks 覆盖）：
// 「用哪几个前缀、识别哪些前缀、兜底基名」属于使用环境的策略，不属于逻辑。
/** 默认：状态 → 前缀文本。 */
export const MARK_PREFIX = DEFAULT_MARKS.prefix;
/** 默认：前缀文本 → 状态。 */
export const MARK_TEXT_TO_STATE = DEFAULT_MARKS.textToState;
/** 默认基名兜底：标题只剩前缀时用它。 */
export const MARK_BASE_FALLBACK = DEFAULT_MARKS.baseFallback;

/**
 * 识别表：把「前缀字面 → 状态」摊平成一张可匹配的表（按字典对象缓存）。
 * 两个来源合并，长前缀优先（避免互相截断）：
 *   · `textToState` 的键（**无括号的纯文本**，自动包 `【】`）—— 识别历史 / 外部脚本写的【…】前缀；
 *   · `prefix` 的**字面值**（原样）—— 识别本插件自己写出去的前缀。
 * 为什么必须两个来源都收：只要认 textToState，把 prefix 改成别的形状（例如 `[RUN]`）之后，
 * 自己刚写的前缀就认不出来 → 下一轮会在基名前面**再叠一层**（实测踩过）。
 */
const markTableCache = new WeakMap();
export function markTableOf(marks = DEFAULT_MARKS) {
  let table = markTableCache.get(marks);
  if (table === undefined) {
    const pairs = [];
    for (const [text, state] of Object.entries(marks?.textToState ?? DEFAULT_MARKS.textToState)) {
      if (typeof text === 'string' && text !== '' && typeof state === 'string' && state !== '') pairs.push([`【${text}】`, state]);
    }
    for (const [state, prefix] of Object.entries(marks?.prefix ?? DEFAULT_MARKS.prefix)) {
      if (typeof prefix === 'string' && prefix !== '') pairs.push([prefix, state]);
    }
    const map = new Map(pairs);
    const ordered = [...map.entries()].sort((a, b) => b[0].length - a[0].length);
    table = {
      map,
      // 空表 → 永不匹配（任何标题都不带前缀）；否则拼成非捕获分组，无 g 标志（exec 不带 lastIndex 状态）
      re: ordered.length === 0
        ? /(?!)/
        : new RegExp(`^(?:${ordered.map(([prefix]) => prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*`),
    };
    markTableCache.set(marks, table);
  }
  return table;
}

/** 前缀正则（{@link markTableOf} 的匹配部分）。 */
export function markReOf(marks = DEFAULT_MARKS) {
  return markTableOf(marks).re;
}
/** 默认字典的前缀正则。 */
export const MARK_RE = markReOf(DEFAULT_MARKS);

/** 去掉标题上的状态前缀，返回基名。 */
export function stripTitleMark(title, marks = DEFAULT_MARKS) {
  return typeof title === 'string' ? title.replace(markReOf(marks), '').trim() : '';
}

/** 读标题上的状态前缀，无前缀返回 null。 */
export function titleMarkState(title, marks = DEFAULT_MARKS) {
  if (typeof title !== 'string') return null;
  const table = markTableOf(marks);
  const match = table.re.exec(title);
  if (match === null) return null;
  const raw = match[0];
  return table.map.get(raw) ?? table.map.get(raw.trim()) ?? null;
}

/** 生成带指定状态前缀的标题（基名按字节预算裁剪；纯函数）。 */
export function computeMarkedTitle(title, state, budgetBytes, marks = DEFAULT_MARKS) {
  const prefix = marks?.prefix?.[state];
  if (prefix === undefined) throw new Error(`dsh-session-title-live: unknown mark state "${String(state)}"`);
  const base = truncateUtf8(stripTitleMark(title, marks), budgetBytes) || marks.baseFallback;
  return `${prefix}${base}`;
}

/** 子代理会话判定：有父会话或 origin=subagent 即跳过。 */
export function isSubagentSession(session) {
  const header = session?.header;
  if (header === undefined || header === null) return false;
  return header.origin === 'subagent' || header.parentSession !== undefined;
}

// ── 人类消息文本（与主包 collectSessionTitleMessages 同口径：source.kind==='user'）──
/**
 * 取一条 user/message 事件的人类正文；非人类来源或规范化后为空 → null。
 * @param {object} event - session/event 里的 user/message 事件。
 * @param {number} maxBytes - 规范化文本的字节上限（用于判空/裁剪）。
 * @returns {string|null}
 */
export function humanTextOf(event, maxBytes = Number.MAX_SAFE_INTEGER) {
  const data = event?.data;
  if (data === undefined || data?.source?.kind !== 'user') return null;
  const content = Array.isArray(data.content) ? data.content : [];
  const text = content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n');
  return normalizeTitle(text, maxBytes).length === 0 ? null : text;
}

// ── 自建调度（方案 A）：状态机 + 触发判定 + 定时器装载 ──────────────────
/**
 * 自调度状态机：与 dsh 无关，可在沙箱/单测里直接驱动。
 * 语义：
 *   noteHuman(seq)    记下新人类消息（capped 环形保留 prompt）
 *   matchesSource(ev) 该 session/title 事件是否覆盖了 throughSeq（去重判据）
 *   onMainRequest()   一次 agent 主请求；命中则安排一次生成，返回 done Promise
 *   onProviderDone()  生成收尾；期间若又来人类消息 → 自动再排一轮（只保最新）
 *
 * @param {object} deps
 * @param {() => number} deps.now 时间源（ms）
 * @param {number} [deps.maxHumans] prompt 环形上限
 * @param {() => object} deps.getState 取当前 view 状态（events/providerId）
 * @param {(view:object, u:object) => void} deps.log
 * @param {(u:object) => Promise<void>} deps.generate 真正干活的生成回调
 * @param {(session:object) => boolean} [deps.isPinned] 人工改名（pin）判定 —— **收口①**：
 *        为 true 时不再重生成基名（与打标路径共用同一份账本，见 createPinLedger）
 * @param {(n:number) => void} [deps.onError]
 */
export function createSelfScheduler(deps) {
  const maxHumans = Math.max(1, deps.maxHumans ?? 32);
  const sessions = new Map();
  let scheduled = 0; let deduped = 0; let errors = 0; let pinnedSkip = 0;

  const stateOf = (session) => {
    let st = sessions.get(session);
    if (st === undefined) {
      st = { lastHumanSeq: 0, humans: [], generatedSeq: 0, inFlight: false, scheduled: false };
      sessions.set(session, st);
    }
    return st;
  };

  const noteHuman = (session, text, seq) => {
    const st = stateOf(session);
    st.humans.push({ seq, text });
    if (st.humans.length > maxHumans) st.humans.splice(0, st.humans.length - maxHumans);
    st.lastHumanSeq = Math.max(st.lastHumanSeq, seq);
  };

  const matchesSource = (session, throughSeq, event) => {
    const src = event?.data?.source;
    if (src?.kind !== 'provider') return false;
    const id = String(src.provider ?? '');
    const base = id.endsWith('#turn-mark') ? id.slice(0, -'#turn-mark'.length) : id;
    if (base !== deps.getState(session).providerId) return false;
    const seqs = Array.isArray(event?.data?.messageSeqs) ? event.data.messageSeqs : [];
    return seqs.length > 0 ? seqs.at(-1) === throughSeq : event.seq > throughSeq;
  };

  /** 有没有「seq 比当前人类消息更新」的 provider 标题（= 已处理过） */
  const hasNewerProviderTitle = (session, lastHumanSeq) => {
    const events = deps.getState(session).events ?? [];
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e?.type !== EV.SESSION_TITLE) continue;
      if (e.data?.source?.kind !== 'provider') continue;
      const seqs = Array.isArray(e.data.messageSeqs) ? e.data.messageSeqs : [];
      if (seqs.length > 0 && seqs.at(-1) >= lastHumanSeq) return true;
    }
    return false;
  };

  /**
   * 收口②·事件流对账：本轮是否**已有别的通路**发出生成请求（GENREQ）。
   * 判据 = 存在 `session/title-llm-request` 且其 `messageSeqs` 末项 ≥ 本轮人类 seq，
   * 且该请求不是自调度自己写的（`scheduler !== 'self'`，历史事件无该字段 → 视为主包通路）。
   * 这一条拦的是「主包通路已发起、标题还没写回来」的窗口 —— 与轮次认领（claimRound）互补：
   * 认领管同进程内的抢先占位，本判据管已落盘的事实。
   */
  const hasOtherSchedulerRequest = (session, throughSeq) => {
    const events = deps.getState(session).events ?? [];
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e?.type !== EV.SESSION_TITLE_LLM_REQUEST) continue;
      if (e.data?.scheduler === 'self') continue;
      const seqs = Array.isArray(e.data?.messageSeqs) ? e.data.messageSeqs : [];
      const last = seqs.length > 0 ? seqs.at(-1) : undefined;
      if (typeof last === 'number' && last >= throughSeq) return true;
    }
    return false;
  };

  const runGenerate = (session, view, st, throughSeq) => {
    const picked = st.humans.filter((h) => h.seq <= throughSeq);
    const hs = picked.length > 0 ? picked : st.humans;
    st.inFlight = true;
    return Promise.resolve()
      .then(() => deps.generate(view, {
        session,
        throughSeq,
        messages: hs.map((h) => ({ seq: h.seq, text: h.text })),
      }))
      .then(() => { st.generatedSeq = throughSeq; })
      .catch((error) => {
        errors += 1;
        // 失败也推进到该 seq：否则本轮会被反复重试（LLM 失败往往是持续性的），
        // 下一个新人类消息会自然再触发一次。这与主包「失败保留旧标题、不重试」的口径一致。
        st.generatedSeq = Math.max(st.generatedSeq, throughSeq);
        deps.log(view, { kind: 'error', error, throughSeq });
      })
      .then(() => { st.inFlight = false; return onProviderDone(session); });
  };

  const scheduleGenerate = (session, view, st) => {
    if (st.scheduled) return undefined;   // 同 tick 已排过（无动作统一返回 undefined）
    st.scheduled = true;
    scheduled += 1;
    const throughSeq = st.lastHumanSeq;
    return Promise.resolve().then(() => { st.scheduled = false; return runGenerate(session, view, st, throughSeq); });
  };

  /** 生成收尾：期间有新人类消息就再排一轮（只保最新，不并发） */
  const onProviderDone = (session) => {
    const st = stateOf(session);
    if (st.inFlight || st.lastHumanSeq <= st.generatedSeq) return undefined;
    const view = deps.getState(session);
    if (view?.events === undefined) return undefined;
    return scheduleGenerate(session, view, st);
  };

  /** 一次 agent 主请求；返回 Promise（无动作时 undefined） */
  const onMainRequest = (session) => {
    const view = deps.getState(session);
    const st = stateOf(session);
    if (st.inFlight) return undefined;                                  // 在途：等它收尾时再评估
    if (st.lastHumanSeq <= 0 || st.lastHumanSeq <= st.generatedSeq) return undefined; // 无新人类消息
    // 【收口①】人工改名（pin）之后不再重生成基名 —— 与打标路径共用同一份 pin 账本。
    //   放在最前：pin 的会话连事件扫描都不做（每轮 llm/stream 都会走到这里，省一点是一点）。
    if (deps.isPinned?.(session) === true) { pinnedSkip += 1; return undefined; }
    if (hasNewerProviderTitle(session, st.lastHumanSeq)) { deduped += 1; return undefined; } // 主包已处理该 seq
    // 【收口②】本轮已有别家 GENREQ（主包通路已发起、标题未回）→ 不重复发一条
    if (hasOtherSchedulerRequest(session, st.lastHumanSeq)) { deduped += 1; return undefined; }
    return scheduleGenerate(session, view, st);
  };

  return {
    sessions,
    noteHuman,
    onMainRequest,
    onProviderDone,
    matchesSource,
    hasNewerProviderTitle,
    hasOtherSchedulerRequest,
    stats: () => ({ scheduled, deduped, errors, pinnedSkip, sessions: sessions.size }),
    forget: (session) => { sessions.delete(session); },
  };
}

const SELF_SCHED = Symbol('dsh-session-title-live.selfSched');
const LAST_ROUTE = Symbol('dsh-session-title-live.lastRoute');

/**
 * 装载自调度：事件订阅 + llm/stream 钩子。
 * 与主包 register 并存——register 仍满足 `session-title` 服务的注册要求与 fallback 逻辑。
 * @param {object} ctx
 * @param {object} cfg
 * @param {{buildOptions: (arg:object) => object}} deps 生成入口（复用 apply 内的同一份实现）
 */
export function installSelfScheduling(ctx, cfg, deps) {
  const sched = createSelfScheduler({
    getState: (session) => ({ events: deps.events(session), providerId: 'dsh-session-title-live' }),
    now: () => Date.now(),
    maxHumans: cfg.selfScheduleMaxHumans,
    log: (view, u) => {
      if (u.kind === 'error') ctx.logger?.warn?.(`[dsh-session-title-live] 自调度生成失败（ignored）: ${String(u.error)}`);
    },
    // 收口①：pin 判定与打标路径共用同一份账本（人工改名后不再重生成基名）
    isPinned: (session) => deps.isPinned(session),
    generate: async (view, u) => {
      const ks = isTitleLiveEnabled(cfg.killSwitch);
      if (ks.enabled !== true) return;                       // 活开关：静默跳过（不烧 token）
      if (ctx.llm?.stream === undefined) {                   // 防御：llm 服务不可用时不抛进事件链
        ctx.logger?.warn?.('[dsh-session-title-live] ctx.llm.stream 不可用 → 跳过本轮自调度生成');
        return;
      }
      const session = u.session;
      // 【收口①】人工改名（pin）之后不再重生成基名。这里是最后一道闸（onMainRequest 已先拦一次），
      //   兜的是「认领/调度与真正生成之间发生了改名」。跳过走 resolve（不是 throw）→
      //   generatedSeq 照常推进到本轮 seq，此后不再为这一轮反复触发。
      if (deps.isPinned(session)) {
        ctx.logger?.debug?.(`[dsh-session-title-live] 会话已被人工改名（pin）→ 自调度跳过本轮重生成（seq=${u.throughSeq}）`);
        return;
      }
      // 【收口②】轮次认领：一条人类消息最多一条 GENREQ。拿到不到就静默退出
      //   （不写 title-llm-request、不调 LLM = 不烧 token），让先认领的那条通路去写标题。
      if (deps.claimRound(session, u.throughSeq, 'self') === false) {
        ctx.logger?.debug?.(`[dsh-session-title-live] 本轮（seq=${u.throughSeq}）已由主包通路认领 → 自调度跳过（去重）`);
        return;
      }
      const route = session[LAST_ROUTE];
      // 【小样本幻觉收口】选材不再依赖内存累积的 st.humans（实例重建会丢，见 planTitleInput 段根因），
      //   改从**持久事件流**取人类消息 + **主题锚**（上一版标题依据）；st.humans 只在事件流取不到时兜底。
      const events = deps.events(session);
      const fromEvents = collectHumanMessages(events, u.throughSeq);
      const humans = fromEvents.length > 0 ? fromEvents : u.messages.map(toMessageEntry);
      const currentTitle = ctx.sessionTitle.get(session)?.title;
      const plan = planTitleInput({
        humans,
        anchorSeqs: lastTitleMessageSeqs(events),
        lastCovered: lastCoveredSeq(events),
        hasExistingTitle: typeof currentTitle === 'string' && currentTitle.length > 0,
        maxInputBytes: cfg.maxInputBytes,
        minIncrementChars: cfg.minIncrementChars,
        anchorMax: cfg.themeAnchorMax,
      });
      if (plan.skip) {
        // 静默跳过：不写 GENREQ、不调 LLM（不烧 token）。generatedSeq 照常推进（runGenerate 收尾），
        // 该 seq 不会被反复重试；后续长消息到来时增量仍会累计（lastCovered 取自事件流）。
        ctx.logger?.debug?.(`[dsh-session-title-live] 本轮新增人类消息仅 ${plan.incrementChars} 字（< ${cfg.minIncrementChars}）→ 保留旧标题（最小信息门槛，seq=${u.throughSeq}）`);
        return;
      }
      const selected = plan.selected;
      const framed = `${cfg.promptIntro}\n${JSON.stringify(selected.map((m) => m.text))}`;
      const messages = [{
        role: 'user',
        id: crypto.randomUUID(),
        content: [{ type: 'text', text: framed }],
        source: { kind: 'plugin', plugin: 'dsh-session-title-live' },
      }];
      const signal = AbortSignal.any([AbortSignal.timeout(cfg.timeoutMs)]);
      const options = Object.freeze({
        provider: route?.provider ?? cfg.provider,
        model: route?.model ?? cfg.model,
        messages,
        system: systemPrompt(cfg),
        maxTokens: cfg.maxOutputTokens,
        sessionId: session.id,
        purpose: 'session-title',                              // ← 自递归护栏：钩子按此排除
        signal,
      });
      if (options.provider === undefined || options.model === undefined) {
        ctx.logger?.warn?.('[dsh-session-title-live] 自调度缺路由（无 request/header 且未配置 provider/model）→ 跳过本轮');
        return;
      }
      session.append(EV.SESSION_TITLE_LLM_REQUEST, {
        titleProvider: 'dsh-session-title-live',
        scheduler: 'self',                                     // 来源标记：收口②的去重对账按它区分通路
        messageSeqs: selected.map((m) => m.seq),
        route: { provider: options.provider, model: options.model },
        system: systemPrompt(cfg),
        messages,
        maxTokens: cfg.maxOutputTokens,
      });
      let text = '';
      let finish = null;
      for await (const chunk of ctx.llm.stream(options)) {
        if (chunk.type === 'text-delta') text += chunk.text;
        else if (chunk.type === 'finish') finish = chunk.reason;
      }
      const terminal = finishError(finish);
      if (terminal !== null) throw terminal;
      const title = normalizeTitle(text, cfg.maxTitleBytes);
      if (title.length === 0) throw new Error('dsh-session-title-live: title model produced no text');
      session.append(EV.SESSION_TITLE, {
        title,
        messageSeqs: selected.map((m) => m.seq),
        source: { kind: 'provider', provider: 'dsh-session-title-live' },
      });
    },
  });

  ctx.on(EV.SESSION_EVENT, (session, event) => {
    if (session === undefined || event === undefined) return;
    if (isSubagentSession(session)) return;
    if (event.type === EV.USER_MESSAGE) {
      const text = humanTextOf(event);
      if (text === null) return;                             // 空消息/非人类来源不计
      sched.noteHuman(session, text, event.seq);
      return;
    }
    if (event.type === EV.SESSION_TITLE) {
      // 去重不用在这里记：onMainRequest 每次都以事件流里「最新的 provider 标题 messageSeqs」
      // 为准判断该 seq 是否已处理（hasNewerProviderTitle），主包通路或自己写过的都算。
      // 人工改名（source=user）的解码：pin 判定与打标路径共用 pin 账本（收口①）。
      return;
    }
    if (event.type === EV.REQUEST_HEADER) {
      const config = event.data?.header?.config;
      if (config !== undefined) session[LAST_ROUTE] = { provider: config.provider, model: config.model };
      return;
    }
  });

  // ⚠️ 契约（2026-09-14 真实实例实测教训）：主包的 `llm/stream` 是 **waterfall**，不是普通事件——
  //    dsh-llm: `return this.ctx.waterfall(this, "llm/stream", options, () => this.adapterStream(options, prepared))`
  //    官方监听器一律写成 `(options, next) => ... return next()`（见 dsh-llm/lib/invariant.js、dsh-session-title/lib/index.js）。
  //    **裸 `return;` 会把 waterfall 的结果变成 undefined** → 调用方 `for await (const c of llm.stream(...))`
  //    当场抛 `Cannot read properties of undefined (reading 'Symbol(Symbol.asyncIterator)')`，
  //    主请求整回合 error（首轮就崩）。所以下面的早退分支也一律 `return next()`，绝不裸 return。
  //    为什么离线单测没抓住：mock 的 `ctx.llm.stream` 是普通异步生成器、`ctx.on` 直接调用监听器，
  //    契约与真机不同 —— 见 _test/test-waterfall-contract.mjs（补的这条护栏）。
  ctx.on('llm/stream', (options, next) => {
    try {
      const skip = options?.purpose === 'session-title'        // 防自递归（也是主包自己的标记）
        || options?.sessionId === undefined
        || isTitleLiveEnabled(cfg.killSwitch).enabled !== true; // 活开关关闭 → 零动作
      if (!skip) {
        const session = ctx.sessions.get(options.sessionId);
        if (session !== undefined && !isSubagentSession(session)) void sched.onMainRequest(session);
      }
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-session-title-live] 自调度触发失败（ignored）: ${String(error)}`);
    }
    return next();
  }, { global: true, prepend: true });

  ctx.on('session/disposed', (session) => { if (session !== undefined) sched.forget(session); });

  ctx.logger?.info?.(`[dsh-session-title-live] 自调度已启用（selfSchedule=true, maxHumans=${cfg.selfScheduleMaxHumans}）`);
  return sched;
}

// ── 消息选择：主题锚 + 最小信息门槛（2026-09-17 小样本幻觉修复）──────────
// 根因（事件级证据）：
//   自调度通路的选材来自**插件实例内存**里累积的人类消息（createSelfScheduler 的 st.humans）——
//   实例在重启/热重载后重建，窗口骤缩成「重启后这几条」，且不含会话首条消息（主题锚）：
//     seq 61070（service，6 条含首条）→ 标题命中会话主题 ✔
//     seq 79490（self，2 条短消息共 5 字）→ 标题与会话主题无关 ✘
// 两条收口（方案 C = A+B）：
//   ① **主题锚 + 持久窗口**：人类消息改从 `session.events`（持久、含 seed 全量历史）取，
//      并把「上一版标题的依据」（`messageSeqs` → 文本）作为**主题锚**优先纳入选材；
//      锚与最近消息都在字节预算内收拢，预算不足时先裁最近消息、保锚。
//   ② **最小信息门槛**：已有标题时，本轮**新增**人类消息合计字数 < minIncrementChars
//      （默认 20）→ 不重生成（保留旧标题），避免「B吧 / 回来了」这类短噪声驱动重写。
// 兼容两种入参形状：主包 generate 契约给 {seq, text}；自调度同样给 {seq, text}。
// 统一归一成 {seq, text}（seq 可为 undefined），保证下游 messageSeqs / JSON 序列化一致。
function toMessageEntry(m) {
  if (typeof m === 'string') return { seq: undefined, text: m };
  return { seq: m?.seq, text: typeof m?.text === 'string' ? m.text : '' };
}

/**
 * 从会话事件流取人类消息（`source.kind==='user'`、seq ≤ throughSeq），按 seq 升序。
 * 为什么不用内存累积：见上方根因 —— 实例重建后内存态会丢，事件流不会。
 * @param {object[]} events - session.events
 * @param {number} [throughSeq] - 只取 seq ≤ 该值的人类消息（默认全部）
 * @returns {{seq:number, text:string}[]}
 */
export function collectHumanMessages(events, throughSeq = Number.POSITIVE_INFINITY) {
  const out = [];
  for (const e of Array.isArray(events) ? events : []) {
    if (e?.type !== EV.USER_MESSAGE) continue;
    if (typeof e.seq !== 'number' || e.seq > throughSeq) continue;
    const text = humanTextOf(e);
    if (text === null) continue;
    out.push({ seq: e.seq, text });
  }
  return out;
}

/**
 * 最后一版 provider 标题的依据 seq（`messageSeqs`）。
 * 含 `#turn-mark` 标题：它写的是「当前 folded 标题」的依据副本，正是主题锚的来源。
 * @returns {number[]}
 */
export function lastTitleMessageSeqs(events) {
  const list = Array.isArray(events) ? events : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (e?.type !== EV.SESSION_TITLE) continue;
    if (e.data?.source?.kind !== 'provider') continue;
    const seqs = Array.isArray(e.data?.messageSeqs) ? e.data.messageSeqs.filter((s) => typeof s === 'number') : [];
    if (seqs.length > 0) return seqs;
  }
  return [];
}

/** 上一版标题已覆盖到的人类 seq（`messageSeqs` 最大项）；0 = 还没生成过标题。 */
export function lastCoveredSeq(events) {
  const seqs = lastTitleMessageSeqs(events);
  return seqs.length > 0 ? Math.max(...seqs) : 0;
}

/**
 * 生成前的统一规划（两条通路共用）：最小信息门槛 → 主题锚 → 预算内选材。**纯函数**。
 * @param {object} opts
 * @param {{seq:number|undefined,text:string}[]} opts.humans 候选人类消息（升序）
 * @param {number[]} [opts.anchorSeqs] 主题锚来源（上一版标题的 messageSeqs）
 * @param {number} [opts.lastCovered] 上一版标题覆盖到的人类 seq
 * @param {boolean} [opts.hasExistingTitle] 是否已有标题（门槛只在有旧标题时生效）
 * @param {number} [opts.maxInputBytes] 字节预算
 * @param {number} [opts.minIncrementChars] 最小新增信息量（字符；0 = 关）
 * @param {number} [opts.anchorMax] 主题锚最多保留几条（0 = 关闭锚）
 * @returns {{skip:boolean, reason:string|null, selected:{seq:number|undefined,text:string}[],
 *   anchorSeqs:number[], incrementSeqs:number[], incrementChars:number, totalChars:number}}
 */
export function planTitleInput(opts) {
  const raw = Array.isArray(opts?.humans) ? opts.humans : [];
  const humans = [];
  for (const m of raw) {
    const entry = toMessageEntry(m);
    if (entry.text.trim().length === 0) continue;
    humans.push({ ...entry, ord: humans.length });
  }
  if (humans.length === 0) throw new Error('dsh-session-title-live: at least one human message is required');

  const budget = Math.max(256, (opts?.maxInputBytes ?? DEFAULT_CONFIG.maxInputBytes) - 512); // 留 JSON 包裹/转义余量
  const lastCovered = typeof opts?.lastCovered === 'number' ? opts.lastCovered : 0;
  const minIncrementChars = opts?.minIncrementChars ?? DEFAULT_MIN_INCREMENT_CHARS;
  const anchorMax = opts?.anchorMax ?? DEFAULT_CONFIG.themeAnchorMax;

  // ① 最小信息门槛：已有标题 + 本轮新增太薄 → 保留旧标题（不调 LLM）
  const increment = humans.filter((m) => typeof m.seq === 'number' && m.seq > lastCovered);
  const incrementChars = increment.reduce((sum, m) => sum + [...m.text].length, 0);
  if (opts?.hasExistingTitle === true && minIncrementChars > 0
    && increment.length > 0 && incrementChars < minIncrementChars) {
    return {
      skip: true, reason: 'thin-increment', selected: [], anchorSeqs: [],
      incrementSeqs: increment.map((m) => m.seq), incrementChars, totalChars: 0,
    };
  }

  // ② 主题锚：上一版标题的依据消息（能对上人类消息的 seq）**恒定并上会话首条人类消息**——
  //    后者是"会话到底在讲什么"的最硬锚点；即使中间某一版标题的依据退化了（例如历史遗留的
  //    漂移标题），锚里也总有首条兜住主题。没有历史依据时退回首条本身。
  const bySeq = new Map();
  for (const m of humans) if (typeof m.seq === 'number') bySeq.set(m.seq, m);
  let anchor = [];
  if (anchorMax > 0) {
    for (const s of Array.isArray(opts?.anchorSeqs) ? opts.anchorSeqs : []) {
      const m = bySeq.get(s);
      if (m !== undefined) anchor.push(m);
    }
    anchor = anchor.slice(-anchorMax);
    const first = typeof humans[0].seq === 'number' ? humans[0] : null;
    if (first !== null && !anchor.some((m) => m.seq === first.seq)) anchor = [first, ...anchor];
    if (anchor.length === 0) anchor = [humans[0]];
  }

  // ③ 选材：锚优先（占预算一半，从新到旧），最近消息再把剩余预算填满；按 ord 输出保证升序
  const taken = new Map(); // ord → {seq, text}
  let total = 0;
  const anchorBudget = Math.floor(budget / 2);
  let anchorUsed = 0;
  for (const m of [...anchor].reverse()) {
    const text = truncateUtf8(m.text, Math.max(64, anchorBudget - anchorUsed));
    const bytes = Buffer.byteLength(JSON.stringify(text), 'utf8');
    if (anchorUsed + bytes > anchorBudget && taken.size > 0) break;
    taken.set(m.ord, { seq: m.seq, text });
    anchorUsed += bytes; total += bytes;
  }
  for (let i = humans.length - 1; i >= 0; i--) {
    const m = humans[i];
    if (taken.has(m.ord)) continue;
    const text = truncateUtf8(m.text, Math.max(64, budget - total));
    const bytes = Buffer.byteLength(JSON.stringify(text), 'utf8');
    if (taken.size > 0 && total + bytes > budget) break;
    taken.set(m.ord, { seq: m.seq, text });
    total += bytes;
    if (total >= budget) break;
  }
  const selected = [...taken.entries()].sort((a, b) => a[0] - b[0]).map(([, entry]) => entry);
  return {
    skip: false, reason: null, selected,
    anchorSeqs: anchor.map((m) => m.seq).filter((s) => typeof s === 'number'),
    incrementSeqs: increment.map((m) => m.seq),
    incrementChars,
    totalChars: selected.reduce((sum, m) => sum + [...m.text].length, 0),
  };
}

// ── system prompt：内置默认 + 可被 config.systemPrompt 整体覆盖 ──────────
function systemPrompt(cfg) {
  if (cfg.systemPrompt !== undefined) {
    return Array.isArray(cfg.systemPrompt) ? cfg.systemPrompt.join('\n') : String(cfg.systemPrompt);
  }
  return [
    'Create a concise title for an AI coding-assistant session from the supplied human messages.',
    'Summarize the overall topic of the supplied messages as a whole, not just the first one.',
    'Return only the title on one line, **in plain text of natural language**, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.',
    'Use the language of the messages.',
    `Aim for about ${cfg.targetWords} words in non-CJK languages or ${cfg.targetCjkCharacters} CJK characters.`,
  ].join('\n');
}

function finishError(finish) {
  switch (finish.kind) {
    case 'stop':
      return null;
    case 'error':
    case 'aborted':
      return new Error(finish.failure?.message ?? 'dsh-session-title-live: title stream aborted');
    case 'max-tokens':
      return new Error('dsh-session-title-live: title output reached maxOutputTokens');
    case 'tool-calls':
      return new Error('dsh-session-title-live: title model unexpectedly requested a tool');
    default:
      return new Error(`dsh-session-title-live: unsupported finish reason "${String(finish.kind)}"`);
  }
}

// ── pin 账本：打标路径与自调度路径共享的**同一份**判定（2026-09-14 收口①）──
/**
 * pin = 人工改名。判定口径与打标路径逐字一致（**不新增标记**）：
 *   · `session/title` 且 `source.kind==='user'`，且**早于第一个 turn/start** 的那条
 *     = 会话创建阶段写的（外部流程在第一个 turn/start **之前**预先写入的标题）
 *     → 记进 bootstrapSeq，**不算 pin**；否则这类会话会被永久跳过；
 *   · 同一会话里其余任何 `source.kind==='user'` 的标题（含当前 folded 标题指向它的）
 *     = 人工改名 → **pin**：此后既不再打标，**也不再由自调度重生成基名**。
 *
 * 为什么抽出来：实测归因（形状 E）发现自调度路径
 * **不读 pin**，会在用户手动改名后继续覆盖（语义反转）。两处读同一份账本即消除两套口径。
 * 状态表由 installPinTracking 的订阅维护，**与 turnMarks 开关无关**——即使关掉打标，
 * 自调度仍须尊重 pin。
 */
export function createPinLedger(ctx, marks = DEFAULT_MARKS) {
  const states = new Map();
  const stateFor = (session) => {
    let st = states.get(session.id);
    if (st === undefined) {
      // sawTurn：已见过本会话第一个 turn/start（区分"创建阶段的标题"与"人工改名"）
      // bootstrapSeq：创建阶段那条 user source 标题事件的 seq（任务卡发起的会话会有）
      st = { state: null, pinned: false, queued: false, sawTurn: false, bootstrapSeq: null, cardBase: null };
      states.set(session.id, st);
    }
    return st;
  };

  /** 事件入口：维护 sawTurn / bootstrapSeq / cardBase / pinned（pin 之后不再更新） */
  const noteEvent = (session, event) => {
    const st = stateFor(session);
    if (st.pinned) return st;
    if (isTurnStart(event.type)) { st.sawTurn = true; return st; }
    if (event.type !== EV.SESSION_TITLE || event.data?.source?.kind !== 'user') return st;
    if (st.sawTurn) { st.pinned = true; return st; }   // 回合中的人工改名 = pin
    st.bootstrapSeq = event.seq;                       // 创建阶段那条（任务卡标题）→ 不算 pin
    st.cardBase = stripTitleMark(event.data?.title, marks);
    return st;
  };

  /**
   * 该会话是否已被人工 pin。
   * 末尾那段兜底覆盖「订阅之前就已存在的人工标题」：当前 folded 标题是 user source
   * 且不是创建阶段那条 → pin（与打标路径原来的兜底判定同一口径）。
   */
  const isPinned = (session) => {
    const st = stateFor(session);
    if (st.pinned) return true;
    const current = ctx.sessionTitle.get(session);
    if (current?.source?.kind !== 'user') return false;
    if (st.bootstrapSeq === null || current.eventSeq !== st.bootstrapSeq) { st.pinned = true; return true; }
    return false;
  };

  return {
    states,
    stateFor,
    noteEvent,
    isPinned,
    forget: (session) => { if (session?.id !== undefined) states.delete(session.id); },
  };
}

/** 装 pin 跟踪订阅（打标与自调度共用的唯一状态维护点）。 */
function installPinTracking(ctx, ledger) {
  ctx.on(EV.SESSION_EVENT, (session, event) => {
    if (session === undefined || event === undefined) return;
    if (isSubagentSession(session)) return;
    ledger.noteEvent(session, event);
  });
  ctx.on('session/disposed', (session) => ledger.forget(session));
}

// ── 回合边界自动前缀：事件订阅 ─────────────────────────────────────────
/**
 * 装订阅：turn/start → 【运行】，turn/end → 【完成】，provider 写完新标题 →
 * 按当前状态补前缀，会话销毁 → 清状态表。
 * @param {object} ctx - cordis 上下文（已 inject sessionTitle / sessions）。
 * @param {object} cfg - 解析后的插件配置。
 */
function installTurnMarks(ctx, cfg, ledger) {
  const MARK_PROVIDER = cfg.markProvider;
  const marks = cfg.marks;                     // 前缀文案字典（可配置）
  // 状态对象（含 pin / sawTurn / bootstrapSeq / cardBase）由共享 pin 账本持有，
  // 本函数只读写其中的 state / queued 两个字段 —— 见 createPinLedger 的说明。
  const stateFor = (session) => ledger.stateFor(session);

  const warn = (message) => {
    try { ctx.logger?.debug?.(`[dsh-session-title-live] ${message}`); } catch { /* logging must never break marking */ }
  };

  /**
   * 打标主体：读当前 folded 标题 → 换算 → append 一条 provider source 的
   * session/title（绝不走 rename，避免 pin）。
   */
  let ksWarned = false; // 关闭状态只提示一次（防每回合刷日志）

  const applyMark = (session, st, reason) => {
    // 人工改名（pin）→ 不再打标。判定走共享账本（与自调度侧同一份口径，收口①）。
    if (ledger.isPinned(session)) return;
    if (st.state === null) return;
    // 【卡① 活开关】关掉即不再打标（≤3s 生效，无需重启 dsh）——放在取标题之前，
    //   关掉后本插件对会话事件**零写入**（不再 append session/title）
    const ks = isTitleLiveEnabled(cfg.killSwitch);
    if (ks.enabled !== true) {
      if (!ksWarned) {
        ksWarned = true;
        warn(`kill switch OFF（${ks.reason}${ks.why ? `；${ks.why}` : ''}）→ 暂停回合打标。恢复：${cfg.killSwitch.resumeHint}`);
      }
      return;
    }
    if (ksWarned) { ksWarned = false; warn('kill switch ON → 恢复回合打标'); }
    if (ctx.sessions.get(session.id) !== session) return; // 已 dispose / 非 live 会话
    const current = ctx.sessionTitle.get(session);
    const title = current?.title;
    if (typeof title !== 'string' || title.length === 0) return; // 还没有标题 → 跳过
    // 注：人工改名（source=user、且非创建期那条）的 pin 判定已由函数开头的 ledger.isPinned 拦下，
    //     原来写在这里的兜底段（st.bootstrapSeq / eventSeq 比较）已搬进 createPinLedger —— 口径不变。
    // 前缀已经是当前状态就收手（既覆盖"上一轮已标【运行】"的幂等，也避免多余事件）；
    // 状态变了（如 turn/end 的 running→done）则必须重写，哪怕标题正是我们上一轮标的。
    if (titleMarkState(title, marks) === st.state) return;
    // 预置标题的会话（创建阶段已写过标题）：基名固定用它，只换状态前缀——
    // 否则自动摘要会把预置标题顶掉，侧边栏就认不出是哪个任务的会话了。
    const next = (typeof st.cardBase === 'string' && st.cardBase.length > 0)
      ? `${marks.prefix[st.state]}${truncateUtf8(st.cardBase, cfg.markBaseBudgetBytes).trimEnd() || marks.baseFallback}`
      : computeMarkedTitle(title, st.state, cfg.markBaseBudgetBytes, marks);
    session.append(EV.SESSION_TITLE, {
      title: next,
      messageSeqs: [...(current.messageSeqs ?? [])],
      source: { kind: 'provider', provider: MARK_PROVIDER },
    });
    warn(`mark ${session.id} → ${next} (${reason})`);
  };

  /**
   * 微任务里打标：append 期间主包禁止重入 append（"session append cannot
   * reenter while another append is being published"），且同一 tick 的
   * 多个事件只落一次标（以最终 state 为准）。
   */
  const schedule = (session, st, reason) => {
    if (st.queued) return;
    st.queued = true;
    queueMicrotask(() => {
      st.queued = false;
      try {
        applyMark(session, st, reason);
      } catch (error) {
        warn(`mark failed for ${session?.id}: ${String(error)}`);
      }
    });
  };

  ctx.on(EV.SESSION_EVENT, (session, event) => {
    if (session === undefined || event === undefined) return;
    if (isSubagentSession(session)) return; // 子代理会话不标注
    // pin / sawTurn / bootstrapSeq / cardBase 的维护统一在 pin 跟踪订阅（installPinTracking，
    // 注册顺序早于本订阅）——这里只读，避免两处各写一套（收口①的单一真相源）。
    const st = stateFor(session);
    if (st.pinned) return;
    switch (event.type) {
      case EV.TURN_START:
        st.state = 'running';
        schedule(session, st, EV.TURN_START);
        return;
      case EV.TURN_END:
        st.state = 'done';
        schedule(session, st, EV.TURN_END);
        return;
      case EV.SESSION_TITLE: {
        const source = event.data?.source;
        // 人工改名（pin）与创建阶段卡标题（bootstrapSeq / cardBase）都在 pin 账本里处理；
        // 打标路径对 user 标题不做任何写回。
        if (source?.kind === 'user') return;
        if (source?.kind === 'provider' && source.provider === MARK_PROVIDER) return; // 自己写的，防回环
        if (st.state === null) return; // 还没开过回合（如历史会话重放）
        schedule(session, st, EV.SESSION_TITLE);
        return;
      }
      default:
        return;
    }
  });

  // 状态表的清理已由 pin 账本的 session/disposed 订阅负责（打标/自调度共用一份表）。

  warn(`turn-boundary title marks enabled (provider=${MARK_PROVIDER}, baseBudget=${cfg.markBaseBudgetBytes})`);
}

export function apply(ctx, config) {
  // 三层合并：默认值 ← 配置文件（SESSION_TITLE_LIVE_CONFIG）← 宿主 config。
  // 配置错误不静默：逐条 warn（缺参回落默认，不影响会话），一条日志即可定位。
  const { config: cfg, errors, source } = resolveConfig({ config });
  for (const message of errors) ctx.logger?.warn?.(`[dsh-session-title-live] 配置：${message}`);
  if (source !== null) ctx.logger?.info?.(`[dsh-session-title-live] 配置来源：${source}`);

  // ── 收口②·轮次认领账本：**一条人类消息最多一条 GENREQ** ───────────────────
  /**
   * 两条通路都会写 `session/title-llm-request`（生成请求）：
   *   · 主包服务通路（session-title 服务调用本插件 register 的 provider.generate）→ who='service'
   *   · 自调度通路（llm/stream 钩子触发）→ who='self'
   * 归因实测（形状 F）：同一轮两条通路都会发；
   * 标题观感无损，但**该轮多烧一次标题 token**，且两条内容可能不同、后写的胜出。
   * 于是让两条通路在**写 GENREQ / 调 LLM 之前**各认领一次：谁先认领谁赢，后者静默退出。
   * 判据 = 该请求覆盖的**最大人类消息 seq**（同一轮 = 同一 seq），不是选材条数。
   * 同一通路重复调用放行（不改变主包既有的内部重试语义）；会话销毁时清表。
   */
  const roundClaims = new Map();
  const claimRound = (session, throughSeq, who) => {
    if (session === undefined || typeof throughSeq !== 'number' || !Number.isFinite(throughSeq) || throughSeq <= 0) return true;
    const cur = roundClaims.get(session.id);
    if (cur !== undefined && cur.seq >= throughSeq) return cur.who === who;
    roundClaims.set(session.id, { seq: throughSeq, who, at: Date.now() });
    return true;
  };

  // ── 收口①·pin 账本：打标路径与自调度路径共用同一份状态（人工改名后双路都停重生成）──
  const ledger = createPinLedger(ctx, cfg.marks);
  installPinTracking(ctx, ledger);
  ctx.on('session/disposed', (session) => { if (session?.id !== undefined) roundClaims.delete(session.id); });

  ctx.sessionTitle.register({
    id: 'dsh-session-title-live',
    automatic: 'all-prompts',
    async generate(request) {
      // 【活开关】关掉即**不调 LLM**（不烧 token）；抛错走"生成失败"同一路径：
      //   主包保留旧标题、不影响会话（真机表现为"标题保持旧值"）。
      const ks = isTitleLiveEnabled(cfg.killSwitch);
      if (ks.enabled !== true) {
        throw new Error(`dsh-session-title-live: 已被 kill switch 关闭（${cfg.killSwitch.moduleId}.enabled=false${ks.why ? `；原因：${ks.why}` : ''}）—— 恢复：${cfg.killSwitch.resumeHint}`);
      }
      request.signal.throwIfAborted();

      // 1. 选材：主题锚 + 最近消息（预算内）；已有标题时先过最小信息门槛（小样本幻觉收口）
      const events = request.session?.events;
      const plan = planTitleInput({
        humans: request.messages,
        anchorSeqs: lastTitleMessageSeqs(events),
        lastCovered: lastCoveredSeq(events),
        hasExistingTitle: (() => {
          const t = ctx.sessionTitle.get(request.session)?.title;
          return typeof t === 'string' && t.length > 0;
        })(),
        maxInputBytes: cfg.maxInputBytes,
        minIncrementChars: cfg.minIncrementChars,
        anchorMax: cfg.themeAnchorMax,
      });
      if (plan.skip) {
        // 契约上没有"安静地什么都不做"这一档 → 走失败路径（主包保留旧标题、不影响会话）。
        // 文案写明是**预期跳过**（最小信息门槛），排障时不要当故障。
        throw new Error(`dsh-session-title-live: 本轮新增人类消息仅 ${plan.incrementChars} 字（< minIncrementChars ${cfg.minIncrementChars}）→ 保留旧标题（最小信息门槛，非故障）`);
      }
      const selected = plan.selected;

      // 【收口②】轮次认领：本轮若已被自调度认领 → 立刻退出（不写 GENREQ、不调 LLM = 不烧 token）。
      //   为什么抛错而不是静默返回：主包对 provider.generate 的契约是"要么给标题、要么失败"，
      //   没有"安静地什么都不做"这一档；失败路径主包保留旧标题、不影响会话。
      //   文案写明是**预期去重**，排障时不要当故障。
      const throughSeq = selected.map((m) => m.seq).filter((n) => typeof n === 'number').at(-1);
      if (claimRound(request.session, throughSeq, 'service') === false) {
        throw new Error(`dsh-session-title-live: 本轮（seq=${throughSeq}）已由自调度生成 → 跳过重复生成（去重，非故障）`);
      }
      const framedInput = `${cfg.promptIntro}\n${JSON.stringify(selected.map((m) => m.text))}`;
      const inputBytes = Buffer.byteLength(framedInput, 'utf8');
      if (inputBytes > cfg.maxInputBytes) {
        throw new Error(`dsh-session-title-live: input is ${inputBytes} bytes, exceeding maxInputBytes ${cfg.maxInputBytes}`);
      }

      // 2. 路由：显式配置优先，否则用主请求路由（request/header 记录）
      let route;
      if (cfg.provider !== undefined && cfg.model !== undefined) {
        route = { provider: cfg.provider, model: cfg.model };
      } else if (request.route !== undefined) {
        route = request.route;
      } else {
        throw new Error('dsh-session-title-live: no logged request route is available; configure provider and model together');
      }

      // 3. 组装 LLM 调用（对齐官方 createUserMessage 结构）
      const messages = [{
        role: 'user',
        id: crypto.randomUUID(),
        content: [{ type: 'text', text: framedInput }],
        source: { kind: 'plugin', plugin: 'dsh-session-title-live' },
      }];
      const deadlineSignal = AbortSignal.timeout(cfg.timeoutMs);
      const signal = AbortSignal.any([request.signal, deadlineSignal]);
      const options = Object.freeze({
        provider: route.provider,
        model: route.model,
        messages,
        system: systemPrompt(cfg),
        maxTokens: cfg.maxOutputTokens,
        sessionId: request.session.id,
        purpose: 'session-title',
        signal,
      });

      // 4. 记录请求事件（诊断可见，同官方行为）
      request.session.append(EV.SESSION_TITLE_LLM_REQUEST, {
        titleProvider: 'dsh-session-title-live',
        scheduler: 'service',                                  // 来源标记：收口②的去重对账按它区分通路
        messageSeqs: selected.map((m) => m.seq),
        route,
        system: systemPrompt(cfg),
        messages,
        maxTokens: cfg.maxOutputTokens,
      });
      signal.throwIfAborted();

      // 5. 流式收集（极简 assembler：只要 text-delta + finish）
      let text = '';
      let finish = null;
      for await (const chunk of ctx.llm.stream(options)) {
        signal.throwIfAborted();
        if (chunk.type === 'text-delta') text += chunk.text;
        else if (chunk.type === 'finish') finish = chunk.reason;
      }
      signal.throwIfAborted();

      const terminal = finishError(finish);
      if (terminal !== null) throw terminal;
      const title = normalizeTitle(text, cfg.maxTitleBytes);
      if (title.length === 0) throw new Error('dsh-session-title-live: title model produced no text');

      return {
        title,
        messageSeqs: selected.map((m) => m.seq),
        model: route,
      };
    },
  });

  if (cfg.turnMarks !== false) installTurnMarks(ctx, cfg, ledger);

  // 自建调度（方案 A）：主包调度在首轮之后拿不到启动时机（见文件头），所以由本插件自己触发。
  // register 仍照旧保留 —— 它满足 session-title 服务的注册契约、负责 fallback，并在
  // request/header 通路仍有效时（会话第一次主请求）继续工作；两条通路由轮次认领（收口②）去重，
  // 人工改名（pin）由共享账本拦下（收口①）。
  if (cfg.selfSchedule !== false) {
    installSelfScheduling(ctx, cfg, {
      events: (session) => session?.events ?? [],
      isPinned: (session) => ledger.isPinned(session),
      claimRound,
    });
  }

  ctx.logger?.info?.(`[dsh-session-title-live] registered: all-prompts live title provider｜${describeConfig(cfg)}`);
}
