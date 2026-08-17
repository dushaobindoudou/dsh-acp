#!/usr/bin/env node
/**
 * One-command combined profile: the Web GUI and the ACP endpoint in ONE
 * process on ONE port.
 *
 *   node bin/setup-webacp.mjs [--pkg <spec>] [--home <dir>] [--from web]
 *
 * Clones the `web` profile into a `webacp` profile, installs dsh-acp-server
 * with the official plugin command, and appends the row-level inject that
 * makes the acp-server row wait for the shared `webServer` service (the
 * deterministic web-mounted mode; without it the row would race the web
 * composition and grab stdio). Boot with:
 *
 *   dsh --profile webacp [--port <port>]
 *
 * then http://127.0.0.1:3080 serves the GUI and /acp serves ACP.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { env, exit } from 'node:process'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index !== -1 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const pkg = flag('pkg', 'dsh-acp-server')
const home = flag('home', env.DSH_HOME ?? join(env.HOME ?? '.', '.dsh'))
const from = flag('from', 'web')
const name = 'webacp'

const source = join(home, 'profiles', from)
const profileDir = join(home, 'profiles', name)
if (!existsSync(source)) {
  process.stderr.write(`dsh-acp setup-webacp: source profile ${source} does not exist (boot \`dsh ${from}\` once first)\n`)
  exit(1)
}

// 1. clone the web profile (its in-box bundles - dsh-base + dsh-web-app -
//    resolve from the dsh install; nothing to reinstall).
mkdirSync(join(home, 'profiles'), { recursive: true })
cpSync(source, profileDir, { recursive: true })

// 2. install our bundle with the official command (adds the dependency and
//    appends dsh-acp-server to dsh.profile.bundles).
const install = spawnSync('dsh', ['plugin', '--profile', name, 'add', pkg], {
  stdio: 'inherit',
  env: { ...env, DSH_HOME: home },
})
if (install.status !== 0) {
  process.stderr.write(`dsh-acp setup-webacp: \`dsh plugin --profile ${name} add ${pkg}\` failed\n`)
  exit(install.status ?? 1)
}

// 3. row-level inject: deterministic web-mounted mode. The overlay replaces
//    the whole row, so restate the plugin's own needs alongside webServer.
const patchPath = join(profileDir, 'cordis.patch.yml')
const entries = [
  '# dsh-acp-server: web-mounted mode - ACP rides the shared webServer port',
  '- id: acp-server',
  '  inject: [agents, agentDefaultModel, webServer]',
].join('\n')
// The profile template ships the empty-list placeholder `[]`; a YAML file is
// one document, so replace the placeholder instead of appending after it.
let previous = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
if (/^\[\]\s*$/m.test(previous)) previous = previous.replace(/^\[\]\s*$/m, entries)
else previous = (previous.trim() === '' ? '' : previous.trimEnd() + '\n') + entries + '\n'
writeFileSync(patchPath, previous)

process.stdout.write(`done. boot with:  dsh --profile ${name}\nGUI and ACP then share one port: http://127.0.0.1:3080 (GUI) + /acp (ACP)\n`)
