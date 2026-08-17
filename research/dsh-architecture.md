# DSH (DeepSeek Harness) 架构调研 —— 为 ACP 协议插件做准备

> 调研对象：`@deepseek-ai/dsh@0.1.0-rc.6`（安装于 `/Users/liepin/.nvm/versions/node/v24.15.0/lib/node_modules/@deepseek-ai/dsh/`）
> 结论先行：**DSH 的核心架构已经为 "ACP bridge" 预留了全部接入点**——`dsh-agent`、`dsh-user-approval`、`dsh-plan-mode` 等包的官方文档中多次显式提到 "the ACP bridge" / "ACP automation bridge" 作为预期消费者。实现一个完整 ACP agent 不需要 hack，只需要写一个新插件包 + 一个 profile。

## 1. 包总体结构

DSH 是一个 Cordis 插件联邦（monorepo 发布为 ~150 个 `@deepseek-ai/*` 包）：

| 层 | 包 | 职责 |
|---|---|---|
| CLI 启动器 | `@deepseek-ai/dsh`（bin: `dsh`） | 解析 `--profile <name>`，从 `$DSH_HOME/profiles/<name>/` 组合配置树启动 |
| 基础 bundle | `@deepseek-ai/dsh-base` | 所有 profile 共享的核心行：LLM 适配器、session、工具集、持久化、沙箱、审批、settings |
| 模式 bundle | `dsh-web-app`（Web GUI）、`dsh-headless`（一次性任务） | 在 base 之上叠加/覆盖行 |
| 核心 service | `dsh-session`、`dsh-agent`、`dsh-agent-loop`、`dsh-llm`、`dsh-tools` | 会话事件溯源、Agent 注册表与驱动、模型路由、工具管线 |
| 持久化 | `dsh-session-persistence(-jsonl)` | JSONL 事件日志后端，`$DSH_HOME/sessions/` |

### Profile 组合机制（ACP 进程如何启动）

```
$DSH_HOME/profiles/<name>/
├── package.json   # { dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", ...] } } }
└── cordis.patch.yml  # 用户覆盖层（loader patch：insert / id 定位覆盖 / disable）
```

- 每个 bundle 自带 `cordis.patch.yml`（如 `dsh-headless` 的 patch 插入 `headless-runner` 行）。
- 启动：`dsh --profile headless "task"`；`dsh-base` 的行以 `id` 寻址（如 `id: approval`），后续层整行替换 `config`。
- **ACP 方案**：新建 profile（如 `acp`）= `dsh-base` + 新包 `dsh-acp`（ACP stdio server 插件），无 Web/HTTP 行。Zed 以 `dsh --profile acp`（或包自己的 bin shim）启动它。
- 启动器给应用插件注入 `ctx.cmdlineArgs` 与 `ctx.appExit`（headless runner 即如此使用；见 `dsh-headless/lib/index.js`）。

## 2. 核心 API 面（ACP bridge 的对接点）

### 2.1 Agent 注册表 `ctx.agents`（`dsh-agent`）

`AgentRegistry`（`ctx.agents`），工厂由 `dsh-agent-loop` 提供：

- `create(options: CreateAgentOptions): Promise<AgentHandle>` —— **文档原文点名 "e.g. an ACP-generated id"**：
  ```js
  const { agent, dispose } = await ctx.agents.create({
    sessionId: SessionId(`session-${randomUUID()}`), // ACP session/new 的 sessionId 可以直接用
    meta: { cwd },                                   // ACP session/new.cwd（必须是绝对路径）
    agentOptions: { provider, model },               // 模型路由
    setup: (agentCtx) => { /* agent 级组合（模型选择快照等） */ },
  })
  ```
- `resume({ resumeSessionId, agentOptions, setup })` —— 从持久化日志恢复（**ACP `session/load`**）。
- `get(id)` / `list()` / `roots()`。
- `AgentHandle.dispose()` —— 停 loop、注销、删 session、回滚 scoped world（**ACP `session/release`**）。

