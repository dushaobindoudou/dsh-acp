#!/usr/bin/env node
/**
 * dsh-acp-server: the standalone ACP entry point.
 *
 *   dsh-acp-server                    ACP on stdio (the editor command)
 *   dsh-acp-server run "task" ...     one-shot CLI for scripts (see README)
 *   dsh-acp-server catalog|call|stream|rpc ...
 *                                     host control: every GUI action from a shell
 *   dsh-acp-server serve --port 7800  ACP on HTTP+SSE (remote)
 *   dsh-acp-server --patch extra.yml  any launcher flags pass through
 *
 * Boots `dsh --profile acp` with the current stdio. On first use in a DSH
 * home (no `acp` profile yet) it bootstraps the profile with the official
 * `dsh plugin --profile acp add <this package>` first; bootstrap output goes
 * to stderr so an editor's stdout never sees anything but ACP frames.
 *
 * Why a bin and not `dsh acp-server`: the dsh launcher hardcodes its app
 * subcommands (`web`, `plugin`) and parses argv before any plugin loads, so
 * a bundle cannot register one; this wrapper is the single-command form.
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from 'node:process'

const dsh = env.DSH_BIN ?? 'dsh'

// Client subcommands of THIS package, not dsh launcher flags: each speaks
// ACP to a running server (--url / DSH_ACP_URL) or to a private
// `dsh --profile acp` child, and exits with its outcome.
const CLIENT_COMMANDS = {
  run: ['run.js', 'runMain'],
  call: ['control.js', 'callMain'],
  stream: ['control.js', 'streamMain'],
  catalog: ['control.js', 'catalogMain'],
  rpc: ['control.js', 'rpcMain'],
}
const subcommand = CLIENT_COMMANDS[process.argv[2] ?? '']

if (subcommand !== undefined) {
  const [file, entry] = subcommand
  const module = await import(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'cli', file))
  process.exitCode = await module[entry](process.argv.slice(3))
} else {
  const { ensureAcpProfile } = await import(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'cli', 'bootstrap.js'))
  ensureAcpProfile()
  const child = spawn(dsh, ['--profile', 'acp', ...process.argv.slice(2)], {
    stdio: ['inherit', 'inherit', 'inherit'],
    env,
  })

  child.on('error', (error) => {
    process.stderr.write(`dsh-acp-server: failed to launch ${dsh}: ${String(error)}\n`)
    process.exit(1)
  })
  child.on('exit', (code, signal) => {
    if (signal !== null) process.exit(128 + 2)
    process.exit(code ?? 0)
  })
}
