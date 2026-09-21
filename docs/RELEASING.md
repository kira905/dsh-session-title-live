# 发布流程（RELEASING）

本文件说明本仓库的**版本号策略**、**变更记录规范**与**发布前检查单**。

---

## 1. 版本号策略（SemVer）

`MAJOR.MINOR.PATCH`，按**使用者能观察到的行为**判定，不按内部重构：

| 变更 | 版本位 | 例子 |
|---|---|---|
| 破坏性：配置键改名/删除、默认行为改变、主包支持区间收窄、标题/前缀的默认形态改变 | **MAJOR** | 改掉 `marks.prefix` 默认值；把活开关文件默认名换掉 |
| 新增：新配置键、新能力（如新的选材策略）、扩大主包支持区间 | **MINOR** | 新增 `themeAnchorMax` 可配 |
| 修复：bug 修复、文案修正、性能优化、内部重构（行为不变） | **PATCH** | 修自定义前缀叠层 |

补充规则：

- 当前处于 **0.x**：允许 MINOR 位承载破坏性变更，但**必须在 CHANGELOG 里显式标注 `BREAKING`**，
  并在 README 的兼容性表里更新支持区间。
- **主包兼容区间变化 = 至少 MINOR**，且必须同步改 `package.json` 的 `peerDependencies`。
- 一个版本一个主题；混装多个主题就拆成多次发布。
- 版本号只增不减；发错了就发下一个补丁版本回退，**不重打已发布的 tag**。

## 2. 变更记录规范

`CHANGELOG.md`，倒序（最新在最上），每条发布一节：

```markdown
## [0.2.1] - 2026-09-30

### Added
- 配置项 `xxx`（默认 …）。
### Changed
- 默认值从 A 改成 B（影响：…）。
### Fixed
- 某个具体症状 + 根因一句话。
### Breaking
- 改了什么、**怎么迁移**（要能照着做）。
```

约定：

- 面向**使用者**写（他能观察到什么变化），不写内部流水账；
- 每条尽量带「影响面」与「迁移动作」；
- 未发布期间的改动先写进 `## [Unreleased]` 一节，发布时改成版本号 + 日期。

## 3. 发布前检查单

按顺序跑，任一项不过就不发：

- [ ] `node scripts/verify-source.mjs .` → `ALL CHECKS PASSED`
      ⚠️ 要在**本机**覆盖实名规则（机器名 / 用户名 / 本机目录名 / 同步产品名 / 内部专有名 / 个人称呼）时，先注入
      `BUILD_MACHINE_NAMES` / `BUILD_USER_NAMES` / `BUILD_LAYOUT_ROOTS` / `BUILD_SYNC_PRODUCTS` /
      `BUILD_INTERNAL_TERMS` / `BUILD_PERSONAL_TERMS` 再跑；
      不注入时只跑通用形态规则（脚本会打印 `injected=0` 提示，属**预期**而非失败）
      ⚠️ **`BUILD_INTERNAL_TERMS` 不能省**：内部组件名与项目代号**没有可枚举的形态**（不是 id、不是路径），
      只有注入才能拦住。它拦的就是"测试样本或注释里顺手写了自己环境里的举例"这类残留
      ⚠️ **`BUILD_PERSONAL_TERMS` 同理，而且更硬**：扫描器源码本身会进公开仓，
      因此**私人的机主/助手自称一个字都不许写在规则表里**（写进去 = 换个地方公开它），只能靠注入拦
- [ ] `node scripts/test-e2e.mjs` → `E2E PASSED`
- [ ] `node _test/test-mark.mjs && node _test/test-self-schedule.mjs && node _test/test-kill-switch.mjs` 全绿
- [ ] 在**隔离的**真实 DSH 实例上装一次（至少：标题随消息更新、回合打标、pin 不覆盖、活开关能停）
- [ ] `node scripts/verify-live.mjs --base <隔离实例> --home <隔离实例 home>` → `LIVE READ-ONLY CHECK PASSED`
      （它核对"内联的协议常量与真实事件是否还一致"——主包升级后这一步最能提前暴露问题）
