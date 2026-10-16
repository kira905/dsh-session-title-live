# dsh-session-title-live

> **English**: [README.en.md](./README.en.md)

一个 **DeepSeek Harness (DSH) 插件**：让会话标题**跟着对话实时更新**。

## 为什么需要它

DSH 自带的标题机制只在**会话第一条用户消息**时生成一次标题（`automatic: "first-prompt"`）。
长会话聊到十几轮之后，侧边栏显示的还是开头那句话，跟会话实际内容完全脱节 ——
而会话列表恰恰是你找会话的唯一入口。

本插件注册一个 `automatic: "all-prompts"` 的标题 provider：**每条人类消息之后**都会用
「字节预算内最近的人类消息」重新生成一次标题。它**不替换**核心的 `session-title` 服务，
而是注册进它（和官方 provider 同一个扩展点）。

顺带解决一个相关问题：**回合边界自动状态前缀**。如果团队约定「干活写【运行】、收尾写【完成】」，
只靠 agent 自觉去写，实测绝大多数会话都不会有标记；本插件在 `turn/start` / `turn/end`
边界自动把前缀写上（前缀文案可配置，不想用可以关）。

- **零第三方依赖**：只用 `node:fs` / `node:os` / `node:path`（`node:zlib` 只在验证脚本里用）。
- **零主包 import**：插件随 profile 部署，运行期解析不到全局 npm 里的 `@deepseek-ai/*` 包，
  因此事件名 / 服务名**内联**在 `lib/host-protocol.js` 一个文件里（升级主包时只核对这一处）。
- **不读会话文件**：只订阅会话事件、只 append `session/title` 事件（写标题是主包公开的事件契约）。

---

## 设计依据

