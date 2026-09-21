/**
 * dsh-session-title-live / lib/config.js
 *
 * 配置层：**默认值 ⊕ 配置文件 ⊕ 宿主 config** 三层合并 + 校验 + 界面/日志文案字典。
 *
 * 为什么要这一层（而不是把参数写死在 lib/index.js 里）：
 *   ① 同一份代码要在不同机器、不同主包线上跑 —— 路径必须由环境推导
 *      （`SESSION_TITLE_LIVE_HOME` > `DSH_HOME` > `~/.dsh`），不能写字面量；
 *   ② 提示词、标题长度目标、状态前缀文案、调度阈值都属于**使用环境的策略**，
 *      不属于逻辑，必须可覆盖；
 *   ③ 配置错误要在**加载时**一次性报清（而不是运行到某条分支才崩）。
 *
 * 三层各自怎么来：
 *   默认值    = {@link DEFAULT_CONFIG}（本文件，全量列出，示例见 examples/）
 *   配置文件  = `SESSION_TITLE_LIVE_CONFIG` 指向的 JSON（可选；缺失不是错误）
 *   宿主 config = `cordis.patch.yml` 里该插件 insert 项的 `config:`
 * 合并顺序：默认值 ← 配置文件 ← 宿主 config（后者覆盖前者）；对象段**深合并**，数组整体覆盖。
 *
 * 零依赖：只用 node 标准库。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 默认的回合状态前缀字典（前缀文本 → 状态 与 状态 → 前缀文本）。 */
export const DEFAULT_MARKS = Object.freeze({
  /** 状态 → 前缀文本（写标题时用）。 */
  prefix: Object.freeze({ running: '【运行】', done: '【完成】' }),
  /**
   * 前缀文本 → 状态（读标题时用）。
   * 只列**能被识别**的前缀：不在表里的「【…】」会被当成标题正文的一部分。
   * 默认四态与常见的外部打标脚本口径一致（运行 / 完成 / 待命 / 已中断）。
   */
  textToState: Object.freeze({ '运行': 'running', '完成': 'done', '待命': 'idle', '已中断': 'interrupted' }),
  /** 标题只剩前缀时的兜底基名。 */
  baseFallback: '会话',
});