`Agent` 句柄（`runtime-types.d.ts`）：

| 成员 | ACP 对应 |
|---|---|
| `followup(UserMessage)` — 排队一条新 turn 并唤醒 | `session/prompt` |
| `steer(UserMessage)` — 当前 turn 下一 step 边界插入 | （steering，无直接 ACP 对应；可用于 mid-turn 追加） |
| `inject(UserMessage)` — 只入上下文不唤醒 | （文件变更通知等上下文注入） |
| `cancel(cause, {keepInbox})` | `session/cancel` |
| `whenIdle()` | prompt 完成等待 |
| `status: 'idle' \| 'running'` | 事件流状态 |

驱动模式（headless runner 的标准写法）：
```js
agent.followup(createUserMessage({
  content: [{ type: 'text', text: prompt }],
  source: { kind: 'user' },
}))
await agent.whenIdle()
```

### 2.2 会话事件溯源 `ctx.sessions`（`dsh-session`）

`Session` = append-only `SessionEvent` 日志；**`session/event` Cordis 事件**（scope 过滤到 agent）是 ACP `session/update` 的翻译源：

| SessionEvent | ACP 映射 |
|---|---|
| `turn/start` / `turn/end {reason}` | prompt 生命周期；`reason` → ACP `stopReason` |
| `step/start` / `step/end` | （模型请求边界） |
| `user/message`（UserMessage） | 输入回显（bridge 自己发的 prompt 无需再回显） |
| `assistant/chunk {chunk: StreamChunk}` | `agent_message_chunk` / `agent_thought_chunk` 流式 |
| `assistant/message {message, usage?}` | 组装完成的助手消息（含 token 用量） |
| `tool/call {callId, name, arguments}` | `tool_call`（pending→in_progress） |
| `tool/result {message: ToolResultMessage, error?, meta?}` | `tool_call_update`（completed/failed + 内容块） |
| `todo/write {todos: TodoItem[]}` | ACP `plan` 更新（whole-list 快照，天然契合 plan entries） |
| `request/header` / `request/context` | 模型路由变化（内部） |
| `session/end-seed` | resume/fork 边界（内部） |

**`TurnEndReason`（merge-extensible）→ ACP stopReason 映射建议**：
- `completed` → `end_turn`
- `aborted`（reason.user）→ `cancelled`
- `max-tokens` → `max_tokens`
- `error` → `end_turn` + 错误文本 chunk（或 `refusal`，与 opencode 的做法对齐——见 acp-implementations.md）
- `blocked` / `interrupted` → `cancelled` / `end_turn`

**StreamChunk**（`dsh-llm/types.d.ts`）：
- `text-delta {index, text}` → `agent_message_chunk {content:{type:'text'}}`
- `reasoning-delta {index, text}` → `agent_thought_chunk`（DSH 原生区分思考流！）
- `tool-call-delta {id, name?, argumentsDelta}` → `tool_call` 的 rawArgs 增量（ACP `rawArgs` + `locations`）
- `block-start`/`block-end`/`usage`/`finish` → 内部

**内容块**（`ContentBlockMap`）：`text` / `reasoning` / `image`（attachment 引用）/ `tool-call` / `tool-result`。ACP 侧 text/resource_link/image 的换算在 bridge 内做（工具结果里的文件路径 → `resource_link`）。

### 2.3 持久化 `ctx.sessionPersistence`（`dsh-session-persistence`）

- `list()` / `listSnapshots()` — 枚举已存 session（`session/load` 前的 id 校验/列表）
- `inspect(id)` — 只读检查；`prepare(id)` → `SessionPreparation`（resume 用）
- 实际恢复直接用 `ctx.agents.resume({ resumeSessionId })`（工厂内部走 `sessionPersistence.prepare`）
- JSONL 后端 mounted at `$DSH_HOME/sessions`（`dsh-base` patch：`session-persistence-jsonl` 行）

### 2.4 审批（权限）`ctx.approval`（`dsh-user-approval`）—— ACP `session/request_permission` 的对接口

