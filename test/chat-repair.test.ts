import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChatRepairRoutes } from '../src/admin/chat-repair.ts'
import { AdminRequestError, type AdminRoute } from '../src/admin/server.ts'
import { parseChatRepairSnapshot, type ChatRepairOperation } from '../src/contracts/chat-repair.ts'
import { chatRepairProcessStart, createChatRepairStorage, projectChatRepair } from '../src/storage/chat-repair.ts'

const linux = { skip: process.platform !== 'linux' }
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'qbf-chat-repair-'))
  const routes = createChatRepairRoutes({ directory, configurationFilename: join(directory, 'admin.json'), serviceManager: join(directory, 'missing-manager') })
  const route = (method: 'GET' | 'POST', path = '/api/chat/repair') => routes.find(route => route.method === method && route.pathname === path)!
  const invoke = (route: AdminRoute, body: Record<string, unknown> | null, query = new URLSearchParams()) => route.handle({ body, query, signal: new AbortController().signal })
  return { directory, storage: createChatRepairStorage(directory), route, invoke, dispose: () => rm(directory, { recursive: true, force: true }) }
}
const operation = (patch: Partial<ChatRepairOperation> = {}): ChatRepairOperation => ({ id: randomUUID(), state: 'running', phase: 'checking', createdAt: Date.now(), updatedAt: Date.now(), reasons: [], ...patch })
const code = (expected: string) => (error: unknown) => error instanceof AdminRequestError && error.code === expected

test('repair reconciliation durably retires a request that never arrived, rejecting its delayed POST', linux, async () => {
  const setup = await fixture()
  try {
    const operationId = randomUUID()
    await assert.rejects(async () => setup.invoke(setup.route('POST', '/api/chat/repair/reconcile'), { operationId }), code('chat_repair_not_received'))
    await assert.rejects(async () => setup.invoke(setup.route('POST'), { operationId }), code('chat_repair_retired'))
    const saved = await setup.storage.read()
    assert.deepEqual(saved.value.retired, [operationId])
    assert.equal(saved.value.records.length, 0)
    // Retrying reconciliation does not duplicate the tombstone.
    await assert.rejects(async () => setup.invoke(setup.route('POST', '/api/chat/repair/reconcile'), { operationId }), code('chat_repair_not_received'))
    assert.deepEqual((await setup.storage.read()).value.retired, [operationId])
  } finally { await setup.dispose() }
})
test('accepted repair IDs and the active worker stay idempotent across a reopened route set', linux, async () => {
  const setup = await fixture()
  try {
    const current = operation()
    await setup.storage.modify(value => ({ ...value, records: [{ operation: current, worker: { pid: process.pid, started: null } }] }))
    const reused = parseChatRepairSnapshot(await setup.invoke(setup.route('POST'), { operationId: current.id }))
    assert.equal(reused?.operation?.id, current.id)
    assert.equal(reused?.operation?.state, 'running')
    const concurrent = parseChatRepairSnapshot(await setup.invoke(setup.route('POST'), { operationId: randomUUID() }))
    assert.equal(concurrent?.operation?.id, current.id)
    const confirmed = parseChatRepairSnapshot(await setup.invoke(setup.route('POST', '/api/chat/repair/reconcile'), { operationId: current.id }))
    assert.equal(confirmed?.operation?.state, 'running')
    assert.equal((await setup.storage.read()).value.records.length, 1)
  } finally { await setup.dispose() }
})
test('spawn failure is durable and another UI click can immediately retry with a new repair ID', linux, async () => {
  const setup = await fixture()
  try {
    const first = parseChatRepairSnapshot(await setup.invoke(setup.route('POST'), { operationId: randomUUID() }))
    assert.equal(first?.operation?.state, 'failed')
    assert.deepEqual(first?.operation?.reasons, ['chat_repair_worker_start_failed'])
    const next = parseChatRepairSnapshot(await setup.invoke(setup.route('POST'), { operationId: randomUUID() }))
    assert.equal(next?.operation?.state, 'failed')
    assert.equal((await setup.storage.read()).value.records.length, 2)
  } finally { await setup.dispose() }
})
test('dead workers and reused PIDs project interrupted instead of permanently running', linux, async () => {
  const current = operation()
  assert.equal((await projectChatRepair({ operation: current, worker: { pid: 1_000_000_000, started: null } })).state, 'failed')
  const started = await chatRepairProcessStart(process.pid)
  assert(started)
  assert.equal((await projectChatRepair({ operation: current, worker: { pid: process.pid, started: started + '0' } })).state, 'failed')
  assert.equal((await projectChatRepair({ operation: operation({ createdAt: Date.now() - 20_000 }), worker: null })).state, 'failed')
})
test('repair journal can recover its own dead PID writer lock without clearing unrelated runtime locks', linux, async () => {
  const setup = await fixture()
  try {
    const control = join(setup.directory, 'chat-repair-control')
    await mkdir(control, { mode: 0o700 })
    await writeFile(join(control, 'writer.lock'), JSON.stringify({ pid: 1_000_000_000, started: '1' }), { mode: 0o600 })
    const unrelated = join(setup.directory, '.chat-runtime.lock')
    await writeFile(unrelated, '', { mode: 0o600 })
    const current = operation({ state: 'failed' })
    await setup.storage.modify(value => ({ ...value, records: [{ operation: current, worker: null }] }))
    assert.equal((await setup.storage.read()).value.records[0]?.operation.id, current.id)
    assert.equal(await readFile(unrelated, 'utf8'), '')
  } finally { await setup.dispose() }
})
test('repair admission refuses shared accounts before accepting or spawning a worker', linux, async () => {
  const setup = await fixture()
  try {
    const routes = createChatRepairRoutes({ directory: setup.directory, configurationFilename: join(setup.directory, 'admin.json'), serviceManager: join(setup.directory, 'missing-manager'),
      async assertRepairScope() { throw new AdminRequestError(409, 'chat_repair_accounts_require_individual_recovery') } })
    await assert.rejects(async () => setup.invoke(routes.find(route => route.method === 'POST' && route.pathname === '/api/chat/repair')!, { operationId: randomUUID() }), code('chat_repair_accounts_require_individual_recovery'))
    assert.equal((await setup.storage.read()).value.records.length, 0)
  } finally { await setup.dispose() }
})

