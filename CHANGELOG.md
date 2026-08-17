# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