**这是最关键的设计契合点**。README 原文：

> Answerers are `approval/request` waterfall listeners. … **The ACP automation bridge supplies one-shot machine decisions for sessions it owns.**

- 工具链在 `ask` 策略下经 `ctx.approval.request({agent, toolName, callId?, reason?, signal?})` 询问；waterfall 监听者返回 `ApprovalOutcome` 或 `next()` 透传。
- `ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`。
- **ACP bridge 的做法**：注册 agent-scoped 的 `approval/request` 监听 → 转成 ACP `session/request_permission`（options: allow_once / allow_always(映射为本次 allow) / reject_once / reject_always）→ 客户端答复映射回 outcome。`req.signal` abort → `cancelled`。
- 沙箱升级重试（`sandbox_permissions`）也走同一 seam。
- 策略：`ApprovalPolicy = 'ask' | 'never'`，`ctx.approval.setPolicy(agent, policy)`；`approval/asked`/`approval/decided` 是 log-only 审计事件。
- 注意：只有 one-shot grant（无 allow-always 存储）→ ACP 的 `allow_always` 只能当作本次允许处理（DSH 侧无 grant store，README 明确为 deferred work）。

### 2.5 计划模式 `ctx.planMode`（`dsh-plan-mode`）—— ACP modes 的对接点

- `ctx.planMode.set(agent, active)` → 提交/排队 `plan/mode` 事件；`get(agent)` → `{active, pending?}`。
- README：“**other entry points may drive the same service directly** without defining a second mode vocabulary” —— ACP `session/set_mode`（modeId `plan`）直接映射。
- ACP 模式清单：primary `default`（kind: primary）+ secondary `plan`；`current_mode_update` 在 `plan/mode` 事件时推送。
- `exit_plan_mode` 工具走 `ctx.userQuestions` 审批 → ACP 侧可呈现为普通 tool_call（Zed 原生渲染 plan 审批的是 `session/request_permission` 或 plan 更新，按 acp-protocol.md 的细节定）。

### 2.6 命令 `ctx.commands`（`dsh-commands`）—— ACP `available_commands_update`

- `ctx.commands.list(agent): CommandDescriptor[]`（name/description/input hint）→ 初始化后推送一次 `available_commands_update`。
- `ctx.commands.execute(agent, line, signal)` → ACP 客户端 `/plan …`、`/compact`、`/goal` 等斜杠命令直接执行（不进模型）。
- 注意：`dsh-command-feedback` README 明说 “headless mode, **ACP automation**, and JSON-RPC do not provide a command adapter”——即 ACP bridge 自己决定暴露哪些命令。

### 2.7 子代理 `ctx.subagents`（`dsh-subagent`）—— ACP subagent modes（后续）

- `start`/`startContinuable`/`followup`/`interrupt`/`reportFrom`/`listChildren`；provider `spawn`（不继承历史）/`fork`（继承）。
- 新 ACP 规范的 subagent modes 可映射 continuable children；v1 可不做（modes 只报 primary+plan）。

### 2.8 其他相关服务（经运行时 Inspect 注册表交叉验证）

