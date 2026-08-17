# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Declared the full dsh dependency closure (cordis, dsh-attachment/brand/
  invariants/scope/system-prompt/timeout/typert-protocol, zod) as regular
  dependencies, matching how other published dsh bundles ship their trees.
  The official profile template pins `autoInstallPeers: false`, so a
  partial closure produced a wall of "missing peer" warnings on
  `dsh plugin add`. Installs are now warning-free with every peer resolved.

### Changed

- npm package name is `dsh-acp-server` (the plain `dsh-acp` name on npm
  belongs to another project); bin renamed to `dsh-acp-server` to avoid a
  global bin collision. The `acp-server` plugin row id is unchanged.
- Fixed `types` / `exports` paths to the actual `lib/*.d.ts` outputs
  (was pointing at a nonexistent `lib/types/`).

### Added

- Plugin configuration (Schemastery schema, validated at load, all defaults
  in schema): `agentName` (initialize.agentInfo.name), `provider`/`model`
  pin for ACP sessions (both-or-neither, else follows the profile default),
  `offerAlwaysPermissions` (hide allow_always/reject_always, which M1 maps
  to one-shot decisions), `flushOnTurnEnd`. Users override keys in their
  own profile patch layer; the e2e run proves the override reaches the wire
  (`initialize.agentInfo.name`).

### Changed

- Install path now uses the official `dsh plugin --profile acp add <pkg>`
  command (profile manifest is never hand-written); `bin/setup-profile.mjs`
  is a thin wrapper over it, and the e2e test installs through the same
  command.
- Added a `prepare` build script so source installs from git can build
  `lib/` (requires the pnpm `allowBuilds` authorization documented in the
  README); npm/tarball installs ship prebuilt and need no authorization.

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
- `bin/setup-profile.mjs` one-command profile installer; `dsh-acp` launcher
  bin for editor integration.
- `dsh-acp/test/mock-llm` deterministic mock LLM provider + e2e harness that
  boots the real dsh process and asserts the full wire behavior.
