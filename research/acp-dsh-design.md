# dsh-acp 插件设计蓝图 —— 让 DSH 成为完整 ACP 协议 Agent

> 综合结论文档。事实依据：[dsh-architecture.md](dsh-architecture.md)（DSH 侧 API，全部一手类型声明 + 运行时注册表验证）、[acp-protocol.md](acp-protocol.md)（ACP v1 规范全量，一手规范/schema/SDK/opencode/Zed 源码）、[acp-implementations.md](acp-implementations.md)（opencode / Claude Code adaptor / Gemini CLI 实现模式）。
> 目标：像 opencode 一样，让 Zed / JetBrains / 任何 ACP 客户端完整地驱动 DSH agent：多轮会话、流式输出、工具调用可视化、权限审批、plan、模式切换、会话持久化与恢复。

## 0. 结论（TL;DR）

- **可行且是被预期的**：DSH 的 `ctx.agents.create/resume` 文档原文点名 "ACP bridge"、"ACP-generated id"；approval seam 原文写明 "The ACP automation bridge supplies one-shot machine decisions for sessions it owns"。
- **形态**：一个新包 `dsh-acp`（纯 Host Cordis 插件）+ 一个 profile（`dsh-base` + `dsh-acp`）。进程 = `dsh --profile acp`，stdin/stdout 上跑 NDJSON JSON-RPC（ACP v1），无 Web/HTTP。
- **无需 fork DSH**：全部交互通过公开 service/事件完成；唯一要注意的是 stdio 独占与 `appExit` 生命周期。

## 1. 架构

```
Zed (ACP client)                dsh --profile acp (Host 进程)
  │  NDJSON JSON-RPC (stdin)      │
  │ ◄──────────────────────► │  dsh-acp 插件（本包）
  │                            │   ├─ Connection    @agentclientprotocol/sdk@1.3：agent({name}).onRequest(method, handler).connect(ndJsonStream(stdin, stdout))
  │                            │   │                  handler 收到单上下文对象 {params, signal, client, requestId}
  │                            │   │                  发通知：client.notify('session/update', {sessionId, update})
  │                            │   │                  发请求：client.request('session/request_permission', {...})
  │                            │   ├─ SessionTable  acpSessionId ⇄ {AgentHandle, 前端状态, message 计数}
  │                            │   ├─ EventBridge   'session/event' (agent-scoped) → session/update
  │                            │   ├─ ToolBridge    tool/call|result + tools/execute → tool_call(_update)
  │                            │   ├─ PermBridge    'approval/request' waterfall ⇄ session/request_permission
  │                            │   ├─ ModeBridge    planMode ⇄ modes/configOptions
  │                            │   └─ CommandBridge ctx.commands ⇄ available_commands_update
  │                            │  dsh-base 提供的既有能力：agents/sessions/persistence/approval/
  │                            │  planMode/commands/llm/attachments/sessionQuery/userQuestions
```

> ✅ **传输层已验证**（[spike/sdk/spike.mjs](../spike/sdk/spike.mjs)，真实 SDK 1.3.0 + 进程内双流）：initialize → session/new（modes）→ 流式 agent_message_chunk → A→C `session/request_permission`（含 outcome 回传）→ `session/prompt` 响应 `{stopReason}` 全链路通过。注意 1.3.0 的 API 变化：`AgentSideConnection`/camelCase builder 均为 legacy；正确姿势是 `onRequest('session/prompt', async (rc) => …)`，`rc.signal` 即该请求的 AbortSignal（session/cancel 时 abort——恰好对接 `agent.cancel`）。

进程内数据流（一次 `session/prompt`）：

```
prompt → SessionTable 查 agent → (斜杠? → ctx.commands.execute) → agent.followup(createUserMessage)
  ← 'session/event'（agent-scoped 监听）
      assistant/chunk text-delta      → agent_message_chunk（稳定 messageId）
      assistant/chunk reasoning-delta → agent_thought_chunk
      tool/call                       → tool_call {status:pending, kind, title, locations, rawInput}
      tools/execute waterfall 进入    → tool_call_update {status:in_progress}
      tool/result                     → tool_call_update {status:completed|failed, content, rawOutput}
      todo/write                      → plan {entries}
      usage (assistant/message)       → usage_update
  ← 'approval/request' waterfall（若触发）
      → A→C session/request_permission（prompt 请求挂起期间发出，属正常打断）
      ← outcome {selected|cancelled} → ApprovalOutcome
  turn/end + agent.whenIdle() → 响应 session/prompt {stopReason}
```

