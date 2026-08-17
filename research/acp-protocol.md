# Agent Client Protocol (ACP) — Technical Research Report

> **Purpose:** complete, wire-level reference for implementing an ACP server compatible with Zed and other ACP clients (JetBrains, VS Code extensions, Neovim plugins, opencode, etc.). All facts below are verified against **primary sources only**: the official spec site (agentclientprotocol.com), the official schema/SDK repositories, opencode's actual source, and Zed's actual source/docs. Every section carries inline citations.
>
> **Spec version documented:** ACP **v1 (stable)** — `protocolVersion: 1`. ACP v2 exists in **draft** and is summarized in [§19 Versioning & evolution](#19-protocolversion-versioning-and-evolution).

**Primary sources:**

| Source | URL |
|---|---|
| Spec site (v1 prose + full schema page) | https://agentclientprotocol.com/protocol/v1/overview … /schema |
| Machine-readable JSON Schema | https://github.com/agentclientprotocol/agent-client-protocol → `schema/v1/schema.json`; https://github.com/agentclientprotocol/agent-client-protocol/releases/latest/download/schema.json |
| Official TypeScript SDK (`@agentclientprotocol/sdk`) | https://github.com/agentclientprotocol/typescript-sdk (repo moved from `zed-industries/agent-client-protocol`, which now redirects to the `agentclientprotocol` org) |
| opencode ACP implementation | https://github.com/sst/opencode/tree/dev/packages/opencode/src/acp |
| Zed (client side) | https://github.com/zed-industries/zed — `docs/src/ai/external-agents.md`, `crates/agent_servers/src/acp.rs`, `crates/acp_thread/src/*` |

---

## Table of Contents

1. [Critical corrections — names that do NOT exist in ACP](#1-critical-corrections--names-that-do-not-exist-in-acp)
2. [Overview & architecture](#2-overview--architecture)
3. [Transport & framing (stdio, NDJSON, stderr, process launch)](#3-transport--framing)
4. [Initialize handshake & version negotiation](#4-initialize-handshake--version-negotiation)
5. [Capabilities reporting (client & agent)](#5-capabilities-reporting)
6. [Authentication (`authenticate`, `logout`, `authMethods`, terminal-auth extension)](#6-authentication)
7. [Full method reference (all methods, direction, params, results)](#7-full-method-reference)
8. [`session/update` notification — every content type in detail](#8-sessionupdate-notification--every-content-type-in-detail)
9. [Content blocks (`ContentBlock` union)](#9-content-blocks-contentblock-union)
10. [Tool calls (`tool_call` / `tool_call_update`, kinds, statuses, content, locations)](#10-tool-calls)
11. [Agent plans (`plan` update, entries, priorities, statuses)](#11-agent-plans)
12. [Modes (`session/set_mode`, `SessionModeState`, `current_mode_update`)](#12-modes)
13. [Session config options (successor to modes)](#13-session-config-options)
14. [Permission flow in detail](#14-permission-flow-in-detail)
15. [`session/prompt` request/response in detail (stopReason, interruption)](#15-sessionprompt-in-detail)
16. [Client-side services: filesystem (`fs/*`) and terminals (`terminal/*`)](#16-client-side-services-filesystem-and-terminals)
17. [Slash commands, session info updates, usage updates, elicitation](#17-slash-commands-session-info-updates-usage-updates-elicitation)
18. [Cancellation (`session/cancel`, `$/cancel_request`, error `-32800`)](#18-cancellation)
19. [`protocolVersion`, versioning & evolution (RFDs, v2 draft, extensibility)](#19-protocolversion-versioning-and-evolution)
20. [Error handling & error codes](#20-error-handling--error-codes)
21. [How opencode implements ACP (file-by-file)](#21-how-opencode-implements-acp)
22. [How Zed discovers & launches ACP agents](#22-how-zed-discovers--launches-acp-agents)
23. [Wire-compatibility checklist for a new ACP server](#23-wire-compatibility-checklist-for-a-new-acp-server)
24. [Complete source list](#24-complete-source-list)

---

## 1. Critical corrections — names that do NOT exist in ACP

Several method/field names circulating in summaries (and in the research brief for this document) **do not exist in any published version of Zed's ACP** — v0.0.32 (the first npm release) through the current schema were checked directly. Implementing them would break wire compatibility. Verified against the [v1 schema page](https://agentclientprotocol.com/protocol/v1/schema), the [TS SDK method constants](https://github.com/agentclientprotocol/typescript-sdk/blob/main/src/schema/index.ts), and the npm-published `@zed-industries/agent-client-protocol@0.0.32` tarball:

| Name from popular summaries | Reality in ACP | Note |
|---|---|---|
| `initialized` notification after `initialize` | **Does not exist.** The handshake is exactly one request → one response. There is no LSP/MCP-style `initialized` notification. | Verified: not in the [initialization spec](https://agentclientprotocol.com/protocol/v1/initialization), not in `AGENT_METHODS`/`CLIENT_METHODS` SDK constants, not in the earliest npm SDK. |
| `session/set_environment` | **Does not exist.** Client-provided environment arrives per-MCP-server (`env: EnvVariable[]` in `session/new`/`session/load`/`session/resume` `mcpServers`) and per-terminal (`terminal/create.env`). | This name comes from Block/Goose's older same-named "Agent Client Protocol", not Zed's. |
| `session/release` | **Does not exist.** The lifecycle method is [`session/close`](https://agentclientprotocol.com/protocol/v1/session-setup#closing-active-sessions) (draft name was `session/stop`, renamed before stabilization — see repo CHANGELOG PRs [#701](https://github.com/agentclientprotocol/agent-client-protocol/pull/701)/[#724](https://github.com/agentclientprotocol/agent-client-protocol/pull/724)). `terminal/release` *does* exist (terminals only). | |
| `session/abort` (or `…/abort`) | **Does not exist.** Cancellation is the [`session/cancel` **notification**](https://agentclientprotocol.com/protocol/v1/prompt-turn#cancellation). `cancel` existed under this exact name since the first npm release. | |
| `agent/permissions/list` | **Does not exist.** Permissions are requested per-tool-call at runtime via `session/request_permission` (Agent→Client request). There is no permission-listing method. | |
| `workspace/diagnostics` | **Does not exist** in ACP. (Zed has *custom extension* methods like `_zed.dev/workspace/buffers`, documented as an extensibility example — [extensibility spec](https://agentclientprotocol.com/protocol/v1/extensibility) — but no diagnostics method is standardized.) | |
| `terminal/start`, `terminal/wait` | Real names are `terminal/create` and `terminal/wait_for_exit`. (`start`/`wait` are Goose-ACP names.) | |
| `stopReason` "notification" / "stop hook" | `stopReason` is a **field of the `session/prompt` response** (and, in v2, of `state_update` notifications). There is no separate stop notification. | |
| Plan object with `id`/`status: pending/active/completed/cancelled` | v1 `Plan` has **only** `entries: PlanEntry[]` (each entry has `content`, `priority`, `status: pending|in_progress|completed`). No plan id, no plan-level status, no `cancelled` entry status in stable v1. (Plan ids/statuses are a v2 draft: `plan_update`.) | |
| `modeInfo` with `kind: primary/secondary/subagent`, `available_commands` on modes | v1 `SessionMode` = `{ id, name, description? }` only. No `kind` field. `available_commands` is a separate `session/update` variant, not attached to modes. (opencode *internally* filters its agents by a `mode` property — see [§21](#21-how-opencode-implements-acp) — but that never appears on the wire.) | |
| `promptCapabilities: { resource, audio, image, audio_input }` | Real keys: **`image`, `audio`, `embeddedContext`** (booleans). Embedded `ContentBlock::Resource` is gated by `embeddedContext`. `audio_input` never existed. Verified identical back to SDK v0.0.32. | |
| Permission options with `single`/`multi` types | v1 permission options are a flat `PermissionOption[]` with `kind: allow_once | allow_always | reject_once | reject_always`. No single/multi select in v1 (v2 draft restructures permission params with a required `title` and optional `subject` — see [§19](#19-protocolversion-versioning-and-evolution)). | |

The authoritative wire method set (from the SDK's [`AGENT_METHODS`](https://github.com/agentclientprotocol/typescript-sdk/blob/main/src/schema/index.ts) / `CLIENT_METHODS` constants, mirrored by the [schema page](https://agentclientprotocol.com/protocol/v1/schema)) is in [§7](#7-full-method-reference).

---

## 2. Overview & architecture

ACP standardizes communication between **Clients** (code editors: Zed, JetBrains, VS Code extensions, Neovim plugins…) and **Agents** (programs using generative AI to autonomously modify code: Claude Code, Gemini CLI, opencode, Codex…). Agents typically run as **subprocesses of the Client** ([overview](https://agentclientprotocol.com/protocol/v1/overview#agent)).

- **Message model:** [JSON-RPC 2.0](https://www.jsonrpc.org/specification). Two kinds of messages: *methods* (request/response) and *notifications* (one-way, no response ever).
- **Bidirectional:** both sides implement server *and* client roles. The Agent exposes agent-side methods (`initialize`, `session/new`, `session/prompt`…); the Client exposes client-side methods (`session/request_permission`, `fs/read_text_file`, `terminal/create`…). Server-initiated requests flow Agent→Client during a prompt turn.
- **Typical flow** ([overview](https://agentclientprotocol.com/protocol/v1/overview#message-flow)):
  1. Client→Agent `initialize` (negotiate version + capabilities); `authenticate` if the agent requires it
  2. Client→Agent `session/new` (or `session/load` / `session/resume`)
  3. Client→Agent `session/prompt`; Agent→Client `session/update` notifications stream progress; Agent→Client `session/request_permission` / `fs/*` / `terminal/*` as needed; Client→Agent `session/cancel` to interrupt
  4. Turn ends when the Agent responds to `session/prompt` with a `stopReason`
- **Baseline requirements:** every Agent MUST support `initialize`, `session/new`, `session/prompt`, `session/cancel`, and `session/update` ([initialization spec](https://agentclientprotocol.com/protocol/v1/initialization#session-capabilities)). Every Client baseline: `session/request_permission`.
- **Conventions** ([overview](https://agentclientprotocol.com/protocol/v1/overview#conventions)): all file paths **MUST be absolute**; line numbers are **1-based**; JSON object property keys are `camelCase`; discriminator string values are `snake_case`.
- **Agents list / clients list:** [agentclientprotocol.com/get-started/agents](https://agentclientprotocol.com/get-started/agents), [/get-started/clients](https://agentclientprotocol.com/get-started/clients).

---

## 3. Transport & framing

Source: [Transports spec](https://agentclientprotocol.com/protocol/v1/transports).

### stdio (the only stable transport)

- The **client launches the agent as a subprocess**. The agent reads JSON-RPC from **stdin** and writes JSON-RPC to **stdout**.
- **Framing: newline-delimited JSON (NDJSON).** Each message is a single JSON-RPC request, notification, or response. Messages are delimited by `\n` and **MUST NOT contain embedded newlines** — i.e. serialize each message with a JSON serializer that escapes newlines inside strings (standard `JSON.stringify` behavior) and append one `\n`.
- Messages **MUST be UTF-8** encoded.
- **stderr:** the agent **MAY** write UTF-8 strings to stderr for logging; clients **MAY** capture, forward, or ignore it. (Zed captures stderr into its ACP debug log — see `exited_load_error_with_stderr` in [`crates/agent_servers/src/acp.rs`](https://github.com/zed-industries/zed/blob/main/crates/agent_servers/src/acp.rs).)
- The agent **MUST NOT** write anything to stdout that is not a valid ACP message; the client **MUST NOT** write anything to the agent's stdin that is not a valid ACP message. (Critical for CLI binaries: banner/version output on stdout breaks clients.)
- Connection teardown: client closes stdin and/or terminates the subprocess.

Exactly how Zed launches the process (verified in [`crates/agent_servers/src/acp.rs`](https://github.com/zed-industries/zed/blob/main/crates/agent_servers/src/acp.rs)): builds the command from the user's `agent_servers` settings (`command`, `args`, `env`), wraps it with the system shell in **non-interactive** mode, applies `env`, sets the child's `cwd` to the project root (local projects), and spawns with **piped stdin/stdout/stderr**. Zed's `dev::OpenAcpLogs` command shows the full message log ([Zed docs](https://zed.dev/docs/ai/external-agents#debugging-agents)).

### Other transports

- **Streamable HTTP / WebSocket:** draft proposal in progress ([RFD](https://agentclientprotocol.com/rfds/streamable-http-websocket-transport.md)); not stable. Custom transports are allowed as long as they preserve the JSON-RPC message format and lifecycle ([transports spec](https://agentclientprotocol.com/protocol/v1/transports#custom-transports)).

---

## 4. Initialize handshake & version negotiation

Source: [Initialization spec](https://agentclientprotocol.com/protocol/v1/initialization), [schema: initialize](https://agentclientprotocol.com/protocol/v1/schema#initialize).

**The handshake is exactly one request/response pair — there is no `initialized` notification** (unlike LSP/MCP; verified absent from the spec, the schema, and the SDK).

**Client → Agent request:**

```json
{
  "jsonrpc": "2.0",
  "id": 0,
  "method": "initialize",
  "params": {
    "protocolVersion": 1,
    "clientCapabilities": {
      "fs": { "readTextFile": true, "writeTextFile": true },
      "terminal": true
    },
    "clientInfo": { "name": "my-client", "title": "My Client", "version": "1.0.0" }
  }
}
```

- `protocolVersion` (required): **a single integer naming a MAJOR version** (type `uint16`). "This version is only incremented when breaking changes are introduced."
- `clientCapabilities` (required object; defaults `{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false}`).
- `clientInfo` (optional today, **"in future versions of the protocol, this will be required"**): `Implementation { name, title?, version? }` — `name` for programmatic use, `title` human-readable.
- `_meta` allowed on every request/response/notification and nested type ([extensibility](https://agentclientprotocol.com/protocol/v1/extensibility)).

**Agent → Client response:**

```json
{
  "jsonrpc": "2.0",
  "id": 0,
  "result": {
    "protocolVersion": 1,
    "agentCapabilities": {
      "loadSession": true,
      "promptCapabilities": { "image": true, "audio": true, "embeddedContext": true },
      "mcpCapabilities": { "http": true, "sse": true },
      "sessionCapabilities": { "list": {}, "resume": {}, "close": {}, "delete": {}, "additionalDirectories": {} },
      "auth": { "logout": {} }
    },
    "agentInfo": { "name": "my-agent", "title": "My Agent", "version": "1.0.0" },
    "authMethods": []
  }
}
```

### Version negotiation rules (normative)

1. The `initialize` request **MUST** carry the *latest* protocol version the client supports.
2. If the agent supports the requested version it **MUST** respond with the same version; otherwise it **MUST** respond with the latest version *it* supports.
3. If the client doesn't support the version in the response, it **SHOULD** close the connection and inform the user.
4. Both parties then act according to that version's spec. Current stable: **`1`**.

### Session setup after initialize

Order is mandatory: initialize → (authenticate if needed) → `session/new` | `session/load` | `session/resume` → prompts ([overview](https://agentclientprotocol.com/protocol/v1/overview#message-flow)).

---

## 5. Capabilities reporting

Sources: [initialization spec](https://agentclientprotocol.com/protocol/v1/initialization), [schema types](https://agentclientprotocol.com/protocol/v1/schema).

Rules: all capabilities are **OPTIONAL**; **omitted = UNSUPPORTED**; peers **SHOULD** support all combinations; adding new capabilities is **not** a breaking change.

### Client capabilities (`clientCapabilities`)

| Field | Type | Gates |
|---|---|---|
| `fs.readTextFile` | boolean | Agent may call `fs/read_text_file` |
| `fs.writeTextFile` | boolean | Agent may call `fs/write_text_file` |
| `terminal` | boolean | Agent may call **all** `terminal/*` methods |
| `elicitation` | object \| null | which `elicitation/create` modes the agent may use: `{ form?: {}, url?: {} }` — a present `{}` under `form`/`url` advertises that mode; omitted/null = not advertised. "Unlike MCP, ACP does not treat `{}` as form support." |
| `session.configOptions.boolean` | object \| null | Client accepts `type:"boolean"` config options; `{}` = supported |
| `_meta` | object | custom capabilities, e.g. **Zed advertises `"terminal-auth": true`** here (see [§6](#6-authentication)) |

### Agent capabilities (`agentCapabilities`)

| Field | Type | Meaning |
|---|---|---|
| `loadSession` | boolean | `session/load` available (replay-style resume) |
| `promptCapabilities.image` | boolean | prompt may include `ContentBlock::Image` |
| `promptCapabilities.audio` | boolean | prompt may include `ContentBlock::Audio` |
| `promptCapabilities.embeddedContext` | boolean | prompt may include `ContentBlock::Resource` |
| `mcpCapabilities.http` | boolean | can connect to MCP servers over HTTP |
| `mcpCapabilities.sse` | boolean | can connect to MCP servers over SSE (deprecated by MCP spec) |
| `sessionCapabilities.list` | `{}` \| null | `session/list` available |
| `sessionCapabilities.resume` | `{}` \| null | `session/resume` available (no-replay resume) |
| `sessionCapabilities.close` | `{}` \| null | `session/close` available |
| `sessionCapabilities.delete` | `{}` \| null | `session/delete` available |
| `sessionCapabilities.additionalDirectories` | `{}` \| null | accepts `additionalDirectories` on lifecycle requests |
| `sessionCapabilities.fork` | `{}` \| null | **unstable**: `session/fork` available |
| `auth.logout` | `{}` \| null | `logout` available |

Notes:
- "Omitted or `null`" both mean unsupported; **supplying an empty object `{}` means supported** (for all the object-valued markers).
- Baseline (no capability needed): `session/new`, `session/prompt`, `session/cancel`, `session/update`; prompt content `text` + `resource_link` always supported.
- `session/load` is deliberately still a top-level boolean (`loadSession`) — the spec notes this inconsistency will be unified later.
- Capability objects also accept `_meta` for custom extensions, e.g. opencode advertises nothing extra, but Zed's docs show the pattern `agentCapabilities._meta["zed.dev"] = {...}` ([extensibility](https://agentclientprotocol.com/protocol/v1/extensibility#advertising-custom-capabilities)).

---

## 6. Authentication

Source: [authentication spec](https://agentclientprotocol.com/protocol/v1/authentication).

Flow: agent advertises `authMethods` in the `initialize` response → client calls `authenticate(methodId)` when needed (typically after an `auth_required` / `-32000` error from `session/new`) → agent returns `{}`. Optional `logout` (capability `auth.logout`).

**`authMethods` entry** (`AuthMethod`):

```json
{ "id": "agent-login", "name": "Agent login", "description": "Sign in using the agent's login flow" }
```

- `id` (`AuthMethodId`, string, required), `name` (required), `description?`.
- A `type` field acts as discriminator when present; **absent `type` = `"agent"`** (the only stable type): the agent handles authentication itself through `authenticate`. (v2 groups methods under `auth/*` with more types.)

**Client → Agent `authenticate`:**

```json
{ "jsonrpc": "2.0", "id": 1, "method": "authenticate", "params": { "methodId": "agent-login" } }
```

Response on success: `{ "jsonrpc": "2.0", "id": 1, "result": {} }`. After success, new sessions can be created without `auth_required` errors. Unknown `methodId` → JSON-RPC `-32602`.

**Client → Agent `logout`** (only after verifying `agentCapabilities.auth.logout`):

```json
{ "jsonrpc": "2.0", "id": 2, "method": "logout", "params": {} }
```

Response: `result: {}`. Behavior of already-running sessions after logout is unspecified; clients should expect auth errors and re-prompt.

**Terminal-auth extension (real-world):** Zed sets `clientCapabilities._meta["terminal-auth"] = true` ([zed `crates/agent_servers/src/acp.rs`](https://github.com/zed-industries/zed/blob/main/crates/agent_servers/src/acp.rs), which also implements a `"spawn-gemini-cli"` terminal-auth method). opencode consumes this: when present it attaches `_meta["terminal-auth"] = { command: "opencode", args: ["auth","login"], label: "OpenCode Login" }` to its auth method, so the client can run a terminal command to log in ([opencode `acp/service.ts`](https://github.com/sst/opencode/blob/dev/packages/opencode/src/acp/service.ts)). This is a `_meta` extension, not standardized.

---

## 7. Full method reference

Direction convention: **C→A** = client calls agent (agent = server); **A→C** = agent calls client (client = server). All request params/results are objects that also accept `_meta`.

### Agent-side methods (C→A)

| Method | Kind | Params | Result | Capability gate |
|---|---|---|---|---|
| `initialize` | request | `protocolVersion: int`, `clientCapabilities`, `clientInfo?` | `protocolVersion`, `agentCapabilities`, `agentInfo?`, `authMethods[]` | baseline |
| `authenticate` | request | `methodId` | `{}` | — |
| `logout` | request | `{}` | `{}` | `agentCapabilities.auth.logout` |
| `session/new` | request | `cwd` (abs), `mcpServers[]`, `additionalDirectories?[]` | `sessionId`, `modes?`, `configOptions?` | baseline |
| `session/load` | request | `sessionId`, `cwd`, `mcpServers[]`, `additionalDirectories?[]` | `modes?`, `configOptions?` (replays history first via `session/update`) | `loadSession: true` |
| `session/resume` | request | `sessionId`, `cwd`, `mcpServers[]`, `additionalDirectories?[]` | `modes?`, `configOptions?` (**no replay**) | `sessionCapabilities.resume` |
| `session/close` | request | `sessionId` | `{}` (cancels ongoing work, frees session) | `sessionCapabilities.close` |
| `session/list` | request | `cwd?`, `cursor?` | `sessions: SessionInfo[]`, `nextCursor?` | `sessionCapabilities.list` |
| `session/delete` | request | `sessionId` | `{}` (idempotent) | `sessionCapabilities.delete` |
| `session/fork` *(unstable)* | request | `sessionId`, `cwd?`, `mcpServers?` | like `session/load` | `sessionCapabilities.fork` |
| `session/prompt` | request | `sessionId`, `prompt: ContentBlock[]` | `stopReason` (+unstable `usage`, `userMessageId`) | baseline |
| `session/set_mode` | request | `sessionId`, `modeId` | `{}` | modes advertised |
| `session/set_config_option` | request | `sessionId`, `configId`, `value` (+`type:"boolean"` for booleans) | `configOptions[]` (full state) | config options advertised |
| `session/cancel` | **notification** | `sessionId` | — | baseline |
| `providers/list`, `providers/set`, `providers/disable` *(unstable)* | request | — | configurable LLM providers RFD | `_meta` negotiation |
| `nes/start|suggest|accept|reject|close` *(unstable)* | — | — | next-edit-suggestions RFD | — |
| `document/didOpen|didChange|didClose|didSave|didFocus` *(unstable)* | notification | editor document state | — | — |

### Client-side methods (A→C)

| Method | Kind | Params | Result | Capability gate |
|---|---|---|---|---|
| `session/update` | **notification** | `sessionId`, `update: SessionUpdate` (see [§8](#8-sessionupdate-notification--every-content-type-in-detail)) | — | baseline |
| `session/request_permission` | request | `sessionId`, `toolCall: ToolCallUpdate`, `options: PermissionOption[]` | `outcome` (see [§14](#14-permission-flow-in-detail)) | baseline |
| `fs/read_text_file` | request | `sessionId`, `path`, `line?`, `limit?` | `content: string` | `fs.readTextFile` |
| `fs/write_text_file` | request | `sessionId`, `path`, `content` | `{}` / `null` | `fs.writeTextFile` |
| `terminal/create` | request | `sessionId`, `command`, `args[]`, `env[]`, `cwd?`, `outputByteLimit?` | `terminalId` | `terminal` |
| `terminal/output` | request | `sessionId`, `terminalId` | `output`, `truncated`, `exitStatus?` | `terminal` |
| `terminal/wait_for_exit` | request | `sessionId`, `terminalId` | `exitCode`, `signal` | `terminal` |
| `terminal/kill` | request | `sessionId`, `terminalId` | `{}` (ID stays valid) | `terminal` |
| `terminal/release` | request | `sessionId`, `terminalId` | `{}` (kills if running; ID invalidated) | `terminal` |
| `elicitation/create` | request | `message`, `mode:"form"`+`requestedSchema` or `mode:"url"`+`elicitationId`+`url`; scoped by `sessionId`(+`toolCallId?`) or `requestId` | `action: "accept"`(+`content?`) \| `"decline"` \| `"cancel"` | `elicitation.form` / `elicitation.url` |
| `elicitation/complete` | **notification** | `elicitationId` | — (URL-flow completion) | — |
| `mcp/connect`, `mcp/message`, `mcp/disconnect` *(unstable)* | — | — | MCP-over-ACP tunneling RFD | — |

### Protocol-level (both directions)

| Method | Kind | Params | Result |
|---|---|---|---|
| `$/cancel_request` | **notification** | `requestId` | cancelled request must eventually get a normal result or error `-32800` |

Sources: [schema page](https://agentclientprotocol.com/protocol/v1/schema) (Agent / Client / Protocol Level sections), [TS SDK `AGENT_METHODS`/`CLIENT_METHODS`/`PROTOCOL_METHODS`](https://github.com/agentclientprotocol/typescript-sdk/blob/main/src/schema/index.ts). Unstable sets live in `schema/v1/schema.unstable.json`.

### Key request/response JSON (verbatim shapes from the spec)

**`session/new`:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "session/new",
  "params": {
    "cwd": "/home/user/project",
    "mcpServers": [
      { "name": "filesystem", "command": "/path/to/mcp-server", "args": ["--stdio"], "env": [] }
    ]
  }
}
```

Response (minimal and with optional mode/config state):

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "sessionId": "sess_abc123def456",
    "modes": {
      "currentModeId": "ask",
      "availableModes": [
        { "id": "ask", "name": "Ask", "description": "Request permission before making any changes" },
        { "id": "code", "name": "Code", "description": "Write and modify code with full tool access" }
      ]
    },
    "configOptions": [ /* see §13 */ ]
  }
}
```

`McpServer` variants ([session-setup](https://agentclientprotocol.com/protocol/v1/session-setup#mcp-servers)):
- **stdio (all agents MUST support):** `{ name, command /*abs path*/, args: string[], env: [{name, value}] }`
- **http:** `{ type: "http", name, url, headers: [{name, value}] }` — needs `mcpCapabilities.http`
- **sse:** `{ type: "sse", name, url, headers }` — needs `mcpCapabilities.sse` (deprecated transport)

`additionalDirectories: string[]` (absolute paths; complete list; only when `sessionCapabilities.additionalDirectories`); effective root set = `[cwd, ...additionalDirectories]`.

**`session/load`** — same params plus `sessionId`. The agent MUST replay the entire conversation via `session/update` notifications (`user_message_chunk`, `agent_message_chunk`, tool calls, …) **before** responding; the response is then `{"result": {"modes": ..., "configOptions": ...}}` (docs show `result: null` in the minimal example; the schema allows optional `modes`/`configOptions`). Clients MUST NOT call it unless `loadSession: true`.

**`session/resume`** — same params; **MUST NOT replay**; returns current `modes`/`configOptions` when supported.

**`session/close`:**

```json
{ "jsonrpc": "2.0", "id": 2, "method": "session/close", "params": { "sessionId": "sess_789xyz" } }
→ { "jsonrpc": "2.0", "id": 2, "result": {} }
```

MUST behave as if `session/cancel` was called, then free resources. Errors allowed for unknown/inactive sessions.

**`session/list`:**

```json
{ "jsonrpc": "2.0", "id": 2, "method": "session/list", "params": { "cwd": "/home/user/project", "cursor": "eyJwYWdlIjogMn0=" } }
```

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "sessions": [
      {
        "sessionId": "sess_abc123def456",
        "cwd": "/home/user/project",
        "title": "Implement session list API",
        "updatedAt": "2025-10-29T14:22:15Z",
        "_meta": { "messageCount": 12, "hasErrors": false }
      }
    ],
    "nextCursor": "eyJwYWdlIjogM30="
  }
}
```

`SessionInfo = { sessionId, cwd, additionalDirectories?, title?, updatedAt?, _meta? }`; cursors are opaque; missing `nextCursor` = end.

**`session/delete`:** `params: {sessionId}` → `result: {}`; deleting a nonexistent/deleted session SHOULD succeed silently; removed from future `session/list` results.

**`session/set_mode`:**

```json
{ "jsonrpc": "2.0", "id": 2, "method": "session/set_mode", "params": { "sessionId": "sess_abc123def456", "modeId": "code" } }
→ { "jsonrpc": "2.0", "id": 2, "result": {} }
```

May be called at any time (idle or generating). `modeId` must be from `availableModes`.

---

## 8. `session/update` notification — every content type in detail

Source: [schema: SessionUpdate](https://agentclientprotocol.com/protocol/v1/schema#sessionupdate), [prompt-turn spec](https://agentclientprotocol.com/protocol/v1/prompt-turn#3-agent-reports-output).

Envelope (notification — no `id`, never any response):

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "sess_abc123def456",
    "update": { "sessionUpdate": "<discriminator>", ... }
  }
}
```

`SessionUpdate` is a **tagged union discriminated by `sessionUpdate`** with exactly these stable v1 variants:

### 8.1 `user_message_chunk` / 8.2 `agent_message_chunk` / 8.3 `agent_thought_chunk`

Identical shape; differ only in meaning. `user_message_chunk` is used mainly for **history replay** during `session/load` (opencode also emits it live).

```json
{
  "sessionId": "sess_abc123def456",
  "update": {
    "sessionUpdate": "agent_message_chunk",
    "messageId": "msg_agent_c42b9",
    "content": { "type": "text", "text": "I'll analyze your code for potential issues…" }
  }
}
```

- `content: ContentBlock` — **exactly one block per chunk** (usually `text`; can be any ContentBlock). Chunks with the same `messageId` are concatenated in order into one message; a changed/absent `messageId` starts a new message. `messageId` is optional (`MessageId | null`) — if the agent provides IDs, clients group by them.
- `agent_thought_chunk` streams the model's internal reasoning; rendered collapsed/dimmed by clients (spec: for reasoning display).
- Rendering guidance: text "may be plain text or formatted with Markdown… Clients SHOULD render this text as Markdown" ([schema: ContentBlock.text](https://agentclientprotocol.com/protocol/v1/schema#contentblock)).
- Text chunks may carry `annotations.audience: ["user"|"assistant"]` (inherited from MCP); opencode maps `audience:["assistant"]`→"synthetic" and `["user"]`→"ignored" internally (see [§21](#21-how-opencode-implements-acp)).

### 8.4 `tool_call` — create a tool call

```json
{
  "sessionId": "sess_abc123def456",
  "update": {
    "sessionUpdate": "tool_call",
    "toolCallId": "call_001",
    "title": "Reading configuration file",
    "kind": "read",
    "status": "pending",
    "content": [],
    "locations": [ { "path": "/home/user/project/src/config.json" } ],
    "rawInput": { "filePath": "/home/user/project/src/config.json" },
    "rawOutput": {}
  }
}
```

All fields except `sessionUpdate`+`toolCallId` are technically optional on creation; `status` defaults to `pending`. Full field semantics in [§10](#10-tool-calls).

### 8.5 `tool_call_update` — patch an existing tool call

```json
{
  "sessionId": "sess_abc123def456",
  "update": {
    "sessionUpdate": "tool_call_update",
    "toolCallId": "call_001",
    "status": "in_progress",
    "content": [
      { "type": "content", "content": { "type": "text", "text": "Found 3 configuration files…" } }
    ]
  }
}
```

**All fields except `toolCallId` are optional — include only changed fields.** Present collections **replace** the previous collection (not append).

### 8.6 `plan` — full plan snapshot

```json
{
  "sessionId": "sess_abc123def456",
  "update": {
    "sessionUpdate": "plan",
    "entries": [
      { "content": "Check for syntax errors",       "priority": "high",   "status": "pending" },
      { "content": "Identify potential type issues", "priority": "medium", "status": "pending" },
      { "content": "Review error handling patterns", "priority": "medium", "status": "pending" },
      { "content": "Suggest improvements",           "priority": "low",    "status": "pending" }
    ]
  }
}
```

The agent **MUST send the complete entry list every time**; the client **MUST replace the whole plan**. Details in [§11](#11-agent-plans).

### 8.7 `available_commands_update`

```json
{
  "sessionId": "sess_abc123def456",
  "update": {
    "sessionUpdate": "available_commands_update",
    "availableCommands": [
      { "name": "web",  "description": "Search the web for information", "input": { "hint": "query to search for" } },
      { "name": "test", "description": "Run tests for the current project" },
      { "name": "plan", "description": "Create a detailed implementation plan", "input": { "hint": "description of what to plan" } }
    ]
  }
}
```

`AvailableCommand = { name, description, input?: { hint } }` (unstructured text input; everything typed after `/name` is the argument). May be sent any time (typically right after session create/load). Clients offer these as slash commands and send them as ordinary `session/prompt` text (`"/web agent client protocol"`). Source: [slash-commands spec](https://agentclientprotocol.com/protocol/v1/slash-commands).

### 8.8 `current_mode_update`

```json
{
  "sessionId": "sess_abc123def456",
  "update": { "sessionUpdate": "current_mode_update", "currentModeId": "code" }
}
```

Agent-initiated mode switch (e.g. a model-invoked "exit plan mode" tool). See [§12](#12-modes).

### 8.9 `config_option_update`

```json
{
  "sessionId": "sess_abc123def456",
  "update": {
    "sessionUpdate": "config_option_update",
    "configOptions": [ /* full SessionConfigOption[] state, see §13 */ ]
  }
}
```

Complete config state; reasons include mode switches after planning, model fallback on rate limits, changed available options. See [§13](#13-session-config-options).

### 8.10 `session_info_update`

```json
{
  "sessionId": "sess_abc123def456",
  "update": {
    "sessionUpdate": "session_info_update",
    "title": "Implement user authentication",
    "_meta": { "tags": ["feature", "auth"], "priority": "high" }
  }
}
```

Optional partial fields: `title: string|null` (null clears), `updatedAt: string|null`, `_meta`. Typically sent after the first exchange to auto-title the session. Source: [session-list spec](https://agentclientprotocol.com/protocol/v1/session-list#updating-session-metadata).

### 8.11 `usage_update`

```json
{
  "sessionId": "sess_abc123def456",
  "update": {
    "sessionUpdate": "usage_update",
    "used": 53000,
    "size": 200000,
    "cost": { "amount": 0.045, "currency": "USD" }
  }
}
```

`used` (tokens currently in context) and `size` (total context window, tokens) are **required non-null uint64s**; `cost` optional but if present `amount:number` + `currency` (ISO 4217) are required. Source: [prompt-turn spec](https://agentclientprotocol.com/protocol/v1/prompt-turn#session-usage-updates).

### Ordering rules

- Updates may be sent freely during a turn; after `session/cancel`, the agent MAY still send final updates but MUST finish them **before** responding to `session/prompt`; clients SHOULD keep accepting them ([prompt-turn](https://agentclientprotocol.com/protocol/v1/prompt-turn#cancellation)).
- v1 treats updates as turn-scoped in practice; v2 explicitly allows updates at any time (see [§19](#19-protocolversion-versioning-and-evolution)).

---

## 9. Content blocks (`ContentBlock` union)

Source: [content spec](https://agentclientprotocol.com/protocol/v1/content), [schema: ContentBlock](https://agentclientprotocol.com/protocol/v1/schema#contentblock).

ACP reuses the **MCP `ContentBlock` structure** ("This design choice enables Agents to seamlessly forward content from MCP tool outputs without transformation"). Every variant also accepts `annotations?` and `_meta?`. `Annotations = { audience?: ("user"|"assistant")[], lastModified?: string, priority?: number }` (MCP annotations).

| `type` | Shape | Prompt support |
|---|---|---|
| `text` | `{ type: "text", text: string }` — plain or Markdown | **MUST** (baseline) |
| `resource_link` | `{ type: "resource_link", uri, name, mimeType?, title?, description?, size? }` | **MUST** (baseline) |
| `image` | `{ type: "image", data /*base64*/, mimeType, uri? }` | needs `promptCapabilities.image` |
| `audio` | `{ type: "audio", data /*base64*/, mimeType }` | needs `promptCapabilities.audio` |
| `resource` | `{ type: "resource", resource: TextResourceContents \| BlobResourceContents }` | needs `promptCapabilities.embeddedContext` |

`Role` enum (used in `annotations.audience` and message metadata): `"user" | "assistant"`.

Examples (from spec):

```json
{ "type": "text",  "text": "What's the weather like today?" }

{ "type": "image", "mimeType": "image/png", "data": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB..." }

{ "type": "audio", "mimeType": "audio/wav", "data": "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAAB..." }

{ "type": "resource", "resource": {
    "uri": "file:///home/user/script.py", "mimeType": "text/x-python",
    "text": "def hello():\n    print('Hello, world!')" } }

{ "type": "resource_link", "uri": "file:///home/user/document.pdf",
  "name": "document.pdf", "mimeType": "application/pdf", "size": 1024000 }
```

- `TextResourceContents = { uri, text, mimeType? }`; `BlobResourceContents = { uri, blob /*base64*/, mimeType? }`.
- Embedded `resource` is the **preferred** way to attach context (@-mentions): it avoids round-trips and lets clients include sources the agent can't reach ([prompt-turn spec](https://agentclientprotocol.com/protocol/v1/prompt-turn#1-user-message)).
- Where content blocks appear: `session/prompt.prompt[]`, message chunk `content`, and wrapped in `ToolCallContent` for tool output.

---

## 10. Tool calls

Source: [tool-calls spec](https://agentclientprotocol.com/protocol/v1/tool-calls), [schema: ToolCall/ToolCallUpdate/ToolKind/…](https://agentclientprotocol.com/protocol/v1/schema).

### Lifecycle

1. Model requests a tool → agent sends `session/update` `tool_call` (usually `status: "pending"`).
2. Agent **MAY** call `session/request_permission` before executing ([§14](#14-permission-flow-in-detail)).
3. Agent executes, sends `tool_call_update` with `status: "in_progress"` (+ live content).
4. On completion: `tool_call_update` with `status: "completed"` (+ final content, `rawOutput`) or `"failed"` (+ error text).
5. Results go back to the model; loop continues until the model stops requesting tools.

### `ToolCall` / `tool_call` fields

| Field | Type | Meaning |
|---|---|---|
| `toolCallId` | string | unique within the session |
| `title` | string | human-readable description of what the tool is doing |
| `kind` | `ToolKind` | icon/UX hint: `read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `switch_mode`, `other` (default) |
| `status` | `ToolCallStatus` | `pending` (not started — input streaming or awaiting approval), `in_progress`, `completed`, `failed` |
| `content` | `ToolCallContent[]` | produced content (below) |
| `locations` | `ToolCallLocation[]` | `{ path /*abs*/, line? }` — enables client "follow-along" (auto-open files as the agent works) |
| `rawInput` | object | raw tool input parameters |
| `rawOutput` | object | raw tool output |

### `ToolCallContent` union (discriminator `type`)

```json
{ "type": "content", "content": { "type": "text", "text": "Analysis complete. Found 3 issues." } }
```

```json
{ "type": "diff", "path": "/home/user/project/src/config.json",
  "oldText": "{\n  \"debug\": false\n}", "newText": "{\n  \"debug\": true\n}" }
```

- `diff`: `oldText` is `null` for new files; clients render a file diff view.
- `terminal`: `{ "type": "terminal", "terminalId": "term_xyz789" }` — embeds a live client terminal created via `terminal/create`; client streams its output live inside the tool card and **keeps displaying it even after `terminal/release`** ([terminals spec](https://agentclientprotocol.com/protocol/v1/terminals#embedding-in-tool-calls)).

### `tool_call_update` patch semantics

All fields except `toolCallId` optional; only changed fields sent; array fields replace the stored array. `content: null` vs omitted are distinguishable in the schema (`ToolCallContent[] | null`).

---

## 11. Agent plans

Source: [agent-plan spec](https://agentclientprotocol.com/protocol/v1/agent-plan), [schema: Plan/PlanEntry](https://agentclientprotocol.com/protocol/v1/schema#plan).

- Delivered as the `plan` variant of `session/update` (see [§8.6](#86-plan--full-plan-snapshot)).
- **`Plan = { entries: PlanEntry[] }`** — that is the whole object in v1. There is **no plan `id`, no plan-level `status` (`pending/active/completed/cancelled`), no `content`** on the plan itself. (Those belong to the v2 draft `plan_update` — see [§19](#19-protocolversion-versioning-and-evolution).)
- **`PlanEntry = { content: string, priority, status }`**:
  - `content`: human-readable task description
  - `priority`: `"high" | "medium" | "low"`
  - `status`: `"pending" | "in_progress" | "completed"` (no `cancelled` in v1)
- Update rule: agent MUST send a **complete** list each update; client MUST **replace** the plan wholesale. Entries may be added/removed/reordered as the plan evolves ("Dynamic Planning").

---

## 12. Modes

Source: [session-modes spec](https://agentclientprotocol.com/protocol/v1/session-modes).

> Status note: modes are **superseded by [Session Config Options](#13-session-config-options)** ("Dedicated session mode methods will be removed in a future version of the protocol. Until then, you can offer both for backwards compatibility"). v2 removes `session/set_mode` entirely. New servers should implement both.

- **Initial state:** `session/new` / `session/load` / `session/resume` responses MAY include `modes: SessionModeState`:

```json
"modes": {
  "currentModeId": "ask",
  "availableModes": [
    { "id": "ask",      "name": "Ask",      "description": "Request permission before making any changes" },
    { "id": "architect","name": "Architect","description": "Design and plan software systems without implementation" },
    { "id": "code",     "name": "Code",     "description": "Write and modify code with full tool access" }
  ]
}
```

- **`SessionMode = { id: SessionModeId, name, description? }`** — v1 has **no `kind` (primary/secondary/subagent) and no per-mode commands**. Modes "often affect the system prompts used, the availability of tools, and whether they request permission before running."
- **Client sets mode** at any time: `session/set_mode` (`{sessionId, modeId}`) → `{}`.
- **Agent changes its own mode** → `session/update` `current_mode_update` (`{currentModeId}`).
- **Exit-plan-mode pattern:** agents commonly expose a model-facing "switch mode" tool whose execution requests permission with the plan in `toolCall.content` and options like:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "session/request_permission",
  "params": {
    "sessionId": "sess_abc123def456",
    "toolCall": {
      "toolCallId": "call_switch_mode_001",
      "title": "Ready for implementation",
      "kind": "switch_mode",
      "status": "pending",
      "content": [ { "type": "text", "text": "## Implementation Plan..." } ]
    },
    "options": [
      { "optionId": "code",   "name": "Yes, and auto-accept all actions", "kind": "allow_always" },
      { "optionId": "ask",    "name": "Yes, and manually accept actions", "kind": "allow_once" },
      { "optionId": "reject", "name": "No, stay in architect mode",       "kind": "reject_once" }
    ]
  }
}
```

On selection the tool runs, sets the mode, and emits `current_mode_update`.

---

## 13. Session config options

Source: [session-config-options spec](https://agentclientprotocol.com/protocol/v1/session-config-options).

The preferred, general mechanism ("Agents can provide an arbitrary list of configuration options… models, modes, reasoning levels, and more"). If an agent provides `configOptions`, clients SHOULD use them **instead of** `modes` (but keep both in sync during the transition).

**Initial state** (in `session/new`/`load`/`resume` responses):

```json
"configOptions": [
  {
    "id": "mode",
    "name": "Session Mode",
    "description": "Controls how the agent requests permission",
    "category": "mode",
    "type": "select",
    "currentValue": "ask",
    "options": [
      { "value": "ask",  "name": "Ask",  "description": "Request permission before making any changes" },
      { "value": "code", "name": "Code", "description": "Write and modify code with full tool access" }
    ]
  },
  {
    "id": "model", "name": "Model", "category": "model", "type": "select",
    "currentValue": "model-1",
    "options": [ { "value": "model-1", "name": "Model 1", "description": "The fastest model" },
                 { "value": "model-2", "name": "Model 2", "description": "The most powerful model" } ]
  }
]
```

**`SessionConfigOption`** (tagged by `type`):
- shared: `id`, `name`, `description?`, `category?`, `_meta?`
- `select`: + `currentValue: SessionConfigValueId`, `options` = flat `SessionConfigSelectOption[]` (`{value, name, description?}`) **or grouped** `{group, name, options[]}[]`
- `boolean`: + `currentValue: boolean` — only when client advertised `session.configOptions.boolean: {}`

**Categories** (`SessionConfigOptionCategory`, UX-only, MUST NOT be required for correctness): `mode`, `model`, `model_config` (render near model selector), `thought_level`, `other`; `_`-prefixed names are custom.

**Rules:** array order = agent-preferred priority; agents MUST always have a default per option; clients ignore unknown `type`s (agent falls back to default).

**Setting** — `session/set_config_option`:

```json
{ "jsonrpc": "2.0", "id": 2, "method": "session/set_config_option",
  "params": { "sessionId": "sess_abc123def456", "configId": "mode", "value": "code" } }
```

Boolean form adds `"type": "boolean"` and boolean `value`. Response **always returns the complete config state** (so dependent options can change): `{ "result": { "configOptions": [ ...full list... ] } }`.

**Agent-initiated changes** → `session/update` `config_option_update` with the full state (see [§8.9](#89-config_option_update)).

---

## 14. Permission flow in detail

Source: [tool-calls spec — Requesting Permission](https://agentclientprotocol.com/protocol/v1/tool-calls#requesting-permission), [schema: RequestPermissionRequest/Response, PermissionOption, RequestPermissionOutcome](https://agentclientprotocol.com/protocol/v1/schema).

This is an **Agent→Client JSON-RPC request** (`session/request_permission`), sent before executing a sensitive tool call. It can arrive **while a `session/prompt` request is outstanding** — that is the normal "permission interrupts a prompt" mechanism (there is no other interrupt).

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "session/request_permission",
  "params": {
    "sessionId": "sess_abc123def456",
    "toolCall": { "toolCallId": "call_001", "title": "Reading configuration file", "kind": "read", "status": "pending" },
    "options": [
      { "optionId": "allow-once", "name": "Allow once", "kind": "allow_once" },
      { "optionId": "reject-once", "name": "Reject",     "kind": "reject_once" }
    ]
  }
}
```

- `toolCall: ToolCallUpdate` — a tool-call-shaped object describing the operation (may include `content`, e.g. a `diff` preview; opencode sends computed before/after diffs here — see [§21](#21-how-opencode-implements-acp)).
- `options: PermissionOption[]` — **flat list**; each is `{ optionId: string /*unique*/, name: string /*label*/, kind: PermissionOptionKind }`.
- `PermissionOptionKind` values and required behavior:
  - `allow_once` — allow this operation only this time
  - `allow_always` — allow and **remember the choice** (the agent then persists a permission rule)
  - `reject_once` — reject this operation only this time
  - `reject_always` — reject and remember the choice
- The **agent decides** which options to offer (this is the "mode-based vs prompt-based" behavior: an "ask" mode offers allow/reject; an auto-accept mode may not request at all; a plan-exit tool offers mode-switching options — see [§12](#12-modes)). Clients MAY auto-allow/auto-reject per user settings.

**Response — user selected an option:**

```json
{ "jsonrpc": "2.0", "id": 5, "result": { "outcome": { "outcome": "selected", "optionId": "allow-once" } } }
```

**Response — turn was cancelled** (client MUST answer every pending permission request with this after sending `session/cancel`):

```json
{ "jsonrpc": "2.0", "id": 5, "result": { "outcome": { "outcome": "cancelled" } } }
```

`RequestPermissionOutcome` = `{ "outcome": "cancelled" }` | `{ "outcome": "selected", "optionId }`. Agent behavior per outcome: proceed / skip (report tool as failed or never run) / abort turn (`cancelled` stop reason).

**Cascading cancellation:** when the client cancels the turn, the agent cancels its in-flight client-requests via `$/cancel_request`, and the client answers those with error `-32800` ([cancellation spec](https://agentclientprotocol.com/protocol/v1/cancellation#cascading-cancellation-flow)).

---

## 15. `session/prompt` in detail

Source: [prompt-turn spec](https://agentclientprotocol.com/protocol/v1/prompt-turn), [schema: PromptRequest/Response, StopReason](https://agentclientprotocol.com/protocol/v1/schema).

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/prompt",
  "params": {
    "sessionId": "sess_abc123def456",
    "prompt": [
      { "type": "text", "text": "Can you analyze this code for potential issues?" },
      { "type": "resource", "resource": {
          "uri": "file:///home/user/project/main.py", "mimeType": "text/x-python",
          "text": "def process_data(items):\n    for item in items:\n        print(item)" } }
    ]
  }
}
```

- `prompt: ContentBlock[]` — allowed types constrained by `promptCapabilities` ([§5](#5-capabilities-reporting)); baseline MUST accept `text` + `resource_link`. Slash commands are plain text (`"/web query"`).
- (Unstable SDK additions seen in the wild: `params.messageId` client-generated user-message id → echoed as `userMessageId` in the response, plus `usage` — opencode uses both; gated by `_meta` negotiation.)

**Response** (turn finished — this request stays open for the whole turn):

```json
{ "jsonrpc": "2.0", "id": 2, "result": { "stopReason": "end_turn" } }
```

**`StopReason` values (complete list):**

| Value | Meaning |
|---|---|
| `end_turn` | model finished responding without requesting more tools |
| `max_tokens` | maximum token limit reached |
| `max_turn_requests` | maximum number of model requests in a single turn exceeded |
| `refusal` | agent refuses to continue; "the user prompt and everything after it won't be included in the next prompt, so this should be reflected in the UI" |
| `cancelled` | the client cancelled via `session/cancel`. MUST be returned even if cancellation caused exceptions internally — agents MUST catch abort exceptions and answer with this stop reason, never with an error response. |

**During the turn** the agent sends: `plan`, `agent_message_chunk`, `tool_call`, permission requests, `tool_call_update` (`in_progress`→`completed`/`failed`), `usage_update`, etc. (full variant list in [§8](#8-sessionupdate-notification--every-content-type-in-detail)); loop continues until no more tool calls are requested or the turn is stopped/cancelled.

---

## 16. Client-side services: filesystem and terminals

### Filesystem — [file-system spec](https://agentclientprotocol.com/protocol/v1/file-system)

Purpose: read files **including unsaved editor state**, and make writes visible to the client (editor dirty buffers). Both gated by `clientCapabilities.fs.*`.

**`fs/read_text_file`** (A→C):

```json
{ "jsonrpc": "2.0", "id": 3, "method": "fs/read_text_file",
  "params": { "sessionId": "sess_abc123def456", "path": "/home/user/project/src/main.py", "line": 10, "limit": 50 } }
→ { "jsonrpc": "2.0", "id": 3, "result": { "content": "def hello_world():\n    print('Hello, world!')\n" } }
```

`path` absolute; `line` 1-based start; `limit` max lines.

**`fs/write_text_file`** (A→C): `{sessionId, path, content}` → `result: null`. "The Client MUST create the file if it doesn't exist."

### Terminals — [terminals spec](https://agentclientprotocol.com/protocol/v1/terminals)

Gated by `clientCapabilities.terminal: true` (all five methods).

**`terminal/create`:**

```json
{ "jsonrpc": "2.0", "id": 5, "method": "terminal/create",
  "params": {
    "sessionId": "sess_abc123def456",
    "command": "npm", "args": ["test", "--coverage"],
    "env": [ { "name": "NODE_ENV", "value": "test" } ],
    "cwd": "/home/user/project",
    "outputByteLimit": 1048576
  } }
→ { "jsonrpc": "2.0", "id": 5, "result": { "terminalId": "term_xyz789" } }
```

Returns immediately (background execution). `outputByteLimit`: retained output cap; on overflow the client truncates from the beginning, at a UTF-8 character boundary.

**`terminal/output`:**

```json
{ "jsonrpc": "2.0", "id": 6, "method": "terminal/output",
  "params": { "sessionId": "sess_abc123def456", "terminalId": "term_xyz789" } }
→ { "jsonrpc": "2.0", "id": 6, "result": {
      "output": "Running tests...\n✓ All tests passed (42 total)\n",
      "truncated": false,
      "exitStatus": { "exitCode": 0, "signal": null } } }
```

(`exitStatus` present only after exit; `exitCode`/`signal` nullable.)

**`terminal/wait_for_exit`:** `{sessionId, terminalId}` → `{ "exitCode": 0, "signal": null }` (blocks until exit).

**`terminal/kill`:** kills the command; terminal ID **remains valid** for `output`/`wait_for_exit`; still must `release` later. Used to build timeouts (create → race timer vs `wait_for_exit` → kill → output → release).

**`terminal/release`:** kills if running and frees resources; ID becomes invalid afterwards; tool-call cards embedding it keep showing output. **Agents MUST release every terminal they create.**

---

## 17. Slash commands, session info updates, usage updates, elicitation

- **Slash commands**: see [§8.7](#87-available_commands_update). Advertised via `available_commands_update`; invoked as ordinary prompt text. ([spec](https://agentclientprotocol.com/protocol/v1/slash-commands))
- **Session info updates**: see [§8.10](#810-session_info_update). ([spec](https://agentclientprotocol.com/protocol/v1/session-list#updating-session-metadata))
- **Usage updates**: see [§8.11](#811-usage_update). ([spec](https://agentclientprotocol.com/protocol/v1/prompt-turn#session-usage-updates))
- **Elicitation** (stabilized 2026): `elicitation/create` lets the agent ask the user **structured** input — a JSON-schema-driven form (`mode: "form"`, property schemas for string/number/boolean/enum/multi-select with `title`/`description`/`default`/constraints) or a URL flow (`mode: "url"` + `elicitationId`; completion signaled by the agent via the `elicitation/complete` notification). Responses: `accept` (+`content` matching schema) / `decline` / `cancel`. Scoped to a session+toolCall or an arbitrary request. Gated by `clientCapabilities.elicitation.{form,url}`. Full schemas: [elicitation spec](https://agentclientprotocol.com/protocol/v1/elicitation), [schema page](https://agentclientprotocol.com/protocol/v1/schema#elicitationcreate).

---

## 18. Cancellation

Sources: [prompt-turn — cancellation](https://agentclientprotocol.com/protocol/v1/prompt-turn#cancellation), [cancellation spec](https://agentclientprotocol.com/protocol/v1/cancellation), [schema: $/cancel_request](https://agentclientprotocol.com/protocol/v1/schema#cancelrequestnotification).

### Turn cancellation — `session/cancel` (C→A **notification**)

```json
{ "jsonrpc": "2.0", "method": "session/cancel", "params": { "sessionId": "sess_abc123def456" } }
```

- On receipt the agent **SHOULD** stop all model requests and tool executions ASAP; it MAY send final `session/update`s **before** responding; then it **MUST** answer the outstanding `session/prompt` with `stopReason: "cancelled"` (never an error).
- The client **SHOULD** preemptively mark non-finished tool calls `cancelled` locally and **MUST** answer all pending `session/request_permission` requests with the `cancelled` outcome; it SHOULD keep accepting late tool-call updates.

### Request cancellation — `$/cancel_request` (either direction, notification)

```json
{ "jsonrpc": "2.0", "method": "$/cancel_request", "params": { "requestId": 2 } }
```

Sent by the party that issued request `id` (e.g. agent cancelling its own `terminal/create`). Receiver MAY cancel; MUST eventually answer the original request with either a valid result or **error `-32800` (Request Cancelled)**. `$/*` methods are optional-to-implement and may be ignored. Internal (self-initiated) cancellations should also surface `-32800`.

---

## 19. `protocolVersion`, versioning & evolution

### Versioning model ([initialization spec](https://agentclientprotocol.com/protocol/v1/initialization#protocol-version), [repo README](https://github.com/agentclientprotocol/agent-client-protocol))

- `protocolVersion` = **integer MAJOR version** (`uint16`); bumped **only for breaking changes**. Current stable: **1**.
- **Non-breaking features are introduced via capabilities** — new capabilities, fields, and enum variants are added without a major bump; unknown capabilities must be treated as unsupported, unknown enum discriminators should degrade gracefully.
- Negotiation is per-connection (see [§4](#4-initialize-handshake--version-negotiation)).
- Schema artifact versioning is separate from wire protocol version ("Consumers should not infer wire compatibility from the crate or schema release version alone" — [README](https://github.com/agentclientprotocol/agent-client-protocol#versioning)). Versioned JSON Schemas: `schema/v1/schema.json` (+ `schema.unstable.json`), attached to GitHub releases.

### Change process: RFDs ("Requests for Dialog")

Protocol changes go through a public RFD process ([rfds](https://agentclientprotocol.com/rfds/about), [governance](https://agentclientprotocol.com/community/governance)); stabilized features are announced (e.g. session/list, session/resume, session/close, session/delete, logout, elicitation, boolean config options, request cancellation — see [announcements](https://agentclientprotocol.com/announcements/*) and repo CHANGELOG). Notable history: `session/stop` was renamed `session/close` pre-stabilization (PRs [#701](https://github.com/agentclientprotocol/agent-client-protocol/pull/701), [#724](https://github.com/agentclientprotocol/agent-client-protocol/pull/724)).

### Extensibility (stable mechanisms) — [extensibility spec](https://agentclientprotocol.com/protocol/v1/extensibility)

1. **`_meta` on every type** (`{[key: string]: unknown}`), including nested blocks/capabilities. Root-level `_meta` keys `traceparent`, `tracestate`, `baggage` reserved for W3C trace context. **No custom fields at the root of spec types** — all names reserved for future versions.
2. **`_`-prefixed methods** are reserved for custom extensions (requests must be answered; unknown custom *requests* → `-32601`; unknown custom *notifications* → ignore). Real example: `_zed.dev/workspace/buffers`.
3. **Custom capabilities** advertised via `_meta` inside capability objects (e.g. Zed's `terminal-auth`, opencode consumes it).

### ACP v2 (DRAFT — do not target for wire compatibility today)

Source: [v2 migration guide](https://agentclientprotocol.com/protocol/v2/migration), [v2 schema](https://agentclientprotocol.com/protocol/v2/schema), [v2 draft announcement](https://agentclientprotocol.com/announcements/acp-v2-draft). Key deltas (selected):

- **Prompt lifecycle:** `session/prompt` response only *acknowledges*; progress/completion arrive via new `state_update` notifications (`running`/`idle`/`requires_action`) which carry the stop reason. Updates allowed at any time (beyond the turn).
- **Upsert semantics:** messages/tool calls/plans patched by stable IDs — omitted=unchanged, `null`=cleared, value=replaced, chunks append. New whole-message variants (`user_message`, `agent_message`, `agent_thought`) and `tool_call_content_chunk`; `tool_call` creation variant removed (first `tool_call_update` creates).
- **Removed:** `fs/read_text_file`, `fs/write_text_file`, all `terminal/*` client methods ("use client-provided MCP servers"), `session/set_mode` (use config options), `current_mode_update`; `authenticate`/`logout` renamed `auth/login`/`auth/logout`; `session/load` removed (use `session/resume` with `replayFrom`).
- **initialize restructured:** symmetric `info` (required) + `capabilities`; session methods `list`/`resume`/`close` become required baseline.
- **Forward compatibility everywhere:** unknown enum values tolerated; `_`-prefixed values are implementer-owned.
- Negotiation unchanged mechanically: send `protocolVersion: 2` to opt in; agents answer with what they support; one connection speaks exactly one version.

---

## 20. Error handling & error codes

Source: [overview — error handling](https://agentclientprotocol.com/protocol/v1/overview#error-handling), [schema: ErrorCode](https://agentclientprotocol.com/protocol/v1/schema#errorcode), TS SDK `RequestError` constructors ([jsonrpc.ts](https://github.com/agentclientprotocol/typescript-sdk/blob/main/src/jsonrpc.ts)).

Standard JSON-RPC 2.0 envelope: success has `result`; failure has `error: {code, message, data?}`; **notifications never receive any response**.

| Code | Name | When |
|---|---|---|
| `-32700` | Parse error | invalid JSON |
| `-32600` | Invalid request | not a valid Request object |
| `-32601` | Method not found | unknown method / unsupported capability-gated method |
| `-32602` | Invalid params | bad parameters (unknown session, bad modeId/configId/model…) |
| `-32603` | Internal error | implementation-defined server errors |
| `-32800` | Request cancelled | request aborted via `$/cancel_request` or internally |
| `-32000` | **Authentication required** (`auth_required`) | auth-gated operation before `authenticate` |
| `-32002` | Resource not found | e.g. file not found |

(Server error range `-32000..-32099` reserved for protocol-specific codes; `Other` int allowed.)

---

## 21. How opencode implements ACP

All file links: [`sst/opencode` `dev` branch, `packages/opencode/src/acp/`](https://github.com/sst/opencode/tree/dev/packages/opencode/src/acp) (verified at commit `1c96545`, v1.18.18). opencode builds on the official [`@agentclientprotocol/sdk`](https://www.npmjs.com/package/@agentclientprotocol/sdk) with [Effect](https://effect.website) for error handling.

### Architecture: ACP façade over opencode's own HTTP API

`opencode acp` (CLI entrypoint: [`src/cli/cmd/acp.ts`](https://github.com/sst/opencode/blob/dev/packages/opencode/src/cli/cmd/acp.ts)):
1. Starts an **internal opencode server** (`Server.listen`) in-process.
2. Creates an opencode SDK client (`createOpencodeClient`) pointed at `http://127.0.0.1:<port>` with auth headers.
3. Pipes **stdin → ReadableStream**, **stdout → WritableStream**, wraps them in the SDK's `ndJsonStream` (NDJSON framing), and constructs an `AgentSideConnection` with the `Agent` implementation.

So the ACP layer is a **translator**: ACP ⇄ opencode's native session/event/permission HTTP+SSE API.

### File map

| File (all under `packages/opencode/src/acp/`) | Role |
|---|---|
| [`agent.ts`](https://github.com/sst/opencode/blob/dev/packages/opencode/src/acp/agent.ts) | Implements the SDK's `Agent` interface: `initialize`, `authenticate`, `newSession`, `loadSession`, `listSessions`, `resumeSession`, `closeSession`, `unstable_forkSession`, `setSessionConfigOption`, `setSessionMode`, `unstable_setSessionModel`, `prompt`, `cancel`; maps Effect errors → `RequestError` |
| [`service.ts`](https://github.com/sst/opencode/blob/dev/packages/opencode/src/acp/service.ts) | All handlers: capability advertisement, session lifecycle, prompt/command dispatch, slash-command detection, MCP registration, usage updates, stopReason mapping |
| [`session.ts`](https://github.com/sst/opencode/blob/dev/packages/opencode/src/acp/session.ts) | In-memory ACP session registry (`id`, `cwd`, `mcpServers`, model/variant/mode, per-part metadata keyed `messageId:partId`) |
| [`event.ts`](https://github.com/sst/opencode/blob/dev/packages/opencode/src/acp/event.ts) | **Event bridge**: subscribes to opencode's global SSE event stream; maps internal events → `session/update` notifications; replay for `session/load`; idle-wait machinery |
| [`permission.ts`](https://github.com/sst/opencode/blob/dev/packages/opencode/src/acp/permission.ts) | `permission.asked` events → `session/request_permission`; replies via `sdk.permission.reply`; pre-writes approved edits via `fs/write_text_file` |
| [`tool.ts`](https://github.com/sst/opencode/blob/dev/packages/opencode/src/acp/tool.ts) | opencode tool parts → ACP `ToolCall`/`ToolCallUpdate`: kind mapping, titles, locations, diffs, images, rawOutput |
| [`content.ts`](https://github.com/sst/opencode/blob/dev/packages/opencode/src/acp/content.ts) | ACP `ContentBlock[]` ⇄ opencode parts (`text`/`file`/`reasoning`), incl. `file://`/`zed://` URI handling and audience annotations |
| [`config-option.ts`](https://github.com/sst/opencode/blob/dev/packages/opencode/src/acp/config-option.ts) | Builds `configOptions`: `model` (category `model`, grouped by provider), `effort` (category `thought_level`, model variants), `mode` (category `mode`) |
| [`directory.ts`](https://github.com/sst/opencode/blob/dev/packages/opencode/src/acp/directory.ts) | Directory snapshot cache: providers/models, agents (modes), commands+skills, default model resolution |
| [`usage.ts`](https://github.com/sst/opencode/blob/dev/packages/opencode/src/acp/usage.ts) | Token/cost computation → `usage_update` |
| [`error.ts`](https://github.com/sst/opencode/blob/dev/packages/opencode/src/acp/error.ts) | Error taxonomy → JSON-RPC codes (`-32602`, `-32000` authRequired, `-32601`, `-32603`) |
| [`profile.ts`](https://github.com/sst/opencode/blob/dev/packages/opencode/src/acp/profile.ts) | Startup profiling marks |

### `initialize` (verbatim behavior from `service.ts`)

```json
{
  "protocolVersion": 1,
  "agentCapabilities": {
    "loadSession": true,
    "mcpCapabilities": { "http": true, "sse": true },
    "promptCapabilities": { "embeddedContext": true, "image": true },
    "sessionCapabilities": { "close": {}, "fork": {}, "list": {}, "resume": {} }
  },
  "authMethods": [{
    "id": "opencode-login", "name": "Login with opencode",
    "description": "Run `opencode auth login` in the terminal",
    "_meta": { "terminal-auth": { "command": "opencode", "args": ["auth", "login"], "label": "OpenCode Login" } }
  }],
  "agentInfo": { "name": "OpenCode", "version": "<install version>" }
}
```

(The `_meta.terminal-auth` block is only attached when the client advertised `clientCapabilities._meta["terminal-auth"] === true`.)

### Internal events → `session/update` mapping (`event.ts`)

opencode's global event stream (SSE) delivers `session.status`, `message.part.updated`, `message.part.delta`, `permission.asked`; `event.ts` maps:

| opencode event | ACP emission |
|---|---|
| `message.part.delta` (text part, assistant) | `session/update` `agent_message_chunk` `{messageId: <message id>, content:{type:"text", text:<delta>}}` |
| `message.part.delta` (reasoning part) | `session/update` `agent_thought_chunk` (same shape) |
| `message.part.updated` (tool part, first sighting) | `session/update` `tool_call` (`status:"pending"`, title/kind/locations/rawInput from `tool.ts`) |
| tool state `running` | `tool_call_update` `status:"in_progress"` (+ incremental bash output snapshot as text content; dedup via output snapshot cache) |
| tool state `completed` | `tool_call_update` `status:"completed"` with content (text; + `diff` for edit tools; + image attachments) and `rawOutput` |
| tool state `error` | `tool_call_update` `status:"failed"` with error text |
| `session.status` idle | resolves the idle-waiter so the pending `session/prompt` can return |
| `permission.asked` | → `permission.ts`: `session/request_permission` with options `[allow_once "once", allow_always "always", reject_once "reject"]`; answer mapped to opencode `permission.reply` (`once|always|reject`); **for `edit` permissions the patched file content is computed (diff apply) and pushed to the client via `fs/write_text_file`** when available |
| replay (on `session/load`) | history messages re-emitted as `user_message_chunk` / `agent_message_chunk` / `agent_thought_chunk` with stable `messageId`s, tool parts replayed through the same tool pipeline |

**Tool mapping** (`tool.ts`): `toToolKind`: bash/shell→`execute`, webfetch→`fetch`, edit/apply_patch/patch/write→`edit`, grep/glob/context*/context7*→`search`, read→`read`, task→`think`, else `other`. Shell tools get the command string as `title` and `cwd` injected into `rawInput`. Locations derived from `filePath`/`path`/`workdir` inputs (absolute paths).

**Modes/subagents:** opencode exposes its agents (config-defined) as ACP modes — filtering to `agent.mode !== "subagent" && !agent.hidden`; the `primary` (non-subagent, default) agent becomes `defaultModeID` (`service.ts` `loadDirectorySnapshot`). **Subagents are not separate ACP sessions** — they are internal; their work surfaces as ordinary tool calls (`task` tool → `think` kind). Slash commands: `command.list` + skills (deduped by name) → `available_commands_update` right after session create/load (`sendAvailableCommands`); during `session/prompt`, a leading `/name args` text is detected (`detectSlashCommand`) and dispatched to `sdk.session.command` (or built-ins like `/compact` → `session.summarize`).

**Stop reasons** (`service.ts` `promptResponse`): no error → `end_turn`; `MessageAbortedError` → `cancelled`; `MessageOutputLengthError` → `max_tokens`; `ContentFilterError` → `refusal`; `ProviderAuthError` → JSON-RPC `auth_required`; anything else → internal error. A `usage_update` is emitted after each prompt; `session/cancel` calls `sdk.session.abort`.

---

## 22. How Zed discovers & launches ACP agents

Sources: [Zed external-agents docs](https://zed.dev/docs/ai/external-agents) (source: [`zed-industries/zed/docs/src/ai/external-agents.md`](https://github.com/zed-industries/zed/blob/main/docs/src/ai/external-agents.md)), Zed client source [`crates/agent_servers/src/acp.rs`](https://github.com/zed-industries/zed/blob/main/crates/agent_servers/src/acp.rs), [ACP registry](https://agentclientprotocol.com/get-started/registry).

1. **ACP Registry (primary):** curated catalog ([github.com/agentclientprotocol/registry](https://github.com/agentclientprotocol/registry)); install via `zed::AcpRegistry` command or Agent Settings → External Agents → Add Agent → *Install from Registry*. Agents then appear in the Agent Panel's new-thread menu.
2. **Custom agents (settings.json):**

```json
{
  "agent_servers": {
    "my-agent": { "type": "custom", "command": "node", "args": ["~/projects/agent/index.js", "--acp"], "env": {} },
    "Poolside":  { "command": "pool", "args": ["acp"], "type": "custom" }
  }
}
```

   (Historically this key was named `context_servers`; extension-provided agents are deprecated and auto-migrated to registry equivalents.)
3. **Launch mechanics** (from `agent_servers/src/acp.rs`): command + args + env from settings → system shell, **non-interactive** → child `cwd` = project root (local projects) → spawn with piped stdin/stdout/stderr → NDJSON JSON-RPC over the pipes. stderr feeds Zed's ACP debug log (`dev::OpenAcpLogs`).
4. **Capabilities Zed sends:** `fs.readTextFile/writeTextFile`, `terminal: true`, plus `_meta["terminal-auth"] = true` (used for terminal-driven login flows, e.g. Gemini CLI's `spawn-gemini-cli` method, opencode's `opencode auth login`).
5. **Session/history integration:** Zed calls `session/list` (when advertised) for *Import Threads*; `session/load`/`resume` to reopen; MCP servers configured in Zed may be forwarded to the agent via `session/new.mcpServers`.
6. Other clients follow the same pattern (JetBrains AI Assistant, VS Code extensions, Neovim plugins — [clients list](https://agentclientprotocol.com/get-started/clients)); opencode documents `opencode acp` as its stdio entrypoint.

---

## 23. Wire-compatibility checklist for a new ACP server

Minimum viable Agent that Zed/JetBrains/etc. can drive:

1. **stdio only**, NDJSON: one JSON-RPC message per `\n`-terminated line on stdout; **nothing else ever on stdout**; logs to stderr; UTF-8.
2. **`initialize`** → echo `protocolVersion: 1` (or your latest); return `agentCapabilities` (all optional; omit what you don't support), `agentInfo`, `authMethods: []`. No `initialized` notification exists — don't wait for one.
3. **`session/new`** → persist `sessionId` (+ `cwd`, `mcpServers`); respond `{"sessionId": ...}` (+ `modes`/`configOptions` if any). MAY error `-32000` if auth needed.
4. **`session/prompt`** → stream `session/update` notifications: `agent_message_chunk` (Markdown text, stable `messageId`), `tool_call`/`tool_call_update` (`pending`→`in_progress`→`completed`/`failed`), optionally `plan`, `usage_update`. Hold the request open for the whole turn, then answer `{stopReason}` (`end_turn`/`refusal`/`max_tokens`/`cancelled`…). Accept `text` + `resource_link` prompt blocks at minimum.
5. **Permissions:** before risky tools, send `session/request_permission` with `allow_once`/`allow_always`/`reject_once`(/`reject_always`) options; honor `selected{optionId}` and `cancelled`; treat `allow_always` as "persist rule".
6. **`session/cancel`** (notification): abort work, flush final updates, answer the prompt with `cancelled` — never an error.
7. Optional but expected by Zed: `fs/read_text_file`/`fs/write_text_file` usage *as a client capability consumer* only if you need editor-state files; `terminal/*` only if `clientCapabilities.terminal`; `session/load` (advertise `loadSession: true` and replay history via `user_message_chunk`/`agent_message_chunk`/tool updates **before** responding) and/or `session/resume` + `session/list` (+ `session/delete`, `session/close`); `available_commands_update` for slash commands; config options (`model`, `mode`, `thought_level` categories) — preferred over legacy `modes`.
8. **Never** add non-spec fields at object roots — use `_meta`. Custom methods must start with `_`. Answer unknown methods with `-32601`; ignore unknown notifications.
9. If you spawn MCP servers from `mcpServers`, stdio is mandatory; http/sse only if you advertised `mcpCapabilities`.

---

## 24. Complete source list

**Official spec (primary, v1 stable):**

- Overview: https://agentclientprotocol.com/protocol/v1/overview
- Transports: https://agentclientprotocol.com/protocol/v1/transports
- Initialization: https://agentclientprotocol.com/protocol/v1/initialization
- Authentication: https://agentclientprotocol.com/protocol/v1/authentication
- Session setup: https://agentclientprotocol.com/protocol/v1/session-setup
- Prompt turn: https://agentclientprotocol.com/protocol/v1/prompt-turn
- Content: https://agentclientprotocol.com/protocol/v1/content
- Tool calls: https://agentclientprotocol.com/protocol/v1/tool-calls
- Agent plan: https://agentclientprotocol.com/protocol/v1/agent-plan
- Session modes: https://agentclientprotocol.com/protocol/v1/session-modes
- Session config options: https://agentclientprotocol.com/protocol/v1/session-config-options
- Slash commands: https://agentclientprotocol.com/protocol/v1/slash-commands
- Session list: https://agentclientprotocol.com/protocol/v1/session-list
- Session delete: https://agentclientprotocol.com/protocol/v1/session-delete
- File system: https://agentclientprotocol.com/protocol/v1/file-system
- Terminals: https://agentclientprotocol.com/protocol/v1/terminals
- Cancellation: https://agentclientprotocol.com/protocol/v1/cancellation
- Elicitation: https://agentclientprotocol.com/protocol/v1/elicitation
- Extensibility: https://agentclientprotocol.com/protocol/v1/extensibility
- **Full schema/method reference:** https://agentclientprotocol.com/protocol/v1/schema
- JSON Schema artifacts: https://github.com/agentclientprotocol/agent-client-protocol (`schema/v1/schema.json`, `schema/v1/schema.unstable.json`); https://github.com/agentclientprotocol/agent-client-protocol/releases/latest/download/schema.json
- v2 (draft): https://agentclientprotocol.com/protocol/v2/migration , /protocol/v2/schema ; announcement: https://agentclientprotocol.com/announcements/acp-v2-draft
- RFDs/governance: https://agentclientprotocol.com/rfds/about , https://agentclientprotocol.com/community/governance
- Registry: https://agentclientprotocol.com/get-started/registry ; https://github.com/agentclientprotocol/registry
- Clients/agents lists: https://agentclientprotocol.com/get-started/clients , /get-started/agents

**Official SDK (primary):**

- TypeScript SDK repo: https://github.com/agentclientprotocol/typescript-sdk (npm `@agentclientprotocol/sdk`); method constants: `src/schema/index.ts`; NDJSON: `ndJsonStream` in `src/acp.ts`; `RequestError`: `src/jsonrpc.ts`; examples: `src/examples`
- Schema/Rust repo (formerly `zed-industries/agent-client-protocol`): https://github.com/agentclientprotocol/agent-client-protocol (README versioning notes; CHANGELOG for rename history)
- Historical verification: npm `@zed-industries/agent-client-protocol@0.0.32` … `@agentclientprotocol/sdk@1.x` tarballs (method-name archaeology)

**opencode (primary source code):**

- ACP module: https://github.com/sst/opencode/tree/dev/packages/opencode/src/acp — `agent.ts`, `service.ts`, `session.ts`, `event.ts`, `permission.ts`, `tool.ts`, `content.ts`, `config-option.ts`, `directory.ts`, `usage.ts`, `error.ts`, `profile.ts`
- CLI entrypoint: https://github.com/sst/opencode/blob/dev/packages/opencode/src/cli/cmd/acp.ts

**Zed (primary source/docs):**

- External agents doc: https://zed.dev/docs/ai/external-agents (source: https://github.com/zed-industries/zed/blob/main/docs/src/ai/external-agents.md)
- ACP client implementation / process launch: https://github.com/zed-industries/zed/blob/main/crates/agent_servers/src/acp.rs ; thread/connection: `crates/acp_thread/src/*`; tools: `crates/acp_tools/src/acp_tools.rs`

---

*Report generated from live primary sources; spec pages captured from agentclientprotocol.com's full documentation dump (`llms-full.txt`), repos cloned at: ACP schema repo + TS SDK (main), opencode `dev` @ `1c96545` (2026-08-16, v1.18.18), Zed `main`. ACP stable protocol version at time of writing: **1** (v2 in draft).*
