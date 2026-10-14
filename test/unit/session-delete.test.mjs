/**
 * session/delete's guarded filesystem cleanup: the depth-two directory scan
 * and the refuse-or-delete decision table (absent artifact, foreign write
 * claim, missing directory, successful removal).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findSessionDirs, deletePersistedSession } from '../../lib/session-delete.js'
import { RequestError } from '@agentclientprotocol/sdk'

/** An in-memory two-level tree: root/project/session directories. */
function fakeFs(tree) {
  return {
    async readdir(path, { withFileTypes }) {
      assert.equal(withFileTypes, true)
      const names = Object.keys(tree).filter((key) => {
        const slash = key.lastIndexOf('/')
        return (slash === -1 ? '' : key.slice(0, slash)) === path
      })
      return names.map((name) => {
        const base = name.slice(name.lastIndexOf('/') + 1)
        return { name: base, isDirectory: () => typeof tree[name] === 'object' }
      })
    },
    async rm(path, options) {
      assert.deepEqual(options, { recursive: true, force: true })
      delete tree[path]
    },
  }
}

function persistence(overrides = {}) {
  return {
    stat: async () => ({}),
    open: async () => ({ close: async () => {} }),
    config: { root: '/root' },
    ...overrides,
  }
}

test('findSessionDirs locates the artifact at exactly depth two', async () => {
  const fs = fakeFs({
    '/root': {},
    '/root/--home-user--': {},
    '/root/_no-cwd': {},
    '/root/--home-user--/nested': {},
    '/root/--home-user--/session-a': {},
    '/root/_no-cwd/session-a': {},
    '/root/--home-user--/session-b': {},
    '/root/--home-user--/nested/session-a': {}, // deeper than the layout: not an artifact
    '/root/loose-file': 'not a directory',
  })
  assert.deepEqual(await findSessionDirs('/root', 'session-a', fs), [
    '/root/--home-user--/session-a',
    '/root/_no-cwd/session-a',
  ])
  assert.deepEqual(await findSessionDirs('/missing', 'session-a', fs), [])
})

test('deletePersistedSession refuses unknown sessions', async () => {
  const deps = { persistence: persistence({ stat: async () => undefined }), sessionId: 'gone', fs: fakeFs({}), fallbackRoot: '/root' }
  await assert.rejects(deletePersistedSession(deps), (error) => {
    assert.ok(error instanceof RequestError)
    assert.equal(error.code, -32602)
    assert.match(error.message, /unknown session: gone/)
    return true
  })
})

test('deletePersistedSession refuses a session another process owns', async () => {
  const deps = {
    persistence: persistence({ open: async () => { throw Object.assign(new Error('owned'), { name: 'SessionAlreadyOwnedError' }) } }),
    sessionId: 'live',
    fs: fakeFs({ '/root/p/live': {} }),
    fallbackRoot: '/root',
  }
  await assert.rejects(deletePersistedSession(deps), (error) => {
    assert.equal(error.code, -32602)
    assert.match(error.message, /live in another process/)
    return true
  })
})

test('deletePersistedSession refuses when no artifact directory exists', async () => {
  const deps = { persistence: persistence(), sessionId: 'ghost', fs: fakeFs({ '/root/p/other': {} }), fallbackRoot: '/root' }
  await assert.rejects(deletePersistedSession(deps), (error) => {
    assert.equal(error.code, -32603)
    assert.match(error.message, /artifact directory was not found/)
    return true
  })
})

test('deletePersistedSession falls back to $DSH_HOME/sessions when the backend hides its config', async () => {
  const tree = {
    '/home/.dsh/sessions': {},
    '/home/.dsh/sessions/p': {},
    '/home/.dsh/sessions/p/session-x': {},
  }
  const fs = fakeFs(tree)
  const deps = { persistence: persistence({ config: undefined }), sessionId: 'session-x', fs, fallbackRoot: '/home/.dsh/sessions' }
  await deletePersistedSession(deps)
  assert.equal('/home/.dsh/sessions/p/session-x' in tree, false, 'the artifact directory was removed')
})

test('deletePersistedSession claims write ownership and removes the directory', async () => {
  const tree = { '/root/p': {}, '/root/p/session-x': {}, '/root/p/session-x/keep': {} }
  let opened = 0
  let closed = 0
  const deps = {
    persistence: persistence({
      open: async (id, access) => {
        assert.equal(id, 'session-x')
        assert.equal(access, 'write')
        opened += 1
        return { close: async () => { closed += 1 } }
      },
    }),
    sessionId: 'session-x',
    fs: fakeFs(tree),
    fallbackRoot: '/root',
  }
  await deletePersistedSession(deps)
  assert.equal(opened, 1)
  assert.equal(closed, 1, 'the probe handle is released before removal')
  assert.equal('/root/p/session-x' in tree, false)
})
