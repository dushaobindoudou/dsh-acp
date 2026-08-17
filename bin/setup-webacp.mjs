#!/usr/bin/env node
/**
 * One-command `dsh web` + ACP: installs dsh-acp-server INTO the web profile
 * so every plain `dsh web` boot serves the GUI and /acp on one port.
 *
 *   node bin/setup-webacp.mjs                 # install into the `web` profile
 *   node bin/setup-webacp.mjs --clone webacp  # keep `web` untouched, use a copy
 *   node bin/setup-webacp.mjs --pkg dsh-acp-server@latest --from web
 *
 * After setup:
 *
 *   dsh web                     # http://127.0.0.1:3080 = GUI, /acp = ACP
 *
 * It runs the official `dsh plugin --profile web add <pkg>` (adds the
 * dependency and appends dsh-acp-server to dsh.profile.bundles) and appends
 * the deterministic web-mounted row to the profile patch: with a row-level
 * `inject: [agents, agentDefaultModel, webServer]`, Cordis starts the
 * acp-server fiber only after the shared webServer service exists, so the
 * stdio transport never races a web boot.
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
const cloneName = flag('clone', undefined)
const profile = cloneName !== undefined ? cloneName : from

const source = join(home, 'profiles', from)
const profileDir = join(home, 'profiles', profile)

// --clone: copy the source profile first so the original stays untouched.
if (cloneName !== undefined) {
  if (!existsSync(source)) {
    process.stderr.write(`dsh-acp setup-webacp: source profile ${source} does not exist (boot \`dsh ${from}\` once first)\n`)
    exit(1)
  }
  mkdirSync(join(home, 'profiles'), { recursive: true })
  cpSync(source, profileDir, { recursive: true })
}

// Official install (initializes the profile from its shipped template on
// first use, adds the dependency, appends the bundle to the manifest).
const install = spawnSync('dsh', ['plugin', '--profile', profile, 'add', pkg], {
  stdio: 'inherit',
  env: { ...env, DSH_HOME: home },
})
if (install.status !== 0) {
  process.stderr.write(`dsh-acp setup-webacp: \`dsh plugin --profile ${profile} add ${pkg}\` failed\n`)
  exit(install.status ?? 1)
}

// Deterministic web-mounted mode: the row waits for the shared webServer.
// The profile template ships the empty-list placeholder `[]`; a YAML file is
// one document, so replace the placeholder instead of appending after it.
const patchPath = join(profileDir, 'cordis.patch.yml')
const entries = [
  '# dsh-acp-server: web-mounted mode - ACP rides the shared webServer port',
  '- id: acp-server',
  '  inject: [agents, agentDefaultModel, webServer]',
].join('\n')
let previous = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
if (/\[\]\s*$/m.test(previous)) previous = previous.replace(/\[\]\s*$/m, entries)
else previous = (previous.trim() === '' ? '' : previous.trimEnd() + '\n') + entries + '\n'
writeFileSync(patchPath, previous)

process.stdout.write(`done. boot with:  dsh ${profile === 'web' ? 'web' : `--profile ${profile}`}\nGUI and ACP then share one port: http://127.0.0.1:3080 (GUI) + /acp (ACP)\n`)