- `ctx.agentDefaultModel.currentSelection()` → `initialize` 后创建 agent 的默认 `{provider, model}`；`installModelSelection(agentCtx, …)` setup 写法照抄 headless。
- `ctx.agentPresets`（`dsh-agent-presets`）— `list()` / `resolve(id?)` / `mount(agentCtx, id?)`：按 agent 组合 preset。ACP 的 subagent modes（新规范）可直接映射 presets；v1 可不挂。
- `ctx.userQuestions`（`dsh-user-questions`）— `ask_user_question` 工具的提问 seam；**`AskUserQuestionIntent` 内置 `plan-review`（带 `approve` 选项标签）**——ACP bridge 可注册 provider，把 plan-review 呈现为 ACP 侧的 plan 审批/权限请求，普通问题作为 tool_call 展示。
- `ctx.shellEnv.register(contributor)`（`dsh-shell-env`）— 为每次 bash 执行注入 `DSH_*` 变量。注意 ACP v1 **没有** `session/set_environment`（env 只随 `mcpServers[].env`/`terminal/create.env` 到达）；此 seam 可用于把 ACP mcpServers env 或自定义 config option 传导到工具执行，或作 Zed `_meta` 扩展的自定义通道。
- `ctx.attachments.saveImage/readImage`（`dsh-attachment-local`）— ACP prompt 里的 image 块可存为 attachment 再进 `createUserMessage` 的 `ImageBlock`；工具结果图片同理回传。
- `ctx.sessionQuery.listSessions()/readTitle`（`dsh-session-query`）— `session/load` 前的 id 校验与标题回显。
- `ctx.sessionTitle.rename(session, title)` — 可选：用 ACP 会话上下文命名 DSH session。
- `dsh-sandbox-policy` / `ctx.permissionPresets`（`dsh-permission-presets`）— `read-only`/`workspace-write`/`danger-full-access` × `ask`/`never`；ACP 无沙箱概念，保持 DSH 侧配置即可（可用 `session/set_mode` 的 permission updates 联动，进阶项）。
- `ctx.terminals`（`dsh-terminal`）— PTY 服务；ACP 的 `terminal/start` 反向请求可映射（可选能力，不声明则客户端不发送）。
- `dsh-mcp-client` 存在 → ACP `session/new` 的 `mcpServers` 可在 create 前/agent setup 中挂载（进阶项）。
- `ctx.typertGateway`（`dsh-api-gateway`）— Web 的 RPC 面，ACP 不需要（stdio 自己开 JSON-RPC）。

## 3. DSH ↔ ACP 方法级映射总表（已按 ACP v1 真实规范校正）

> ⚠️ 命名校正（依据 [acp-protocol.md §1](acp-protocol.md)）：Zed 的 ACP **没有** `initialized` 通知（握手只有一次 initialize 请求/响应）、没有 `session/set_environment`（env 只随 `mcpServers[].env` 与 `terminal/create.env` 到达）、没有 `session/release`（是 `session/close`）、没有 `session/abort`（是 `session/cancel` **通知**）、没有 `agent/permissions/list`、没有 `workspace/diagnostics`；terminal 反向方法是 `terminal/create|output|wait_for_exit|kill|release`。这些名字全部来自 Block/Goose 的同名协议。

| ACP（client→agent，v1 稳定） | DSH bridge 实现 |
|---|---|
| `initialize` | 返回 `protocolVersion: 1`、`agentCapabilities {loadSession: true, promptCapabilities {image, audio, embeddedContext}, sessionCapabilities {close, list, resume, delete?}}`、`authMethods`（DEEPSEEK_API_KEY 缺失时给 terminal-auth 方式）；**握手后不等任何 initialized 通知** |
| `authenticate` / `logout` | 缺 key 时经 `_meta["terminal-auth"]`（`dsh credentials set`）或写 `$DSH_HOME/.credentials.yaml`（进阶） |
| `session/new {cwd, mcpServers, additionalDirectories?}` | `ctx.agents.create({sessionId: SessionId(新生成), meta:{cwd}, …})`；响应带 `modes` + `configOptions`（mode/model） |
| `session/load {sessionId, cwd}` | `ctx.sessionPersistence` 校验存在 → `ctx.agents.resume({resumeSessionId})` → **响应前必须先回放全部历史**（`user_message_chunk`/`agent_message_chunk`/tool_call 回放，从 `session.events` 折叠） |
| `session/resume {sessionId}` | 同 load 但**不回放**（直接复用 DSH resume） |
| `session/list` / `session/delete` | `ctx.sessionQuery.listSessions()` / 持久化删除（v1 可选能力） |
| `session/close {sessionId}` | 取消在途工作 + `AgentHandle.dispose()` |
| `session/prompt {prompt: ContentBlock[]}` | 斜杠开头 → `ctx.commands.execute`（再按需 followup）；否则 `agent.followup(createUserMessage(…))`；**请求保持到 turn 结束**（`turn/end` + `whenIdle`）→ 响应 `{stopReason}` |
| `session/set_mode {modeId}` | `default` ↔ `plan`：`ctx.planMode.set(agent, bool)`；变更折叠到 `plan/mode` 事件 → 发 `current_mode_update` |
| `session/set_config_option {configId, value}` | `mode`（映射 planMode）；`model`（`ctx.llm.listModels()` → 重设 agent options / 新 turn 生效）；响应必须返回**完整** configOptions |
| `session/cancel`（notification） | `agent.cancel({kind:'user'})`；在途 `session/request_permission` 用 `$/cancel_request` 级联取消；prompt 以 `stopReason: cancelled` 收尾（不是 error） |

