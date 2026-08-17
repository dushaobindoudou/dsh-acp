# ACP 实现调研：Claude Code Adaptor / opencode / Gemini CLI / 官方 TS SDK

> 由后台调研代理对各仓库固定 commit 的一手源码编译而成（GitHub 源码直读）。本文件由 sections/ 五个分节合并；各节自带内联源码链接。配套文档：[acp-protocol.md](acp-protocol.md)（协议规范）、[dsh-architecture.md](dsh-architecture.md)（DSH 侧 API）、[acp-dsh-design.md](acp-dsh-design.md)（插件设计蓝图）。

## 目录

1. Claude Code ACP adaptor（zed-industries/claude-code-agent）
2. opencode ACP server（sst/opencode）
3. Gemini CLI ACP mode（google-gemini/gemini-cli）
4. 官方 TypeScript SDK（agentclientprotocol/typescript-sdk）
5. 新 ACP server 实现的可复制模式（蓝图）

---

# How real-world coding agents implement ACP as a server

> Research notes, compiled from primary sources (GitHub source code at pinned commits).
> Scope: four implementations — Zed's Claude Code ACP adapter, opencode, Gemini CLI, and the
> official TypeScript SDK. Web search was unavailable during research; every claim below comes
> from the local clones of the repositories at the cited commits.

**Repo snapshot / permalink bases:**

