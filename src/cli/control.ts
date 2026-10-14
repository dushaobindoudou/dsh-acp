/**
 * Host-control subcommands: everything a dsh user can do, from a shell.
 *
 *   dsh-acp-server catalog [namespace] [--schemas] [--json]
 *   dsh-acp-server call   <ns/method> [argsJson]          -> result JSON
 *   dsh-acp-server stream <ns/method> [argsJson] [--limit N] [--timeout s]
 *                                                          -> NDJSON items
 *   dsh-acp-server rpc    <method> [paramsJson]           -> any ACP / dsh/* request
 *
 * All take `--url` / `--token` (or DSH_ACP_URL / DSH_ACP_TOKEN) to reach a
 * RUNNING dsh — the web composition's `/acp` is where the GUI's workspaces,
 * sessions and settings live; without a URL a private `dsh --profile acp`
 * is spawned for the one call. Argument JSON may be `@file.json` or `-`
 * (stdin). Exit codes: 0 ok · 1 error · 2 timeout (stream).
 */
import { Command } from 'commander'
import { readFile } from 'node:fs/promises'
import { describeRpcError, openServer, settle, targetOf, type OpenedServer, type ServerTarget } from './connect.js'
import { formatCatalog, parseJsonArg, positiveNumberArg, type CatalogMethodLike } from './control-core.js'

const err = (command: string, message: string): void => { process.stderr.write(`dsh-acp-server ${command}: ${message}\n`) }

interface Common { url?: string; token?: string; cwd?: string }

function withCommon(program: Command): Command {
  return program
    .option('--url <url>', 'running server base URL (serve / web composition); default $DSH_ACP_URL, else spawn a private dsh')
    .option('--token <token>', 'bearer token for --url; default $DSH_ACP_TOKEN')
    .option('--cwd <dir>', 'working directory of a spawned server', process.cwd())
}

/** Read a JSON argument: inline text, `@path`, or `-` for stdin. */
async function jsonArg(raw: string | undefined, what: string): Promise<Record<string, unknown>> {
  if (raw === '-') {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
    return parseJsonArg(Buffer.concat(chunks).toString('utf8'), what)
  }
  if (raw !== undefined && raw.startsWith('@')) return parseJsonArg(await readFile(raw.slice(1), 'utf8'), what)
  return parseJsonArg(raw, what)
}

async function withServer<T>(command: string, target: ServerTarget, configure: Parameters<typeof openServer>[1], body: (server: OpenedServer) => Promise<T>): Promise<T> {
  const server = await openServer(target, configure)
  try {
    return await body(server)
  } finally {
    await server.close().catch(() => undefined)
  }
}

/**
 * Parse argv; `undefined` means "go on", a number is the exit code (help
 * printed = 0, a usage error = 1, already reported by commander).
 */
function parseArgs(program: Command, argv: readonly string[]): number | undefined {
  program.exitOverride()
  try {
    program.parse([...argv], { from: 'user' })
    return undefined
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === undefined) process.stderr.write(`${program.name()}: ${error instanceof Error ? error.message : String(error)}\n`)
    return code === 'commander.helpDisplayed' || code === 'commander.help' || code === 'commander.version' ? 0 : 1
  }
}

function printJson(value: unknown, compact: boolean): void {
  process.stdout.write(`${compact ? JSON.stringify(value) : JSON.stringify(value, null, 2)}\n`)
}

function reportError(command: string, error: unknown): number {
  const described = describeRpcError(error)
  err(command, described.message)
  if (described.code !== undefined || described.data !== undefined) {
    process.stderr.write(`${JSON.stringify({ error: described })}\n`)
  }
  return 1
}

export async function catalogMain(argv: readonly string[]): Promise<number> {
  const program = withCommon(new Command().name('dsh-acp-server catalog'))
    .description('list every host-control (Remote) method the running dsh exposes')
    .argument('[namespace]', 'only this namespace (e.g. workspace, session, settings)')
    .option('--schemas', 'include parameter/result JSON Schemas (implied by a namespace)', false)
    .option('--json', 'print the raw catalog JSON', false)
  const parsed = parseArgs(program, argv)
  if (parsed !== undefined) return parsed
  const options = program.opts<Common & { schemas: boolean; json: boolean }>()
  const namespace = program.args[0]
  try {
    const catalog = await withServer('catalog', targetOf(options), (app) => app, (server) =>
      settle(server, server.rpc.request<{ methods: CatalogMethodLike[]; namespaces: Array<{ namespace: string; methods: number }> }>('dsh/remote/catalog', {
        ...namespace !== undefined ? { namespace } : {},
        ...options.schemas ? { schemas: true } : {},
      }), 'dsh/remote/catalog'))
    if (options.json) printJson(catalog, false)
    else {
      process.stdout.write(`${formatCatalog(catalog.methods)}\n`)
      if (namespace === undefined) {
        process.stderr.write(`${catalog.methods.length} methods in ${catalog.namespaces.length} namespaces; \`catalog <namespace>\` adds JSON Schemas\n`)
      }
    }
    return 0
  } catch (error) {
    return reportError('catalog', error)
  }
}

