# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Install path now uses the official `dsh plugin --profile acp add <pkg>`
  command (profile manifest is never hand-written); `bin/setup-profile.mjs`
  is a thin wrapper over it, and the e2e test installs through the same
  command.
- Added a `prepare` build script so source installs from git can build
  `lib/` (requires the pnpm `allowBuilds` authorization documented in the
  README); npm/tarball installs ship prebuilt and need no authorization.

## [0.1.0] - 2026-08-17

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
