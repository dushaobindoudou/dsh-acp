#!/usr/bin/env node
/**
 * One-command `acp` profile setup:
 *
 *   node bin/setup-profile.mjs [--pkg <spec>] [--home <dir>] [--force]
 *
 * Creates $DSH_HOME/profiles/acp (package.json + pnpm-workspace.yaml, with
 * `dsh.profile.bundles = ["@deepseek-ai/dsh-base", "dsh-acp"]`) and installs
 * the bundle into it with pnpm. Default --pkg is `dsh-acp` (the published
 * package); pass a local checkout path during development.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { env, exit } from 'node:process'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index !== -1 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const pkg = flag('pkg', 'dsh-acp')
const home = flag('home', env.DSH_HOME ?? join(env.HOME ?? '.', '.dsh'))
const force = args.includes('--force')

const profileDir = join(home, 'profiles', 'acp')
const manifestPath = join(profileDir, 'package.json')

if (existsSync(manifestPath) && !force) {
  process.stdout.write(`acp profile already exists at ${profileDir} (use --force to rewrite its manifest)\n`)
} else {
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(manifestPath, `${JSON.stringify({
    name: 'dsh-profile-acp',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-acp'] } },
  }, null, 2)}\n`)
  writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  process.stdout.write(`wrote ${manifestPath}\n`)
}

process.stdout.write(`installing ${pkg} into ${profileDir} with pnpm ...\n`)
const result = spawnSync('pnpm', ['add', pkg, '--ignore-scripts'], {
  cwd: profileDir,
  stdio: 'inherit',
  env,
})
if (result.status !== 0) {
  process.stderr.write('dsh-acp setup: pnpm add failed\n')
  exit(result.status ?? 1)
}

try {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (!bundles.includes('dsh-acp')) {
    process.stderr.write(`dsh-acp setup: expected dsh.profile.bundles to include "dsh-acp", got ${JSON.stringify(bundles)}\n`)
  }
} catch {
  process.stderr.write('dsh-acp setup: could not re-read the profile manifest\n')
}

process.stdout.write('done. boot with:  dsh --profile acp\n(or in Zed agent_servers: command "dsh-acp")\n')
