// 源码静态验证：语法 + 配置层行为 + 脱敏扫描
// 用法：node scripts/verify-source.mjs <repoRoot>
//
// 三件事：
//   ① 每个 .js/.mjs 过 `node --check`（语法）；
//   ② 配置层（lib/config.js）在**临时目录**里跑一遍真实行为：默认值 / 目录解析 /
//      配置文件覆盖 / 深合并 / 非法值清洗 / 公开配置不含绝对路径；
//   ③ 脱敏扫描：通用形态规则（永久）+ 本机标识规则（由 BUILD_* 环境变量注入）。
//
// ⚠️ 本文件自身**不写任何真实机器名 / 用户名 / 本机路径或目录名**（否则等于把要藏的东西
//    写进要发布的仓）。本机标识一律靠注入：
//      BUILD_MACHINE_NAMES=<主机名1>,<主机名2>
//      BUILD_USER_NAMES=<用户名1>,<用户名2>
//      BUILD_LAYOUT_ROOTS=<工作区目录名>,<同步根目录名>,<测试根目录名>
//      BUILD_SYNC_PRODUCTS=<本机在用的同步产品目录名>
//      BUILD_INTERNAL_TERMS=<内部专有名/项目代号>（逗号分隔；形态上无法枚举的那一类）
//      BUILD_PERSONAL_TERMS=<个人称呼>（逗号分隔；**本文件里一个字都不写**，只能靠注入）
//    未注入时通用形态规则仍然生效（绝对路径与用户目录这类形态无需注入即可检出），
//    并会打印一行提示（提示不影响退出码）。
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { extname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = process.argv[2] ?? process.cwd();
let fail = 0;
const check = (name, ok, detail = '') => {
  console.log((ok ? '[OK]  ' : '[FAIL]') + ' ' + name + (detail ? ' :: ' + detail : ''));
  if (!ok) fail += 1;
};

// ── ① 语法 ────────────────────────────────────────────────────────────────
const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry.startsWith('.tmp-')) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full);
    else if (['.js', '.mjs', '.cjs'].includes(extname(entry))) files.push(full);
  }
};
walk(root);
for (const file of files) {
  const rel = relative(root, file).replace(/\\/g, '/');
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  check('syntax ' + rel, res.status === 0, (res.stderr || '').split('\n').find((l) => l.trim() !== '') ?? '');
}

