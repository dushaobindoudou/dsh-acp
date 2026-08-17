#!/usr/bin/env node
/**
 * One-command `acp` profile setup.
 *
 * Thin wrapper over the OFFICIAL plugin installer:
 *
 *   dsh plugin --profile acp add <pkg>
 *
 * which initializes the profile, installs the bundle with pnpm, and keeps
 * `dsh.profile.bundles` in sync automatically (see the "打包与安装插件"
 * tutorial: the profile manifest never needs to be hand-written). This script
 * only fills in defaults: profile name `acp`, package spec from --pkg.
 *
 *   node bin/setup-profile.mjs [--pkg <spec>] [--home <dir>]
 *
 * --pkg accepts anything pnpm accepts: `dsh-acp` (npm), a local path,
 * `github:dushaobindoudou/dsh-acp`, or a tarball. From-scratch, without this
 * script, the equivalent is simply:
 *
 *   dsh plugin --profile acp add github:dushaobindoudou/dsh-acp
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { env, exit } from 'node:process'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index !== -1 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const pkg = flag('pkg', 'dsh-acp')
const home = flag('home', env.DSH_HOME ?? join(env.HOME ?? '.', '.dsh'))

process.stdout.write(`installing ${pkg} into the acp profile ...\n`)
const result = spawnSync('dsh', ['plugin', '--profile', 'acp', 'add', pkg], {
  stdio: 'inherit',
  env: { ...env, DSH_HOME: home },
})
if (result.status !== 0) {
  process.stderr.write(
    `dsh-acp setup: \`dsh plugin --profile acp add ${pkg}\` failed\n` +
    'note: installing from git runs the prepare build script; pnpm >= 10 needs\n' +
    'an explicit allowBuilds entry in the profile pnpm-workspace.yaml first.\n',
  )
  exit(result.status ?? 1)
}

process.stdout.write(`done. boot with:  dsh --profile acp   (DSH_HOME=${home})\n(or in Zed agent_servers: command "dsh-acp")\n`)
