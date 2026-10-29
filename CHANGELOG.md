# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

## [0.14.4] - 2026-10-29

- Stopped the bundle's directory-picker row from replacing dsh-web-app's auto
  picker in the Web profile (both used the id `directory-picker`). On DSH
  0.2.1 that row mounts the client directory flow, so "Add workspace" vanished
  from the sidebar and the new-session picker. The ACP row now has its own id
  and is disabled when dsh-web-app is loaded.
- Fixed every `dsh/remote/invoke` and `dsh/remote/stream` call on DSH 0.2.1,
  which requires a Peer on each gateway request ("Cannot read properties of
  undefined (reading 'signal')"). Host-control calls now speak for one owner
  Peer bound to the plugin's lifetime; adopted-session model switches use it
  too.
- Dropped the `{{cwd}}` persona suffix. DSH 0.2.1 registers only
  `{{provider}}` and `{{model}}` and states the working directory in user
  context, so every turn in the standalone ACP profile failed with "unknown
  prompt variable".

## [0.14.3] - 2026-10-28

- Refreshed `@deepseek-ai` dependencies to `^0.2.1-rc.2` for DSH 0.2.1, dropped
  the unused `@deepseek-ai/dsh-invariants`, and aligned
  `@deepseek-ai/schemastery` to `~3.18.5`.

## [0.14.2] - 2026-10-14

- Let client subcommands flush stdout before exiting, so large host-control
  responses such as `settings/describe` remain valid JSON.
- Delay private ACP profile bootstrap until after CLI argument validation, so
  invalid commands fail cleanly on a fresh installation.

## [0.14.1] - 2026-10-14

- Aligned workspace, workspace files, directory browser, and settings host
  controllers with DSH 0.2.0-rc.2. The 0.14.0 bundle used 0.1.5 controllers
  that DSH 0.2 disables as incompatible, leaving the Remote catalog incomplete.
- Pinned the E2E runtime to DSH 0.2.0-rc.2 so its plugin compatibility checks
  cover the runtime this release targets.

## [0.14.0] - 2026-10-13

- Added CLI access to running HTTP servers (`--url` / `DSH_ACP_URL`) for
  `run`, `catalog`, `call`, `stream`, and `rpc`, including detached tasks.
- Added form-mode user-question elicitation with permission-button fallback
  and unattended session policies. Already-cancelled questions no longer
  open a client dialog.
- Fixed HTTP client network failures reaching the connection's error
  listener; transport shutdown now aborts SSE before bounded DELETE cleanup.
- Invalid CLI timeouts and stream limits fail before connecting.
- Added regression coverage for question mappings, policies, cancellation,
  HTTP client failures and shutdown, and CLI control of a running server.
- Added a Typert backed `dsh/remote/*` host control plane with live catalog,
  unary and streaming calls, cancellation, endpoint deny rules, and method
  availability during startup. The standalone ACP profile now mounts the
  workspace, directory browser, workspace file, and settings controllers.
- Added `dsh/sessions/search` for session IDs, titles, and working directories;
  documented the session dispatch and resume workflow for orchestrators.
- Web-mounted ACP now shares DSH Web's Host/Origin and login-cookie checks;
  a configured ACP bearer token is an alternate credential for scripts.
- Verified workspace creation, settings updates, session discovery and
  switching against a disposable DSH home, plus the Web composition's full
  session/workspace/settings Remote catalog.

## [0.13.0] - 2026-10-01

The orchestration release: the ACP surface an external agent needs to drive
dsh from a script — per-session model/effort overrides, one-shot task runs,
session cleanup, and token usage — plus honest capability advertisement.

### Added

- **`session/set_config_option`** (agent method): per-session overrides of
  the model select and the reasoning-effort select, answered with the full
  `configOptions` state. The model select is valued `<provider>/<model>` and
  built live from the llm registry (`listProviders` × `listModels`, each read
  under a soft deadline so a stalled catalog never stalls the session);
  the reasoning-effort select appears only when the CURRENT route declares
  efforts via `resolveModelInfo`. Overrides ride dsh's agent-scoped model
  selection: a switch takes effect on the NEXT step (no mount-time
  snapshot), an effort set on a route without efforts is refused with a
  precise `-32602` instead of being silently ignored, and a successful set
  pushes `config_option_update` with the new state. `session/new`,
  `session/load` and `session/resume` responses now carry `configOptions`.
- **`authenticate`** (agent method): no-op success immediately after the
  handshake (empty `authMethods` stays), matching official dsh-acp; strict
  clients no longer get `-32601`.
- **`session/delete`** (agent method; `sessionCapabilities.delete` now
  advertised): removes a persisted session's artifact directory from the
  JSONL backend root. Refuses BEFORE touching bytes: open in this process's
  ACP table, live elsewhere in this process, write-claimed by another
  process (kernel lock probe), or no artifact directory found.
- **Token usage**: every `assistant/message` that reports token accounting
  now drives a `usage_update` (`used` = that call's full context footprint,
  `size` = the route's context window, silent when the window is unknown),
  and `session/prompt` responses carry the turn's summed `usage`
  (input/output/thought/cache tokens; the experimental ACP field).
- **One-shot CLI `run`** (`dsh-acp-server run "task"`): drive one task from
  any script without implementing ACP. It spawns the real
  `dsh --profile acp` and speaks the same protocol through the SDK client —
  no second implementation, no bypass. Flags: `--cwd`, `--json` (one
  `{sessionId, stopReason, text, toolCalls, usage?, error?}` object),
  `--session <id>` (resume; no cold plugin-tree start per task), `--model
  <provider>/<model>` (maps to `session/set_config_option`), `--timeout
  <seconds>` (cancels via `$/cancel_request` + `session/cancel`),
  `--permission-policy auto|ask|deny`, repeatable `--attach <file>` (images
  ride image blocks, other files inline as text). Exit codes: `0` done ·
  `1` error · `2` timeout · `3` cancelled · `4` permission denied.
- `session/resume` / `session/load` fail with a precise `unknown session`
  `-32602` when the id has no persisted artifact, instead of surfacing the
  agents-service failure as a generic internal error.

### Fixed

- **fs methods are honestly out of scope**: the server never calls
  `fs/read_text_file` / `fs/write_text_file` — dsh tools read and write the
  host filesystem in-process, so a client that declared the fs capability
  would never be contacted. Documented in the README method table instead of
  advertised and left dead.
- The e2e mock LLM now declares two models (`mock-1`, and `mock-2` with
  adapter-declared reasoning efforts), which is what makes the
  config-option and refusal paths exercised above deterministic.

## [0.12.0] - 2026-09-18

dsh 0.1.5-rc.2 compatibility release. The 0.1.5 session-event changes removed
`assistant/chunk`; this release restores live text streaming on the new event
model and is verified by both e2e suites against a real dsh 0.1.5-rc.2.

### Fixed

- **Live streaming (P0)**: `assistant/chunk` no longer exists in dsh 0.1.5's
  `SessionEventMap`, so the bridge's text branch never fired and ACP clients
  received no thought/message chunks at all. Token-level streaming now rides
  the process-local `agent/assistant-stream` publication (chunk frames carry
  no turn/step, so the position is tracked from each attempt's `start` frame);
  the durable `assistant/message` event is skipped on the live path to avoid
  double emission and expanded only for watch/replay delivery.
- **Image capability (P1)**: `promptCapabilities.image` is now computed the
  way official dsh-acp does — attachments must accept an ACP image media type
  AND the default model route must declare `image` input via
  `llm.resolveModelInfo`. Previously the capability was advertised whenever
  the attachments service existed, so non-image models failed at model-call
  time after the client had already offered uploads.
- **`dsh/changed {jobs}` in serve and web-mounted modes (P1)**: the jobs
  signal attached only on the late-attach path, so the two main mount modes
  never pushed job-registry updates. Attachment is hoisted above the per-mode
  returns.
- **`dsh/changed {agents}` signal (P1)**: `dispatchGlobalSessionEvent` gated
  on `agent/status`, which never arrives on `session/event` — dead code since
  0.10.0. The throttled signal now fires on `session/prompt` / `turn/end`,
  which bound real agent activity.
- `agentInfo.version` reads the package version instead of a hardcoded
  `'0.1.0'`.
- The mock LLM declares `inputModalities: ['text','image']` so the e2e image
  path exercises the honest capability gate.

### Changed

- All `@deepseek-ai/dsh-*` dependencies moved to `^0.1.5-rc.2` (the dsh core
  convention; the old `^0.1.2-rc.1` floor could never resolve to 0.1.5-rc.x
  under npm prerelease semantics).

## [Unreleased]

## [0.11.1] - 2026-09-09

### Fixed

- `/command` prompts failed against dsh 0.1.2-rc.1 with `Cannot read
  properties of undefined (reading 'aborted')`. `commands.execute()` gained an
  `images` parameter between `line` and `signal`, and the registry reads
  `signal.aborted` unguarded — the old 3-argument call put the signal in
  `images` and left `signal` undefined, so the request died before the command
  handler ever ran. 0.11.0's compatibility pass missed it because the local
  `CommandsLike` interface is hand-written against a `ctx.get()` service, so
  the arity change was invisible to the type checker, and the e2e suite only
  asserted `available_commands_update` (advertisement), never an execution.
  The serve suite now executes an advertised command end-to-end.

## [0.11.0] - 2026-09-09

### Fixed

- **Compatibility with dsh 0.1.2-rc.1.** dsh now ships its own ACP bundle
  (`@deepseek-ai/dsh-acp-app`) and auto-initializes the `acp` profile
  template with it, so `dsh plugin --profile acp add dsh-acp-server`
  produced a composition holding TWO ACP servers on one stdio: both
  answered `initialize`, then requests split across two session tables and
  `session/prompt` failed with `unknown session`. This bundle's patch layer
  now disables the `acp-app-startup` and `acp` rows, so it stays the single
  ACP server. Both ids are absent on older dsh, where an unmatched patch id
  is a silent no-op.
- `todo/write` moved out of the core `SessionEventMap` into
  `@deepseek-ai/dsh-tool-todo`; the event bridge now imports that module's
  declaration so `plan` updates keep type-checking.
- `CallId` was renamed to `ToolCallId` in `@deepseek-ai/dsh-llm` (test
  mock-LLM adapter).

### Changed

- Dependency floors moved to `@deepseek-ai/dsh-*@^0.1.2-rc.1`, cordis
  `^4.0.2`, cordis-plugin-loader `^1.0.3`, and schemastery `^3.18.2` (the
  latter deduplicates the copy that made the config schema type unnameable
  under pnpm).
- The web-mounted e2e suites no longer assert `GET / -> 200`: dsh >= 0.1.2
  puts its GUI behind a token trust fence and answers 401 unauthenticated.
  The ACP routes are unaffected - `/acp`, `/acp/stream` and `/acp/healthz`
  are still reachable without a token, verified end-to-end.

## [0.10.0] - 2026-08-18

### Added

- Standard ACP surface completion: `session/list` (id, cwd, title),
  `session/resume` (standard form of the vendor method), `session/load`
  (reopen + replay the transcript as user/agent message chunks),
  `session/set_mode` bridged to dsh plan mode with `current_mode_update`
  push, `available_commands_update` from the dsh command registry with
  single-`/command` prompt routing, and image prompt blocks persisted
  through the dsh attachments service (`promptCapabilities.image`).
- `dsh/sessions/watch` + `unwatch`: subscribe to any session's translated
  live stream (`dsh/session/update` frames, same SessionUpdate shapes the
  owner receives) - verified end-to-end with a third connection observing
  a live prompt.
- Agent-status transitions now push `dsh/changed {agents}` (throttled) so
  host panels can track the live agent tree.

### Fixed

- Watch translator wiring now happens in every transport mode (previously
  only the non-serve branches installed it, so serve-mode watch silently
  translated nothing).

## [0.9.0] - 2026-08-17

### Added

- Host plane over ACP via `dsh/*` vendor extensions: `dsh/sessions/list`,
  `dsh/sessions/read` (transcript), `dsh/sessions/resume` (reopen a persisted
  session as a live ACP session with full context), `dsh/jobs/list`,
  `dsh/goals/list`, `dsh/skills/list`, `dsh/agents/tree` (live subagent tree),
  plus `dsh/changed {topics}` push notifications. Opt-in through the
  schema-sanctioned `clientCapabilities._meta['dsh/extensions']` extension
  point - standard clients see a fully standard server; methods degrade to
  -32601 in compositions without the underlying service.
- Built-in web UI: host sidebar (sessions with titles + resume, jobs, goals,
  skills, live agent tree) that refreshes on `dsh/changed`, next to the chat.

## [0.8.0] - 2026-08-17

### Added

- Built-in single-file web client (`webui.html`) served at `GET /` in serve
  mode: a complete chat UI - streaming, thought panels, tool cards, plan
  checklist, permission dialogs, cancel - driven purely by the ACP routes
  (initialize, SSE via the `?connection=` form EventSource needs,
  session/prompt). Proof that the ACP surface carries a web interface.

### Fixed

- Multi-client notification binding: a session's updates and permission
  requests now go to the connection that created it (captured from the
  `session/new` request context). Previously all sessions emitted through one
  shared context - the latest connection stole every other client's
  notifications, and deleting it made them vanish silently. Found by the
  serve e2e probe (kept as the regression test).

## [0.7.0] - 2026-08-17

### Added

- `examples/` - runnable usage specs: `curl-conversation.sh` (a complete
  initialize → SSE → session → prompt → teardown conversation using only
  curl, verified against a live server), `zed-settings.json`, and profile
  patch samples (`web-mounted.yml`, `model-pin.yml`).
- README restructured around the two final forms (`dsh-acp-server` standalone,
  `dsh web` together) with a full configuration reference (including `token`)
  and an HTTP transport reference.

### Changed

- Reorganized this changelog: entries accumulated under *Unreleased* were
  filed under their actually-released versions (0.2.0 - 0.6.1).

## [0.6.1] - 2026-08-17

### Fixed

- The default model is read per `session/new` instead of being captured once
  at plugin mount: sessions now follow config-store defaults and in-GUI model
  switches (a mount-time snapshot could pin a stale pre-config-load selection).

## [0.6.0] - 2026-08-17

### Fixed

- A turn that ends in `error` (transport, auth, quota - e.g. a broken
  provider baseURL) no longer resolves `session/prompt` as a silent empty
  `end_turn`: the request now fails with a JSON-RPC error carrying the cause
  (`agent turn failed: ...`) and the failure is logged to stderr. Found
  against a real misconfigured provider (`baseURL: "11111"`).

## [0.5.1] - 2026-08-17

### Fixed

- `setup-webacp.mjs` no longer re-runs `dsh plugin add` when the bundle is
  already in the profile manifest: a bare-spec re-add could fail on stale npm
  metadata right after a release and abort the setup before writing the
  web-mounted row.

## [0.5.0] - 2026-08-17

### Added

- The `dsh-acp-server` bin is the standalone single command: boots
  `dsh --profile acp` with full flag passthrough (`serve`, `--patch`, ...),
  and auto-bootstraps the acp profile on first use in a DSH home with the
  official `dsh plugin` command (bootstrap chatter on stderr only - editor
  stdout stays pure ACP). Bare `dsh acp-server` is not possible from a
  bundle: the launcher hardcodes its `web`/`plugin` subcommands before any
  plugin parses argv.

## [0.4.0] - 2026-08-17

### Added

- `dsh web` auto-starts ACP: setup-webacp.mjs now installs INTO the web
  profile by default (--clone keeps the original), so a plain `dsh web` boot
  serves the GUI and /acp on one port.
- Hand installs (no inject row) are safe: the plugin listens for the shared
  webServer service and web-mounts late - terminal boots skip the stdio
  transport entirely, daemon boots get a 2s stdin-EOF grace window instead of
  taking the GUI down (previously a silent exit 0).

## [0.3.0] - 2026-08-17

### Added

- Web-mounted mode: `dsh plugin --profile web add dsh-acp-server` plus the
  row-level `inject: [agents, agentDefaultModel, webServer]` (automated by
  bin/setup-webacp.mjs) serves the GUI and ACP in one process on one port -
  /acp, /acp/stream, /acp/healthz registered on the shared webServer service;
  optional `token` config for bearer auth. Zero races: Cordis inject semantics
  guarantee the shared service exists before the ACP row mounts.

## [0.2.0] - 2026-08-17

### Added

- `serve` mode: `dsh --profile acp serve [--host] [--port] [--token]` runs a
  long-lived HTTP+SSE ACP endpoint (POST /acp + GET /acp/stream + DELETE,
  Acp-Connection-Id binding, bearer auth, multi-client) following the ACP
  streamable-HTTP RFD draft shape. stdio editor mode unchanged; the acp-chat
  client gained `--url`/`--token` remote mode.

## [0.1.1] - 2026-08-17

### Fixed

- Declared the full dsh dependency closure (cordis, dsh-attachment/brand/
  invariants/scope/system-prompt/timeout/typert-protocol, zod) as regular
  dependencies, matching how other published dsh bundles ship their trees.
  The official profile template pins `autoInstallPeers: false`, so a
  partial closure produced a wall of "missing peer" warnings on
  `dsh plugin add`. Installs are now warning-free with every peer resolved.

## [0.1.0] - 2026-08-17

### Published

- `dsh-acp-server@0.1.0` is live on npm (prebuilt; `dsh plugin --profile acp
  add dsh-acp-server`). Verified end-to-end: registry install -> full ACP
  conversation -> tool lifecycle -> clean exit, in a throwaway $DSH_HOME.

### Added

- M1 ACP v1 server as a dsh profile bundle (`dsh --profile acp`):
  `initialize`, `session/new`, `session/prompt`, `session/cancel`,
  `session/close`.
- Streaming session updates: `agent_message_chunk`, `agent_thought_chunk`
  (DSH reasoning streams), `tool_call` lifecycle (pending → in_progress →
  completed/failed with content/locations/rawInput), `plan` updates from
  todo writes.
- Permission bridge: DSH `approval/request` waterfall ⇄ ACP
  `session/request_permission` with allow/reject once/always options.
- stopReason mapping for every DSH turn-end reason (completed, aborted,
  max-tokens, error, blocked, interrupted).
- Plugin configuration (Schemastery schema, validated at load, all defaults
  in schema): `agentName`, `provider`/`model` pin (both-or-neither, else
  follows the profile default), `offerAlwaysPermissions`, `flushOnTurnEnd`.
- `bin/setup-profile.mjs` one-command profile installer; `dsh-acp` launcher
  bin for editor integration.

### Changed

- Install path uses the official `dsh plugin --profile acp add <pkg>`
  command (the profile manifest is never hand-written); the e2e test installs
  through the same command.
- `prepare` build script added so source installs from git can build `lib/`
  (requires the pnpm `allowBuilds` authorization documented in the README);
  npm/tarball installs ship prebuilt and need no authorization.
- npm package name is `dsh-acp-server` (the plain `dsh-acp` name on npm
  belongs to another project); bin renamed to `dsh-acp-server` to avoid a
  global bin collision. The `acp-server` plugin row id is unchanged.
- `types` / `exports` paths fixed to the actual `lib/*.d.ts` outputs
  (were pointing at a nonexistent `lib/types/`).
