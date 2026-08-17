#!/usr/bin/env node
/**
 * dsh-acp launcher: boots `dsh --profile acp` with the current stdio.
 *
 * Use this as the ACP agent command in editors (Zed: agent_servers custom
 * entry). Requires the `dsh` CLI on PATH (or pointed to by $DSH_BIN) and the
 * `acp` profile installed (see bin/setup-profile.mjs).
 */
import { spawn } from 'node:child_process'
import { env } from 'node:process'

const dsh = env.DSH_BIN ?? 'dsh'
const child = spawn(dsh, ['--profile', 'acp', ...process.argv.slice(2)], {
  stdio: ['inherit', 'inherit', 'inherit'],
  env,
})

child.on('error', (error) => {
  process.stderr.write(`dsh-acp: failed to launch ${dsh}: ${String(error)}\n`)
  process.exit(1)
})
child.on('exit', (code, signal) => {
  if (signal !== null) process.exit(128 + 2)
  process.exit(code ?? 0)
})