- [ ] **隐私扫描**：仓库里没有本机路径、机器名、用户名、会话 id、个人称谓、凭据；
      `git grep -nE "[A-H]:[\\\\/]"` 只应命中文档里的通用示例
- [ ] `package.json` 的 `version` 已按第 1 节递增；`peerDependencies` 区间与实测一致
- [ ] **许可三处一致**（若本次动了许可）：① 仓根 `LICENSE`（**官方全文，不改写条款文字**）
      ② README 的许可段 ③ `package.json` 的 `license` 字段（SPDX，如 `AGPL-3.0-only`）；
      并在 CHANGELOG 里写明"哪个版本起换了什么许可"。
      ⚠️ 许可变更**只约束未来版本**：已按旧许可发布的版本，他人已获得的授权收不回来 —— 必须写进 README
- [ ] `cordis.patch.yml.example` 里的 `name` 与 `package.json` 的包名一致
- [ ] `CHANGELOG.md` 已写、日期已填、`BREAKING` 已标注（若有）
- [ ] README 的「兼容性」表格与实测结论一致（哪些版本"已实测"，哪些"预期可用"）
- [ ] 打包内容正确：`npm pack --dry-run` 只应包含 `lib/` `examples/` `cordis.patch.yml.example`
      `README.md` `CHANGELOG.md` `LICENSE`（由 `package.json` 的 `files` 字段控制）

## 4. 发布步骤

```bash
# 1) 版本与记录：改 package.json 的 version、更新 CHANGELOG.md
# 2) 全套验证（见第 3 节）
node scripts/verify-source.mjs .
node scripts/test-e2e.mjs
# 3) 提交与标签
git add -A
git commit -m "release: v0.2.0"
git tag -a v0.2.0 -m "v0.2.0"
git push origin main --tags
# 4) 发布说明：直接贴 CHANGELOG 里本节的正文
```

**要不要同时发 npm，由维护者决定。** 若发 npm：

```bash
npm publish --access public   # 首次发布前确认包名可用、LICENSE/README 已在 files 里
```

> 发 npm 的前提是包名 `dsh-session-title-live` 未被占用，且愿意承担长期可用性承诺。
> 只发 Release（用户 `git clone` 后按 README 手工安装）是更轻的选择。

### 双端发布（Gitee 镜像 + GitHub 主）的四个实测坑

（来自同一条开源支线的先例，仍适用）

1. **Gitee 建仓后默认是私有** —— 即便建仓请求里写了 `private: false`，实测建出来的仍是私有仓
   （表现为"公开仓"其实只有自己能看，匿名 API 一律 `404 Not Found Project`）。
   建仓后必须再显式 PATCH 一次：`PATCH /api/v5/repos/{owner}/{repo}`，**且必须带 `name` 字段**
   （否则报 `{"messages":["name is missing"]}`），body 用 form 编码。
2. **post-publish 复核要看"匿名视角"**：带 token 读得到 ≠ 公开。权威判据 = 匿名读
   `GET /api/v5/repos/{owner}/{repo}` 返回 `private: false`，且匿名能取到文件内容。
3. **重打过的 tag 推送会被拒**（提示像认证失败，其实是 non-fast-forward）→ **只对 tag 用 `--force`**，
   分支仍走非快进保护。
4. **Gitee 不因 push 自动建仓**：目标仓不存在时 push 直接 `404 not found`；建仓只能走 API 或网页。

## 5. 兼容性回归（每次动到事件 / 服务名相关代码时）

改到 `lib/host-protocol.js`、或 `lib/index.js` 里读会话事件（`user/message`、`session/title`、
`turn/*`、`request/header`）的部分时，除了跑第 3 节的三条脚本，**必须**再对一台真实例跑一次
`scripts/verify-live.mjs`。原因：这些名字是主包的**字符串契约**，主包升级可能改名或改形状；
静态检查看不出来，只有对着真实日志读一遍才能确认。

同一条纪律的推论：**任何新出现的事件名 / 服务名，只许加进 `lib/host-protocol.js`**，
不许散落在功能代码里 —— 否则下次升主包时你会漏掉它。
