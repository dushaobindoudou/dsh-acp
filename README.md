# dsh-acp

[![npm](https://img.shields.io/npm/v/dsh-acp-server.svg)](https://www.npmjs.com/package/dsh-acp-server)
[![CI](https://github.com/dushaobindoudou/dsh-acp/actions/workflows/ci.yml/badge.svg)](https://github.com/dushaobindoudou/dsh-acp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Agent Client Protocol (ACP) server for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).**

Drive a full dsh coding agent - streaming output, tool calls, permission prompts, durable sessions - from [Zed](https://zed.dev), JetBrains, or any ACP v1 client, exactly like opencode or Gemini CLI.

English | [中文](README.zh.md)

## What it does

`dsh-acp` is a [`dsh` profile bundle](https://github.com/deepseek-ai/deepseek-harness): booting `dsh --profile acp` starts the entire DeepSeek Harness (agent loop, tools, sandbox, session persistence) with an ACP v1 JSON-RPC server on stdio instead of the web UI.

M1 (current release) implements:

| ACP method | Status |
|---|---|
| `initialize` | ✅ capabilities + agent info |
| `session/new` | ✅ creates a durable dsh agent (persisted under `$DSH_HOME/sessions`) |
| `session/prompt` | ✅ streaming `agent_message_chunk` / `agent_thought_chunk` (reasoning), `plan` updates, `{stopReason}` |
| tool calls | ✅ full lifecycle: `tool_call` (pending, with title/kind/locations/rawInput) → `in_progress` → `completed`/`failed` with content |
| `session/request_permission` | ✅ dsh's approval seam bridged to the client (allow once/always, reject once/always) |
| `session/cancel` | ✅ aborts the turn, prompt resolves `cancelled` |
| `session/close` | ✅ cancels, flushes, disposes the agent |

Roadmap: `session/load` replay, `session/resume`/`list`, modes (plan mode) + config options (model), slash commands, images, elicitation - see [the design doc](research/acp-dsh-design.md).

## Install

Requires Node.js ≥ 22, pnpm, and the `dsh` CLI (`npm i -g @deepseek-ai/dsh`).

Install the bundle into an `acp` profile with the official plugin command (it
initializes the profile, installs the package, and keeps `dsh.profile.bundles`
in sync - see the harness docs, *打包与安装插件*):

```bash
# prebuilt from npm (recommended — no build authorization needed)
dsh plugin --profile acp add dsh-acp-server

# or from a tarball
dsh plugin --profile acp add ./dsh-acp-server-0.1.0.tgz

# or from GitHub (source install; see note below)
dsh plugin --profile acp add github:dushaobindoudou/dsh-acp

# boots the ACP server on stdio
dsh --profile acp
```

`node bin/setup-profile.mjs --pkg <spec>` is a thin convenience wrapper over
the same command.

**GitHub installs pull source, not build output.** The package's `prepare`
script builds `lib/` on install; pnpm ≥ 10 refuses to run it until you add the
key it prints to the profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-acp: true
```

then re-run the `add`. Prefer locking a commit (`github:…/dsh-acp#<sha>`), or
avoid the authorization entirely with a prebuilt npm package or tarball.
Verify any time with `dsh --profile acp --dump-config` (a `# == dsh-acp` layer
should appear).

## Remote access (`serve`, like `opencode serve`)

Editors get ACP over stdio, but you can also run a long-lived HTTP+SSE endpoint -
for remote machines, shared agents, or curl - following the shape of the
ACP [streamable-HTTP RFD](https://agentclientprotocol.com/rfds/streamable-http-websocket-transport.md)
(POST sends client->server messages, a long-lived SSE GET stream carries all
server->client messages, `Acp-Connection-Id` binds them):

```bash
dsh --profile acp serve --port 7800            # bind 127.0.0.1 by default
dsh --profile acp serve --host 0.0.0.0 --port 7800 --token s3cret
```

| Endpoint | Purpose |
|---|---|
| `POST /acp` | one JSON-RPC message per body; `initialize` -> `200` + `Acp-Connection-Id`; everything else -> `202` (response arrives on SSE) |
| `GET /acp/stream` | SSE stream for the connection (header or `?connection=`) |
| `DELETE /acp` | close the connection |
| `GET /healthz` | liveness (no auth) |

Several clients can be attached to one dsh process (one SDK connection each).
Connect from anywhere with the bundled client:

```bash
node bin/acp-chat.mjs --url http://127.0.0.1:7800 --token s3cret
```

Without `serve` the profile still boots stdio-first, so Zed keeps working
unchanged. Default bind is loopback; use `--token` whenever you bind beyond it.

## Try it without an editor

`acp-chat` is a zero-install interactive terminal client bundled in this repo (REPL with streaming, tool-call display, plan rendering, and inline permission prompts):

```bash
node bin/acp-chat.mjs            # spawns `dsh --profile acp` and drops you into a chat
```

Third-party ACP clients that work today:

| Client | Type | Try it |
|---|---|---|
| [Zed](https://zed.dev) | editor (reference client) | `agent_servers` custom entry below |
| [acpx](https://github.com/openclaw/acpx) | CLI | `npx acpx@latest --agent 'dsh --profile acp' "hello"` |
| [ghost.nvim](https://github.com/assagman/ghost.nvim) / [acpear.nvim](https://github.com/Eric-Song-Nop/acpear.nvim) | Neovim | plugin config → command `dsh-acp` |
| [acp.el](https://github.com/xenodium/acp.el) | Emacs | `(setq acp-agent-command '("dsh" "--profile" "acp"))` |
| [obsidian-agent-client](https://github.com/RAIT-09/obsidian-agent-client) | Obsidian | plugin settings |
| [ACP-inspector](https://github.com/venikman/ACP-inspector) | conformance/debug | validates wire traffic |

## Configuration

All knobs have schema defaults, so the shipped bundle row carries no config;
override only the keys you want in your own profile layer
(`$DSH_HOME/profiles/acp/cordis.patch.yml`):

```yaml
- id: acp-server
  config:
    agentName: my-dsh            # initialize.agentInfo.name shown to clients
    provider: deepseek           # pin the model for ACP sessions
    model: reasoner              # (provider and model must be set together)
    offerAlwaysPermissions: false # hide allow_always/reject_always (M1 maps
                                  # "always" grants to one-shot decisions)
    flushOnTurnEnd: true         # flush session persistence after each turn
```

Behavior follows the harness config conventions: the schema validates at
plugin load (wrong types or a half-set provider/model pin fail loudly with
the exact key), missing keys fall back to defaults (a patch layer replaces
the whole config value, the schema refills the rest), and unset
provider/model follows the profile's `agent-default-model`. Config is read
when the process boots - editors spawn one per session.

## Use with Zed

Zed → Settings → `agent_servers`:

```json
{
  "dsh": {
    "type": "custom",
    "command": "dsh-acp-server",
    "args": []
  }
}
```

The npm package is `dsh-acp-server` (the plain `dsh-acp` name on npm belongs to another project); its `dsh-acp-server` bin is a thin launcher for `dsh --profile acp`. Point `DSH_BIN` at a non-PATH `dsh`. Model credentials come from the usual dsh places (`$DSH_HOME` settings / `DEEPSEEK_API_KEY`), shared with the web UI - no second setup.

## Development

```bash
pnpm install
pnpm run build     # tsc -> lib/
pnpm test          # unit tests (pure translation layer)

# end-to-end: boots the REAL dsh --profile acp in a throwaway $DSH_HOME
# with a deterministic mock LLM, and asserts the full M1 wire behavior
node test/e2e/e2e.test.mjs
```

The e2e harness is also the fastest way to iterate on protocol behavior: it drives initialize → new → prompt (text) → prompt (tool call) → close over real stdio.

### How it maps

```
ACP client (Zed) ⇄ NDJSON JSON-RPC ⇄ dsh-acp plugin ⇄ dsh services
                                          ├─ ctx.agents.create/resume   (session/new, load)
                                          ├─ agent.followup/cancel      (session/prompt, cancel)
                                          ├─ 'session/event'            (streaming session/update)
                                          ├─ 'approval/request'         (session/request_permission)
                                          └─ dsh-base: tools, sandbox, persistence, settings
```

Full research behind every mapping: [`research/`](research/) - [ACP protocol](research/acp-protocol.md), [DSH architecture](research/dsh-architecture.md), [prior art](research/acp-implementations.md), [design blueprint](research/acp-dsh-design.md).

## Contributing

PRs welcome - see [CONTRIBUTING.md](CONTRIBUTING.md). Milestone plan lives in [research/acp-dsh-design.md §4](research/acp-dsh-design.md).

## License

[MIT](LICENSE)