/** 全部默认值（改默认值 = 改语义，须同步 CHANGELOG 与 README 的兼容性表）。 */
export const DEFAULT_CONFIG = Object.freeze({
  // ── 标题生成 ───────────────────────────────────────────────────────────
  /** 非 CJK 语言的标题目标词数（只写进提示词，不参与裁剪）。 */
  targetWords: 5,
  /** CJK 语言的标题目标字数（只写进提示词）。 */
  targetCjkCharacters: 10,
  /** 送进模型的输入字节预算（从最新消息往前收拢，超出会被裁剪）。 */
  maxInputBytes: 32768,
  /** 标题输出的 token 上限。 */
  maxOutputTokens: 128,
  /** 标题落盘的 UTF-8 字节上限（主包标题上限默认 80 字节）。 */
  maxTitleBytes: 80,
  /** 单次生成超时（毫秒）。 */
  timeoutMs: 30000,
  /** 成对配置：用独立的 provider/model 生成标题；省略 = 跟随会话主请求路由。 */
  provider: undefined,
  model: undefined,
  /** 送进模型的 JSON 数组前的引导句。 */
  promptIntro: 'Generate the session title from this JSON array of human messages:',
  /** 自定义系统提示词（字符串或字符串数组）；省略 = 用内置提示词。 */
  systemPrompt: undefined,

  // ── 调度 ───────────────────────────────────────────────────────────────
  /**
   * 自建调度：主包的自动调度在首轮之后拿不到启动时机（见 lib/index.js 文件头），
   * 所以由本插件在 `llm/stream` 钩子里自己触发。false = 退回主包调度原状。
   */
  selfSchedule: true,
  /** 每个会话在内存里保留的人类消息条数上限（环形）。 */
  selfScheduleMaxHumans: 32,
  /** 最小信息门槛：已有标题时，本轮新增人类消息字数低于此值 → 保留旧标题（0 = 关闭）。 */
  minIncrementChars: 20,
  /** 主题锚：选材里保留「上一版标题依据」的条数上限（0 = 关闭锚）。 */
  themeAnchorMax: 6,

  // ── 回合边界状态前缀 ───────────────────────────────────────────────────
  /** 回合边界自动打前缀总开关。 */
  turnMarks: true,
  /** 加前缀前的基名 UTF-8 字节预算。 */
  markBaseBudgetBytes: 64,
  /** 打标写回时 source.provider 用的名字（用于识别"这条标题是我们写的"）。 */
  markProvider: 'dsh-session-title-live#turn-mark',
  /** 前缀 / 识别 / 兜底文案字典（见 {@link DEFAULT_MARKS}）。 */
  marks: DEFAULT_MARKS,

  // ── 活开关（kill switch）──────────────────────────────────────────────
  /**
   * 不需要重启就能停掉本插件的开关：每回合与每次生成前现读该 JSON 文件
   * （带 cacheMs 时窗缓存），关闭时**零写入、零 token**。
   * fail-safe 方向：读不到 / 损坏 / 没有该模块键 → **继续工作**（缺文件不等于要求关闭）。
   */
  killSwitch: Object.freeze({
    /** 开关文件名（相对 home）或绝对路径。 */
    file: 'dsh-session-title-live.json',
    /** 文件里 `modules.<id>.enabled` 的 id（也可用顶层 `{enabled:false}` 简写）。 */
    moduleId: 'session-title-live',
    /** 读盘缓存毫秒（0 = 每次现读）。 */
    cacheMs: 3000,
    /** 开关文件所在目录（省略 = 按 {@link resolveHome} 解析）。 */
    home: undefined,
    /** 恢复提示（关掉后打进日志/错误信息，便于照抄）。 */
    resumeHint: '把该开关文件里的 enabled 改回 true（或删除该文件——缺文件 = 继续工作）',
    /** 直接停用（等价于开关文件里写 enabled:false）；环境变量 SESSION_TITLE_LIVE_DISABLED=1 同效。 */
    enabled: true,
  }),
});

/** 数值型配置项（用于校验清洗）：[最小值, 是否必须整数]。 */
const NUMERIC_KEYS = Object.freeze({
  targetWords: [1, true],
  targetCjkCharacters: [1, true],
  maxInputBytes: [256, true],
  maxOutputTokens: [1, true],
  maxTitleBytes: [8, true],
  timeoutMs: [1, true],
  selfScheduleMaxHumans: [1, true],
  minIncrementChars: [0, true],
  themeAnchorMax: [0, true],
  markBaseBudgetBytes: [8, true],
});

/**
 * 解析 DSH home 目录（**不写死任何机器路径**）。
 * 顺序：显式 opts.home → `SESSION_TITLE_LIVE_HOME` → `DSH_HOME` → `~/.dsh`。
 * @param {{home?:string}} [opts]
 * @param {object} [env]
 */
export function resolveHome(opts = {}, env = process.env) {
  return opts.home || env.SESSION_TITLE_LIVE_HOME || env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/** 配置文件路径（`SESSION_TITLE_LIVE_CONFIG`；未设置 = 没有配置文件）。 */
export function configPathOf(env = process.env) {
  const p = env.SESSION_TITLE_LIVE_CONFIG;
  return typeof p === 'string' && p.trim() !== '' ? p : null;
}

/** 深合并（只对纯对象递归，数组与标量整体覆盖；undefined 不覆盖）。 */
function mergeSection(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === undefined) continue;
    const prev = out[key];
    const bothPlain = value !== null && prev !== null
      && typeof value === 'object' && typeof prev === 'object'
      && !Array.isArray(value) && !Array.isArray(prev);
    out[key] = bothPlain ? mergeSection(prev, value) : value;
  }
  return out;
}

/** 读 JSON 文件（缺失返回 null；解析失败抛）。 */
function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  return JSON.parse(text);
}