## 2. 包结构与组合

```
dsh-acp/
├── package.json          # deps: @agentclientprotocol/sdk, dsh-agent, dsh-session, dsh-llm,
│                         #       dsh-user-approval, dsh-plan-mode, dsh-commands (peer/dep)
├── cordis.patch.yml      # insert 行：id: acp-server（覆盖 system-prompt persona、disable hmr，仿 headless）
└── src/
    ├── index.ts          # Cordis 插件：inject 核心 service，mount Connection，装各 bridge（全部 ctx.effect 可回滚）
    ├── connection.ts     # stdio ↔ ndJsonStream ↔ AgentSideConnection；实现 SDK Agent 接口各方法
    ├── table.ts          # ACP 会话表（id、cwd、AgentHandle、per-message messageId 计数、工具名→kind 表）
    ├── event-bridge.ts   # session/event → 11 种 session/update 变体的翻译器（含 load 回放）
    ├── tool-bridge.ts    # 工具名→ToolKind 映射、title/locations/rawInput 提取、content 换算（diff/image/text）
    ├── perm-bridge.ts    # approval/request ⇄ request_permission；allow_always 的 bridge 内会话级规则缓存
    ├── mode-bridge.ts    # modes + configOptions（mode/model 两类）；current_mode_update / config_option_update
    ├── command-bridge.ts # available_commands_update；prompt 斜杠识别
    └── env.ts            # _meta 扩展（terminal-auth 等）与 authMethods 生成
```

Profile 安装（一次性）：

```bash
dsh plugin --profile acp add dsh-acp        # 生成 $DSH_HOME/profiles/acp（bundles: dsh-base）+ 安装本包
dsh --profile acp                            # Zed 里配 command=dsh, args=[--profile, acp]
```

Zed 配置（`agent_servers` custom 或 ACP Registry）：

```json
{ "type": "custom", "command": "dsh", "args": ["--profile", "acp"], "env": {} }
```

## 3. 关键设计决策

### 3.1 握手与能力声明（`initialize`）

```json
{
  "protocolVersion": 1,
  "agentCapabilities": {
    "loadSession": true,
    "promptCapabilities": { "image": true },           // audio/embeddedContext 暂不声明
    "sessionCapabilities": { "close": {}, "list": {}, "resume": {}, "delete": {} }
  },
  "agentInfo": { "name": "DSH", "version": "<dsh 版本>" },
  "authMethods": [ /* 仅当 DEEPSEEK_API_KEY 缺失：terminal-auth → dsh credentials set */ ]
}
```

- 握手后**没有** `initialized` 通知（规范如此），`available_commands_update` 在首个 session 建立后推送。
- `mcpCapabilities` v1 不声明（DSH 的 `dsh-mcp-client` 接入是 M3）。

### 3.2 会话生命周期

- **new**：`sessionId` 由 bridge 生成（`SessionId('acp-' + uuid())`，满足持久化文件名安全），`meta.cwd` 来自 ACP `cwd`（绝对路径，持久化校验要求）。`mcpServers` v1 接受但暂不挂载（M3 接 `dsh-mcp-client`）。
- **load**：`ctx.sessionPersistence.list()` 校验 → `ctx.agents.resume()` → **响应前**把 `session.events` 折叠回放成 `user_message_chunk` / `agent_message_chunk` / `agent_thought_chunk` / `tool_call`(completed) —— opencode 的回放管线照搬（[acp-implementations.md](acp-implementations.md) 的 replay 模式）。
- **resume**：同 load 不回放（新会话用 `session/resume`；Zed 目前的 UI 主要用 load）。
- **close**：`agent.cancel({kind:'user'})` → `handle.dispose()`。
- **list/delete**：`ctx.sessionQuery.listSessions()` / persistence 删除（delete 需确认后端 API，v1 可不声明 `delete`）。
- **持久化**：DSH 自带 JSONL 持久化（`$DSH_HOME/sessions`），ACP 客户端重启进程后凭同一 sessionId 恢复——天然契合。

### 3.3 prompt 与流式翻译

