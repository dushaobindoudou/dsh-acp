#!/usr/bin/env node
/**
 * dsh-acp-server: the standalone ACP entry point.
 *
 *   dsh-acp-server                    ACP on stdio (the editor command)
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
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from 'node:process'

const dsh = env.DSH_BIN ?? 'dsh'
const home = env.DSH_HOME ?? join(env.HOME ?? '.', '.dsh')
const profileDir = join(home, 'profiles', 'acp')

function bootstrap() {
  // This file is <pkg>/bin/dsh-acp.mjs; the package root carries the
  // prebuilt lib/ and cordis.patch.yml that `dsh plugin add` consumes.
  const self = join(dirname(fileURLToPath(import.meta.url)), '..')
  process.stderr.write(`dsh-acp-server: no acp profile in ${home}; bootstrapping with \`dsh plugin --profile acp add ${self}\`...\n`)
  const result = spawnSync(dsh, ['plugin', '--profile', 'acp', 'add', self], {
    // Bootstrap chatter must never touch stdout (editors read ACP frames there).
    stdio: ['ignore', 'pipe', 'inherit'],
    env,
    timeout: 300_000,
  })
  if (result.stdout !== null && result.stdout.length > 0) process.stderr.write(result.stdout)
  if (result.error !== undefined || result.status !== 0) {
    process.stderr.write(`dsh-acp-server: bootstrap failed; run \`dsh plugin --profile acp add dsh-acp-server\` (or from a package dir) manually, then retry.\n`)
    process.exit(1)
  }
}

if (!existsSync(profileDir)) bootstrap()

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