/** 清洗数字项：非法值回落默认并记错误。 */
function sanitizeNumbers(raw, defaults, errors) {
  const out = { ...raw };
  for (const [key, [min, mustBeInt]] of Object.entries(NUMERIC_KEYS)) {
    if (out[key] === undefined) continue;
    const n = Number(out[key]);
    const bad = !Number.isFinite(n) || n < min || (mustBeInt && !Number.isInteger(n));
    if (bad) {
      errors.push(`${key}=${JSON.stringify(out[key])} 非法（要求 ≥${min}${mustBeInt ? ' 的整数' : ''}）→ 回落默认 ${defaults[key]}`);
      out[key] = defaults[key];
    } else out[key] = n;
  }
  return out;
}

/** 清洗文案字典：每项必须是非空字符串。 */
function sanitizeMarks(raw, defaults, errors) {
  const marks = mergeSection(defaults, raw ?? {});
  for (const key of ['running', 'done']) {
    if (typeof marks.prefix?.[key] !== 'string' || marks.prefix[key] === '') {
      errors.push(`marks.prefix.${key} 必须是非空字符串 → 回落默认 ${JSON.stringify(defaults.prefix[key])}`);
      marks.prefix = { ...marks.prefix, [key]: defaults.prefix[key] };
    }
  }
  const textToState = {};
  for (const [text, state] of Object.entries(marks.textToState ?? {})) {
    if (typeof text !== 'string' || text === '' || typeof state !== 'string' || state === '') {
      errors.push(`marks.textToState 里有非法项（${JSON.stringify(text)} → ${JSON.stringify(state)}），已忽略`);
      continue;
    }
    if (/[【】\[\]]/.test(text)) {
      errors.push(`marks.textToState 的键不应含括号（${JSON.stringify(text)}），已忽略`);
      continue;
    }
    textToState[text] = state;
  }
  if (Object.keys(textToState).length === 0) {
    errors.push('marks.textToState 为空 → 回落默认字典');
    marks.textToState = { ...defaults.textToState };
  } else marks.textToState = textToState;
  if (typeof marks.baseFallback !== 'string' || marks.baseFallback === '') {
    errors.push(`marks.baseFallback 必须是非空字符串 → 回落默认 ${JSON.stringify(defaults.baseFallback)}`);
    marks.baseFallback = defaults.baseFallback;
  }
  return marks;
}

/** 清洗 killSwitch 段。 */
function sanitizeKillSwitch(raw, defaults, errors) {
  const ks = mergeSection(defaults, raw ?? {});
  if (typeof ks.file !== 'string' || ks.file.trim() === '') {
    errors.push(`killSwitch.file 必须是非空字符串 → 回落默认 ${defaults.file}`);
    ks.file = defaults.file;
  }
  if (typeof ks.moduleId !== 'string' || ks.moduleId.trim() === '') {
    errors.push(`killSwitch.moduleId 必须是非空字符串 → 回落默认 ${defaults.moduleId}`);
    ks.moduleId = defaults.moduleId;
  }
  const cacheMs = Number(ks.cacheMs);
  if (!Number.isFinite(cacheMs) || cacheMs < 0) {
    errors.push(`killSwitch.cacheMs=${JSON.stringify(ks.cacheMs)} 非法 → 回落默认 ${defaults.cacheMs}`);
    ks.cacheMs = defaults.cacheMs;
  } else ks.cacheMs = cacheMs;
  if (typeof ks.resumeHint !== 'string') ks.resumeHint = defaults.resumeHint;
  if (ks.enabled !== true && ks.enabled !== false) ks.enabled = defaults.enabled;
  if (ks.home !== undefined && typeof ks.home !== 'string') {
    errors.push('killSwitch.home 必须是字符串路径或省略 → 已忽略');
    ks.home = undefined;
  }
  return ks;
}

