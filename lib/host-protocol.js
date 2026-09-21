/**
 * dsh-session-title-live / lib/host-protocol.js
 *
 * 主包（dsh）协议常量：本插件所依赖的**会话事件名**与**服务名**。
 *
 * 为什么内联而不 import @deepseek-ai/*：
 *   插件是按 profile 部署的，运行期解析不到全局 npm 里的主包（路径因机器而异）；
 *   官方文档也把事件名/服务名当成字符串契约，而非可 import 的符号。
 *   集中在这一个文件里，主包升级时只需核对这一处（其余代码一律走 EV.* / SVC.*）。
 *
 * 兼容性（主包 0.1.1 ~ 0.1.5 两线实测）：
 *   · 本文件里的事件名与服务名**两线同名**，升级到 0.1.5 线无需改动；
 *   · 与本插件无关的事件族改名（assistant/chunk → assistant/attempt、tool/code-dispatch
 *     → tool/ptc-dispatch 等）不影响本插件，因为本插件只读人类消息、标题与回合边界。
 */

/** 会话事件类型（写进会话日志的名字）。 */
export const EV = Object.freeze({
  /** 会话事件总线（订阅入口；不是写进日志的事件）。 */
  SESSION_EVENT: 'session/event',
  /** 人类（用户）消息。 */
  USER_MESSAGE: 'user/message',
  /**
   * 会话标题（本次折叠后的当前标题）。
   * `data.source.kind` 实测三种取值（对真实实例逐条核对过）：
   *   `user`     = 人工改名，或外部流程在会话创建阶段预置的标题；
   *   `provider` = 自动生成（本插件写出去的也是这个）；
   *   `fallback` = 主包在会话还没有标题时写的**确定性兜底标题**（由首条用户消息派生）。
   * 本插件「人工改名 = pin」的判定只认 `user`，因此 `fallback` 会被正常打标 / 覆盖——这正是期望行为。
   */
  SESSION_TITLE: 'session/title',
  /** 标题生成请求记录（诊断用；本插件写它以便对账"谁发起的生成"）。 */
  SESSION_TITLE_LLM_REQUEST: 'session/title-llm-request',
  /** 回合开始。 */
  TURN_START: 'turn/start',
  /** 回合结束。 */
  TURN_END: 'turn/end',
  /** 主请求头（记录本轮使用的 provider / model）。 */
  REQUEST_HEADER: 'request/header',
});

/** 服务名（ctx 上可用的服务）。 */
export const SVC = Object.freeze({
  /** 模型调用服务（本插件用 ctx.llm.stream 生成标题）。 */
  llm: 'llm',
  /** 会话服务（ctx.sessions.get(id) 取 live 会话）。 */
  sessions: 'sessions',
  /** 标题服务（本插件用 ctx.sessionTitle.register / .get）。 */
  sessionTitle: 'sessionTitle',
});

/** 是不是一个回合的开始（`turn/start`）。 */
export function isTurnStart(type) {
  return type === EV.TURN_START;
}

/** 是不是一个回合的结束（`turn/end`）。 */
export function isTurnEnd(type) {
  return type === EV.TURN_END;
}
