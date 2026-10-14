/**
 * End-to-end test of the one-shot `run` CLI: boots the REAL
 * `dsh --profile acp` process (through bin/dsh-acp.mjs, the way users invoke
 * it) with a throwaway $DSH_HOME and the mock-LLM overlay, and asserts the
 * CLI contract: plain-text stdout, --json shape, --session resume,
 * --model override, --timeout cancel, and exit codes.
 *
 * Exit code 3 (cancelled) and 4 (permission denied) are covered at the unit
 * level (test/unit/run-core.test.mjs): the mock never self-cancels, and its
 * bash tool never triggers a permission round-trip, so neither code is
 * reachable deterministically here.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const dshBin = process.env.DSH_BIN ?? 'dsh'

const PASS = (message) => process.stdout.write(`  ok - ${message}\n`)
const FAIL = (message) => {
  process.stderr.write(`  not ok - ${message}\n`)
  dumpLogs()
  process.exit(1)
}
const tmp = mkdtempSync(join(tmpdir(), 'dsh-acp-run-'))
const home = join(tmp, 'home')
const project = join(tmp, 'project')
mkdirSync(project, { recursive: true })
const stderrPath = join(tmp, 'dsh-stderr.log')
const logPaths = [stderrPath]
function dumpLogs() {
  for (const path of logPaths) {
    if (!existsSync(path)) continue
    process.stderr.write(`--- ${path} ---\n${readFileSync(path, 'utf8').slice(-4000)}\n`)
  }
}

// ── install into a throwaway home (same official path as the stdio e2e) ──
const install = spawnSync(dshBin, ['plugin', '--profile', 'acp', 'add', process.env.DSH_ACP_PKG ?? repoRoot], {
  encoding: 'utf8',
  env: { ...process.env, DSH_HOME: home },
  timeout: 240_000,
})
if (install.status !== 0) {
  process.stderr.write(install.stdout ?? '')
  process.stderr.write(install.stderr ?? '')
  FAIL('dsh plugin --profile acp add failed')
}
PASS('installed dsh-acp via `dsh plugin add`')

const overlay = join(repoRoot, 'test', 'e2e', 'test-acp.overlay.yml')

// ── the CLI under test: the real bin entry ────────────────────────────────
function runCli(args, env = {}) {
  return spawnSync(process.execPath, [join(repoRoot, 'bin', 'dsh-acp.mjs'), 'run', ...args], {
    encoding: 'utf8',
    cwd: project,
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_ACP_RUN_ARGS: `--patch ${overlay}`,
      ...env,
    },
    timeout: 180_000,
  })
}

// ── 1. plain text output + exit 0 ──────────────────────────────────────────
const plain = runCli(['Say hello'])
if (plain.status !== 0) FAIL(`plain run exited ${plain.status}: ${plain.stderr}`)
assert.match(plain.stdout, /Hello from dsh-acp mock/, `stdout is the final answer, got: ${JSON.stringify(plain.stdout)}`)
assert.equal(plain.stdout.trim(), 'Hello from dsh-acp mock. Second chunk.', 'stdout carries ONLY the answer text')
PASS('plain run: stdout = final answer, exit 0')

// ── 2. --json shape ────────────────────────────────────────────────────────
const json = runCli(['Say hello', '--json'])
if (json.status !== 0) FAIL(`--json run exited ${json.status}: ${json.stderr}`)
const payload = JSON.parse(json.stdout)
assert.match(payload.sessionId, /^acp-/)
assert.equal(payload.stopReason, 'end_turn')
assert.match(payload.text, /Hello from dsh-acp mock/)
assert.ok(Array.isArray(payload.toolCalls))
assert.ok(payload.usage !== undefined && payload.usage.inputTokens > 0, `usage present: ${JSON.stringify(payload.usage)}`)
assert.equal('error' in payload, false)
PASS('--json: {sessionId, stopReason, text, toolCalls, usage}')

// ── 3. --session resumes the same session ─────────────────────────────────
const resumed = runCli(['Say hello again', '--json', '--session', payload.sessionId])
if (resumed.status !== 0) FAIL(`--session run exited ${resumed.status}: ${resumed.stderr}`)
assert.equal(JSON.parse(resumed.stdout).sessionId, payload.sessionId, 'resume reuses the persisted session id')
PASS(`--session resumed ${payload.sessionId}`)

// ── 4. --model override routes through set_config_option ──────────────────
const modelRun = runCli(['Say hello', '--json', '--model', 'mock/mock-2'])
if (modelRun.status !== 0) FAIL(`--model run exited ${modelRun.status}: ${modelRun.stderr}`)
assert.equal(JSON.parse(modelRun.stdout).stopReason, 'end_turn')
assert.match(modelRun.stderr, /model override: mock\/mock-2/)
PASS('--model mock/mock-2 override applied (stderr note, clean turn)')

// ── 5. --timeout cancels and exits 2 ───────────────────────────────────────
const timedOut = runCli(['SLOW please', '--timeout', '1'])
assert.equal(timedOut.status, 2, `timeout exit code, got ${timedOut.status}`)
assert.doesNotMatch(timedOut.stdout, /Second chunk/, 'nothing streamed after the cancel landed')
assert.match(timedOut.stderr, /timeout after 1s/)
PASS('--timeout 1 on a parked turn: exit 2')

// ── 6. exit 1: bad attach path fails before any boot ───────────────────────
const badAttach = runCli(['x', '--attach', join(tmp, 'missing.txt')])
assert.equal(badAttach.status, 1)
assert.match(badAttach.stderr, /--attach failed/)
PASS('--attach with a missing file: exit 1 before any boot')

// ── 7. exit 1: unknown session id ──────────────────────────────────────────
const badSession = runCli(['x', '--json', '--session', 'acp-does-not-exist'])
assert.equal(badSession.status, 1)
assert.match(badSession.stderr, /acp-does-not-exist/)
PASS('--session with an unknown id: exit 1 with the cause')

process.stdout.write('RUN-CLI E2E OK\n')
process.exit(0)