| ACP（agent→client） | DSH 事件源 |
|---|---|
| `session/update: user_message_chunk` | 主要用于 `session/load` 回放（DSH `user/message` 事件重放） |
| `session/update: agent_message_chunk` | `assistant/chunk` 的 `text-delta`（同 step 内聚合到稳定 `messageId`） |
| `session/update: agent_thought_chunk` | `assistant/chunk` 的 `reasoning-delta` |
| `session/update: tool_call`（pending） | `tool/call` 事件（title/kind/locations/rawInput 由工具名+参数推导；kind 映射：bash→execute、read→read、edit/write→edit、glob/grep→search、web→fetch、subagent→think、其余 other） |
| `session/update: tool_call_update`（in_progress） | agent-scoped `tools/execute` waterfall 监听（执行真正开始时）或合成 |
| `session/update: tool_call_update`（completed/failed） | `tool/result`（content 块换算：text→text、fs 元数据 diff→diff、图片→image；`error` → failed） |
| `session/update: plan` | `todo/write`（TodoItem{content,status} → entries[{content,priority:'medium',status}]，v1 plan 无 id/整体 status） |
| `session/update: available_commands_update` | `ctx.commands.list(agent)`（在 session 建立/命令集变化后推送） |
| `session/update: current_mode_update` | `plan/mode` 事件折叠 |
| `session/update: config_option_update` | 模型切换/plan mode 变化后全量推送 |
| `session/update: usage_update` | `assistant/message` 的 `usage`（TokenUsage→ACP usage 字段） |
| `session/update: session_info_update` | 可选：`ctx.sessionTitle` 首题生成后回填标题 |
| `session/request_permission`（A→C 请求） | agent-scoped `approval/request` waterfall 监听 → 选项 `[allow_once, allow_always, reject_once]`（allow_always 需 bridge 内记忆规则）；`ApprovalOutcome` ↔ outcome 映射（cancelled↔cancelled、unavailable→cancelled） |
| `elicitation/create`（form；2026 稳定） | 若客户端声明 `elicitation.form`：`ctx.userQuestions` provider 注册 → `AskUserQuestionItem`（options/multiSelect）→ 表单 schema；客户端不支持时降级为 tool_call 内容展示 |
| `fs/read_text_file` / `fs/write_text_file`（A→C） | 可选声明；opencode 用 write 把批准的编辑推给编辑器。DSH v1 可不声明（自有 fs 工具） |
| `terminal/create` 等（A→C） | 可选声明；可映射 `ctx.terminals`（PTY）；不声明则客户端不发送 |

**stopReason 映射（DSH `turn/end.reason` → ACP）**：`completed`→`end_turn`；`aborted`(user)→`cancelled`；`max-tokens`→`max_tokens`；`error`→`end_turn` + stderr 日志 + 错误文本 chunk（或 `refusal` 仅当 provider 语义是拒绝）；`blocked`/`interrupted`→`cancelled`/`end_turn`。

## 4. 进程形态与工程落点