本组件是「[ops-handoff-design](https://github.com/kira905/ops-handoff-design)」所述运维体系的一个实现，
设计依据（对应文档仓约定的固定四问）：

- **它为什么存在、边界在哪** → 见《自治式运维管家》**§2 会话生命周期覆盖矩阵**，以及《体系全景与家规》**§3.8 会话生命周期的自治**
- **它与宿主版本的兼容区间** → 见《多机交接与云中继》**§4.5「兼容性要求」**（另见本 README 第六节「兼容性」）
- **本组件特有的坑与实测** → 见本 README「已知限制」一节
- **文档仓地址** → Gitee（镜像）<https://gitee.com/kira905/ops-handoff-design>
  ｜ GitHub（主）<https://github.com/kira905/ops-handoff-design>
  （文档仓的组件索引表回指本仓；两仓互链、版本各自独立）

> 设计稿里不写具体仓库地址（写死即死链），实现清单统一收在文档仓的组件索引表里——本仓只负责回链章节。

---

## 一、能力

| 功能 | 说明 |
|---|---|
| 实时重生成标题 | 每条人类消息后重新生成；选材 = 上一版标题的依据（**主题锚**）+ 最近消息，按字节预算收拢 |
| 不覆盖人工改名 | 你在 GUI 里手动改过标题之后，本插件不再动它（**pin**，与打标路径共用同一份判定） |
| 回合边界状态前缀 | `turn/start` → `【运行】`，`turn/end` → `【完成】`（文案可配、可关） |
| 预置标题保护 | 会话创建阶段已写好的标题（任务卡 / 外部流程预置）：只换前缀、不被摘要顶掉 |
| 自建调度 | 主包的自动调度在首轮之后拿不到启动时机（见 `lib/index.js` 文件头），所以本插件自己在 `llm/stream` 钩子里触发；两条通路由**轮次认领**去重，一轮最多一次生成 |
| 最小信息门槛 | 已有标题时，本轮新增消息太少（默认 < 20 字）就不重生成，避免「好」「收到」这类短噪声把标题带跑 |
| 活开关 | 一个 JSON 文件 / 一个环境变量即可停掉（**不重启**），关掉后零写入、零 token |
| 子代理会话跳过 | 子代理 / 派生会话不打标、不生成 |

---

## 二、前置条件

- DSH 主包 `>= 0.1.1-rc.2 < 0.2.0`（兼容性细节见第六节）
- Node.js `>= 18`
- 一个能改 `profiles/<name>/` 的 DSH 安装（默认 profile 名为 `web`）

---

## 三、安装（从零开始）

### 0. 先备份

改 profile 之前把 `cordis.patch.yml`（必要）与 `package.json`、`.package-map.json`（若你会改）
各复制一份留底。

### 1. 把包放进去

```bash
git clone <仓库地址> dsh-session-title-live
```

然后装进你的 profile（二选一）：

**方式 A（推荐，声明式）** —— 在 `profiles/<name>/package.json` 的 `dependencies` 里加一条，再安装：

```jsonc
"dependencies": {
  "dsh-session-title-live": "file:../../path/to/dsh-session-title-live"
}
```

```bash
cd <DSH_HOME>/profiles/<name>
# 用你平时给这个 profile 装插件的那条命令安装（pnpm / npm 均可）
```

**方式 B（手动，不装依赖）** —— 直接把包目录复制成实体目录：

```bash
cp -r dsh-session-title-live <DSH_HOME>/profiles/<name>/node_modules/dsh-session-title-live
```

> 两者差别只在「谁负责把文件放到 `node_modules` 下」，插件行为一致。

### 2. 注册插件 + 关掉官方那个首轮 provider（关键，别跳过）

把 [`cordis.patch.yml.example`](./cordis.patch.yml.example) 那段追加到
`profiles/<name>/cordis.patch.yml` 末尾。它做两件事：

```yaml
- disable:
    - id: session-title-llm        # 官方「只在首轮生成标题」的 provider：先关掉，避免两条抢着写

- insert:
    - id: session-title-live
      name: 'dsh-session-title-live'
```

⚠️ `insert` 的 `id` 不能与已有条目重复（重复会崩 `duplicate loader entry id`）。加之前先查：

```bash
grep -n "id:" <DSH_HOME>/profiles/<name>/cordis.patch.yml
```

> 本插件**没有** client 半（`package.json` 里没有 `dsh.client` 字段），因此理论上也可以放进
> `dsh.profile.bundles`；但**推荐仍然走 patch insert** —— 上面那两条要一起改才生效，
> 写在同一个 patch 里最好维护。若你偏好 bundles，请自行验证（见第七节「已知限制」）。

### 3. 重启并验证

重启 DSH（或让它的守护进程拉起新配置），然后在 GUI 里：

1. 随便开一个会话，发一条消息 → 侧边栏标题应该在几秒内变成与新内容相关的；
2. 再发几条不相关的消息 → 标题会跟着变（不是停在第一条）；
3. 手动把标题改一下 → 此后本插件不再覆盖它；
4. 想确认插件真的加载了：日志里应有一行
   `[dsh-session-title-live] registered: all-prompts live title provider｜route=… selfSchedule=true …`。

---

## 四、配置

三层合并，**后者覆盖前者**：

1. `lib/config.js` 里的默认值（即[示例文件](./examples/session-title-live.config.example.json)里的值）；
2. `SESSION_TITLE_LIVE_CONFIG` 指向的 JSON 文件（**不设这个环境变量就不会读任何文件**）；
3. 宿主 `cordis.patch.yml` 里该插件 `config:` 段。

对象段（`marks` / `killSwitch`）**深合并**（只覆盖你写的那几个键）；非法值会被清洗成默认值
并打一条 `warn` 日志（不会让插件起不来）。

目录解析（`home`）走 `SESSION_TITLE_LIVE_HOME` > `DSH_HOME` > `~/.dsh`，跨平台，**没有机器路径硬编码**。

| 键 | 默认值 | 说明 |
|---|---|---|
| `targetWords` | `5` | 非 CJK 语言的标题目标词数（只写进提示词） |
| `targetCjkCharacters` | `10` | CJK 目标字数（只写进提示词） |
| `maxInputBytes` | `32768` | 送进模型的输入字节预算（超了从最新消息往前收拢） |
| `maxOutputTokens` | `128` | 标题输出 token 上限 |
| `maxTitleBytes` | `80` | 标题落盘的 UTF-8 字节上限（与主包标题上限一致） |
| `timeoutMs` | `30000` | 单次生成超时 |
| `provider` / `model` | 不设 | **成对**配置则用独立路由生成标题；都不写 = 跟随会话主请求的路由 |
| `promptIntro` | 见示例 | 送进模型的 JSON 数组前的引导句 |
| `systemPrompt` | 不设 | 自定义系统提示词（字符串或字符串数组），省略 = 内置 |
| `selfSchedule` | `true` | 自建调度总开关（`false` = 退回主包调度原状，多数情况下标题就不会刷新了） |
| `selfScheduleMaxHumans` | `32` | 每会话内存里保留的人类消息条数上限 |
| `minIncrementChars` | `20` | 最小值门槛：新增字数低于它就不重生成（`0` = 关） |
| `themeAnchorMax` | `6` | 主题锚（上一版标题依据）保留条数上限（`0` = 关锚） |
| `turnMarks` | `true` | 回合边界自动打前缀总开关 |
| `markBaseBudgetBytes` | `64` | 加前缀前的基名字节预算 |
| `markProvider` | `dsh-session-title-live#turn-mark` | 打标写回时 `source.provider` 的名字（用于识别"这条是我们写的"） |
| `marks.prefix` | `{running:'【运行】', done:'【完成】'}` | 状态 → 前缀文本 |
| `marks.textToState` | `{运行:running, 完成:done, 待命:idle, 已中断:interrupted}` | 前缀文本 → 状态（**键不要带括号**） |
| `marks.baseFallback` | `会话` | 标题只剩前缀时的兜底基名 |
| `killSwitch.file` | `dsh-session-title-live.json` | 活开关文件名（相对 `home`）或绝对路径 |
| `killSwitch.moduleId` | `session-title-live` | 开关文件里 `modules.<id>.enabled` 的 id |
| `killSwitch.cacheMs` | `3000` | 读盘缓存（手改文件 ≤ 该毫秒数生效） |
| `killSwitch.enabled` | `true` | 直接停用（等价于开关文件里写 `enabled:false`） |
| `killSwitch.resumeHint` | 见源码 | 关闭后打进日志 / 错误信息的恢复提示 |

> ⚠️ 改了 `marks.prefix` 记得让 `marks.textToState` 能认出你写出去的前缀形状。
> 本插件把**两个来源合并**成识别表（`prefix` 的字面值 + `textToState` 的键），所以像 `[RUN]`
> 这种自定义前缀也能被认出来、不会在下一轮叠一层；但如果你把前缀改成"无包裹"的裸词（例如 `运行 `），
> 建议同时把它加进 `textToState` 以免误伤正文。

### 活开关（kill switch）

```jsonc
// <home>/dsh-session-title-live.json
{ "modules": { "session-title-live": { "enabled": false, "why": "在查别的问题，先别刷标题" } } }
```

也支持顶层简写 `{ "enabled": false }`。`enabled:true` = 开。

- **fail-safe**：文件读不到 / 坏 JSON / 没有该模块键 → **继续工作**（缺文件 ≠ 要求关闭）。
- **环境变量**：`SESSION_TITLE_LIVE_DISABLED=1` 立即停（优先于文件；容器 / CI 用）。
- 关闭后：不打标、不生成、**零写入零 token**（每次回合 / 每次生成前现读，≤3s 生效，不必重启）。

---

## 五、状态前缀（回合边界）

- `turn/start` → 标题写成 `【运行】<基名>`；`turn/end` → `【完成】<基名>`。
- 只换前缀、不动基名；前缀已经是当前状态就不重复写（幂等）。
- **绝不用 `rename`**：`rename` 会把标题 pin 住（主包认定那是人工改名），自动标题从此不再调度。
  本插件用 `append('session/title', { source: { kind: 'provider' } })` —— 只覆盖"当前标题"的显示值。
- 人工改名（`source.kind === 'user'`）之后不再打标、不再重生成基名。
- 已知来源三种（对真实实例核对过）：`user`（人工改名 / 外部预置）、`provider`（自动生成，含本插件）、
  `fallback`（主包在还没有标题时的确定性兜底）。只有 `user` 会被当成 pin，`fallback` 会被正常覆盖。

---

## 六、兼容性

| 主包版本 | 状态 |
|---|---|
| **`0.2.0-rc.2`** | ✅ **已端到端实测（2026-10-16）**：在隔离实例（独立数据根 + 端口 3090，主包 `0.2.0-rc.2`）上**真装真跑** —— 装载面无 `skipping profile bundle` / 无 `failed to import` / 三个 inject 服务（`sessionTitle` / `llm` / `sessions`）全部解析成功；**功能实证** = 新建会话并发一条消息后，标题被生成为 **`【完成】…`**，`【完成】` 正是本插件的**回合状态标记**（本仓 `MARK_RE` 口径） |
| `0.2.x` 后续版本 | ⚠️ **未实测，不作承诺**（本版声明的区间上界为 `<0.3.0`） |
| `0.1.1-rc.2` ~ `0.1.5` 线 | ⚠️ **未端到端实测**（历史版本 `v0.2.3` 及之前的声明基线；**本版起 `peerDependencies` 不再声明 0.1.x**） |
| 自有诊断事件 `session/title-llm-request` | 本插件自身写的诊断事件；官方 0.1.5 / 0.2.0 线未见同名事件（不影响功能，仅供对账） |
| `>= 0.3.0` | ❌ 未评估（主包若改标题事件 / provider 契约即失效） |

升级主包时请重点复核 `lib/host-protocol.js`（本插件内联协议常量的唯一落点）：
把里面的每个名字到新主包源码里搜一遍，存在即可，不存在就要改。

---

## 七、已知限制

1. **依赖主包的私有事件 / 服务名**。本插件不是官方插件，主包改名字就会失效（现象：标题不再刷新，
   日志里可能一片安静）。复核入口只有一个文件：`lib/host-protocol.js`。
2. **标题生成失败时保留旧标题**（不重试）：LLM 超时 / 报错 / 输出为空都会走"失败"路径，
   主包保留上一版标题；下一条人类消息到来时会自然再试一次。
3. **最小信息门槛会让某些轮次不刷新**：只发「好」这类短消息时，标题保持上一版（这是故意的，
   为了不被噪声带跑）。想退回旧行为把 `minIncrementChars` 设为 `0`。
4. **人工改名之后就不再自动更新了**（pin 是设计，不是 bug）。想恢复自动：在 GUI 里让标题
   回到"provider 来源"没有直接入口 —— 换一个会话最省事。
5. **自建调度默认开启**（`selfSchedule: true`）。它是为绕开主包调度的时机限制而存在的；
   关掉它多数情况下就没有实时刷新了，只在排障对照时才关。
6. **`bundles` 加载方式未实测**（本插件无 client 半，理论可行，但实测路径是 `cordis.patch.yml` 的 insert）。
7. **群聊 / 多用户场景未评估**：本插件按"人类消息 = `source.kind==='user'`"取文本，
   若你的部署里有多来源消息，选材口径需自行核对。
8. **`0.1.5` 线只做过静态核对、未端到端实测**（见第六节）。

---

## 八、仓库结构

```
lib/
  index.js           插件主体：provider 注册、自建调度、回合打标、pin 账本、活开关
  config.js          配置层：默认值 ⊕ 配置文件 ⊕ 宿主 config + 校验 + 文案字典
  host-protocol.js   主包协议常量（事件名 / 服务名）—— 升级主包时唯一要核对的文件
examples/
  session-title-live.config.example.json   配置示例（逐项都是默认值）
cordis.patch.yml.example                   注册用的 patch 片段（含 disable 官方 provider）
scripts/
  verify-source.mjs  静态验证：语法 + 配置层行为 + 脱敏扫描（支持 BUILD_* 注入本机标识）
  test-e2e.mjs       端到端：干净临时路径 + 非默认配置 + 假宿主全流程
  verify-live.mjs    对运行中的真实例做**只读**核对（协议常量是否过时）
  probe.mjs          只读探针（RPC / 会话日志解帧 / 事件分析），供上面两个脚本用
_test/
  test-mark.mjs            回合边界打标的离线单测
  test-self-schedule.mjs   自建调度 + 选择器（主题锚 / 最小信息门槛）的离线单测
  test-kill-switch.mjs     活开关的离线单测（解析 / fail-safe / 缓存 / 端到端）
```

---

## 九、开发与测试

```bash
# 1) 静态验证（语法 + 配置层行为 + 脱敏扫描；要在本机覆盖实名规则时注入 BUILD_* 见脚本头部）
#    注：机器名 / 用户名 / 目录名 / 同步产品 / 内部专有名 / 个人称呼六类**全部**由 BUILD_* 注入——
#    扫描器源码自身会进公开仓，所以它里面一个真实标识都不写
node scripts/verify-source.mjs .

# 2) 干净路径端到端（自建临时 home + 非默认配置，跑完自动清理；--keep 保留以便排障）
node scripts/test-e2e.mjs

# 3) 三个离线单测（假宿主，秒级，零副作用）
node _test/test-mark.mjs && node _test/test-self-schedule.mjs && node _test/test-kill-switch.mjs

# 4) 对**运行中的隔离实例**做只读核对（协议常量 / 事件形状是否还成立；只读，不发消息）
node scripts/verify-live.mjs --base http://127.0.0.1:3090 --home <隔离实例 home>
```

发布流程（版本号策略 / 变更记录规范 / 发布前检查单）见 [`docs/RELEASING.md`](./docs/RELEASING.md)。

---

## 十、相关组件

同属 DSH 生态的伴生组件，各自独立仓、独立版本、许可各自独立；它们都回链到同一份文档仓
[`ops-handoff-design`](https://github.com/kira905/ops-handoff-design)
（Gitee 镜像 <https://gitee.com/kira905/ops-handoff-design>）：

| 组件仓 | 做什么 | 与本组件的关系 |
|---|---|---|
| `dsh-session-title-live` | 会话标题跟着对话实时更新 | **本仓** |
| [`dsh-butler-archive`](https://github.com/kira905/dsh-butler-archive) | 会话归档管理（把老会话物理移出 `sessions` 目录，可列出 / 预览 / 恢复 / 删除） | 同一个问题的两面：本仓治「标题跟会话内容对不上」，它治「老会话占着启动与加载开销」——都为了**侧边栏这个唯一入口还能用** |
| [`dsh-ecosystem-panel`](https://github.com/kira905/dsh-ecosystem-panel) | 只读生态总览面板（插件加载 / 补丁 / 技能 frontmatter / 升级风险） | 它的第 ① 类「加载状态」抓的就是宿主首页的 boot 清单——**本插件到底加载上了没有，在那里一眼能看到**（本插件没有 client 半，加载方式只有 `cordis.patch.yml` 的 insert，见第七节第 6 条） |
| [`dsh-diagnostic-tools`](https://github.com/kira905/dsh-diagnostic-tools) | 诊断取证工具组：依赖闭包体检 + 会话图片附件对账 | 宿主升级前后先跑它的 `closure/`；本插件把宿主契约集中在一个文件（`lib/host-protocol.js`），那份清单就是升级时要逐条核对的输入 |
| [`dsh-task-board-local`](https://github.com/kira905/dsh-task-board-local) | 自维护任务看板（卡片 = 一次真实会话 + 人工验收闸） | **本插件的直接受益面**：看板卡的执行会话就是普通会话，卡跑到哪一步、有没有收尾，靠的正是这里的标题状态前缀——**标题不可信，看板上的进度就只是一句话** |
| [`dsh-firstaid`](https://github.com/kira905/dsh-firstaid) | 零依赖急救台：起不来 / 假死 / 要撤销改动 / 数据被删四类现场压成一个入口 | 出事的兜底：本插件（或宿主）一旦**起不来**、界面假死，先跑它生成体检报告，再决定动不动手 |

> 组件之间**没有代码依赖**，也不共享运行时 —— 之所以互指，是因为它们回答的是同一类人的同一批问题
> （长期在自有机器上跑 agent：装得下、找得到、看得见、查得清）。谁装谁不装，互不影响。

---

## 十一、许可

**已定稿（2026-10-16）：`AGPL-3.0-only + 商业授权`（双许可）。**

- 本仓 `LICENSE` 是 GNU AGPL-3.0 官方全文，`package.json` 的 `license` 字段同为 `AGPL-3.0-only`；
- ⚠️ **AGPL-3.0 本身不禁商用**：你可以自由使用、修改、再分发（含商用），条件是**修改版若通过网络向他人提供，必须按 AGPL 一并提供对应源码**；
- 「+ 商业授权」= **双许可**：要么按 AGPL 开源（**衍生作品同开**）、要么取得**商业授权**。若需在**闭源**或**商业场景**中使用（AGPL 的传染条款不适用），**请通过本仓 Issue 联系**。
