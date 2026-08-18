# dsh-acp-server

[![npm](https://img.shields.io/npm/v/dsh-acp-server.svg)](https://www.npmjs.com/package/dsh-acp-server)
[![CI](https://github.com/dushaobindoudou/dsh-acp/actions/workflows/ci.yml/badge.svg)](https://github.com/dushaobindoudou/dsh-acp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Agent Client Protocol (ACP) server for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).**

Drive a full dsh coding agent - streaming output, tool calls, permission prompts, durable sessions - from [Zed](https://zed.dev) or any ACP v1 client, exactly like opencode or Gemini CLI.

English | [中文](README.zh.md)

## What it does

A [`dsh` profile bundle](https://github.com/deepseek-ai/deepseek-harness) that boots the entire DeepSeek Harness (agent loop, tools, sandbox, session persistence) with an ACP v1 JSON-RPC server instead of - or alongside - the web UI.

| ACP method | Status |
|---|---|
| `initialize` | ✅ capabilities + agent info |
| `session/new` | ✅ durable dsh agent (persisted under `$DSH_HOME/sessions`) |
| `session/prompt` | ✅ streaming `agent_message_chunk` / `agent_thought_chunk` (reasoning), `plan` updates, full tool-call lifecycle, `{stopReason}`; failed turns reject with a JSON-RPC error carrying the cause |
| `session/request_permission` | ✅ dsh's approval seam bridged to the client (allow once/always, reject once/always) |
| `session/cancel` | ✅ aborts the turn, prompt resolves `cancelled` |
| `session/close` | ✅ cancels, flushes, disposes the agent |

Roadmap: `session/load` replay, `session/resume`/`list`, modes + config options, slash commands, images, elicitation - see [the design doc](research/acp-dsh-design.md).

## The two final forms

```bash
dsh-acp-server       # 1) standalone: ACP on stdio (editors), or `serve` for remote HTTP
dsh web              # 2) together: the GUI and ACP in one process on one port
```

### Form 1 — standalone (`dsh-acp-server`)

After `npm i -g dsh-acp-server` (or via `npx`). The bin boots `dsh --profile acp` with the current stdio and passes every launcher flag through (`serve --port 7800`, `--patch extra.yml`). First use in a DSH home auto-bootstraps the `acp` profile with the official `dsh plugin` command - bootstrap output goes to stderr, so an editor's stdout only ever sees ACP frames.

Zed → Settings → `agent_servers` (full sample in [examples/zed-settings.json](examples/zed-settings.json)):

```json
{
  "agent_servers": {
    "dsh": { "type": "custom", "command": "dsh-acp-server", "args": [] }
  }
}
```

### Form 2 — together (`dsh web`)

Install into the `web` profile once; every plain `dsh web` boot then serves the GUI and ACP on one port:

```bash
node bin/setup-webacp.mjs        # official `dsh plugin --profile web add` + the web-mounted row
dsh web                          # http://127.0.0.1:3080 = GUI, /acp = ACP
node bin/acp-chat.mjs --url http://127.0.0.1:3080
```

Prefer to keep `web` untouched? `node bin/setup-webacp.mjs --clone webacp` gives the same on `dsh --profile webacp`.

The script writes a row-level `inject: [agents, agentDefaultModel, webServer]` so Cordis starts the acp-server fiber only after the shared `webServer` service exists - the stdio transport can never race a web boot. A hand install without that row is safe too: the plugin web-mounts late via service provisioning (terminal boots skip stdio entirely; daemon boots get an EOF grace window). The full row is documented in [examples/patches/web-mounted.yml](examples/patches/web-mounted.yml).

Why a bin instead of the literal `dsh acp-server`: the dsh launcher hardcodes its app subcommands (`web`, `plugin`) and parses argv before any plugin loads, so a bundle cannot register one; the wrapper is the same single-command shape.

## Install

Requires Node.js ≥ 22 and the `dsh` CLI (`npm i -g @deepseek-ai/dsh`). The `dsh-acp-server` bin handles the profile itself; to manage it explicitly:

```bash
# prebuilt from npm (recommended - no build authorization needed)
dsh plugin --profile acp add dsh-acp-server

# or from a tarball
dsh plugin --profile acp add ./dsh-acp-server-0.7.0.tgz

# or from GitHub (source install; see note below)
dsh plugin --profile acp add github:dushaobindoudou/dsh-acp
```

**GitHub installs pull source, not build output.** The package's `prepare` script builds `lib/` on install; pnpm ≥ 10 refuses to run it until you allow it in the profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-acp-server: true
```

then re-run the `add`. Prefer locking a commit (`github:…/dsh-acp#<sha>`), or avoid the authorization entirely with a prebuilt npm package or tarball. Verify any time with `dsh --profile acp --dump-config` (a `dsh-acp-server` layer should appear). `node bin/setup-profile.mjs --pkg <spec>` is a thin wrapper over the same command.

## Remote access (`serve`)

Editors get ACP over stdio; `serve` runs a long-lived HTTP+SSE endpoint for remote machines, shared agents, or curl - following the shape of the ACP [streamable-HTTP RFD](https://agentclientprotocol.com/rfds/streamable-http-websocket-transport.md):

```bash
dsh --profile acp serve --port 7800            # bind 127.0.0.1 by default
dsh --profile acp serve --host 0.0.0.0 --port 7800 --token s3cret
```

The serve port also ships a built-in single-file web client at `GET /` - open
http://127.0.0.1:7800 in any browser for a complete chat UI (streaming,
thoughts, tool cards, plans, permission dialogs) driven purely by the ACP
routes above. It is the reference proof that this surface can carry a web
interface. The same routes are served in web-mounted mode (Form 2) on the
GUI's port.

### HTTP transport reference

| Method + path | Purpose |
|---|---|
| `POST /acp` | one JSON-RPC message per body (single JSON object or NDJSON lines); `initialize` → `200` + JSON body + `Acp-Connection-Id` header; everything else → `202`, the response arrives on the SSE stream |
| `GET /acp/stream` | long-lived SSE stream for the connection (header `Acp-Connection-Id`, or `?connection=`); `: ping` comment every 15 s |
| `DELETE /acp` | close the connection → `204` |
| `GET /acp/healthz` | liveness probe (no auth; serve mode also answers `/healthz`) |

Errors: `401` bad/missing bearer token · `404` unknown connection id or route · `400` unparseable body. Several clients can attach to one process (one ACP connection each).

## dsh/* vendor extensions (host plane)

ACP v1 standardizes one conversation, not the host around it. Sessions history,
jobs, goals, skills, and the live agent tree are exposed as read-only vendor
methods under the `dsh/` namespace - consumed by the built-in web UI, usable by
any client:

| Method | Returns |
|---|---|
| `dsh/sessions/list` | every persisted + live session (id, title, createdAt, cwd, parentSession, `acp` flag) |
| `dsh/sessions/read` | one session's transcript as `{seq, type, text}` entries |
| `dsh/sessions/resume` | reopen a persisted session as a live ACP session (full context) |
| `dsh/jobs/list` | background jobs (id, kind, label, status, owner) |
| `dsh/goals/list` | active goal per live agent (objective, phase, rounds) |
| `dsh/skills/list` | installed skills (name, description, provider) |
| `dsh/agents/tree` | live agents with parent/model/cwd (the subagent tree) |

Push: `dsh/changed {topics}` notifications fire on turn ends, session
lifecycle, and job changes. **Interop-safe by construction** - they are sent
only to connections that opted in via the schema-sanctioned extension point
`clientCapabilities._meta['dsh/extensions']` (the `_meta` record is official
ACP schema); standard clients like Zed see a fully standard server and are
never contacted with vendor traffic. Each method degrades to a clean `-32601`
in compositions that lack the underlying service.

A complete, runnable conversation with nothing but curl: [examples/curl-conversation.sh](examples/curl-conversation.sh).

```bash
./examples/curl-conversation.sh http://127.0.0.1:7800 [bearer-token]
```

## Configuration

All knobs have schema defaults; override only the keys you want in your profile layer (`$DSH_HOME/profiles/<name>/cordis.patch.yml`). Full samples in [examples/patches/](examples/patches/).

| Key | Type | Default | Description |
|---|---|---|---|
| `agentName` | string | `dsh` | `initialize.agentInfo.name` shown to clients |
| `provider` | string | - | pin the model for ACP sessions (must be set **with** `model`) |
| `model` | string | - | pin the model for ACP sessions (must be set **with** `provider`) |
| `token` | string | - | require `authorization: Bearer <token>` on the HTTP transport (web-mounted mode; standalone `serve` takes `--token` on its command line) |
| `offerAlwaysPermissions` | boolean | `true` | include `allow_always` / `reject_always` options in permission requests |
| `flushOnTurnEnd` | boolean | `true` | flush session persistence after every completed turn |

```yaml
- id: acp-server
  config:
    agentName: my-dsh
    provider: liepin        # pin (or omit both to follow the live default)
    model: glm-5-3
```

Behavior follows the harness config conventions: the schema validates at plugin load (wrong types or a half-set provider/model pin fail loudly with the exact key), missing keys fall back to defaults (a patch layer replaces the whole config value, the schema refills the rest), and an unset provider/model follows the profile's `agent-default-model` - read **per session**, so in-GUI model switches apply to new ACP sessions too.

Model credentials come from the usual dsh places (`$DSH_HOME` settings / provider API-key envs), shared with the web UI - no second setup.

## Try it without an editor

`acp-chat` is a zero-install interactive terminal client bundled in this repo (REPL with streaming, tool-call display, plan rendering, and inline permission prompts). It speaks both transports:

```bash
node bin/acp-chat.mjs                                   # spawns `dsh --profile acp` (stdio)
node bin/acp-chat.mjs --url http://127.0.0.1:7800 --token s3cret   # remote HTTP+SSE
```

Third-party ACP clients that work today:

| Client | Type | Try it |
|---|---|---|
| [Zed](https://zed.dev) | editor (reference client) | `agent_servers` entry above |
| [acpx](https://github.com/openclaw/acpx) | CLI | `npx acpx@latest --agent 'dsh --profile acp' "hello"` |
| [ghost.nvim](https://github.com/assagman/ghost.nvim) / [acpear.nvim](https://github.com/Eric-Song-Nop/acpear.nvim) | Neovim | plugin config → command `dsh-acp-server` |
| [acp.el](https://github.com/xenodium/acp.el) | Emacs | `(setq acp-agent-command '("dsh-acp-server"))` |
| [obsidian-agent-client](https://github.com/RAIT-09/obsidian-agent-client) | Obsidian | plugin settings |
| [ACP-inspector](https://github.com/venikman/ACP-inspector) | conformance/debug | validates wire traffic |

## How it works

Transport choice is deterministic at mount: `serve` subcommand → standalone HTTP server; a `webServer` service present (or arriving late) → routes registered on the shared server; otherwise stdio.

```
ACP client (Zed / curl / acp-chat)
   │  stdio NDJSON JSON-RPC          │  HTTP POST + SSE (serve / web-mounted)
   ▼                                 ▼
  dsh-acp-server plugin ⇄ dsh services
      ├─ ctx.agents.create/dispose      (session/new, close)
      ├─ agent.followup/cancel/whenIdle (session/prompt, cancel)
      ├─ 'session/event'                (streaming session/update)
      ├─ 'approval/request'             (session/request_permission)
      └─ dsh-base: tools, sandbox, persistence, settings
```

Source layout: `src/connection.ts` (method handlers) · `translate.ts` (pure wire mappings, unit-tested) · `event-bridge.ts` / `perm-bridge.ts` (dsh ⇄ ACP seams) · `http-transport.ts` (shared HTTP router) · `serve-startup.ts` (the `serve` subcommand) · `config.ts` (schema) · `table.ts` (session registry).

Full research behind every mapping: [`research/`](research/) - [ACP protocol](research/acp-protocol.md), [DSH architecture](research/dsh-architecture.md), [prior art](research/acp-implementations.md), [design blueprint](research/acp-dsh-design.md).

## Development

```bash
pnpm install
pnpm run build     # tsc -> lib/
pnpm test          # unit tests (pure translation + config layers)

# end-to-end: boots the REAL dsh in a throwaway $DSH_HOME with a
# deterministic mock LLM, and asserts the full wire behavior:
pnpm run test:e2e  # stdio · serve (HTTP+SSE) · web-mounted · bare-install grace
```

The e2e suites are the fastest way to iterate on protocol behavior - each drives a complete conversation (text prompt, tool-call lifecycle, teardown) over its transport. Set `DSH_ACP_PKG` (repo path by default, `./dsh-acp-server-*.tgz`, or an npm spec) to pick the install source.

## Contributing

PRs welcome - see [CONTRIBUTING.md](CONTRIBUTING.md). The milestone plan lives in [research/acp-dsh-design.md](research/acp-dsh-design.md).

## License

[MIT](LICENSE)