1. **新 npm 包** `dsh-acp`（本仓库 `dsh-acp`）：纯 Host 插件（无浏览器 UI），依赖 `@deepseek-ai/dsh-agent`、`dsh-session`、`dsh-llm`、`dsh-user-approval`、`dsh-plan-mode`、`dsh-commands`、`@agentclientprotocol/sdk@1.3.0`（**官方 SDK 已迁至 agentclientprotocol org**，提供 `AgentSideConnection`/`ndJsonStream`/`Agent` 接口与类型；旧名 `@zed-industries/agent-client-protocol@0.4.5` 停在 0.x）。
2. **profile 安装**：`$DSH_HOME/profiles/acp/package.json` bundles = `dsh-base` + `dsh-acp`；或给现有 web/headless profile 加一行 patch（不建议——ACP 进程必须独占 stdin/stdout，且不启动 Web）。
3. **stdio**：Host 进程直接读 stdin/写 stdout（newline-delimited JSON-RPC）。headless 模式证明该形态可行（无监听端口、无浏览器）。注意：**绝不能让任何其他插件写 stdout**（session-title-llm、telemetry 均为内部，安全；但 `dsh-base` 的 HMR 行建议 disable，与 headless 一致）。
4. **生命周期**：`ctx.appExit` 请求退出；SIGINT/SIGTERM 由启动器处理（base 已含 drain）。
5. 模型路由沿用 `agentDefaultModel` + settings（`$DSH_HOME/settings.yaml`），与 Web 配置共享——Zed 用户无需二次配置。

## 5. 风险与开放问题

- **DSH 无 “tool 执行开始” 事件**：`tool/call`（请求）→ `tool/result`（完成）。ACP 的 `in_progress` 态需 bridge 合成（收到 tool/call 即发 pending+in_progress），或监听 `tools/execute` waterfall 精确补态。
- **allow_always 无存储**：DSH approval 只有 one-shot；ACP `allow_always` 选项可给出但按本次允许处理（或在 bridge 内自建 per-session 记忆，注意与 DSH fail-closed 语义的边界）。
- **stopReason 词汇**：DSH `blocked`/`interrupted` 在 ACP 无直接对应，需定死映射表。
- **图片**：ACP prompt 可带 image；DSH 用户消息支持 `ImageBlock`，但需要 attachment 服务写入字节——`ctx.attachments`（`dsh-attachment-local`）已挂载，v1 可先 text。
- **`assistant/message` 与 chunk 双通道**：ACP 只需要流式 chunk + 结束；以 chunk 为主、message 兜底（某些步骤可能无 chunk）。
- **session id 冲突**：`ctx.agents.create` 用 ACP 传入 id 直接做 SessionId（文档背书），但需处理与已存在持久化 id 冲突的报错路径。

## 6. 来源

- 安装包类型声明与源码（均为一手来源，路径以 `$PKG = ~/.nvm/versions/node/v24.15.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai` 缩写）：
  - `$PKG/dsh-agent/lib/types/{index,runtime-types}.d.ts` — AgentRegistry/Agent（"ACP bridge"、"ACP-generated id" 原文）
  - `$PKG/dsh-session/lib/types/{index,types}.d.ts` — SessionEventMap/TurnEndReason/SessionStore
  - `$PKG/dsh-llm/lib/types/{types,message}.d.ts` — StreamChunk/ContentBlock/createUserMessage
  - `$PKG/dsh-user-approval/README.md` + `lib/types/index.d.ts` — approval seam（"The ACP automation bridge supplies one-shot machine decisions"）
  - `$PKG/dsh-plan-mode/README.md` — plan mode service
  - `$PKG/dsh-session-persistence/lib/types/index.d.ts` — persistence API
  - `$PKG/dsh-subagent/README.md` — subagent seam
  - `$PKG/dsh-commands/lib/types/index.d.ts` — 命令注册表
  - `$PKG/dsh-headless/lib/index.js` + `cordis.patch.yml` — 无头驱动标准范式
  - `$PKG/dsh-base/cordis.patch.yml` — 基础组合清单（approval/sandbox/persistence/tools 行）
  - `$PKG/dsh-agent/README.md` — "consumers (UI, the ACP bridge)" 原文