test('accepting a fresh repair seals a delayed unclaimed worker before it could start later', linux, async () => {
  const setup = await fixture()
  try {
    const delayed = operation({ createdAt: Date.now() - 20_000 })
    await setup.storage.modify(value => ({ ...value, records: [{ operation: delayed, worker: null }] }))
    await setup.invoke(setup.route('POST'), { operationId: randomUUID() })
    const journal = await setup.storage.read()
    assert.equal(journal.value.records.find(entry => entry.operation.id === delayed.id)?.operation.state, 'failed')
    assert.deepEqual(journal.value.records.find(entry => entry.operation.id === delayed.id)?.operation.reasons, ['chat_repair_worker_interrupted'])
  } finally { await setup.dispose() }
})

test('repair snapshots retain the exact application ID even after a newer repair is recorded', linux, async () => {
  const setup = await fixture()
  try {
    const completed = operation({ state: 'completed', phase: 'verifying' })
    const applicationId = randomUUID()
    await setup.storage.modify(value => ({ ...value, records: [{ operation: completed, applicationId, worker: null },
      { operation: operation({ state: 'failed' }), worker: null }] }))
    const snapshot = parseChatRepairSnapshot(await setup.invoke(setup.route('GET'), null, new URLSearchParams({ id: completed.id })))
    assert.equal(snapshot?.applicationId, applicationId)
    assert.equal(snapshot?.operation?.id, completed.id)
    assert.equal(parseChatRepairSnapshot({ schema: 1, available: true, applicationId: 'arbitrary', operation: completed }), null)
  } finally { await setup.dispose() }
})