- **所有 per-agent 监听都在 `ctx.agents.create({setup: (agentCtx) => …})` 里经 `agentCtx.on(...)` 注册**（`session/event`、`approval/request`、`tools/execute`、`agent/request`）——`dsh-scope` 机制保证它们只收到本 agent 的事件、随 agent dispose 自动回滚，bridge 无需自写过滤/清理。
- 斜杠命令：prompt 首块 text 以 `/` 开头且 `ctx.commands.find()` 命中 → `ctx.commands.execute(agent, line, signal)`，完成后直接 `stopReason: end_turn`（命令输出以 tool_call 或 agent_message_chunk 形式回放）；未命中则当普通文本 followup（DSH 的 skill 白名单机制本来就会识别 `/name` token，两种路径都安全）。
- `messageId`：DSH `assistant/message` 的 `message.id`（MessageId 为 branded string）直接作 ACP `messageId`；chunk 按 (turn, step) 分组到该 id；`CallId` 同理直接作 `toolCallId`。
- chunk 兜底：若某 step 无任何 chunk（适配器直接给整块），在 `assistant/message` 事件时补发一次全量 chunk。
- stopReason 映射见 [dsh-architecture.md §3](dsh-architecture.md)；prompt 响应只需 `{stopReason}`。

### 3.4 工具调用

- `tool_call.pending` 在 `tool/call` 事件时发出，字段：
  - `title`：bash→命令首行截断；fs read/edit→相对路径；subagent→description 参数；其余→工具名。
  - `kind`：`bash|pwsh→execute`、`read→read`、`edit|write|str-replace→edit`、`glob|grep→search`、`web_search→fetch`、`subagent|workflow|ralph→think`、`ask_user_question→other`、其余 `other`。
  - `locations`：从参数里的 `file_path`/`path` 提取绝对路径 + line。
  - `rawInput`：`JSON.parse(arguments)`（失败则 `{}`）。
- `in_progress`：agent-scoped `tools/execute` waterfall，进入时发 `{status:'in_progress'}`，`next()` 透传（零侵入）。
- 完成态在 `tool/result`：content 换算——text→`{type:'content',content:{type:'text'}}`；`tool/result.meta` 里 fs 的 diff（`dsh-tool-fs` 携带 result-time diff）→ `{type:'diff', path, oldText, newText}`；`error` → `status:'failed'`。
- **follow-along**（Zed 自动打开文件）：locations 正确即可获得。

### 3.5 权限桥（最关键的差异化正确性点）

- bridge 注册 **agent-scoped** `approval/request` waterfall listener（`ctx.on('approval/request', …)` 于 agent.ctx scope；只处理 SessionTable 里自己创建的 agent，其余 `next()`）。
- 触发时发 `session/request_permission`：
  - options：`[allow_once, allow_always, reject_once, reject_always]`（ask 工具语义是单操作审批，全部给出）。
  - `toolCall` 字段：复用该 callId 已发的 tool_call 信息 + reason。
- 回包映射：`selected(allow_*)`→`'allowed-once'`（**allow_always 需 bridge 在会话内记忆规则**：同 toolName+参数指纹的后续 ask 直接放行——这是 DSH approval "one-shot" 语义之上的 bridge 层约定，不动 DSH 核心）；`selected(reject_*)`→`'rejected'`；`cancelled` / `$/cancel_request`(-32800) → `'cancelled'`。
- `req.signal` abort（turn 被取消）→ 不等 ACP 回包，直接 `'cancelled'`（DSH 侧已定义）。
- **级联取消**：客户端 `session/cancel` 后必须答复所有在途 permission 请求——SDK 的 `$/cancel_request` 处理由 `AgentSideConnection` 提供，bridge 需保证 pending 的 A→C 请求随 turn 取消被 reject。

### 3.6 模式与配置选项（双轨，规范推荐）

同时提供 v1 `modes` 与新 `configOptions`（客户端优先用后者）：

- `modes`：`[{id:'default',name:'Default'},{id:'plan',name:'Plan'}]`；`session/set_mode` → `ctx.planMode.set()`。
- `configOptions`：
  - `{id:'mode', category:'mode', type:'select'}`（default/plan）；
  - `{id:'model', category:'model', type:'select', options: ctx.llm.listModels() 按 provider 分组}`——`session/set_config_option` 设置 model 后，新 turn 用新 options（DSH AgentOptions 在 create 时固定；运行中切模型需确认 agent-loop 支持路径，若无则记为 M2 议题：可能需 dispose+resume 同 id 重建，或走 `agentDefaultModel.saveSelection` + 新 session）。
- 变更后推 `current_mode_update` / `config_option_update`。

### 3.7 plan 与 todo

