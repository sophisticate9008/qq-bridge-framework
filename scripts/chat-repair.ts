import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readFile, readdir, realpath, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { loadGatewayAdminConfiguration, gatewayAdminAddress } from '../src/admin/gateway.ts'
import { NativeConfigurationRepository, readNativeChatConfigurationUnlocked } from '../src/admin/native-configuration-repository.ts'
import { createNativeDshDeploymentRuntime } from '../src/host/native-dsh-deployment.ts'
import { discoverLocalDshDeployment } from '../src/host/local-dsh-deployment.ts'
import { resolveLocalDshModelSettings } from '../src/host/local-dsh-model-settings.ts'
import { nativeApplicationRequiresReconciliation, parseNativeApplicationEnvelope } from '../src/contracts/native-application.ts'
import { isNativeConfigurationRevisions } from '../src/contracts/native-revisions.ts'
import { parseNativeAccountRegistry } from '../src/contracts/native-accounts.ts'
import { isRecord } from '../src/contracts/values.ts'
import { parseChatHealth } from '../src/contracts/chat-health.ts'
import type { ChatRepairOperation } from '../src/contracts/chat-repair.ts'
import { createChatRepairStorage, chatRepairProcessStart, chatRepairProcessAlive, chatRepairWorkerAlive } from '../src/storage/chat-repair.ts'
import { createNativeApplicationStorage } from '../src/storage/native-application.ts'
import { createNativeDshRestartStorage } from '../src/storage/native-dsh-restart.ts'
import { nativeRuntimeIsQuiescent } from '../src/contracts/native-runtime-quiescence.ts'
import { ensurePrivateDirectory, readDocument } from '../src/storage/private-json.ts'
import { privatePermissions } from '../src/storage/file-security.ts'

interface RepairPorts {
  readonly dshHome: string
  ensureDsh(): Promise<void>
  guardian(): Promise<void>
  stop(): Promise<void>
  start(): Promise<void>
}
function fail(code: string): never { throw Object.assign(new Error('Chat repair did not complete.'), { code }) }
const pause = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve() }, 1000)
  const aborted = () => { clearTimeout(timer); reject(signal.reason) }
  if (signal.aborted) aborted()
  else signal.addEventListener('abort', aborted, { once: true })
})
async function backup(filename: string, value: unknown): Promise<void> {
  const handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync() } finally { await handle.close() }
  const directory = await open(dirname(filename), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await directory.sync() } finally { await directory.close() }
}
async function openPrivateLock(filename: string) {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const metadata = await handle.stat()
    const path = await lstat(filename)
    if (!metadata.isFile() || path.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > 128
      || metadata.dev !== path.dev || metadata.ino !== path.ino || !privatePermissions(filename, metadata, 0o600)
      || process.getuid && metadata.uid !== process.getuid()) fail('chat_repair_lock_unverified')
    return { handle, metadata }
  } catch (error) { await handle.close(); throw error }
}
async function removeSameLock(filename: string, metadata: { readonly ino: number; readonly dev: number; readonly mtimeMs: number }) {
  const current = await lstat(filename)
  if (current.ino !== metadata.ino || current.dev !== metadata.dev || current.mtimeMs !== metadata.mtimeMs) fail('chat_repair_lock_changed')
  await unlink(filename)
}

async function assertNoLockHolders(metadata: { readonly dev: number; readonly ino: number }): Promise<void> {
  const processes = (await readdir('/proc')).filter(name => /^\d+$/.test(name) && Number(name) !== process.pid)
  if (processes.length > 4096) fail('chat_repair_lock_owners_unverified')
  const inspectionFailures: { readonly pid: number; readonly stage: string; readonly code: string }[] = []
  const gone = (error: unknown) => isRecord(error) && ['ENOENT', 'ESRCH'].includes(String(error.code))
  const remember = (pid: string, stage: string, error: unknown) => {
    if (inspectionFailures.length >= 8) return
    const code = isRecord(error) && typeof error.code === 'string' && /^[A-Z0-9_]{1,48}$/.test(error.code) ? error.code : 'UNKNOWN'
    inspectionFailures.push({ pid: Number(pid), stage, code })
  }
  for (const pid of processes) {
    let stage = 'identity'
    try {
      const processDirectory = await stat(`/proc/${pid}`)
      if (process.getuid && processDirectory.uid !== process.getuid()) {
        // Linux changes /proc ownership for a non-dumpable process. Its real UID can still own this lock.
        const status = await readFile(`/proc/${pid}/status`, 'utf8')
        const uids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m.exec(status)
        if (!uids) throw new Error('Process ownership unavailable')
        if (!uids.slice(1).some(uid => Number(uid) === process.getuid!())) continue
      }
      stage = 'fd-list'
      const descriptors = await readdir(`/proc/${pid}/fd`)
      if (descriptors.length > 4096) { remember(pid, stage, { code: 'LIMIT' }); continue }
      stage = 'fd-identity'
      for (const descriptor of descriptors) {
        let file: Awaited<ReturnType<typeof stat>>
        try { file = await stat(`/proc/${pid}/fd/${descriptor}`) }
        catch (error) { if (!gone(error)) remember(pid, stage, error); continue }
        if (file.dev === metadata.dev && file.ino === metadata.ino) fail('chat_repair_writer_still_running')
      }
    } catch (error) {
      if (gone(error)) continue
      if (isRecord(error) && error.code === 'chat_repair_writer_still_running') throw error
      remember(pid, stage, error)
    }
  }
  if (inspectionFailures.length) throw Object.assign(new Error('Lock ownership could not be fully inspected.'), {
    code: 'chat_repair_lock_owners_unverified', inspectionFailures })
}