/**
 * 解析最终配置。
 * @param {object} [opts]
 * @param {object} [opts.config] 宿主 config（cordis.patch.yml 里的 config）
 * @param {object} [opts.env] 环境变量表（默认 process.env；单测可注入）
 * @param {string} [opts.home] 显式 home（默认按 {@link resolveHome} 解析）
 * @param {boolean} [opts.cache] 是否走进程内缓存（默认 false：宿主只在加载时调一次）
 * @returns {{config:object, source:string|null, errors:string[], home:string}}
 */
export function resolveConfig(opts = {}) {
  const env = opts.env ?? process.env;
  const home = resolveHome({ home: opts.home }, env);
  const errors = [];
  const filePath = opts.configPath !== undefined ? opts.configPath : configPathOf(env);

  let fromFile = null;
  let source = null;
  if (filePath !== null && filePath !== undefined && filePath !== '') {
    try {
      fromFile = readJson(filePath);
      source = fromFile === null ? null : filePath;
    } catch (error) {
      errors.push(`配置文件解析失败（${filePath}）：${error?.message ?? error} → 只用默认值与宿主 config`);
    }
  }

  let config = mergeSection(DEFAULT_CONFIG, fromFile ?? {});
  config = mergeSection(config, opts.config ?? {});
  config = sanitizeNumbers(config, DEFAULT_CONFIG, errors);
  config.marks = sanitizeMarks(config.marks, DEFAULT_MARKS, errors);
  config.killSwitch = sanitizeKillSwitch(config.killSwitch, DEFAULT_CONFIG.killSwitch, errors);

  if ((config.provider === undefined) !== (config.model === undefined)) {
    errors.push('provider 与 model 必须成对配置（只给一个 → 已按"不配置"处理）');
    config.provider = undefined;
    config.model = undefined;
  }
  if (config.provider !== undefined && typeof config.provider !== 'string') {
    errors.push('provider 必须是字符串 → 已忽略');
    config.provider = undefined;
    config.model = undefined;
  }
  if (config.systemPrompt !== undefined && typeof config.systemPrompt !== 'string' && !Array.isArray(config.systemPrompt)) {
    errors.push('systemPrompt 必须是字符串或字符串数组 → 已忽略（用内置提示词）');
    config.systemPrompt = undefined;
  }
  if (typeof config.promptIntro !== 'string' || config.promptIntro.trim() === '') {
    errors.push(`promptIntro 必须是非空字符串 → 回落默认`);
    config.promptIntro = DEFAULT_CONFIG.promptIntro;
  }

  return { config, source, errors, home };
}

/**
 * 可安全下发给界面 / 诊断的配置视图：**不含 home 等本机绝对路径**。
 */
export function publicConfig(config) {
  const ks = { ...config.killSwitch };
  delete ks.home;
  delete ks.resumeHint;
  return {
    targetWords: config.targetWords,
    targetCjkCharacters: config.targetCjkCharacters,
    maxInputBytes: config.maxInputBytes,
    maxOutputTokens: config.maxOutputTokens,
    maxTitleBytes: config.maxTitleBytes,
    timeoutMs: config.timeoutMs,
    hasExplicitRoute: config.provider !== undefined && config.model !== undefined,
    selfSchedule: config.selfSchedule !== false,
    selfScheduleMaxHumans: config.selfScheduleMaxHumans,
    minIncrementChars: config.minIncrementChars,
    themeAnchorMax: config.themeAnchorMax,
    turnMarks: config.turnMarks !== false,
    markBaseBudgetBytes: config.markBaseBudgetBytes,
    marks: { ...config.marks, prefix: { ...config.marks.prefix }, textToState: { ...config.marks.textToState } },
    killSwitch: ks,
  };
}

/** 一行摘要（日志用；不含路径）。 */
export function describeConfig(config) {
  return [
    `route=${config.provider !== undefined ? `${config.provider}/${config.model}` : 'follow-session'}`,
    `selfSchedule=${config.selfSchedule !== false}`,
    `minIncrementChars=${config.minIncrementChars}`,
    `themeAnchorMax=${config.themeAnchorMax}`,
    `turnMarks=${config.turnMarks !== false}`,
    `maxTitleBytes=${config.maxTitleBytes}`,
  ].join(' ');
}