| Project | Repo @ commit (permalink base) | ACP SDK used |
| --- | --- | --- |
| Claude Code adapter | [`zed-industries/claude-code-acp @ 59a7e93`](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/) | `@agentclientprotocol/sdk` 1.3.0 + `@anthropic-ai/claude-agent-sdk` 0.3.232 |
| opencode | [`sst/opencode @ 1c96545`](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/) | `@agentclientprotocol/sdk` 0.21.0 |
| Gemini CLI | [`google-gemini/gemini-cli @ 9a15c45`](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/) | `@agentclientprotocol/sdk` 0.16.1 |
| Official TS SDK | [`agentclientprotocol/typescript-sdk @ 7585334`](https://github.com/agentclientprotocol/typescript-sdk/blob/7585334c5b738868583d561bdfc97caf77a3f3ba/) + spec repo [`agentclientprotocol/agent-client-protocol @ 8e3eb8f`](https://github.com/agentclientprotocol/agent-client-protocol/blob/8e3eb8f23b84d367b5a3fe738dacdf7f535d2a5d/) | — (this *is* the SDK) |

**Naming history (important for anyone following old links):**
- `zed-industries/claude-code-agent` was **renamed to [`zed-industries/claude-code-acp`](https://github.com/zed-industries/claude-code-acp)**; npm package `@zed-industries/claude-code-acp` (0.16.x) became [`@agentclientprotocol/claude-agent-acp`](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp) (0.69.0 at research time) — see [`package.json`](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/package.json). The old repo URL no longer clones.
- `zed-industries/agent-client-protocol` (npm `@zed-industries/agent-client-protocol`, last 0.4.5) moved to the **`agentclientprotocol` org** and split: the spec/schema repo is [`agentclientprotocol/agent-client-protocol`](https://github.com/agentclientprotocol/agent-client-protocol) (npm `@agentclientprotocol/schema`, private) and the TS SDK is [`agentclientprotocol/typescript-sdk`](https://github.com/agentclientprotocol/typescript-sdk) (npm `@agentclientprotocol/sdk`, 1.x) — per its own [`package.json` repository field](https://github.com/agentclientprotocol/agent-client-protocol/blob/8e3eb8f23b84d367b5a3fe738dacdf7f535d2a5d/package.json#L7-L13).

---

## 1. Claude Code ACP adapter (zed-industries/claude-code-acp, formerly claude-code-agent)

An ACP agent that wraps the **Claude Agent SDK** (which itself spawns and drives the Claude Code
CLI process). npm: `@agentclientprotocol/claude-agent-acp`; deps `@agentclientprotocol/sdk` 1.3.0
and `@anthropic-ai/claude-agent-sdk` 0.3.232 ([package.json](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/package.json)).

### 1.1 Entry point / process start

- The binary is `claude-agent-acp` → `dist/index.js` ([package.json `bin`](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/package.json)). No flags are needed to run the ACP server; a special `--cli <args...>` flag **delegates to the wrapped native CLI** by spawning it with forwarded args and signal forwarding ([src/index.ts:10-39](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/index.ts#L10-L39)); `--version`/`-v` prints the adapter version ([src/index.ts:40-42](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/index.ts#L40-L42)).
- Before starting the server it applies managed-policy env vars via the SDK's `resolveSettings` and — critically — **redirects all `console.*` to stderr so stdout stays a clean ACP channel** ([src/index.ts:44-58](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/index.ts#L44-L58)).
- Startup: `runAcp()` builds the connection, then `connection.closed.then(shutdown)` plus SIGTERM/SIGINT handlers dispose the agent, and `process.stdin.resume()` keeps the loop alive ([src/index.ts:64-83](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/index.ts#L64-L83)). The stdin-EOF → clean-exit path exists specifically to avoid orphan processes ([comment, src/index.ts:73-76](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/index.ts#L73-L76)).

### 1.2 Architecture / JSON-RPC over stdio

- `runAcp()` wires **ndjson over stdio** with Web streams: `nodeToWebWritable(process.stdout)` + `nodeToWebReadable(process.stdin)` → `ndJsonStream(...)` ([src/acp-agent.ts:8678-8682](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L8678-L8682)).
- Method handlers are registered with the SDK 1.x builder API: `acpAgent({ name: "claude-code-acp" }).onRequest(methods.agent.initialize, ...)... .connect(stream)` — covering `initialize`, `session/new`, `session/load`, `session/fork`, `session/list`, `session/delete`, `session/resume`, `session/close`, `session/setMode`, `session/setConfigOption`, `authenticate`, `providers.*`, `logout`, `session/prompt` (request) and `session/cancel` (notification), plus extension methods (`steer`, goal control) ([src/acp-agent.ts:8692-8724](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L8692-L8724)).
- Agent→client calls go through a small `AcpClient` interface (`sessionUpdate`, `requestPermission` (with `AbortSignal` → `$/cancel_request`), `readTextFile`, `writeTextFile`, elicitation, extension notifications) implemented by `ClientConnection` wrapping `connection.client` (`ctx.notify`/`ctx.request`) ([src/acp-agent.ts:1428-1496](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L1428-L1496)).
- **It does not parse the CLI's output itself**: the Claude Agent SDK's `query({ prompt: input, options })` runs the CLI child process and yields typed SDK messages; the adapter translates them ([src/acp-agent.ts:6466-6469](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L6466-L6469)). The prompt input is a **pushable stream** (`Pushable<SDKUserMessage>`) that stays open for the session's lifetime so prompts/steers can be injected ([src/acp-agent.ts:6178](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L6178)).

### 1.3 Sessions ↔ ACP sessions

- `session/new` → `createSession()`: the adapter **generates its own ACP sessionId** (`randomUUID()`) and passes it down as the SDK session id (`options.sessionId = sessionId`) so both layers share one id; on resume it adopts the SDK id instead ([src/acp-agent.ts:6166-6176](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L6166-6176), [6456-6459](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L6456-L6459)). It validates `cwd` (absolute + exists) up front ([src/acp-agent.ts:6160-6165](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L6160-L6165)).
- The response carries `{ sessionId, modes, configOptions }` — ACP modes (default/acceptEdits/plan/bypassPermissions…) and new-style config options (model/effort/mode/agent/fast-mode pickers) ([src/acp-agent.ts:6718-6722](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L6718-L6722), [`buildConfigOptions` usage 6626-6634](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L6626-L6634)).
- Client MCP servers from `session/new` are translated 1:1 into SDK `mcpServers` (http/sse/stdio) ([src/acp-agent.ts:6185-6209](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L6185-L6209)); `additionalDirectories` merges ACP's field with a legacy `_meta.additionalRoots` extension ([src/acp-agent.ts:6279-6284](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L6279-6284), [6450-6454](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L6450-L6454)).
- **session/load**: `loadSession()` re-attaches via `getOrCreateSession` (resume path uses the SDK's persisted session files) and then **replays history** to the client as ordinary `session/update` notifications (`replaySessionHistory`), sending `available_commands_update` only after replay so it doesn't interleave with history ([src/acp-agent.ts:1730-1741](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L1730-L1741)). `listSessions` exposes the CLI's persisted sessions (id, cwd, sanitized title, updatedAt) ([src/acp-agent.ts:1743-1759](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L1743-L1759)); a failed resume for an unknown id becomes ACP `resource_not_found` ([src/acp-agent.ts:6471-6484](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L6471-L6484)).

### 1.4 Prompt handling & concurrency

- `session/prompt` converts prompt parts to an SDK user message (`promptToClaude`), stamps a `uuid`, wraps it in a **Turn** with a deferred promise, pushes onto `session.turnQueue` **and onto the SDK input stream**, then awaits the deferred — i.e. prompts **queue** rather than error when concurrent; a persistent per-session consumer task drains the SDK message stream and settles turns ([src/acp-agent.ts:1943-2004](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L1943-L2004), consumer at [2181-2187](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L2181-L2187)).
- A closed SDK stream makes `prompt()` fail fast with a structured "session ended" internal error instead of hanging ([src/acp-agent.ts:1948-1953](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L1948-L1953)).
- **Steering extension**: an extension request injects a follow-up message into the *running* turn (priority `now`, echo-suppression via uuid tracking, settle at SDK `idle`), or starts a detached turn when idle — with a host opt-in `promptRequired` idle behavior ([src/acp-agent.ts:2080-2166](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L2080-L2166)).
- Slash commands that are "local-only" (e.g. `/clear`) return a result without a model turn; the consumer detects them so the turn settles from the result rather than a message echo ([src/acp-agent.ts:1963-1967](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L1963-1967)).

### 1.5 Streaming: SDK events → session/update

- Partial assistant messages (`SDKPartialAssistantMessage`, i.e. Anthropic-style stream events) map in `streamEventToAcpNotifications`: `content_block_start` → emit the block; `content_block_delta` text/thinking deltas → chunks; `input_json_delta` → incremental `tool_call_update` refinements of the *partially parsed* tool input (a hand-rolled streaming JSON scanner emits only complete top-level fields, and suppresses the final refinement because the consolidated message replays it) ([src/acp-agent.ts:8502-8644](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L8502-L8644), scanner at [1028-1076](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L1028-L1076)).
- `toAcpNotifications` maps consolidated content blocks: `text` → `agent_message_chunk`; `thinking` → `agent_thought_chunk`; `image` → image content; `tool_use` → `tool_call` (first surface) or `tool_call_update` (later surfaces); `tool_result` → `tool_call_update` with completed/failed status ([src/acp-agent.ts:8051-8300](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L8051-L8300)).
- **De-dup is a first-class concern**: an `emittedToolCalls` set ensures a permission request that eagerly emitted a `tool_call` and the later streamed `tool_use` don't both emit; the second surface becomes a `tool_call_update` ([src/acp-agent.ts:8064-8070](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L8064-8070), [8260-8285](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L8260-L8285)).
- `TodoWrite` tool uses map to ACP `plan` updates (entries from todos) instead of tool calls ([src/acp-agent.ts:8199-8206](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L8199-8206), [`planEntries` in src/tools.ts:1047](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/tools.ts#L1047)); the newer Task* tools feed the same plan via hooks ([src/acp-agent.ts:6423-6444](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L6423-L6444)).
- **Subagent transcripts**: with client capability `clientCapabilities._meta["subagent-transcript"]`, nested subagent text/thinking/tool calls are forwarded with `_meta.claudeCode.parentToolUseId` relating them to the spawning Agent/Task call; Agent/Task calls get `_meta.claudeCode.subagent = true` ([README](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/README.md), [`supportsSubagentTranscript` src/acp-agent.ts:971-989](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L971-989)).

### 1.6 Tool mapping

`toolInfoFromToolUse` ([src/tools.ts:131-330+](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/tools.ts#L131-L330)) maps Claude tools to ACP tool kinds/contents:

| Claude tool | ACP kind | Content |
| --- | --- | --- |
| `Agent`/`Task` (subagent) | `think` | prompt text ([tools.ts:139-155](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/tools.ts#L139-L155)) |
| `Bash` | `execute` | `terminal` content (`terminalId` = toolUse id) when the client advertises `_meta.terminal_output`, else the command description ([tools.ts:157-173](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/tools.ts#L157-L173)) |
| `Read` | `read` | `locations` with path+line ([tools.ts:175-197](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/tools.ts#L175-L197)) |
| `Write` | `edit` | `diff` content with `oldText: null` ([tools.ts:199-226](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/tools.ts#L199-L226)) |
| `Edit` | `edit` | `diff` content from `old_string`/`new_string` ([tools.ts:228-248](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/tools.ts#L228-L248)) |
| `Glob`/`Grep` | `search` | — ([tools.ts:250-330](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/tools.ts#L250-L330)) |

- Edit/Write diffs get **refined at result time**: a `PostToolUse` hook receives the CLI's `structuredPatch` and emits a `tool_call_update` carrying the real diff (Write's optimistic "creation" diff is replaced by an authoritative update diff) ([src/acp-agent.ts:8212-8250](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L8212-L8250)).
- Tool results map to `tool_call_update` with `status: completed|failed` and `rawOutput` content; unknown/untracked tool_use ids still get resolved (completed/failed) so no call stays pending forever ([src/acp-agent.ts:8290-8332](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L8290-L8332)).

### 1.7 Permissions

- The SDK's `canUseTool` callback is the single funnel. For ordinary tools it sends `session/request_permission` with options `reject_once` ("Deny"), `allow_once` ("Allow Once"), `allow_always` ("Always Allow", with `_meta.permission` describing exactly which rules would be persisted and where — session/user/project scopes) ([src/acp-agent.ts:5575-5608](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L5575-L5608)).
- The ACP response maps back to an SDK `PermissionResult`: `allow` → `{behavior: "allow", updatedInput}`; `allow_always` → allow + `updatedPermissions` (the SDK's `suggestions`, or a synthesized `addRules` allow rule) ; deny/cancel → `{behavior: "deny", message}` ([src/acp-agent.ts:5609-5640](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L5609-L5640)).
- **Permission-request cancellation**: the SDK's abort `signal` is forwarded to the client call as a `cancellationSignal`, which sends `$/cancel_request` so the client dismisses the dialog when the turn is cancelled ([AcpClient docs, src/acp-agent.ts:1430-1436](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L1430-L1436)); an aborted signal → throw "Tool use aborted" ([5521-5523](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L5521-L5523)).
- The request's `toolCall` payload is built by `toolInfoFromToolUse` and the tool_call is **eagerly emitted before asking** (`ensureToolCallEmitted`) so the permission dialog references a call the client has already seen ([src/acp-agent.ts:5453-5467](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L5453-5467)).
- Subagent tool calls are attributed to the spawning Agent/Task call via `parent_tool_use_id` bookkeeping in `liveBackgroundTasks` ([src/acp-agent.ts:5433-5451](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L5433-5451)).

### 1.8 Mode & plan mapping

- ACP modes == Claude Code permission modes (`default`, `acceptEdits`, `plan`, `bypassPermissions`, plus newer `auto`/`dontAsk` gated on model capabilities); `session/set_mode` validates against `availableModes` then calls `query.setPermissionMode(modeId)` and updates the mode config option ([src/acp-agent.ts:4978-4996](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L4978-L4996), [5097-5128](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L5097-L5128)).
- **Plan mode via ExitPlanMode tool**: when the model calls `ExitPlanMode`, the adapter sends a permission request whose options *are* mode choices — "Yes, and use auto mode" / "auto-accept edits" / "manually approve edits" / "No, keep planning" (+bypass when allowed) — then, on selection, sends `current_mode_update`, syncs the mode config option, and returns `{behavior:"allow", updatedPermissions:[{type:"setMode", mode: <chosen>, destination:"session"}]}`; rejection denies the tool ([src/acp-agent.ts:5470-5556](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L5470-L5556)).
- Conversely, when the CLI enters plan mode itself, a `PostToolUse` hook emits `current_mode_update: plan` ([src/acp-agent.ts:6396-6413](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L6396-L6413)).
- `bypassPermissions` needs `allowDangerouslySkipPermissions: ALLOW_BYPASS` on the query (not available as root); in bypass mode remaining asks are auto-allowed except rule-forced asks ([src/acp-agent.ts:6355-6358](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L6355-L6358), [5558-5573](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L5558-L5573)). Settings `permissions.defaultMode` is resolved with alias mapping + root guard by `resolvePermissionMode` ([src/acp-agent.ts:1269-1302](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L1269-L1302)).

### 1.9 Stop reasons

The turn's stop reason is computed in the consumer from SDK result messages: default `end_turn`; `max_tokens` from `stop_reason`; `refusal` (with an explanation chunk appended); `max_turn_requests`; and `cancelled` on abort paths — then resolved into the `session/prompt` response as `{stopReason, usage}` ([src/acp-agent.ts:3850-3868](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L3850-L3868), [3904-3906](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L3904-L3906), [3952-3968](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L3952-L3968), [3983-4043](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L3983-L4043), cancel resolves at [4716](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L4716)).

### 1.10 Cancellation

`session/cancel` (notification) sets `session.cancelled`, tracks orphaned steered messages, and calls `session.query.interrupt()`, using the interrupt **receipt** (`still_queued`) to reconcile which queued turns were dropped; a force-cancel timer (grace period) wedges the loop to settle "cancelled" if the SDK never yields ([src/acp-agent.ts:4676-4700](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L4676-L4700), receipt handling [4852-4870](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L4852-L4870), force-cancel grace [1508-1511](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L1508-L1511)). Additionally, a generic `$/cancel_request` on the prompt request itself routes to the same cancel path ([`runPromptWithCancellation`, src/acp-agent.ts:8646-8676](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L8646-L8676)). The consumer races `query.next()` against an abort controller so cancel wakes a wedged stream ([src/acp-agent.ts:2740-2760](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L2740-L2760)).

### 1.11 Commands & other surfaces

- `available_commands_update` is sent after every session create/resume/load (deferred via `setTimeout(0)` so it lands after the response) ([src/acp-agent.ts:1688-1741](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L1688-L1741)); commands can also refresh mid-session on SDK messages ([3019](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L3019)).
- Session titles: the SDK has no push event, so the title is polled at turn-end and pushed as `session_info_update` ([src/acp-agent.ts:1761-1793](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L1761-L1793)).
- `initialize` advertises auth methods (gateway auth when the client advertises `auth._meta.gateway`, terminal-based login for remote environments) ([src/acp-agent.ts:1519-1577](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L1519-L1577)); provider routing (`providers/list|set|disable`) is process-scoped and baked into new sessions' env ([src/acp-agent.ts:1803-1883](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L1803-L1883), [6304-6325](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L6304-L6325)).

### 1.12 Tricky parts worth copying

- **Turn model**: prompts are Turns on a queue with deferred settlement; one persistent consumer drains the SDK stream for the session's whole life; `prompt()` never loops ([src/acp-agent.ts:1981-2004](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L1981-L2004), [2181-2187](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L2181-L2187)).
- **Hold turns open while subagents live**: a result arriving while background subagents still run is deferred so their output and permission requests land *inside* the prompt response window — many clients stop consuming after the response ([src/acp-agent.ts:4020-4044](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L4020-L4044)).
- Cancellation races: orphaned steered messages, interrupt receipts, force-cancel grace timer ([1.10](#110-cancellation)).
- Duplicate suppression between eager (permission) and streamed emission ([1.5](#15-streaming-sdk-events--sessionupdate)).
- Extensions kept out of core: elicitation ([src/elicitation.ts](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/elicitation.ts)), goal extension ([src/goal-extension.ts](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/goal-extension.ts), docs [docs/goal-extension.md](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/docs/goal-extension.md)), session-failure extension ([src/session-failure-extension.ts](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/session-failure-extension.ts)), file-change audit ([src/file-change-audit.ts](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/file-change-audit.ts)).
- A turn that produced no streamed text (e.g. cache-replayed) still forwards the result text so the client never sees a silent turn ([src/acp-agent.ts:3916-3949](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L3916-L3949)).

---

## 2. opencode ACP server (sst/opencode)

opencode ships a first-party ACP server behind the `opencode acp` command. It does **not** talk to
its internals directly: the CLI boots the regular opencode HTTP server in-process and drives it
through opencode's own generated SDK client (`@opencode-ai/sdk/v2`), then bridges the server's
global event bus into ACP `session/update` notifications. Everything is written in
[Effect](https://effect.website) and exposed as plain promises at the boundary.

- ACP SDK: `@agentclientprotocol/sdk` **0.21.0** ([packages/opencode/package.json:57](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/package.json#L57)).

### 2.1 Entry point / process start

- Command: `opencode acp [--cwd <dir>]` (+ shared network options like `--hostname/--port`) —
  [packages/opencode/src/cli/cmd/acp.ts:9-18](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/cli/cmd/acp.ts#L9-L18).
- The handler sets `process.env.OPENCODE_CLIENT = "acp"`, starts the internal server
  (`Server.listen(opts)`), and creates an authenticated SDK client against it
  (`createOpencodeClient({ baseUrl: http://host:port, headers: ServerAuth.headers() })`)
  ([acp.ts:19-30](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/cli/cmd/acp.ts#L19-L30)).
- stdio wiring is manual Web streams over `process.stdout` (WritableStream) and `process.stdin`
  (ReadableStream), fed to `ndJsonStream(input, output)` from the SDK
  ([acp.ts:32-55](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/cli/cmd/acp.ts#L32-L55)).
- Connection creation uses the SDK 0.21 callback form:
  `new AgentSideConnection((conn) => agent.create(conn), stream)` — the factory returns an object
  implementing the SDK's `Agent` interface ([acp.ts:56-61](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/cli/cmd/acp.ts#L56-L61)).
  The process lives until stdin EOF ([acp.ts:63-71](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/cli/cmd/acp.ts#L63-L71)).

### 2.2 Architecture

- [`src/acp/agent.ts`](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/agent.ts) — `Agent implements ACPAgent`; each method runs an Effect and maps errors to
  ACP `RequestError`s ([agent.ts:32-93](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/agent.ts#L32-L93)).
- [`src/acp/service.ts`](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/service.ts) (1105 lines) — all method implementations; talks to the backing server
  exclusively through `input.sdk.*` HTTP calls (`session.create/prompt/command/abort/messages/...`,
  `permission.reply`, `mcp.add`, `config.providers`, `app.agents`, `command.list`, `app.skills`)
  with a `request()` wrapper that normalizes SDK errors into typed ACP errors
  ([service.ts:710-722](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/service.ts#L710-L722), [1065-1097](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/service.ts#L1065-L1097)).
- [`src/acp/event.ts`](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/event.ts) — a `Subscription` that opens **one global SSE-style event stream**
  (`sdk.global.event({ signal })`) and fans events out to permission handling and update emission,
  with reconnect every 1s on disconnect ([event.ts:144-165](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/event.ts#L144-L165)).
- [`src/acp/session.ts`](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/session.ts) — in-memory session store: `{id, cwd, mcpServers, model, variant, modeId,
  knownParts}` in an Effect `Ref<Map>` ([session.ts:24-33](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/session.ts#L24-L33), [97-140](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/session.ts#L97-L140)).
- `initialize` returns `protocolVersion: 1`, capabilities (`loadSession`, `mcpCapabilities.http/sse`,
  `promptCapabilities.embeddedContext/image`, session `close/fork/list/resume`), an auth method that
  runs `opencode auth login` in a terminal (when the client advertises `_meta.terminal-auth`), and
  `agentInfo {name: "OpenCode", version}` ([service.ts:94-139](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/service.ts#L94-L139)).

### 2.3 Sessions ↔ ACP sessions

- **The ACP sessionId *is* the opencode session id**: `session/new` calls `sdk.session.create({directory: cwd,
  agent: modeId, model: {providerID, modelID, variant}})` and returns `sessionId: created.id`
  ([service.ts:163-209](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/service.ts#L163-L209)).
- A per-directory "snapshot" (providers, models, agents-as-modes, commands, skills) is fetched once
  and cached per session; it feeds `configOptions` (model picker with variants-as-effort, mode
  picker) ([service.ts:728-783](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/service.ts#L728-L783),
  [config-option.ts](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/config-option.ts)).
- `session/load`: verifies the session exists, fetches its messages, **restores model/variant/mode
  from the message history** (`restoreFromMessages` prefers the last user message's model/agent)
  ([service.ts:211-244](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/service.ts#L211-L244), [1037-1059](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/service.ts#L1037-L1059)),
  then **replays the whole history** as `session/update` notifications via `Subscription.replayMessage`
  ([service.ts:235](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/service.ts#L235),
  [event.ts:108-142](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/event.ts#L108-L142)).
- `session/list` merges server-persisted sessions with live in-memory ones, newest-first with
  cursor pagination ([service.ts:246-290](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/service.ts#L246-L290)).
  `resumeSession` is like load without replay; `forkSession` forks on the server then loads + replays
  ([service.ts:292-328](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/service.ts#L292-L328), [356-398](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/service.ts#L356-L398));
  `closeSession` removes state and aborts the backing session ([service.ts:341-349](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/service.ts#L341-L349)).
- Client MCP servers are pushed into the backing server via `sdk.mcp.add` (remote/local config),
  deduplicated per session by a stable config key ([service.ts:958-1026](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/service.ts#L958-L1026)).

### 2.4 Modes & subagents

- **ACP modes == opencode agents (non-subagent)**: modes are built from `app.agents` filtered to
  `agent.mode !== "subagent" && !agent.hidden`, id = agent name; default mode = the `primary` agent
  (fallback `"build"`) ([service.ts:754-778](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/service.ts#L754-L778)).
  Subagents stay invisible; the `task` tool kind maps to `think` in tool mapping
  ([tool.ts:65-66](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/tool.ts#L65-L66)).
- The selected mode is passed as `agent: modeId` on **every** prompt and session create
  ([service.ts:169-183](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/service.ts#L169-L183), [506-526](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/service.ts#L506-L526)).
- `session/set_mode` and the `mode` config option validate against available modes then update the
  stored modeId ([service.ts:440-465](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/service.ts#L440-L465)). Model/effort switching is likewise config-option based
  (`model`, `effort` = model variant) ([service.ts:400-455](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/service.ts#L400-L455)).

### 2.5 Prompt handling

- `prompt()` resolves the model/variant/mode, converts ACP `ContentBlock[]` → opencode parts
  (`content.ts`), and detects a leading `/command` ([service.ts:494-505](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/service.ts#L494-L505), [811-822](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/service.ts#L811-L822)).
- Non-commands call `sdk.session.prompt(...)`; known commands call `sdk.session.command(...)`;
  `/compact` is special-cased to `sdk.session.summarize(...)` ([service.ts:506-575](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/service.ts#L506-L575)).
- **The key trick — `runUntilIdle`**: the HTTP `session.prompt` returns as soon as the turn is
  *submitted*, but ACP requires the prompt response after the turn finished. The subscription
  registers a per-session idle waiter; `session.status: idle` events resolve it. Because the event
  loop processes events **in order** and awaits each emitted update, the idle signal reliably lands
  after all of the turn's updates ([event.ts:74-91](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/event.ts#L74-L91), [93-106](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/event.ts#L93-L106),
  used at [service.ts:507-526](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/service.ts#L507-L526)).
- Prompt content mapping handles text (with audience annotations → synthetic/ignored flags), base64
  and URI images, `resource_link` (including `zed://` URIs converted to `file://`), and embedded
  resources, incl. `file://...#L123` line fragments ([content.ts:26-117](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/content.ts#L26-L117), [153-188](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/content.ts#L153-L188)).

### 2.6 Streaming: event bus → session/update

Event types handled ([event.ts:93-106](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/event.ts#L93-L106)):

- `message.part.delta` with `field === "text"` → `agent_message_chunk` (part type `text`) or
  `agent_thought_chunk` (part type `reasoning`), each tagged with the opencode `messageId`
  ([event.ts:214-259](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/event.ts#L214-L259)). Delta events don't carry the part type, so part metadata is remembered
  from `message.part.updated` (or fetched once via `sdk.session.message`) — the `knownParts` map in
  the session store ([event.ts:191-229](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/event.ts#L191-L229), [session.ts:14-22](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/session.ts#L14-L22)).
- `message.part.updated` with a **tool part** → state machine: first sight emits `tool_call`
  (status `pending`, title/kind/locations/rawInput from tool name + input — `toolStarts` set
  dedupes), then `tool_call_update`s: `running` → `in_progress` (with bash output snapshot;
  identical snapshots re-emitted without content to signal liveness), `completed` → `completed`
  with content + rawOutput, `error` → `failed` with error text ([event.ts:295-394](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/event.ts#L295-L394), helpers in
  [tool.ts:124-228](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/tool.ts#L124-L228)).
- `permission.asked` → the permission handler ([permission.ts](#27-permissions)).
- `session.status: idle` → prompt-waiter resolution (above).

### 2.7 Permissions

- `permission.asked` events are **serialized per session** through a promise chain (`queues` map) so
  two dialogs never interleave ([permission.ts:26-49](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/permission.ts#L26-L49)).
- The ACP request offers exactly three options — `allow_once` ("Allow once"), `allow_always`
  ("Always allow"), `reject_once` ("Reject") — and the reply maps to the server's
  `sdk.permission.reply({requestID, reply: "once"|"always"|"reject"})`; a failed request
  (e.g. client error) auto-rejects ([permission.ts:20-24](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/permission.ts#L20-L24), [51-97](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/permission.ts#L51-L97), [219-223](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/permission.ts#L219-L223)).
- The permission's `toolCall` is synthesized as a pending ToolCall whose title/locations/content
  are built from the permission payload; **for `edit` permissions the content is a real diff**: the
  current file is read, `applyPatch` computes `newText`, and a `{type: "diff", oldText, newText}`
  content block is attached — and before allowing, the proposed result is written to the client via
  `fs/write_text_file` so the editor shows the pending change ([permission.ts:61-89](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/permission.ts#L61-L89), [99-115](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/permission.ts#L99-L115), [183-217](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/permission.ts#L183-L217)).

### 2.8 Tool & content mapping

- Kind mapping (`toToolKind`): bash/shell→`execute`, webfetch→`fetch`, edit/apply_patch/patch/write→
  `edit`, grep/glob/context(+context7)→`search`, read→`read`, task→`think`, else `other`
  ([tool.ts:38-71](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/tool.ts#L38-L71)). Locations from file paths / shell workdir; shell tools get the
  command as title and the resolved cwd injected into `rawInput` ([tool.ts:73-101](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/tool.ts#L73-L101), [263-297](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/tool.ts#L263-L297)).
- Completed tool updates carry text content (read tools use a `display` metadata rendering),
  a `diff` content for edit-family tools built from `oldString`/`newString`-style inputs, image
  attachments extracted from data-URLs, and structured `rawOutput` ([tool.ts:103-122](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/tool.ts#L103-L122), [186-236](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/tool.ts#L186-L236), [325-338](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/tool.ts#L325-L338)).
- Replay (session/load) maps stored parts back to ACP content chunks: `file://` parts →
  `resource_link`, data-URL images → image blocks, text resources → resource blocks
  ([content.ts:119-151](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/content.ts#L119-L151), [190-239](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/content.ts#L190-L239)).

### 2.9 Stop reasons, cancellation, usage

- Stop reason comes from the final assistant message's error name: `MessageAbortedError`→
  `cancelled`, `MessageOutputLengthError`→`max_tokens`, `ContentFilterError`→`refusal`, no error→
  `end_turn`; `ProviderAuthError` becomes an ACP `auth_required` error ([service.ts:824-873](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/service.ts#L824-L873)).
- `session/cancel` → `sdk.session.abort({directory, sessionID})` on the backing session
  ([service.ts:351-354](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/service.ts#L351-L354), [330-339](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/service.ts#L330-L339)).
- After each prompt a `usage_update` session notification is sent with context tokens used/size
  and session cost ([service.ts:624-666](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/service.ts#L624-L666), [880-893](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/service.ts#L880-L893)).

### 2.10 Commands

`available_commands_update` is emitted right after session create/load/resume/fork (deferred with
`setTimeout(0)` so it follows the response), listing the server's commands plus skills as commands
([service.ts:936-956](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/service.ts#L936-L956), skills merged at [761-772](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/service.ts#L761-L772)). Slash-commands in prompts are detected and dispatched through
`sdk.session.command` ([service.ts:531-553](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/service.ts#L531-L553)).

### 2.11 Tricky parts worth copying

- Prompt-response/turn-end synchronization via ordered idle events (`runUntilIdle`) — a clean
  pattern whenever the agent core is asynchronous and "prompt accepted" ≠ "turn done"
  ([event.ts:74-91](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/event.ts#L74-L91)).
- Reconnect loop with `waitUntilConnected` gating prompts until the event stream is live;
  disconnection rejects outstanding idle waiters ([event.ts:144-189](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/event.ts#L144-L189)).
- Per-session permission serialization + auto-reject on transport failure ([permission.ts:26-49](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/permission.ts#L26-L49), [71-74](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/permission.ts#L71-L74)).
- Dedup liveness trick: identical running-bash output re-sends an `in_progress` update *without*
  content so clients can distinguish "still running" from "stalled" ([event.ts:341-377](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/src/acp/event.ts#L341-L377)).
- Tests exercise the wire format through a hand-rolled ACP test client — useful as an executable
  spec of expected update sequences ([test/cli/acp/acp-test-client.ts](https://github.com/sst/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/opencode/test/cli/acp/acp-test-client.ts)).

---

## 3. Gemini CLI ACP mode (google-gemini/gemini-cli)

Gemini CLI embeds a first-party ACP server as a special mode of its normal CLI binary. ACP SDK:
`@agentclientprotocol/sdk` **0.16.1** ([packages/cli/package.json](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/package.json)). User docs:
[docs/cli/acp-mode.md](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/docs/cli/acp-mode.md); module README:
[packages/cli/src/acp/README.md](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/README.md).

### 3.1 Entry point / process start

- Start with `gemini --acp` (the older `--experimental-acp` still works as a deprecated alias)
  ([config.ts:363-371](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/config/config.ts#L363-L371), unified to `acpMode` at
  [config.ts:786-793](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/config/config.ts#L786-L793)).
- In `gemini.tsx` (the CLI bootstrap), the TUI is replaced by the ACP loop when
  `config.getAcpMode()` is set: `return runAcpClient(config, settings, argv)`
  ([gemini.tsx:758-759](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/gemini.tsx#L758-L759)). Google-OAuth pre-auth can run before that when browser launch is suppressed
  ([gemini.tsx:746-755](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/gemini.tsx#L746-L755)).
- `runAcpClient` builds the transport: `createWorkingStdio()` keeps agent/debug output off the
  protocol channel; `Writable.toWeb`/`Readable.toWeb` adapt Node streams; `acp.ndJsonStream(stdout,
  stdin)`; then `new acp.AgentSideConnection((connection) => new GeminiAgent(config, settings, argv,
  connection), stream)`; finally `await connection.closed.finally(runExitCleanup)` so stdin EOF
  flushes telemetry ([acpStdioTransport.ts:15-35](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpStdioTransport.ts#L15-L35)).

### 3.2 Architecture

- `GeminiAgent` (acpRpcDispatcher.ts) is a plain class whose method names match the SDK's `Agent`
  interface (`initialize`, `authenticate`, `newSession`, `loadSession`, `prompt`, `cancel`,
  `setSessionMode`, `unstable_setSessionModel`) — the 0.16 SDK introspects the returned object
  ([acpRpcDispatcher.ts:21-235](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpRpcDispatcher.ts#L21-L235)).
- `initialize` returns `protocolVersion: acp.PROTOCOL_VERSION`, capabilities (`loadSession`,
  prompt `image`/`audio`/`embeddedContext`, MCP `http`/`sse`) and auth methods — including an
  API-key method whose key arrives via `_meta['api-key']` and a gateway method
  ([acpRpcDispatcher.ts:40-104](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpRpcDispatcher.ts#L40-L104));
  `authenticate` refreshes auth, clears cached credentials when switching methods, validates the
  gateway payload with zod ([acpRpcDispatcher.ts:106-167](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpRpcDispatcher.ts#L106-L167)).
- `AcpSessionManager` owns the session map, per-session `Config`, MCP merge, auth gating and the
  response payloads ([acpSessionManager.ts:33-56](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpSessionManager.ts#L33-L56)).
- `Session` (acpSession.ts, 1522 lines) holds one Gemini chat: prompt loop, tool execution,
  permissions, history streaming.

### 3.3 Sessions ↔ ACP sessions

- `session/new`: **ACP session id = `randomUUID()` generated by the agent**; settings are reloaded
  per-cwd; auth runs *before* config init (fail → `-32000` RequestError "Authentication required")
  ([acpSessionManager.ts:58-110](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpSessionManager.ts#L58-L110)). If the client advertises
  `clientCapabilities.fs`, a wrapping `AcpFileSystemService` replaces the local file system so file
  reads/writes are routed through the client ([acpSessionManager.ts:112-121](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpSessionManager.ts#L112-L121), [acpFileSystemService.ts](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpFileSystemService.ts)).
- The chat is started via `geminiClient.startChat()` and the response returns `{sessionId, modes,
  models}` — ACP modes = Gemini approval modes (Default / Auto Edit / YOLO, plus Plan when enabled)
  and the new-style `models` field ([acpSessionManager.ts:127-161](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpSessionManager.ts#L127-L161), `buildAvailableModes` at
  [acpUtils.ts:224-252](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpUtils.ts#L224-L252)).
- Client MCP servers merge with user settings into `MCPServerConfig`s (stdio/http/sse)
  ([acpSessionManager.ts:286-342](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpSessionManager.ts#L286-L342)); on load, auth is verified *before* MCP servers start — a
  documented security ordering ([acpSessionManager.ts:243-284](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpSessionManager.ts#L243-L284)).
- `session/load`: resolves the persisted session via `SessionSelector` (session files), converts to
  client history, `geminiClient.resumeChat(...)`, replaces any live session with the same id, then
  **streams the history back** as `session/update`s (`streamHistory`) and defers
  `available_commands_update` via `setTimeout(0)` ([acpSessionManager.ts:164-229](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpSessionManager.ts#L164-L229)).

### 3.4 Prompt handling

- `prompt()` aborts any previous in-flight prompt (`this.pendingPrompt?.abort()`) — **newest prompt
  wins** rather than queueing — then creates a fresh `AbortController` and resolves prompt content
  ([acpSession.ts:311-320](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpSession.ts#L311-L320)).
- `#resolvePrompt` maps ACP `ContentBlock[]` → Gemini `Part[]`: text→`{text}`, image/audio→
  `inlineData`, `file://` resource_link→`fileData` (the `@path` mechanism), embedded resources→
  `@uri` text + embedded context; attached files are expanded via `ReadManyFilesTool`/glob, with
  **an out-of-workspace attachment producing a synthetic permission request** and read-only path
  grant on allow ([acpSession.ts:945-1131](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpSession.ts#L945-L1131)).
- Slash commands (`/cmd`) and shell shortcuts (`$cmd`) in the leading text are intercepted and run
  by the CLI's `CommandHandler` — a handled command returns immediately with `end_turn`
  ([acpSession.ts:322-360](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpSession.ts#L322-L360), [629-648](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpSession.ts#L629-L648)).
- The **agentic loop lives inside `prompt()`**: `sendMessageStream` events are consumed, then tool
  calls execute sequentially and their function-response parts feed the next iteration until no
  tool calls remain or `maxSessionTurns` is hit ([acpSession.ts:366-603](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpSession.ts#L366-L603)).

### 3.5 Streaming: Gemini events → session/update

- `Content` → `agent_message_chunk` (text) ([acpSession.ts:418-429](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpSession.ts#L418-L429));
  `Thought` → `agent_thought_chunk` formatted as `**subject**\ndescription` ([acpSession.ts:431-438](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpSession.ts#L431-L438)).
- `ToolCallRequest` events are *collected* during the stream, not emitted; the tool_call update is
  emitted around actual execution in `runTool` — `in_progress` when auto-approved, `completed` with
  mapped content, `failed` with the error text ([acpSession.ts:440-442](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpSession.ts#L440-L442), [810-846](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpSession.ts#L810-L846), [899-910](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpSession.ts#L899-L910)).
- Tool kind mapping is nearly 1:1 — Gemini's internal `Kind` enum already mirrors ACP's (`Read`,
  `Edit`, `Execute`, `Search`, `Fetch`, `Think`, …), with `Agent`→`think` and `Plan`/`Communicate`→
  `other` ([acpUtils.ts:202-222](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpUtils.ts#L202-L222)).
- History replay maps persisted messages to `user_message_chunk` / `agent_thought_chunk` /
  `agent_message_chunk` and terminal `tool_call`s (completed/failed, diff content for edits)
  ([acpSession.ts:241-309](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpSession.ts#L241-L309)).

### 3.6 Stop reasons

Computed inside the loop: default `end_turn`; `MaxSessionTurns`/`LoopDetected` →
`max_turn_requests`; `ContextWindowWillOverflow` → `max_tokens`; abort/AbortError → `cancelled`;
structured stream errors become JSON-RPC `RequestError`s (429 rate-limit special-cased); a set of
"graceful" empty/malformed-response stream errors (`NO_RESPONSE_TEXT`, `MALFORMED_FUNCTION_CALL`,
`SAFETY_BLOCKED`, …) is converted to a clean `end_turn` instead of a crash
([acpSession.ts:400-484](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpSession.ts#L400-L484), [486-548](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpSession.ts#L486-L548),
final response with `_meta.quota` token usage at [605-626](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpSession.ts#L605-L626)).

### 3.7 Permissions

- Tools implement `shouldConfirmExecute()`; when confirmation is required, `runTool` builds an ACP
  permission request whose `toolCall` carries title, locations, kind, and — for edits — a real
  `diff` content block (`oldText`=original file, `newText`=proposed, `_meta.kind` add/delete/modify)
  ([acpSession.ts:711-772](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpSession.ts#L711-L772)).
- Options depend on confirmation type and settings: `ProceedOnce` (allow_once) + `Cancel`
  (reject_once) always; "Allow for this session" (allow_always) unless disabled; for edits/exec an
  extra "Allow … for all future sessions" when `enablePermanentToolApproval` is on; MCP tools get
  server-wide and tool-wide session options ([acpUtils.ts:98-200](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpUtils.ts#L98-L200), basic options at
  [85-97](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpUtils.ts#L85-L97)).
- The ACP outcome is parsed (cancelled → Cancel) and fed to `confirmationDetails.onConfirm(outcome)`;
  `updatePolicy` persists "always allow" decisions ([acpSession.ts:770-809](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpSession.ts#L770-L809)).
- Separately, the Session subscribes to the internal message bus for `TOOL_CONFIRMATION_REQUEST`
  (e.g. from subagents) and answers it via the **policy engine** (auto-allow safe commands) —
  failing closed on errors; it never prompts the ACP client on that path
  ([acpSession.ts:82-176](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpSession.ts#L82-L176)).

### 3.8 Modes, model, cancellation, commands

- `session/set_mode` validates against `buildAvailableModes` and calls
  `config.setApprovalMode` — Gemini's `ApprovalMode` (DEFAULT/AUTO_EDIT/YOLO/PLAN) doubles as ACP
  modes ([acpSession.ts:207-218](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpSession.ts#L207-L218)); approval-mode changes are echoed to the client as an
  `agent_message_chunk` with a `[MODE_UPDATE]` marker ([acpSession.ts:178-188](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpSession.ts#L178-L188)).
- `unstable_set_session_model` → `config.setModel` ([acpSession.ts:236-239](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpSession.ts#L236-L239)).
- `session/cancel` → `session.cancelPendingPrompt()` which just aborts the `AbortController`; a
  missing session is a `-32602` error ([acpRpcDispatcher.ts:189-198](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpRpcDispatcher.ts#L189-L198), [acpSession.ts:198-205](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpSession.ts#L198-L205)).
  The abort signal is checked at loop boundaries and stream events, returning
  `{stopReason: 'cancelled'}` ([acpSession.ts:395-415](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpSession.ts#L395-L415)).
- `available_commands_update` lists the CLI's slash commands (sent post-response via setTimeout)
  ([acpSession.ts:224-234](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpSession.ts#L224-L234)).

### 3.9 Tricky parts worth copying

- **Prompt preemption**: a second `session/prompt` aborts the first instead of queueing — simple
  and matches "the client is a UI" semantics ([acpSession.ts:311-314](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpSession.ts#L311-L314)).
- Graceful degradation of provider stream quirks (empty/malformed responses) into `end_turn`
  ([acpSession.ts:505-542](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpSession.ts#L505-L542)).
- Per-session `AcpFileSystemService` that transparently routes the agent's file I/O through the
  client's `fs/read_text_file` when `clientCapabilities.fs` is advertised
  ([acpFileSystemService.ts](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpFileSystemService.ts)).
- Tool-call history is re-recorded into the chat (`recordCompletedToolCalls`) so `session/load`
  can replay full tool transcripts ([acpSession.ts:864-890](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpSession.ts#L864-L890)).
- Error mapping centralized in [acpErrors.ts](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpErrors.ts) (`getAcpErrorMessage`), with zod validation of
  untrusted client payloads (`RequestPermissionResponseSchema`, gateway schema)
  ([acpUtils.ts:37-45](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpUtils.ts#L37-L45), [acpRpcDispatcher.ts:129-148](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpRpcDispatcher.ts#L129-L148)).

---

## 4. Official TypeScript SDK (agent-client-protocol / typescript-sdk)

The official TS library for ACP. Current home: [`agentclientprotocol/typescript-sdk`](https://github.com/agentclientprotocol/typescript-sdk)
(npm **`@agentclientprotocol/sdk`**, 1.3.0 at research time — [package.json](https://github.com/agentclientprotocol/typescript-sdk/blob/7585334c5b738868583d561bdfc97caf77a3f3ba/package.json)).
The spec/schema repo is [`agentclientprotocol/agent-client-protocol`](https://github.com/agentclientprotocol/agent-client-protocol)
(its root [package.json](https://github.com/agentclientprotocol/agent-client-protocol/blob/8e3eb8f23b84d367b5a3fe738dacdf7f535d2a5d/package.json) publishes only the private `@agentclientprotocol/schema`; the JSON schema itself lives at
[schema/schema.json](https://github.com/agentclientprotocol/agent-client-protocol/blob/8e3eb8f23b84d367b5a3fe738dacdf7f535d2a5d/schema/schema.json)).

### 4.1 Package landscape & history

- Old: `@zed-industries/agent-client-protocol` (≤ 0.4.5) from the old `zed-industries/agent-client-protocol`
  monorepo (repo URLs now redirect to the `agentclientprotocol` org).
- Current: `@agentclientprotocol/sdk` from the split-out TS SDK repo, with subpath exports:
  `.` (v1), `/experimental/v2`, `/experimental/http-client`, `/experimental/ws-client`,
  `/experimental/server`, `/experimental/node`, `/schema`
  ([package.json exports](https://github.com/agentclientprotocol/typescript-sdk/blob/7585334c5b738868583d561bdfc97caf77a3f3ba/package.json)).
- API rename at 0.26→0.27 documented in
  [MIGRATION_0.26_0.27.md](https://github.com/agentclientprotocol/typescript-sdk/blob/7585334c5b738868583d561bdfc97caf77a3f3ba/MIGRATION_0.26_0.27.md):
  `new AgentSideConnection((conn) => agent, stream)` → `acp.agent({name}).onRequest(...).connect(stream)`;
  `AgentSideConnection`/`ClientSideConnection` remain as deprecated wrappers
  ([src/acp.ts:2676-2692](https://github.com/agentclientprotocol/typescript-sdk/blob/7585334c5b738868583d561bdfc97caf77a3f3ba/src/acp.ts#L2676-L2692)) — this is why opencode (0.21.0) and gemini-cli (0.16.1)
  use the constructor form while claude-code-acp (1.3.0) uses the app builder.

### 4.2 Core API surface

- **`ndJsonStream(writable, readable)`** creates the standard bidirectional ndjson transport
  (`Stream = {readable, writable}` of parsed messages) ([src/acp.ts:34-53](https://github.com/agentclientprotocol/typescript-sdk/blob/7585334c5b738868583d561bdfc97caf77a3f3ba/src/acp.ts#L34-L53), impl in
  [src/stream.ts](https://github.com/agentclientprotocol/typescript-sdk/blob/7585334c5b738868583d561bdfc97caf77a3f3ba/src/stream.ts) with a [LineBuffer](https://github.com/agentclientprotocol/typescript-sdk/blob/7585334c5b738868583d561bdfc97caf77a3f3ba/src/line-buffer.ts)).
- **`acp.agent({ name })` → `AgentApp`**: fluent builder; `onRequest(method, handler)` /
  `onNotification(method, handler)` register typed handlers (params parsed with generated zod-like
  schemas; thrown errors become JSON-RPC errors); `connect(stream)` returns an `AgentConnection`
  whose `.client` is an `AgentContext` for calling the client; `connectWith(stream, op)` scopes the
  connection to a callback; `onConnect(handler)` for connection-scoped work; custom extension
  methods register with a parser argument ([src/acp.ts:1824-1960](https://github.com/agentclientprotocol/typescript-sdk/blob/7585334c5b738868583d561bdfc97caf77a3f3ba/src/acp.ts#L1824-L1960)).
- **`AgentContext`**: `request(method, params, options?)` / `notify(method, params)` — the agent's
  handle for calling the client ([src/acp.ts:283-331](https://github.com/agentclientprotocol/typescript-sdk/blob/7585334c5b738868583d561bdfc97caf77a3f3ba/src/acp.ts#L283-L331)); `SendRequestOptions.cancellationSignal`
  sends `$/cancel_request` when aborted ([src/jsonrpc.ts:97-105](https://github.com/agentclientprotocol/typescript-sdk/blob/7585334c5b738868583d561bdfc97caf77a3f3ba/src/jsonrpc.ts#L97-L105)).
- **`methods`** — the canonical method table: agent side `initialize`, `authenticate`, `logout`,
  `providers.*`, `session/{new,load,list,delete,fork,resume,close,setMode,setConfigOption,prompt,cancel}`,
  `nes/*`, `document/*`; client side `session/{requestPermission,update}`, `fs/{readTextFile,
  writeTextFile}`, `terminal/*`, `elicitation/*`; plus `protocol.cancelRequest`
  ([src/acp.ts:118-180](https://github.com/agentclientprotocol/typescript-sdk/blob/7585334c5b738868583d561bdfc97caf77a3f3ba/src/acp.ts#L118-L180)).
- **Legacy `Agent` interface** (what the deprecated `AgentSideConnection` factory expects): property
  methods `initialize`, `newSession`, optional `loadSession`, `unstable_forkSession`,
  `listSessions`, `deleteSession`, `resumeSession`, `closeSession`, `setSessionMode`,
  `unstable_setSessionModel`, `setSessionConfigOption`, `prompt`, `cancel`, `authenticate`, …
  ([src/acp.ts:3923-4042](https://github.com/agentclientprotocol/typescript-sdk/blob/7585334c5b738868583d561bdfc97caf77a3f3ba/src/acp.ts#L3923-L4042)). `AgentSideConnection` itself exposes
  `sessionUpdate`, `requestPermission`, `readTextFile`, `writeTextFile` (+ terminal/elicitation) as
  convenience wrappers ([src/acp.ts:2693-2760](https://github.com/agentclientprotocol/typescript-sdk/blob/7585334c5b738868583d561bdfc97caf77a3f3ba/src/acp.ts#L2693-L2760)).
- **`RequestError`** (re-exported from jsonrpc) is the typed way to fail a request
  ([src/acp.ts:55](https://github.com/agentclientprotocol/typescript-sdk/blob/7585334c5b738868583d561bdfc97caf77a3f3ba/src/acp.ts#L55)).
- **`PROTOCOL_VERSION = 1`** ([src/schema/index.ts:320](https://github.com/agentclientprotocol/typescript-sdk/blob/7585334c5b738868583d561bdfc97caf77a3f3ba/src/schema/index.ts#L320)).

### 4.3 Minimal server (official example)

From [`src/examples/agent.ts`](https://github.com/agentclientprotocol/typescript-sdk/blob/7585334c5b738868583d561bdfc97caf77a3f3ba/src/examples/agent.ts) — a complete, Zed-connectable agent:

```ts
import * as acp from "../acp.js";
import { Readable, Writable } from "node:stream";

class ExampleAgent {
  // sessions: Map<string, { pendingPrompt: AbortController | null }>
  async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: false } };
  }
  async newSession(_params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const sessionId = /* random hex id */;
    return { sessionId };
  }
  async prompt(params: acp.PromptRequest, cx: acp.AgentContext): Promise<acp.PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    session.pendingPrompt?.abort();               // newest prompt wins
    session.pendingPrompt = new AbortController();
    try {
      // stream updates + permissions through cx:
      await cx.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "..." } },
      });
      const permissionResponse = await cx.request(
        acp.methods.client.session.requestPermission,
        { sessionId: params.sessionId, toolCall: { /* ... */ }, options: [/* allow/reject */] },
      );
      return { stopReason: "end_turn" };
    } catch (err) {
      if (session.pendingPrompt.signal.aborted) return { stopReason: "cancelled" };
      throw err;
    }
  }
  async cancel(params: acp.CancelNotification): Promise<void> {
    this.sessions.get(params.sessionId)?.pendingPrompt?.abort();
  }
}

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const agent = new ExampleAgent();
acp
  .agent({ name: "example-agent" })
  .onRequest("initialize", (ctx) => agent.initialize(ctx.params))
  .onRequest("session/new", (ctx) => agent.newSession(ctx.params))
  .onRequest("session/prompt", (ctx) => agent.prompt(ctx.params, ctx.client))
  .onNotification("session/cancel", (ctx) => agent.cancel(ctx.params))
  .connect(stream);
```

(Condensed from [agent.ts:1-90](https://github.com/agentclientprotocol/typescript-sdk/blob/7585334c5b738868583d561bdfc97caf77a3f3ba/src/examples/agent.ts#L1-L90),
[263-295](https://github.com/agentclientprotocol/typescript-sdk/blob/7585334c5b738868583d561bdfc97caf77a3f3ba/src/examples/agent.ts#L263-L295); see also
[examples README](https://github.com/agentclientprotocol/typescript-sdk/blob/7585334c5b738868583d561bdfc97caf77a3f3ba/src/examples/README.md) for running it in Zed and the HTTP/WS variants.)

### 4.4 Protocol essentials for server authors (from schema.json)

Extracted from [schema/schema.json](https://github.com/agentclientprotocol/agent-client-protocol/blob/8e3eb8f23b84d367b5a3fe738dacdf7f535d2a5d/schema/schema.json) (mirror
[schema/schema.json in the SDK](https://github.com/agentclientprotocol/typescript-sdk/blob/7585334c5b738868583d561bdfc97caf77a3f3ba/schema/schema.json)):

- **SessionUpdate variants** (13): `user_message_chunk`, `agent_message_chunk`,
  `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `plan_update`, `plan_removed`,
  `available_commands_update`, `current_mode_update`, `config_option_update`,
  `session_info_update`, `usage_update`.
- **StopReason**: `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`.
- **ToolKind**: `read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`,
  `switch_mode`, `other`.
- **ToolCall status**: `pending` → `in_progress` → `completed` | `failed`; **ToolCallContent
  types**: `content`, `diff`, `terminal`.
- **PermissionOptionKind**: `allow_once`, `allow_always`, `reject_once`, `reject_always`; a
  permission response outcome is either `{outcome: "selected", optionId}` or
  `{outcome: "cancelled"}`.
- Plan updates use `PlanEntryStatus` `pending`/`in_progress`/`completed` with priorities/kinds.
- `initialize` negotiates `protocolVersion` (currently 1) and exchanges capabilities; the agent
  advertises `loadSession`, `promptCapabilities`, `mcpCapabilities`, session capabilities
  (`close`/`fork`/`list`/`resume`), `fs` handling, auth methods.

### 4.5 Transports & testing

- stdio ndjson is the default; the SDK also ships experimental Streamable-HTTP server
  ([src/server.ts](https://github.com/agentclientprotocol/typescript-sdk/blob/7585334c5b738868583d561bdfc97caf77a3f3ba/src/server.ts), [server-sse.ts](https://github.com/agentclientprotocol/typescript-sdk/blob/7585334c5b738868583d561bdfc97caf77a3f3ba/src/server-sse.ts)), WebSocket
  ([src/ws-server.ts](https://github.com/agentclientprotocol/typescript-sdk/blob/7585334c5b738868583d561bdfc97caf77a3f3ba/src/ws-server.ts)), HTTP/WS clients ([http-stream.ts](https://github.com/agentclientprotocol/typescript-sdk/blob/7585334c5b738868583d561bdfc97caf77a3f3ba/src/http-stream.ts), [ws-stream.ts](https://github.com/agentclientprotocol/typescript-sdk/blob/7585334c5b738868583d561bdfc97caf77a3f3ba/src/ws-stream.ts)) and a
  Node adapter for them ([src/node-adapter.ts](https://github.com/agentclientprotocol/typescript-sdk/blob/7585334c5b738868583d561bdfc97caf77a3f3ba/src/node-adapter.ts)).
- Tests can connect an `AgentApp` **directly to a `ClientApp` in-process** —
  `agentApp.connect(clientApp)` ([src/acp.ts:1868-1880](https://github.com/agentclientprotocol/typescript-sdk/blob/7585334c5b738868583d561bdfc97caf77a3f3ba/src/acp.ts#L1868-L1880)); [src/test-support/](https://github.com/agentclientprotocol/typescript-sdk/blob/7585334c5b738868583d561bdfc97caf77a3f3ba/src/test-support/) provides `test-agent.ts` and stream helpers.
- ACP v2 is draft-only behind `@agentclientprotocol/sdk/experimental/v2`
  ([README.md:17-32](https://github.com/agentclientprotocol/typescript-sdk/blob/7585334c5b738868583d561bdfc97caf77a3f3ba/README.md#L17-L32)).

---

## Patterns to copy for a new ACP server implementation

Synthesis of the four implementations above. A "backing agent" below is whatever engine you're
wrapping (an in-process agent loop, a CLI child process, or an HTTP agent service).

### P0. Use the official SDK — don't hand-roll JSON-RPC

- Depend on **`@agentclientprotocol/sdk` (1.x)** and use the app API:
  `acp.agent({ name }).onRequest(methods.agent.X, handler)....connect(stream)`; call the client
  through `ctx.notify(methods.client.session.update, ...)` / `ctx.request(methods.client.session.requestPermission, ...)`
  ([SDK §4.2](#42-core-api-surface)). Only use the deprecated `new AgentSideConnection((conn) => agentObj, stream)`
  form if you must match an old pin (that's what opencode 0.21 and gemini-cli 0.16 do).
- Fail requests with `acp.RequestError` (and `RequestError.authRequired()` / `.invalidParams()` /
  `.resourceNotFound()` helpers where available), never bare throws.
- Zero runtime deps; schema types are generated from the protocol schema.

### P1. Process & transport skeleton

1. Entry: a small CLI flag/subcommand (e.g. `myagent acp`, `--acp`) with **no required args**; the
   client (Zed etc.) spawns you and speaks ndjson over stdio.
2. Reserve stdout for the protocol: redirect `console.log/info/warn/error` to **stderr**
   ([claude-code-acp index.ts:53-58](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/index.ts#L53-L58)); or keep a separate "working stdout"
   like gemini-cli's `createWorkingStdio()` ([acpStdioTransport.ts:20-21](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpStdioTransport.ts#L20-L21)).
3. Wire the stream with Web streams: `Writable.toWeb(process.stdout)` + `Readable.toWeb(process.stdin)`
   → `acp.ndJsonStream(...)` ([examples/agent.ts:281-284](https://github.com/agentclientprotocol/typescript-sdk/blob/7585334c5b738868583d561bdfc97caf77a3f3ba/src/examples/agent.ts#L281-L284)).
4. Lifecycle: `await connection.closed.finally(cleanup)`; handle SIGINT/SIGTERM; exit on stdin EOF
   so you never orphan the process ([claude-code-acp index.ts:64-83](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/index.ts#L64-L83), [gemini acpStdioTransport.ts:31-34](https://github.com/google-gemini/gemini-cli/blob/9a15c45fbfc9f36a9817e0113dbd4fc1138840f0/packages/cli/src/acp/acpStdioTransport.ts#L31-L34)).

### P2. Layered architecture (all four converge on this)

```
CLI entry (stdio/ndjson, signal handling)
  └─ Connection wiring (SDK app or AgentSideConnection; a thin ClientFacade
     wrapping connection.client with sessionUpdate/requestPermission/readTextFile)
      └─ Agent object — one method per ACP method, pure dispatch + error mapping
          └─ SessionManager — Map<sessionId, SessionState>; create/load/list/remove
              └─ Session — per-session: backing chat/query handle, AbortController
                 (pendingPrompt), mode/model state, emitted-tool-call dedup set
                  └─ Event bridge — subscribes to the backing agent's stream/bus
                     and translates to session/update (single ordered consumer)
```

- gemini-cli: `GeminiAgent` → `AcpSessionManager` → `Session` ([§3.2](#32-architecture));
  opencode: `Agent` → `service.ts` (HTTP SDK client) + `event.ts` subscription → `session.ts` store
  ([§2.2](#22-architecture)); claude-code-acp: `ClaudeAcpAgent.sessions[sessionId]` + persistent
  consumer task ([§1.2](#12-architecture--json-rpc-over-stdio)).
- Keep an `AcpClient` facade (5-7 methods) so your mapping code is testable without a connection
  ([claude-code-acp acp-agent.ts:1428-1496](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L1428-L1496)).

### P3. Sessions

- **Generate the ACP session id yourself** (uuid/random hex) and, if the backing agent has its own
  ids, make them coincide or keep a map (claude-code-acp passes its uuid *into* the SDK as the
  session id; opencode uses the server's id directly) ([§1.3](#13-sessions--acp-sessions), [§2.3](#23-sessions--acp-sessions)).
- On `session/new`: validate `cwd` (absolute + exists) → fail early with a clear error; translate
  `mcpServers` (http/sse/stdio) into your engine's config; merge `additionalDirectories` into the
  workspace scope; return `{sessionId, modes, configOptions | models}`.
- Advertise capabilities honestly in `initialize` (`loadSession`, prompt `image`/`embeddedContext`,
  MCP `http`/`sse`, session `close`/`fork`/`list`/`resume`) + `protocolVersion: acp.PROTOCOL_VERSION`.
- `session/load` = rehydrate backing state **+ replay the full history as session/update
  notifications** (user/agent chunks, thoughts, terminal tool_calls with diffs), *then*
  `available_commands_update` (defer with `setTimeout(0)` so it never interleaves with the
  response or history) — all three implementations do exactly this ([§1.3](#13-sessions--acp-sessions),
  [§2.3](#23-sessions--acp-sessions), [§3.3](#33-sessions--acp-sessions)).
- Unknown session → `resource_not_found` / `-32602`; a dead backing stream → structured
  "session ended" error rather than a hang ([acp-agent.ts:1948-1953](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L1948-L1953)).

### P4. Prompts & the turn loop

- Either run the **agentic loop inside `prompt()`** (gemini-cli: stream → collect tool calls →
  execute → loop) or **bridge an async engine**: submit and await an ordered idle/completion signal
  (opencode's `runUntilIdle`) or a per-turn deferred settled by a persistent consumer
  (claude-code-acp's Turn queue). In all cases the response returns only after the turn ends.
- Concurrency policy — pick one deliberately:
  - **preempt** (abort previous): gemini-cli + SDK example (`session.pendingPrompt?.abort()`);
  - **queue**: claude-code-acp turn queue.
- Convert `ContentBlock[]` → engine input: text (pass through, keep audience annotations),
  images (base64/uri), `resource_link` (file:// → file attachments/@mentions; opencode even maps
  `zed://`), embedded resources (inline text or blob) ([opencode content.ts](#28-tool--content-mapping),
  [gemini #resolvePrompt](#34-prompt-handling)).
- Intercept leading `/commands` before hitting the model, dispatch to your command system
  (opencode routes to `session.command`, gemini to its CommandHandler, claude-code-acp passes them
  through as prompts and detects local-only commands).
- Response: `{stopReason, usage?, userMessageId?}`; map engine terminal states to
  `end_turn | max_tokens | max_turn_requests | refusal | cancelled` ([§2.9](#29-stop-reasons-cancellation-usage),
  [§3.6](#36-stop-reasons)); auth failures → `authRequired` error, not a stop reason.

### P5. Streaming updates (the heart of the mapping)

Single ordered pipeline; **never emit two `tool_call`s for one tool-call id**:

| Engine event | ACP session/update |
| --- | --- |
| assistant text delta | `agent_message_chunk` `{content:{type:"text"}}` (+ `messageId` for grouping) |
| reasoning/thinking delta | `agent_thought_chunk` |
| user echo / replayed user text | `user_message_chunk` |
| tool call requested | `tool_call` (status `pending`, kind, title, locations, rawInput, optimistic diff for edits) |
| tool input streaming (optional) | `tool_call_update` with progressively parsed rawInput |
| tool started | `tool_call_update` status `in_progress` (+ terminal content if supported) |
| tool finished | `tool_call_update` `completed` (content + rawOutput + real diff) or `failed` (error text) |
| todo/task list change | `plan` update with entries (`pending`/`in_progress`/`completed`) |
| mode changed | `current_mode_update` |
| commands changed | `available_commands_update` |
| token/context/cost | `usage_update` (`_meta` extensions if the client opts in) |

Rules learned the hard way:
- **Emit the tool_call before asking permission** so the dialog references a visible call; keep an
  `emittedToolCalls` set so the later streamed duplicate becomes a `tool_call_update`
  ([§1.5](#15-streaming-sdk-events--sessionupdate)).
- Always resolve every emitted tool_call (completed/failed) even on cancel/unknown-result paths —
  a forever-pending call is a client-side hang ([acp-agent.ts:8290-8332](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L8290-L8332)).
- Edits: emit an optimistic `diff` content from old/new strings at call time, refine with the
  authoritative patch at result time; `_meta.kind` add/delete/modify helps clients
  ([§1.6](#16-tool-mapping), [§3.7](#37-permissions)).
- Terminal tools: if the client advertises `_meta.terminal_output`, use `{type: "terminal",
  terminalId}` content; for long-running shell, periodically re-emit `in_progress` (opencode drops
  content on identical output = liveness ping) ([§2.6](#26-streaming-event-bus--sessionupdate)).
- Tag chunks with your engine's message id — clients group chunks into messages by it.

### P6. Permissions

- Funnel every "needs confirmation" moment into one function that:
  1. (optionally) emits the `tool_call`,
  2. sends `session/request_permission` with options,
  3. maps the outcome back to the engine's allow/deny + policy persistence.
- Options baseline: `allow_once` / `allow_always` / `reject_once` (opencode) — extend with scoped
  variants (per-file, per-server, persistent "future sessions" — gemini) and rich `_meta.permission`
  describing what "always" would persist (claude-code-acp).
- Map outcomes into the engine's own policy store (gemini `updatePolicy`, claude
  `updatedPermissions` suggestions) so "always" survives the turn.
- **Serialize permission requests per session** (promise chain) and **auto-reject on transport
  failure** so a dead dialog can't wedge the turn ([opencode permission.ts:26-49](#27-permissions)).
- Pass a `cancellationSignal` to the request so `session/cancel` dismisses the client dialog
  (`$/cancel_request`) ([claude-code-acp §1.7](#17-permissions)).
- Plan-mode exits: model the "exit plan mode" tool as a permission request whose *options are the
  target modes*, then `current_mode_update` + engine mode switch on selection
  ([acp-agent.ts:5470-5556](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L5470-L5556)).

### P7. Modes & models

- Expose your engine's approval modes as ACP modes (`default`/`acceptEdits`/`plan`/
  `bypassPermissions`, or `Default`/`AutoEdit`/`YOLO`/`Plan`); validate `session/set_mode` against
  the advertised list, then push it into the engine and echo `current_mode_update` whenever the
  engine changes mode itself.
- Model selection: `configOptions` (new-style, supports model/effort/mode/agent pickers) or the
  `models` field (gemini); restore model/mode from history on `session/load`.

### P8. Cancellation

- `session/cancel` is a **notification**; implement it as: abort the per-session
  `AbortController` → propagate the signal into every in-flight engine call (LLM stream, tool
  execution, permission request) → return `{stopReason: "cancelled"}` from the pending prompt.
- Guard the races: prompt resolving between cancel and engine ack (race `next()` against the abort
  promise); wedged engines (force-settle timer with grace period); queued/orphaned messages
  accounting (claude-code-acp); prompt preemption (abort old, start new).
- Also honor `$/cancel_request` on the prompt request itself by routing it to the same path
  ([runPromptWithCancellation](https://github.com/zed-industries/claude-code-acp/blob/59a7e9367b3931a50178de4783cf6074b20060cd/src/acp-agent.ts#L8646-L8676)).

### P9. Auth, extensions, testing

- `initialize` returns `authMethods`; support at least API-key-in-`_meta` and a terminal login
  command (`_meta.terminal-auth`) — see all three agents. `authenticate` refreshes and persists
  selection; missing auth on `session/new` → `authRequired` error.
- Keep proprietary surfaces in `_meta` / extension methods (steering, goals, subagent transcripts
  via `parentToolUseId`, file-change audit) — all gated on client capability flags.
- Test with an in-process `AgentApp ↔ ClientApp` pair (SDK `connect(clientApp)`) and/or a wire-level
  test client like opencode's `acp-test-client.ts`; cover: update ordering, permission
  cancel/deny races, load-replay fidelity, and concurrent prompts.

### P10. Minimal skeleton to start from

```ts
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

console.log = console.error; /* keep stdout clean */ // eslint-disable-line
const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));

const sessions = new Map<string, { pending: AbortController }>();

acp.agent({ name: "my-agent" })
  .onRequest(acp.methods.agent.initialize, async () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
  }))
  .onRequest(acp.methods.agent.session.new, async () => {
    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, { pending: new AbortController() });
    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const s = sessions.get(ctx.params.sessionId);
    if (!s) throw new acp.RequestError(-32602, "unknown session");
    s.pending.abort(); s.pending = new AbortController();   // preempt
    try {
      return await runTurn(ctx.params, s.pending.signal, {
        update: (u) => ctx.client.notify(acp.methods.client.session.update,
          { sessionId: ctx.params.sessionId, update: u }),
        requestPermission: (p) => ctx.client.request(
          acp.methods.client.session.requestPermission, p),
      });
    } catch (e) {
      if (s.pending.signal.aborted) return { stopReason: "cancelled" };
      throw e;
    }
  })
  .onNotification(acp.methods.agent.session.cancel, (ctx) => {
    sessions.get(ctx.params.sessionId)?.pending.abort();
  })
  .connect(stream);
```

(Build `runTurn` as the single ordered pipeline from P5; add session/load + replay when your
engine persists history. Verified shape against the SDK example
([agent.ts](https://github.com/agentclientprotocol/typescript-sdk/blob/7585334c5b738868583d561bdfc97caf77a3f3ba/src/examples/agent.ts)) and the three production implementations.)