- DSH `todo/write`（whole-list 快照）→ ACP `plan {entries:[{content, priority:'medium', status}]}`；`TodoItem.status` 三态与 ACP plan entry status（pending/in_progress/completed）直接同构。
- plan mode 的 `exit_plan_mode` 工具调用：天然映射 ACP "switch_mode permission" 模式（[acp-protocol.md §12](acp-protocol.md)）——`tool_call.kind:'switch_mode'` + plan markdown 作为 content；若客户端声明 `elicitation.form` 也可走 `ctx.userQuestions` 的 `plan-review` intent → elicitation 表单。v1 先用 permission 模式（opencode 同款，Zed 渲染最好）。

### 3.8 stdio 纪律与生命周期

- 插件加载即接管 stdin（`process.stdin` readline，NDJSON）；**stdout 只写 ACP**。`dsh-base` 内可能写 stdout 的路径已审计（无——headless 模式已验证唯一 stdout 写者是应用本身）；HMR 行 disable（防 watch 输出）；日志全部走 stderr（`ctx.logger`）。
- 退出：stdin EOF（客户端关进程）→ dispose 所有 AgentHandle → `ctx.appExit(0)`。SIGINT/SIGTERM 由启动器 drain。

## 4. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| **M1 最小可用** | initialize/new/prompt/cancel/close + 流式 chunk + tool_call 生命周期 + approval⇄permission + stopReason | Zed 中对话、看流式、批权限、取消 |
| **M2 会话与命令** | load/resume/list（历史回放）、available_commands（/plan /compact /goal）、modes+configOptions(mode)、plan(todo) 更新、usage_update | Zed 重启会话恢复、模式切换、plan 渲染 |
| **M3 体验补全** | configOptions(model 切换)、图片 prompt（attachments）、elicitation⇄userQuestions、mcpServers 接入（dsh-mcp-client）、session_info_update（标题） | 与 opencode 的 Zed 体验对齐 |
| **M4 高级** | session/fork（映射 `ctx.sessions.fork`）、terminal/create⇄ctx.terminals、subagent modes（agentPresets）、A→C fs/write_text_file（批准编辑推送） | 超齐 opencode |

## 5. 测试策略

- **协议回放测试**：`myClient.connectWith(myAgent, …)` 进程内直连（spike 已验证该模式）或对接内存 Readable/Writable 双流，脚本化客户端发 initialize/new/prompt，断言逐条 notification JSON（与 [acp-protocol.md §23](acp-protocol.md) 清单对表）。
- **模型侧**：DSH repo 的 `@deepseek-ai/dsh-llm-mock-server`（dev dep）或注册 mock LLM adapter 的测试插件，固定 chunk/工具调用脚本。
- **取消竞态**：prompt 中途 cancel × 权限挂起 × stdin EOF 三方组合用例（opencode 的已知坑位，见 acp-implementations.md）。
- **真机验收**：Zed `agent_servers` custom 配置 + `dsh --profile acp`，跑 [acp-protocol.md §23](acp-protocol.md) wire-compatibility checklist。

## 6. 风险清单（合并两份调研的开放问题）

1. **运行中切模型**：`AgentOptions` 在 create 时固定，但已验证**官方替换点**：`agent/request` waterfall（`dsh-agent/runtime-types.d.ts` + `LlmCallConfig` 文档原文 "request waterfalls replace them and the loop logs changed snapshots"）——在 setup 里挂 agent-scoped `agent/request` 监听，返回替换后的 `{...config, provider, model}` 即可实现热切换且持久化为新的 `request/header` 快照。M3 实现此路径，无需 dispose/重建。
2. **allow_always 语义**：bridge 层会话级规则缓存 vs DSH 无 grant store；需在文档中明示边界（跨会话不记忆）。
3. **stdout 独占**：任何第三方插件（profile 里用户自加的）若写 stdout 即破坏协议——文档中要求 acp profile 不加无关插件；可加启动自检（hook process.stdout.write 早检非 ACP 帧）。
4. **load 回放的 messageId 稳定性**：回放与 live 必须用同一 id 生成规则（直接用 DSH `message.id`，天然稳定）。
5. **DSH `blocked` turn**：goal-blocked 语义在 ACP 无对应，统一 `cancelled` + stderr 说明。
6. **ACP 客户端版本差异**：modes vs configOptions 双轨并存（规范过渡期要求）；`elicitation` 仅在 clientCapabilities 声明时启用。
