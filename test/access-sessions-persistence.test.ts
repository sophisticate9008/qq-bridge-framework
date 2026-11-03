import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAccessSessionStore } from '../src/admin/access-sessions.ts'

const administrator = 'private-test-administrator-token'
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'qbf-access-sessions-'))
  return { directory, filename: join(directory, 'sessions.json'), dispose: () => rmSync(directory, { recursive: true, force: true }) }
}
test('access cookies survive a framework close, with hashes alone on disk and durable logout', () => {
  const setup = fixture()
  try {
    const options = { filename: setup.filename, ttlMs: 60_000 }
    const first = createAccessSessionStore(options)
    const cookie = first.issue(administrator)!
    const persisted = readFileSync(setup.filename, 'utf8')
    assert(!persisted.includes(cookie.token))
    assert(!persisted.includes(administrator))
    first.clear(false)
    assert.equal(createAccessSessionStore(options).authenticate(cookie.token, administrator), cookie.expiresAt)
    const reopened = createAccessSessionStore(options)
    assert.equal(reopened.revoke(cookie.token), true)
    assert.equal(createAccessSessionStore(options).authenticate(cookie.token, administrator), null)
  } finally { setup.dispose() }
})
test('administrator rotation and expiry invalidate persisted cookies', () => {
  const setup = fixture()
  try {
    let now = 1000
    const options = { filename: setup.filename, ttlMs: 100, clock: () => now }
    const store = createAccessSessionStore(options)
    const first = store.issue(administrator)!
    assert.equal(store.authenticate(first.token, administrator + '-new'), null)
    assert.equal(createAccessSessionStore(options).authenticate(first.token, administrator), null)
    const second = store.issue(administrator)!
    now += 101
    assert.equal(createAccessSessionStore(options).authenticate(second.token, administrator), null)
  } finally { setup.dispose() }
})
test('persistent sessions reject symlink storage and duplicate cookie hashes', { skip: process.platform === 'win32' }, () => {
  const setup = fixture()
  try {
    const target = join(setup.directory, 'target.json')
    writeFileSync(target, '{}', { mode: 0o600 })
    symlinkSync(target, setup.filename)
    assert.throws(() => createAccessSessionStore({ filename: setup.filename, ttlMs: 100 }))
    rmSync(setup.filename)
    const options = { filename: setup.filename, ttlMs: 100 }
    createAccessSessionStore(options).issue(administrator)
    const value: unknown = JSON.parse(readFileSync(setup.filename, 'utf8'))
    assert(value !== null && typeof value === 'object' && 'sessions' in value && Array.isArray(value.sessions))
    value.sessions.push(value.sessions[0])
    writeFileSync(setup.filename, JSON.stringify(value))
    assert.throws(() => createAccessSessionStore(options))
  } finally { setup.dispose() }
})
