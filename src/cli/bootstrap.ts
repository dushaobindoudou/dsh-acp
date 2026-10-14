/** Install this package into a private ACP profile only when it is needed. */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function ensureAcpProfile(): void {
  const home = process.env.DSH_HOME ?? join(process.env.HOME ?? '.', '.dsh')
  if (existsSync(join(home, 'profiles', 'acp'))) return

  const self = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const dsh = process.env.DSH_BIN ?? 'dsh'
  process.stderr.write(`dsh-acp-server: no acp profile in ${home}; bootstrapping with \`dsh plugin --profile acp add ${self}\`...\n`)
  const result = spawnSync(dsh, ['plugin', '--profile', 'acp', 'add', self], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: process.env,
    timeout: 300_000,
  })
  if (result.stdout?.length > 0) process.stderr.write(result.stdout)
  if (result.error !== undefined || result.status !== 0) {
    throw new Error('bootstrap failed; run `dsh plugin --profile acp add dsh-acp-server` manually, then retry', {
      cause: result.error,
    })
  }
}
