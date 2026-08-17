/**
 * The serve-mode command-line provider (official dsh pattern: the app owns
 * its flag family through `cmdlineArgs` + `parseCmdline`).
 *
 *   dsh --profile acp serve --port 7800 --host 0.0.0.0 --token <secret>
 *
 * `serve` is a subcommand: when present, this plugin publishes
 * `acpServeStartup`, which the acp-server row reads at apply time to switch
 * from stdio to HTTP+SSE transport. Without `serve` (e.g. when Zed spawns
 * `dsh --profile acp` with no args) nothing is published and the server
 * speaks ACP on stdio exactly as before. Unknown non-serve arguments are
 * ignored so editors may pass their own flags.
 */
import { Command } from 'commander'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'acp-serve-startup'

/** The launcher's immutable argument snapshot; required before parsing. */
export const inject = ['cmdlineArgs']

/** Service published only when the `serve` subcommand is present. */
export const SERVE_STARTUP_SERVICE = 'acpServeStartup'

export interface ServeOptions {
  readonly host: string
  readonly port: number
  readonly token: string | undefined
}

function serveProgram(): Command {
  const program = new Command()
    .name('dsh --profile acp')
    .description('ACP agent server; without `serve` it speaks ACP on stdio')
    .helpOption('-h, --help', 'show this help')
    .allowUnknownOption()
    .argument('[rest...]', 'ignored; editors may pass extra args')
    // A root action keeps commander from printing help and exiting when argv
    // does not name the serve subcommand (e.g. the zero args an editor
    // passes): those are stdio-mode boots, not usage errors.
    .action(() => { /* stdio mode; nothing to provide */ })
  const serve = new Command('serve')
    .description('serve ACP over HTTP+SSE instead of stdio')
    .option('--host <host>', 'bind host', '127.0.0.1')
    .option('--port <port>', 'listen port; 0 lets the OS pick a free one', (value: string) => Number(value), 7800)
    .option('--token <token>', 'require "Authorization: Bearer <token>" on every request')
  program.addCommand(serve, { isDefault: false })
  return program
}

export function apply(ctx: Context): void {
  const program = serveProgram()
  const serve = program.commands.find((command) => command.name() === 'serve')
  if (serve === undefined) return
  serve.action((options: { host?: string; port?: number; token?: string }) => {
    ctx.provide(SERVE_STARTUP_SERVICE, {
      host: options.host ?? '127.0.0.1',
      port: options.port ?? 7800,
      token: options.token,
    } satisfies ServeOptions)
  })
  parseCmdline(ctx, program)
}

export default { name, inject, apply }
