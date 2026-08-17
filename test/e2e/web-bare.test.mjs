/**
 * End-to-end bare-install test: `dsh plugin --profile web add dsh-acp-server`
 * with NO row-level inject (the setup a user reaches by hand), booted
 * daemon-style (stdin at /dev/null). The late web-mounted path must save it:
 * stdin EOF must not exit the process, and ACP must come up with the web
 * composition on the same port.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, openSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const dshBin = process.env.DSH_BIN ?? 'dsh'

const PASS = (message) => process.stdout.write(`  ok - ${message}\n`)
const FAIL = (message) => {
  process.stderr.write(`  not ok - ${message}\n`)
  for (const path of ['/tmp/dsh-acp-bare-out.log', '/tmp/dsh-acp-bare-err.log']) {
    if (existsSync(path)) process.stderr.write(`--- ${path} ---\n${readFileSync(path, 'utf8').slice(-3000)}\n`)
  }
  process.exit(1)
}

const tmp = mkdtempSync(join(tmpdir(), 'dsh-acp-bare-'))
const home = join(tmp, 'home')
const project = join(tmp, 'project')
mkdirSync(project, { recursive: true })

// Official install into the web profile - and deliberately NOTHING else:
// no inject row, this is exactly what a hand-installing user gets.
const install = spawnSync(dshBin, ['plugin', '--profile', 'web', 'add', process.env.DSH_ACP_PKG ?? repoRoot], {
  encoding: 'utf8',
  env: { ...process.env, DSH_HOME: home },
  timeout: 240_000,
})
if (install.status !== 0) {
  process.stderr.write(install.stdout ?? '')
  process.stderr.write(install.stderr ?? '')
  FAIL('dsh plugin --profile web add failed')
}
PASS('bare install into the web profile (no inject row)')

const overlay = join(repoRoot, 'test', 'e2e', 'test-acp.overlay.yml')
const child = spawn(dshBin, ['--profile', 'web', '--patch', overlay, '--port', '0'], {
  cwd: project,
  env: { ...process.env, DSH_HOME: home },
  // Daemon-style: stdin /dev/null (immediate EOF - the dangerous input),
  // stdout/stderr captured to files.
  stdio: ['ignore', openSync('/tmp/dsh-acp-bare-out.log', 'w'), openSync('/tmp/dsh-acp-bare-err.log', 'w')],
})

const withTimeout = (promise, ms, what) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout: ${what}`)), ms))])

const port = await withTimeout(
  new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      try {
        const match = readFileSync('/tmp/dsh-acp-bare-out.log', 'utf8').match(/dsh web: http:\/\/127\.0\.0\.1:(\d+)/)
        if (match !== null) { clearInterval(timer); resolve(Number(match[1])) }
      } catch { /* not written yet */ }
    }, 300)
    child.on('exit', (code) => { clearInterval(timer); reject(new Error(`process exited early (${code}) - the grace path failed`)) })
    setTimeout(() => { clearInterval(timer); reject(new Error('no listening line')) }, 90_000)
  }),
  120_000,
  'web port',
)
PASS(`listening on :${port}`)

// The grace period (2s) plus margin; the process must survive stdin EOF.
await new Promise((resolve) => setTimeout(resolve, 6_000))
if (child.exitCode !== null) FAIL(`process died after stdin EOF (exitCode=${child.exitCode}) - the grace path failed`)
PASS('process alive past the EOF grace window')

const base = `http://127.0.0.1:${port}`
try {
  assert.equal(await (await fetch(`${base}/`)).status, 200)
  assert.equal(await (await fetch(`${base}/acp/healthz`)).text(), 'ok')
  PASS('GUI and ACP on the same port (late web-mounted path)')

  const initResponse = await fetch(`${base}/acp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } }),
  })
  assert.equal(initResponse.status, 200)
  const body = JSON.parse(await initResponse.text())
  assert.equal(body.result.agentInfo.name, 'dsh-e2e')
  PASS('initialize works over the late-mounted routes')

  child.kill('SIGTERM')
  await withTimeout(new Promise((resolve) => child.on('exit', resolve)), 60_000, 'exit')
  PASS('SIGTERM -> clean teardown')

  process.stdout.write('WEB-BARE E2E OK\n')
  process.exit(0)
} catch (error) {
  FAIL(String(error instanceof Error ? error.stack ?? error.message : error))
}