/** Only call after every managed host was proved stopped. Empty leases are still protected if any process holds them. */
export async function retireStoppedFrameworkLocks(directory: string, backups: string): Promise<void> {
  for (const name of ['.chat-runtime.lock', '.native-chat-lifecycle.lock', '.native-chat-runtime.lock']) {
    const filename = join(directory, name)
    let opened: Awaited<ReturnType<typeof openPrivateLock>>
    try { opened = await openPrivateLock(filename) }
    catch (error) { if (isRecord(error) && error.code === 'ENOENT') continue; throw error }
    try {
      if (opened.metadata.size !== 0) fail('chat_repair_lock_unverified')
      await assertNoLockHolders(opened.metadata)
      await backup(join(backups, `${name}.json`), { name, dev: opened.metadata.dev, ino: opened.metadata.ino, mtimeMs: opened.metadata.mtimeMs, size: 0 })
      await removeSameLock(filename, opened.metadata)
    } finally { await opened.handle.close() }
  }
}

/** Only call after all managed hosts stopped. Unknown owners retain their locks. */
export async function retireStoppedDshWriterLock(filename: string, backups: string): Promise<void> {
  let opened: Awaited<ReturnType<typeof openPrivateLock>>
  try { opened = await openPrivateLock(filename) }
  catch (error) { if (isRecord(error) && error.code === 'ENOENT') return; throw error }
  try {
    const content = await opened.handle.readFile('utf8')
    if (!content) {
      await assertNoLockHolders(opened.metadata)
      await backup(join(backups, `writer-lock-${randomUUID()}.json`), { empty: true, ino: opened.metadata.ino, dev: opened.metadata.dev })
      await removeSameLock(filename, opened.metadata)
      return
    }
    if (!/^[1-9]\d*\n?$/.test(content) || !Number.isSafeInteger(Number(content.trim()))) fail('chat_repair_lock_unverified')
    let alive = true
    try { process.kill(Number(content.trim()), 0); await chatRepairProcessStart(Number(content.trim())) }
    catch (error) { if (isRecord(error) && ['ESRCH', 'ENOENT'].includes(String(error.code))) alive = false }
    if (alive) fail('chat_repair_writer_still_running')
    await backup(join(backups, `writer-lock-${randomUUID()}.json`), { pid: Number(content.trim()), ino: opened.metadata.ino, dev: opened.metadata.dev })
    await removeSameLock(filename, opened.metadata)
  } finally { await opened.handle.close() }
}

