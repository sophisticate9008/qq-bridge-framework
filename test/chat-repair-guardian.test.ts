import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { retireStoppedDshWriterLock } from '../scripts/chat-repair.ts'
import { runChatRepairGuardian } from '../scripts/chat-repair-guardian.ts'
import { chatRepairProcessStart, createChatRepairStorage } from '../src/storage/chat-repair.ts'

const extension = import.meta.url.endsWith('.js') ? 'js' : 'ts'
const fixtureScript = fileURLToPath(new URL(`./fixtures/chat-repair-guardian-fixture.${extension}`, import.meta.url))
const linux = { skip: process.platform !== 'linux' }
async function waitFor(check: () => Promise<boolean>) {
  for (let step = 0; step < 250; step++) { if (await check()) return; await new Promise<void>(resolve => setTimeout(resolve, 20)) }
  throw new Error('Isolated repair fixture timed out')
}
async function kill(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
}
test('a real worker abrupt death restores an isolated admin, retains failure, and permits another UI request', linux, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qbf-guardian-death-'))
  const storage = createChatRepairStorage(directory)
  const id = randomUUID()
  let worker: ChildProcess | undefined
  let guardian: ChildProcess | undefined
  let adminPid: number | undefined
  try {
    await writeFile(join(directory, 'business-unknown.json'), '{"execution":"unknown","sent":"unknown"}', { mode: 0o600 })
    worker = spawn(process.execPath, [fixtureScript, 'worker', directory, id], { stdio: ['ignore', 'pipe', 'inherit'] })
    await once(worker.stdout!, 'data')
    assert(worker.pid)
    const at = Date.now()
    await storage.modify(async journal => ({ ...journal, records: [{ operation: { id, state: 'running', phase: 'stopping', createdAt: at, updatedAt: at, reasons: [] },
      worker: { pid: worker!.pid!, started: await chatRepairProcessStart(worker!.pid!) } }] }))
    guardian = spawn(process.execPath, [fixtureScript, 'guardian', directory, id], { stdio: 'inherit', detached: true })
    await waitFor(async () => Boolean((await storage.read()).value.records[0]?.guardian))
    const guardianExited = once(guardian, 'exit')
    await kill(worker)
    const [exitCode] = await guardianExited
    assert.equal(exitCode, 0)
    const saved = (await storage.read()).value.records[0]!
    assert.equal(saved.operation.state, 'failed')
    assert.equal(saved.guardianRecoveryComplete, true)
    assert.equal(saved.rescueAttempts, 1)
    assert(saved.operation.reasons.includes('chat_repair_worker_interrupted'))
    const address: unknown = JSON.parse(await readFile(join(directory, 'admin-address.json'), 'utf8'))
    assert(address && typeof address === 'object' && 'url' in address && typeof address.url === 'string' && 'pid' in address && typeof address.pid === 'number')
    adminPid = address.pid
    const headers = { authorization: 'Bearer isolated-guardian-fixture-administrator', origin: address.url, 'content-type': 'application/json' }
    const observed = await fetch(`${address.url}/api/chat/repair?id=${id}`, { headers })
    assert.equal(observed.status, 200)
    await observed.body?.cancel()
    const retry = await fetch(`${address.url}/api/chat/repair`, { method: 'POST', headers, body: JSON.stringify({ operationId: randomUUID() }) })
    assert.equal(retry.status, 200)
    const retried: unknown = await retry.json()
    assert(retried && typeof retried === 'object' && 'operation' in retried && retried.operation && typeof retried.operation === 'object' && 'state' in retried.operation)
    assert.equal(retried.operation.state, 'failed')
    assert.equal((await storage.read()).value.records.length, 2)
    assert.deepEqual((await readFile(join(directory, 'effects.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)), [{ action: 'start-managed-services' }])
    assert(!(await readFile(join(directory, 'http-effects.jsonl'), 'utf8')).includes('/application'))
    assert.equal(await readFile(join(directory, 'business-unknown.json'), 'utf8'), '{"execution":"unknown","sent":"unknown"}')
  } finally {
    if (adminPid) { try { process.kill(adminPid, 'SIGKILL') } catch { /* Fixture already exited. */ } }
    await kill(worker); await kill(guardian)
    await rm(directory, { recursive: true, force: true })
  }
})
test('guardian startup failures consume at most two rescue attempts and never mark chat completed', linux, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qbf-guardian-limit-'))
  try {
    const storage = createChatRepairStorage(directory)
    const id = randomUUID(), at = Date.now()
    await storage.modify(journal => ({ ...journal, records: [{ operation: { id, state: 'failed', phase: 'stopping', createdAt: at, updatedAt: at, reasons: ['chat_repair_stop_failed'] }, worker: { pid: 1_000_000_000, started: '1' } }] }))
    let attempts = 0
    await runChatRepairGuardian({ directory, operationId: id, pollMs: 1 }, { async ready() { return false }, async start() { attempts++; throw new Error('fixture unavailable') } })
    assert.equal(attempts, 2)
    const saved = (await storage.read()).value.records[0]!
    assert.equal(saved.operation.state, 'failed')
    assert(saved.operation.reasons.includes('chat_repair_services_not_restored'))
    assert.equal(saved.guardianRecoveryComplete, true)
    assert.equal(saved.rescueAttempts, 2)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('stopped-only profile lock recovery retains live holders and recovers an empty orphan', linux, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qbf-profile-empty-lock-'))
  const filename = join(directory, 'writer.lock'), backups = join(directory, 'backups')
  let holder: ChildProcess | undefined
  try {
    await mkdir(backups, { mode: 0o700 })
    await writeFile(filename, '', { mode: 0o600 })
    holder = spawn(process.execPath, [fixtureScript, 'writer', directory, randomUUID()], { stdio: ['ignore', 'pipe', 'inherit'] })
    await once(holder.stdout!, 'data')
    await assert.rejects(retireStoppedDshWriterLock(filename, backups), error => error instanceof Error && 'code' in error && error.code === 'chat_repair_writer_still_running')
    await access(filename)
    await kill(holder)
    await retireStoppedDshWriterLock(filename, backups)
    await assert.rejects(access(filename), error => error instanceof Error && 'code' in error && error.code === 'ENOENT')
    assert.equal((await readdir(backups)).length, 1)
  } finally { await kill(holder); await rm(directory, { recursive: true, force: true }) }
})
test('a real unreaped zombie PID does not permanently retain a profile writer lock', linux, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qbf-profile-zombie-lock-'))
  const filename = join(directory, 'writer.lock'), backups = join(directory, 'backups')
  let parent: ChildProcess | undefined
  try {
    await mkdir(backups, { mode: 0o700 })
    parent = spawn('python3', ['-c', 'import os,sys\npid=os.fork()\nif pid==0: os._exit(0)\nprint(pid,flush=True)\nsys.stdin.readline()\nos.waitpid(pid,0)'], { stdio: ['pipe', 'pipe', 'inherit'] })
    const [output] = await once(parent.stdout!, 'data')
    const zombie = Number(String(output).trim())
    assert(Number.isSafeInteger(zombie) && zombie > 0)
    await waitFor(async () => (await readFile(`/proc/${zombie}/stat`, 'utf8')).split(') ')[1]?.startsWith('Z ') === true)
    await writeFile(filename, `${zombie}\n`, { mode: 0o600 })
    await retireStoppedDshWriterLock(filename, backups)
    await assert.rejects(access(filename), error => error instanceof Error && 'code' in error && error.code === 'ENOENT')
    const exited = once(parent, 'exit')
    parent.stdin!.end('reap\n')
    await exited
  } finally {
    if (parent?.stdin && !parent.stdin.writableEnded) parent.stdin.end('reap\n')
    await kill(parent)
    await rm(directory, { recursive: true, force: true })
  }
})
