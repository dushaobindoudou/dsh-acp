# dsh-acp

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

```bash
# from a checkout of this repo (published package works the same way)
node bin/setup-profile.mjs --pkg /path/to/dsh-acp

# boots the ACP server on stdio
dsh --profile acp
```

The setup script creates `$DSH_HOME/profiles/acp` with `dsh.profile.bundles = ["@deepseek-ai/dsh-base", "dsh-acp"]` and installs the bundle via pnpm. Re-run it any time; `--force` rewrites the manifest.

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

## Use with Zed

Zed → Settings → `agent_servers`:

```json
{
  "dsh": {
    "type": "custom",
    "command": "dsh-acp",
    "args": []
  }
}
```

`dsh-acp` (installed by this package) is a thin launcher for `dsh --profile acp`; point `DSH_BIN` at a non-PATH `dsh`. Model credentials come from the usual dsh places (`$DSH_HOME` settings / `DEEPSEEK_API_KEY`), shared with the web UI - no second setup.

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