/** Runs outside the framework, without resetting business executions, conversations or model requests. */
export async function runChatRepair(configurationFilename: string, operationId: string, ports: RepairPorts): Promise<void> {
  const admin = loadGatewayAdminConfiguration(configurationFilename)
  const directory = join(dirname(admin.tokenFile), 'runtime')
  const storage = createChatRepairStorage(directory)
  const worker = { pid: process.pid, started: await chatRepairProcessStart(process.pid) }
  let claimed = false
  await storage.modify(async journal => {
    const record = journal.records.find(entry => entry.operation.id === operationId)
    if (!record || record.operation.state !== 'running' || record.worker && await chatRepairWorkerAlive(record)) return journal
    claimed = true
    return { ...journal, records: journal.records.map(entry => entry === record ? { ...entry, worker } : entry) }
  })
  if (!claimed) return
  async function update(patch: Partial<ChatRepairOperation>, applicationId?: string) {
    await storage.modify(journal => {
      const owned = journal.records.find(entry => entry.operation.id === operationId)
      if (owned?.worker?.pid !== worker.pid || owned.worker.started !== worker.started) fail('chat_repair_ownership_changed')
      return { ...journal, records: journal.records.map(entry => entry === owned
        ? { ...entry, ...(applicationId ? { applicationId } : {}), operation: { ...entry.operation, ...patch, updatedAt: Date.now() } } : entry) }
    })
  }
  const signal = AbortSignal.timeout(600_000)
  const repository = new NativeConfigurationRepository(directory)
  const base = gatewayAdminAddress(admin)
  const backups = join(directory, 'chat-repair-backups', operationId)
  let stopAttempted = false
  let servicesRestored = false
  let token = ''
  async function call(path: string, body?: unknown): Promise<unknown> {
    signal.throwIfAborted()
    const response = await fetch(new URL(path, base), { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json', origin: new URL(base).origin }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([signal, AbortSignal.timeout(65_000)]) })
    const value: unknown = await response.json()
    if (!response.ok) fail(isRecord(value) && typeof value.error === 'string' ? value.error : 'chat_repair_request_failed')
    return value
  }
  async function readWhenAvailable(path: string): Promise<unknown> {
    while (true) {
      try { return await call(path) }
      catch (error) {
        signal.throwIfAborted()
        if (isRecord(error) && typeof error.code === 'string') throw error
        await pause(signal)
      }
    }
  }
  async function assertSingleAccount() {
    const registry = await readDocument(join(directory, 'native-accounts.json'), { schema: 1 as const, accounts: [] }, value => {
      const parsed = parseNativeAccountRegistry(value)
      if (!parsed) fail('chat_repair_account_registry_invalid')
      return parsed
    })
    if (registry.value.accounts.length > 0) fail('chat_repair_accounts_require_individual_recovery')
  }
  try {
    if (process.platform !== 'linux') fail('chat_repair_platform_unavailable')
    token = (await readFile(admin.tokenFile, 'utf8')).trim()
    if (token.length < 24) fail('chat_repair_authentication_unavailable')
    await update({ phase: 'checking' })
    await assertSingleAccount()
    const configuration = await readNativeChatConfigurationUnlocked(directory)
    const adapter = configuration.adapters.dshAgent
    if (!adapter.enabled || !adapter.localCredentialsPath || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(adapter.endpoint).hostname)) fail('chat_repair_local_dsh_required')
    if (await realpath(adapter.localCredentialsPath) !== await realpath(join(ports.dshHome, '.credentials.yaml'))) fail('chat_repair_dsh_target_mismatch')
    // Only start DSH, preserving any working chat. Preflight capabilities require its authenticated API even after an outage.
    await ports.ensureDsh()
    signal.throwIfAborted()
    const target = await discoverLocalDshDeployment({ endpoint: adapter.endpoint, localCredentialsPath: adapter.localCredentialsPath, signal })
    if (await realpath(target.credentialsPath) !== await realpath(adapter.localCredentialsPath)) fail('chat_repair_dsh_target_mismatch')
    const resolved = await resolveLocalDshModelSettings(configuration, target, signal, directory)
    const prepared = await createNativeDshDeploymentRuntime({ sessionDirectory: directory }).prepare({ ...configuration,
      deployment: { ...configuration.deployment, target, modelSettings: resolved.modelSettings } })
    if (prepared.state !== 'prepared') fail(prepared.missingReasons[0] ?? 'chat_repair_configuration_missing')
    if (!isDeepStrictEqual((await readNativeChatConfigurationUnlocked(directory)).revisions, configuration.revisions)) fail('chat_repair_configuration_changed')
    await assertSingleAccount()
    await ensurePrivateDirectory(join(directory, 'chat-repair-backups'))
    await ensurePrivateDirectory(backups)
    const intent = await repository.readRunningIntent()
    await backup(join(backups, 'running-intent.json'), intent.value)
    await ports.guardian()
    // The separate guardian loads and validates the installed host before registering.
    // Cold startup must fit within the handshake without relaxing the live identity check.
    const guardianDeadline = Date.now() + 60_000
    while (true) {
      const guarded = (await storage.read()).value.records.find(entry => entry.operation.id === operationId)
      if (guarded?.guardian && guarded.guardianRecoveryComplete !== true && await chatRepairProcessAlive(guarded.guardian)) break
      if (Date.now() >= guardianDeadline) fail('chat_repair_guardian_unavailable')
      await pause(signal)
    }
    await update({ phase: 'stopping' })
    // This flag precedes the call: stop may have stopped the UI before another component fails.
    stopAttempted = true
    await ports.stop()
    signal.throwIfAborted()
    await retireStoppedFrameworkLocks(directory, backups)
    // Preserve original IDs, versions and phases in durable backups before interrupting only these configuration controllers.
    const applications = createNativeApplicationStorage(directory)
    const journal = await applications.read()
    if (journal.value.records.some(entry => nativeApplicationRequiresReconciliation(entry.snapshot))) {
      await backup(join(backups, 'applications.json'), journal.value)
      await applications.write(journal.revision, { ...journal.value, records: journal.value.records.map(entry =>
        nativeApplicationRequiresReconciliation(entry.snapshot) ? { ...entry, snapshot: { ...entry.snapshot, state: 'blocked' as const,
          reasons: ['application_interrupted_by_chat_repair'], updatedAt: Date.now() } } : entry) })
    }
    const restarts = createNativeDshRestartStorage(directory)
    const maintenance = await restarts.read()
    if (maintenance.value.records.some(entry => ['running', 'unknown'].includes(entry.operation.state))) {
      await backup(join(backups, 'dsh-restarts.json'), maintenance.value)
      await restarts.write(maintenance.revision, { ...maintenance.value, records: maintenance.value.records.map(entry =>
        ['running', 'unknown'].includes(entry.operation.state) ? { ...entry, operation: { ...entry.operation, state: 'blocked' as const,
          reasons: ['dsh_restart_interrupted_by_chat_repair'], updatedAt: Date.now() } } : entry) })
    }
    for (const filename of [...new Set([`${join(dirname(target.profilePath), 'package.json')}.lock`, `${target.credentialsPath}.lock`])]) {
      await retireStoppedDshWriterLock(filename, backups)
    }
    await repository.clearRunningIntent()
    await update({ phase: 'starting-services' })
    await ports.start()
    servicesRestored = true
    let runtime: Record<string, unknown>
    while (true) {
      const value = await readWhenAvailable('/api/chat/runtime')
      if (!isRecord(value)) fail('chat_repair_runtime_invalid')
      runtime = value
      if (nativeRuntimeIsQuiescent(value)) break
      await pause(signal)
    }
    if (!isNativeConfigurationRevisions(runtime.revisions)) fail('chat_repair_runtime_invalid')
    const applicationId = randomUUID()
    await update({ phase: 'applying' }, applicationId)
    let result: unknown
    try { result = await call('/api/chat/application', { operationId: applicationId, revisions: runtime.revisions, deploy: true }) }
    catch {
      // A lost response never causes a second apply. Query the original durable operation.
      result = await readWhenAvailable(`/api/chat/application?id=${encodeURIComponent(applicationId)}`)
    }
    let envelope = parseNativeApplicationEnvelope(result)
    if (!envelope?.operation || envelope.operation.id !== applicationId) fail('chat_repair_application_unknown')
    while (envelope.operation.state === 'running') {
      await update({ phase: envelope.operation.phase === 'start' ? 'starting-chat' : 'applying' })
      await pause(signal)
      envelope = parseNativeApplicationEnvelope(await readWhenAvailable(`/api/chat/application?id=${encodeURIComponent(applicationId)}`))
      if (!envelope?.operation || envelope.operation.id !== applicationId) fail('chat_repair_application_unknown')
    }
    if (envelope.operation.state !== 'completed') fail(envelope.operation.reasons[0] ?? 'chat_repair_application_failed')
    await update({ phase: 'verifying' })
    const verificationDeadline = Date.now() + 30_000
    while (true) {
      const current = await readWhenAvailable('/api/chat/runtime')
      const health = parseChatHealth(await readWhenAvailable('/api/chat/health'))
      if (isRecord(current) && current.state === 'running' && current.chatReady === true && health?.healthy) break
      if (Date.now() >= verificationDeadline) {
        if (health?.layers.some(layer => ['receive', 'send'].includes(layer.id) && !['ready', 'idle'].includes(layer.state))) fail('chat_repair_protocol_unavailable')
        fail('chat_repair_chat_not_ready')
      }
      await pause(signal)
    }
    await update({ state: 'completed', phase: 'verifying', reasons: [] })
  } catch (error) {
    const reasons: string[] = [isRecord(error) && typeof error.code === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(error.code)
      ? error.code : signal.aborted ? 'chat_repair_timeout' : 'chat_repair_failed']
    // Independent of the workflow timeout, a partial stop still gets one bounded UI restoration attempt.
    if (stopAttempted && !servicesRestored) {
      try { await ports.start() } catch { reasons.push('chat_repair_services_not_restored') }
    }
    await update({ state: 'failed', reasons })
  }
}
