# Contributing to dsh-acp

Thanks for improving dsh-acp! This project is an ACP (Agent Client Protocol) server
shipped as a [dsh](https://github.com/deepseek-ai/deepseek-harness) profile bundle.

## Setup

```bash
pnpm install
pnpm run build      # tsc -> lib/
pnpm test           # unit tests
node test/e2e/e2e.test.mjs   # end-to-end against a real `dsh --profile acp` boot
```

The e2e test requires the `dsh` CLI on PATH (`npm i -g @deepseek-ai/dsh`) and network
access for its one-time `pnpm add` into a throwaway profile.

## Ground rules

- **Wire compatibility first.** Every protocol behavior should match the ACP v1 spec;
  the authoritative local reference is [research/acp-protocol.md](research/acp-protocol.md)
  (compiled from the spec, schema, and SDK sources). When in doubt, check the spec, not
  another agent's behavior.
- **stdout is sacred.** The ACP process must never write anything but NDJSON
  JSON-RPC frames to stdout. Logs go to stderr (`ctx.logger` or `process.stderr`).
- **DSH seams, not internals.** The plugin talks to dsh through its public services
  (`ctx.agents`, `agent.followup/cancel`, `session/event`, `approval/request`, ...)
  and registers agent-scoped listeners inside `ctx.agents.create({ setup })` so
  teardown is automatic. No reaching into private APIs.
- **Every effect is reversible.** Anything registered in `apply()` must be cleaned up
  via `ctx.effect()` / scope-owned listeners.

## Commit style

Conventional commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`), one logical change
per PR. Tests required for protocol behavior changes.

## Testing strategy

- **Unit** (`test/unit/`): pure translation functions - stopReason mapping, tool kinds,
  content conversion. No Cordis, no I/O.
- **E2E** (`test/e2e/`): boots the real `dsh --profile acp` with a mock LLM provider
  (`dsh-acp/test/mock-llm`) and drives the full wire conversation. Extend the script
  there when adding protocol methods.

## Milestone plan

See [research/acp-dsh-design.md §4](research/acp-dsh-design.md). M1 is complete;
M2 (session load/replay, commands, modes) is next.