export async function callMain(argv: readonly string[]): Promise<number> {
  const program = withCommon(new Command().name('dsh-acp-server call'))
    .description('invoke one host-control (Remote) method and print its result')
    .argument('<endpoint>', 'namespace/method, e.g. workspace/create')
    .argument('[args]', 'named wire arguments as a JSON object, @file.json, or - (stdin)')
    .option('--compact', 'print single-line JSON', false)
  const parsed = parseArgs(program, argv)
  if (parsed !== undefined) return parsed
  const options = program.opts<Common & { compact: boolean }>()
  try {
    const args = await jsonArg(program.args[1], 'call arguments')
    const endpoint = program.args[0]!
    const response = await withServer('call', targetOf(options), (app) => app, (server) =>
      settle(server, server.rpc.request<{ result: unknown }>('dsh/remote/invoke', { endpoint, args }), endpoint))
    printJson(response.result, options.compact)
    return 0
  } catch (error) {
    return reportError('call', error)
  }
}

export async function rpcMain(argv: readonly string[]): Promise<number> {
  const program = withCommon(new Command().name('dsh-acp-server rpc'))
    .description('send any ACP or dsh/* request (e.g. dsh/sessions/list, dsh/sessions/wait) and print the result')
    .argument('<method>', 'JSON-RPC method name')
    .argument('[params]', 'params as a JSON object, @file.json, or - (stdin)')
    .option('--compact', 'print single-line JSON', false)
  const parsed = parseArgs(program, argv)
  if (parsed !== undefined) return parsed
  const options = program.opts<Common & { compact: boolean }>()
  try {
    const params = await jsonArg(program.args[1], 'rpc params')
    const method = program.args[0]!
    const result = await withServer('rpc', targetOf(options), (app) => app, (server) =>
      settle(server, server.rpc.request<unknown>(method, params), method))
    printJson(result, options.compact)
    return 0
  } catch (error) {
    return reportError('rpc', error)
  }
}

export async function streamMain(argv: readonly string[]): Promise<number> {
  const program = withCommon(new Command().name('dsh-acp-server stream'))
    .description('open a host-control stream method (follow/watch) and print each item as one JSON line')
    .argument('<endpoint>', 'namespace/method, e.g. workspace/follow')
    .argument('[args]', 'named wire arguments as a JSON object, @file.json, or - (stdin)')
    .option('--limit <n>', 'stop after this many items', (value: string) => positiveNumberArg(value, '--limit', true))
    .option('--timeout <seconds>', 'stop after this many seconds (exit 2)', (value: string) => positiveNumberArg(value, '--timeout'))
  const parsed = parseArgs(program, argv)
  if (parsed !== undefined) return parsed
  const options = program.opts<Common & { limit?: number; timeout?: number }>()
  try {
    const args = await jsonArg(program.args[1], 'stream arguments')
    const endpoint = program.args[0]!
    const streamId = `cli-${process.pid}-${Date.now()}`
    let count = 0
    let finish: (code: number) => void = () => undefined
    const finished = new Promise<number>((resolve) => { finish = resolve })
    return await withServer('stream', targetOf(options), (app) => app
      .onNotification('dsh/remote/item', (params: unknown) => params as { streamId: string; item: unknown }, async ({ params }) => {
        if (params.streamId !== streamId) return
        process.stdout.write(`${JSON.stringify(params.item)}\n`)
        count += 1
        if (options.limit !== undefined && count >= options.limit) finish(0)
      })
      .onNotification('dsh/remote/end', (params: unknown) => params as { streamId: string; reason: string; error?: { message?: string } }, async ({ params }) => {
        if (params.streamId !== streamId) return
        if (params.reason === 'error') {
          err('stream', params.error?.message ?? 'stream failed')
          finish(1)
        } else finish(0)
      }), async (server) => {
      await settle(server, server.rpc.request('dsh/remote/stream', { endpoint, args, streamId }), endpoint)
      const timer = options.timeout !== undefined && options.timeout > 0
        ? setTimeout(() => finish(2), options.timeout * 1000)
        : undefined
      const onSigint = () => finish(0)
      process.once('SIGINT', onSigint)
      const code = await Promise.race([finished, server.lost.then((reason) => { err('stream', reason); return 1 })])
      clearTimeout(timer)
      process.off('SIGINT', onSigint)
      await server.rpc.request('dsh/remote/cancel', { streamId }).catch(() => undefined)
      return code
    })
  } catch (error) {
    return reportError('stream', error)
  }
}
