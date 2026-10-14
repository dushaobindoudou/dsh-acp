/**
 * `session/delete`: remove one persisted session's artifact directory.
 *
 * dsh's persistence seam (`SessionPersistence`) deliberately exposes no
 * delete — storage semantics are append-only. Deletion is therefore an
 * explicit, guarded filesystem cleanup of the JSONL backend's layout
 * (`<root>/<projectKey>/<sessionId>/`), with three refusals BEFORE any
 * bytes are touched:
 *
 *  1. open in this process's ACP table -> close it first;
 *  2. live elsewhere in this process (e.g. the web GUI) -> close it first;
 *  3. a cross-process write claim succeeds -> nobody else owns it
 *     (the backend takes a kernel write lock per session directory, so a
 *     live writer in ANOTHER process makes `open(id, 'write')` fail).
 *
 * The project directory is located by scanning, not by re-deriving the
 * backend's private cwd-slug: one directory named `<sessionId>` at depth two
 * under the backend root is the artifact, whatever the slug encoding does.
 */
import { RequestError } from '@agentclientprotocol/sdk'
import { join } from 'node:path'

/** The slice of the JSONL persistence service the deletion needs. */
export interface SessionPersistenceLike {
  stat(id: string, options?: { signal?: AbortSignal }): Promise<unknown>
  open(id: string, access: 'read' | 'write', options?: { signal?: AbortSignal }): Promise<{ close(): Promise<void> }>
  readonly config?: { readonly root?: string }
}

/** Minimal fs seam (node:fs/promises shape) so tests need no real tree. */
export interface DeleteFs {
  readdir(path: string, options: { withFileTypes: true }): Promise<Array<{ name: string; isDirectory(): boolean }>>
  rm(path: string, options: { recursive: true; force: true }): Promise<void>
}

/**
 * Every artifact directory of `sessionId` under the backend root:
 * `<root>/<projectDir>/<sessionId>`, exactly two levels deep. Multiple hits
 * are possible only if the same id was materialized under two cwds (a
 * persisted session's directory is fixed by its header, so normally one).
 */
export async function findSessionDirs(root: string, sessionId: string, fs: DeleteFs): Promise<string[]> {
  let projects
  try {
    projects = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return [] // absent root: nothing persisted at all
  }
  const hits: string[] = []
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectPath = join(root, project.name)
    let sessions
    try {
      sessions = await fs.readdir(projectPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (session.isDirectory() && session.name === sessionId) hits.push(join(projectPath, session.name))
    }
  }
  return hits
}

export interface DeletePersistedDeps {
  readonly persistence: SessionPersistenceLike
  readonly sessionId: string
  readonly fs: DeleteFs
  /** Fallback root when the backend exposes no config (`$DSH_HOME/sessions`). */
  readonly fallbackRoot: string
}

/** Refuse-or-delete. Every failure is a precise JSON-RPC error; success removes the directory. */
export async function deletePersistedSession(deps: DeletePersistedDeps): Promise<void> {
  const { persistence, sessionId, fs } = deps
  const stat = await persistence.stat(sessionId).catch((error: unknown) => {
    throw new RequestError(-32603, `session/delete could not inspect session ${sessionId}: ${messageOf(error)}`)
  })
  if (stat === undefined) {
    throw new RequestError(-32602, `unknown session: ${sessionId} (it has no persisted artifact)`)
  }
  try {
    const handle = await persistence.open(sessionId, 'write')
    await handle.close()
  } catch (error) {
    if (/AlreadyOwned|AlreadyExists/.test(errorNameOf(error))) {
      throw new RequestError(-32602, `session ${sessionId} is live in another process; close it there before deleting`)
    }
    throw new RequestError(-32603, `session/delete could not claim session ${sessionId}: ${messageOf(error)}`)
  }
  const root = persistence.config?.root ?? deps.fallbackRoot
  const dirs = await findSessionDirs(root, sessionId, fs)
  if (dirs.length === 0) {
    throw new RequestError(-32603, `session ${sessionId} is persisted but its artifact directory was not found under ${root}`)
  }
  for (const dir of dirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch((error: unknown) => {
      throw new RequestError(-32603, `failed to remove ${dir}: ${messageOf(error)}`)
    })
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorNameOf(error: unknown): string {
  return error instanceof Error ? error.name : String(error)
}