// ── ② 配置层行为（全在系统临时目录，绝不在仓库里留残留）──────────────────
const { mkdtempSync: mkdtemp } = await import('node:fs');
const sandbox = mkdtemp(join(tmpdir(), 'stl-verify-'));
const savedEnv = { ...process.env };
try {
  const cfgMod = await import(pathToFileURL(join(root, 'lib', 'config.js')).href);
  const indexMod = await import(pathToFileURL(join(root, 'lib', 'index.js')).href);
  const { DEFAULT_CONFIG, DEFAULT_MARKS } = cfgMod;

  check('默认 maxTitleBytes=80', DEFAULT_CONFIG.maxTitleBytes === 80);
  check('默认 minIncrementChars=20', DEFAULT_CONFIG.minIncrementChars === 20);
  check('默认 turnMarks=true / selfSchedule=true', DEFAULT_CONFIG.turnMarks === true && DEFAULT_CONFIG.selfSchedule === true);
  check('默认 killSwitch 文件名是通用名', DEFAULT_CONFIG.killSwitch.file === 'dsh-session-title-live.json', DEFAULT_CONFIG.killSwitch.file);
  check('默认前缀字典为两态', DEFAULT_MARKS.prefix.running === '【运行】' && DEFAULT_MARKS.prefix.done === '【完成】');
  check('默认识别字典含四态', Object.keys(DEFAULT_MARKS.textToState).length === 4);

  // 目录解析：SESSION_TITLE_LIVE_HOME > DSH_HOME > ~/.dsh
  const homeA = join(sandbox, 'home-a');
  const homeB = join(sandbox, 'home-b');
  const env = { DSH_HOME: homeA, SESSION_TITLE_LIVE_HOME: homeB };
  check('SESSION_TITLE_LIVE_HOME 优先于 DSH_HOME', cfgMod.resolveHome({}, env) === homeB, cfgMod.resolveHome({}, env));
  check('无注入时回落 DSH_HOME', cfgMod.resolveHome({}, { DSH_HOME: homeA }) === homeA);
  check('显式 home 最高优先', cfgMod.resolveHome({ home: '/tmp/x' }, env) === '/tmp/x');
  const noEnv = cfgMod.resolveHome({}, {});
  check('两者都没有 → <os.homedir()>/.dsh', noEnv === join(homedir(), '.dsh'), noEnv);

  // 无配置文件：只用默认 + 宿主 config
  let res = cfgMod.resolveConfig({ env: {}, home: homeA, config: {} });
  check('无配置来源时零错误', res.errors.length === 0, JSON.stringify(res.errors));
  check('source 为 null（没有配置文件）', res.source === null);

  // 配置文件覆盖 + 深合并 marks（只改 running，done 保留默认）
  const cfgPath = join(sandbox, 'custom.config.json');
  const sandboxHome = join(sandbox, 'home-c');
  mkdirSync(sandboxHome, { recursive: true });
  writeFileSync(cfgPath, JSON.stringify({
    targetWords: 3,
    maxTitleBytes: 60,
    minIncrementChars: 5,
    marks: { prefix: { running: '[RUN]' }, baseFallback: 'untitled' },
    killSwitch: { file: 'sw.json', cacheMs: 0 },
  }), 'utf8');
  res = cfgMod.resolveConfig({ env: { SESSION_TITLE_LIVE_CONFIG: cfgPath }, home: sandboxHome, config: { maxTitleBytes: 72 } });
  check('配置文件被读取', res.source === cfgPath);
  check('配置文件覆盖默认值', res.config.targetWords === 3);
  check('宿主 config 覆盖配置文件', res.config.maxTitleBytes === 72, String(res.config.maxTitleBytes));
  check('marks 深合并：只改 running', res.config.marks.prefix.running === '[RUN]' && res.config.marks.prefix.done === '【完成】');
  check('marks 深合并：baseFallback 生效', res.config.marks.baseFallback === 'untitled');
  check('killSwitch 段深合并', res.config.killSwitch.file === 'sw.json' && res.config.killSwitch.cacheMs === 0);
  check('killSwitch.moduleId 保留默认', res.config.killSwitch.moduleId === 'session-title-live');

  // 非法值清洗（并记 errors，不抛）
  writeFileSync(cfgPath, JSON.stringify({
    targetWords: 'abc',
    maxInputBytes: -5,
    minIncrementChars: 0,
    provider: 'p',
    marks: { textToState: { '运行': 'running', '带【括号】的': 'x' } },
    killSwitch: { cacheMs: -1, home: 123 },
  }), 'utf8');
  res = cfgMod.resolveConfig({ env: { SESSION_TITLE_LIVE_CONFIG: cfgPath }, home: sandboxHome, config: {} });
  check('非法数值回落默认', res.config.targetWords === 5 && res.config.maxInputBytes === 32768);
  check('minIncrementChars=0 合法（关闭门槛）', res.config.minIncrementChars === 0);
  check('不成对的 provider 被忽略', res.config.provider === undefined && res.config.model === undefined);
  check('带括号的识别键被剔除', !('带【括号】的' in res.config.marks.textToState));
  check('killSwitch 非法值回落', res.config.killSwitch.cacheMs === 3000 && res.config.killSwitch.home === undefined);
  check('非法值都记进了 errors', res.errors.length >= 4, String(res.errors.length));

  // 坏 JSON 不致命
  writeFileSync(cfgPath, '{ not json', 'utf8');
  res = cfgMod.resolveConfig({ env: { SESSION_TITLE_LIVE_CONFIG: cfgPath }, home: sandboxHome, config: {} });
  check('坏配置文件不抛且用默认值', res.config.maxTitleBytes === 80 && res.errors.length === 1, res.errors[0] ?? '');

  // publicConfig 不含路径
  const pub = cfgMod.publicConfig(cfgMod.resolveConfig({ env: {}, home: sandboxHome, config: {} }).config);
  const pubText = JSON.stringify(pub);
  check('publicConfig 不含 home 路径', !pubText.includes(sandboxHome) && !/[A-Za-z]:[\\/]/.test(pubText), pubText.slice(0, 90));
  check('publicConfig 不含 resumeHint', pub.killSwitch.resumeHint === undefined);

  // 开关解析：三形状 + fail-safe
  check('parseKillSwitch 损坏 JSON → 继续工作', indexMod.parseKillSwitch('{ bad').enabled === true);
  check('parseKillSwitch 顶层简写生效', indexMod.parseKillSwitch('{"enabled":false}').enabled === false);
  check('parseKillSwitch modules 形状生效', indexMod.parseKillSwitch('{"modules":{"session-title-live":{"enabled":false}}}').enabled === false);
  check('parseKillSwitch 别的模块键 → baseline 开', indexMod.parseKillSwitch('{"modules":{"other":{"enabled":false}}}').enabled === true);
  check('环境变量一键停（SESSION_TITLE_LIVE_DISABLED）',
    indexMod.isTitleLiveEnabled({ env: { SESSION_TITLE_LIVE_DISABLED: '1' } }).enabled === false);
  check('killSwitchPath 跟随 SESSION_TITLE_LIVE_HOME',
    indexMod.killSwitchPath({ home: sandboxHome, file: 'x.json' }) === join(sandboxHome, 'x.json'));
  process.env.DSH_HOME = sandboxHome;
  check('killSwitchPath 无参时回落 DSH_HOME',
    indexMod.killSwitchPath() === join(sandboxHome, 'dsh-session-title-live.json'), indexMod.killSwitchPath());
  delete process.env.DSH_HOME;
} finally {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── ③ 脱敏扫描 ────────────────────────────────────────────────────────────
const envList = (name) => (process.env[name] ?? '')
  .split(/[,;]/)
  .map((s) => s.trim())
  .filter((s) => s.length >= 2);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const EXTRA_MACHINES = envList('BUILD_MACHINE_NAMES');
const EXTRA_USERS = envList('BUILD_USER_NAMES');
const EXTRA_ROOTS = envList('BUILD_LAYOUT_ROOTS');
const EXTRA_SYNC = envList('BUILD_SYNC_PRODUCTS');
// 内部专有名 / 项目代号：形态上无法枚举（既不是 id、也不是路径），只能由发布环境注入。
// 动过测试样本或注释里的举例之后，务必带上这一项再复扫一遍（本项就是为这类残留加的）。
const EXTRA_TERMS = envList('BUILD_INTERNAL_TERMS');
// 个人称呼（私人的机主/助手自称那一类）：**绝不写在本文件里** —— 本文件会进公开仓，
// 把私人称谓明文写进扫描器，等于换个地方把它公开。一律由发布环境注入：
//   BUILD_PERSONAL_TERMS=<称呼1>,<称呼2>,…
const EXTRA_PERSONAL = envList('BUILD_PERSONAL_TERMS');

// 通用形态规则：与具体机器无关，永远生效
const PATTERNS = [
  [/[\\/]Users[\\/](?!<|\$\{|%|<user>)[A-Za-z0-9._-]{2,}/, 'user profile dir'],
  // 盘符前必须是「行首或非字母数字」——否则 http:// 这类 URL scheme 会被误判成盘符
  [/(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/](?!<|\$\{|%|<path>)[^\s'"`<>|?*]{2,}/, 'absolute windows path'],
  [/\bsk-[A-Za-z0-9]{8,}/, 'api key'],
  // 会话 id（`session-<uuid 首段>`）与任务卡 id（形如 `card id ab12cd34`）
  [/\bsession-[0-9a-f]{8}-[0-9a-f]{4}-/, 'session id'],
  [/(?:卡|card)\s*id\s*[:：=]?\s*[0-9a-f]{8}\b/i, 'card id'],
];
const GENERIC_COUNT = PATTERNS.length;
// 本机标识规则：由 BUILD_* 注入（未注入 = 无此规则，通用形态规则兜底）
if (EXTRA_SYNC.length) PATTERNS.unshift([new RegExp(EXTRA_SYNC.map(esc).join('|'), 'i'), 'local sync product']);
if (EXTRA_MACHINES.length) PATTERNS.unshift([new RegExp(EXTRA_MACHINES.map(esc).join('|'), 'i'), 'machine name']);
if (EXTRA_USERS.length) PATTERNS.unshift([new RegExp(EXTRA_USERS.map(esc).join('|'), 'i'), 'user name']);
if (EXTRA_ROOTS.length) PATTERNS.unshift([new RegExp(EXTRA_ROOTS.map(esc).join('|'), 'i'), 'local layout path']);
if (EXTRA_TERMS.length) PATTERNS.unshift([new RegExp(EXTRA_TERMS.map(esc).join('|'), 'i'), 'internal proper name']);
if (EXTRA_PERSONAL.length) PATTERNS.unshift([new RegExp(EXTRA_PERSONAL.map(esc).join('|')), 'personal address']);
const injected = EXTRA_MACHINES.length + EXTRA_USERS.length + EXTRA_ROOTS.length + EXTRA_SYNC.length
  + EXTRA_TERMS.length + EXTRA_PERSONAL.length;
console.log(
  '[i] sensitive rules: generic=' + GENERIC_COUNT + ' + injected=' + injected
  + '(machine=' + EXTRA_MACHINES.length + ' user=' + EXTRA_USERS.length
  + ' layout=' + EXTRA_ROOTS.length + ' sync=' + EXTRA_SYNC.length
  + ' terms=' + EXTRA_TERMS.length + ' personal=' + EXTRA_PERSONAL.length + ')'
  + (injected
    ? ''
    : '  ← 未注入 BUILD_* 变量（MACHINE_NAMES / USER_NAMES / LAYOUT_ROOTS / SYNC_PRODUCTS / INTERNAL_TERMS'
      + ' / PERSONAL_TERMS），仅通用形态规则生效')
);

const TEXT_LIKE = new Set(['.md', '.json', '.yml', '.yaml', '.txt', '.example']);
const isTextLike = (rel) => [...TEXT_LIKE].some((ext) => rel.endsWith(ext));
// 注释行允许说明性提及（例如文档里写"别把 /home/xxx 写进去"），但**不允许**真实标识：
// 只对"绝对路径 / 用户目录"两类放行注释；个人称呼、机器名、用户名、同步产品名、内部专有名
// 在注释里**同样拦**（注释外泄与正文外泄一样致命）。
const COMMENT_ALLOWED = new Set(['absolute windows path', 'user profile dir']);
let scanned = 0;
for (const file of files) {
  const rel = relative(root, file).replace(/\\/g, '/');
  if (rel.startsWith('scripts/')) continue; // 本目录是测试与验证工具，自身含检测规则
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const patterns = isTextLike(rel) ? PATTERNS : [...PATTERNS, [/[A-H]:[\\/]/, 'absolute windows path in code']];
  for (let i = 0; i < lines.length; i++) {
    scanned += 1;
    const line = lines[i];
    const isComment = /^\s{0,4}(\/\/|\/\*|\*|#|<!--)/.test(line);
    for (const [re, label] of patterns) {
      if (!re.test(line)) continue;
      if (isComment && COMMENT_ALLOWED.has(label)) continue;
      check(`sensitive scan ${rel}:${i + 1} [${label}]`, false, line.trim().slice(0, 120));
    }
  }
}
check('sensitive scan finished (' + scanned + ' lines scanned)', true);
check('sandbox cleaned up', !existsSync(sandbox));

console.log('\n' + (fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'));
process.exitCode = fail === 0 ? 0 : 1;
