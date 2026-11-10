import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, isAbsolute } from 'node:path'
import { EMPTY_EXTENSION_REGISTRY, parseExtensionRegistry, type ExtensionRegistry, type ManagedExtension, type ExtensionOperation } from '../contracts/managed-extensions.ts'
import { FrameworkError } from '../core/values.ts'
import { ensurePrivateDirectory, readPrivateJson, replacePrivateJson } from '../storage/private-json.ts'
import { acquireProcessFileLock } from '../storage/process-file-lock.ts'

export const extensionStore = (configuration: string) => join(dirname(resolve(configuration)), 'extensions')
export const extensionRegistryFile = (configuration: string) => `${resolve(configuration)}.extensions.json`
export function extensionSetRevision(items: readonly ManagedExtension[]): string {
  return createHash('sha256').update(JSON.stringify(items)).digest('hex')
}
function validate(value: unknown): ExtensionRegistry {
  const registry = parseExtensionRegistry(value)
  if (!registry || [...registry.items, ...(registry.operation?.before ?? []), ...(registry.operation?.after ?? [])].some(item => !isAbsolute(item.directory))) throw new FrameworkError('EXTENSION_REGISTRY_INVALID', '扩展安装记录无效。')
  return registry
}
export async function readExtensionRegistry(configuration: string) {
  return readPrivateJson(extensionRegistryFile(configuration),{maxBytes:1048576,validate,fallback:{value:EMPTY_EXTENSION_REGISTRY},exactMode:0o600,
    requireSingleLink:true,invalidCode:'EXTENSION_REGISTRY_INVALID',conflictCode:'EXTENSION_REGISTRY_CHANGED'})
}
export function extensionOperationPending(registry: ExtensionRegistry): boolean {
  return registry.operation !== null && !['completed','rolled-back'].includes(registry.operation.phase)
}
export function createExtensionRegistry(configuration: string) {
  async function write(expected: string, value: ExtensionRegistry) {
    validate(value)
    const directory=dirname(resolve(configuration)), content=Buffer.from(JSON.stringify(value)+'\n')
    if(content.length>1048576)throw new FrameworkError('EXTENSION_REGISTRY_LIMIT','扩展安装记录超过容量。')
    return replacePrivateJson({directory,filename:extensionRegistryFile(configuration),expectedRevision:expected,content,
      temporary:join(directory,`.extensions-${randomUUID()}.tmp`),read:()=>readExtensionRegistry(configuration),verifyTemporaryMetadata:true,
      directoryOpenFlags:constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW,conflictCode:'EXTENSION_REGISTRY_CHANGED',
      writeFailedCode:'EXTENSION_REGISTRY_WRITE_FAILED',writeUnknownCode:'EXTENSION_REGISTRY_WRITE_UNKNOWN'})
  }
  return {
    read: () => readExtensionRegistry(configuration), write,
    async lock() { const directory = extensionStore(configuration); await ensurePrivateDirectory(directory); return acquireProcessFileLock(directory, 'operation.lock') },
    async stage(items: readonly ManagedExtension[]) {
      const current = await readExtensionRegistry(configuration)
      if (extensionOperationPending(current.value)) throw new FrameworkError('EXTENSION_OPERATION_PENDING', '请用原操作编号核对或应用待完成的扩展操作。')
      if(current.value.operation) {
        const directory=join(extensionStore(configuration),'history');await ensurePrivateDirectory(directory)
        const filename=join(directory,`${current.value.operation.id}.json`),text=JSON.stringify(current.value.operation)+'\n'
        await writeFile(filename,text,{mode:0o600,flag:'wx'}).catch(async error=>{
          if(!(error instanceof Error&&'code' in error&&error.code==='EEXIST')||await readFile(filename,'utf8')!==text)throw error
        })
      }
      const operation = { id: randomUUID(), phase: 'prepared' as const, before: current.value.items, after: items, error: null }
      return write(current.revision, { schema: 1, items, operation })
    },
  }
}

export async function readExtensionOperation(configuration:string,id:string):Promise<ExtensionOperation|null> {
  if(!/^[a-f0-9-]{36}$/.test(id))throw new FrameworkError('EXTENSION_OPERATION_INVALID','扩展操作编号无效。')
  const current=await readExtensionRegistry(configuration)
  if(current.value.operation?.id===id)return current.value.operation
  const saved=await readPrivateJson(join(extensionStore(configuration),'history',`${id}.json`),{maxBytes:1048576,exactMode:0o600,requireSingleLink:true,
    fallback:{value:null as ExtensionOperation|null},invalidCode:'EXTENSION_OPERATION_INVALID',conflictCode:'EXTENSION_OPERATION_CHANGED',
    validate(value){
      if(value===null)return null
      const parsed=parseExtensionRegistry({schema:1,items:[],operation:value})
      if(!parsed?.operation)throw new FrameworkError('EXTENSION_OPERATION_INVALID','扩展操作记录无效。')
      return parsed.operation
    }})
  return saved.value
}

export interface ExtensionObservation {
  readonly operationId?: string | null
  readonly registryRevision: string
  readonly running: boolean
  readonly packages: readonly { readonly id: string; readonly state: string; readonly toolNames: readonly string[] }[]
  readonly tools: readonly string[]
  readonly services: readonly { readonly owner: string; readonly state: string }[]
}
export function extensionObservationMatches(items: readonly ManagedExtension[], observation: ExtensionObservation): boolean {
  return observation.running && observation.registryRevision === extensionSetRevision(items)
    && items.filter(item => item.enabled).every(item => item.packages.every(id => {
      const loaded = observation.packages.find(candidate => candidate.id === id)
      const registered = observation.tools.filter(name=>name.startsWith(`extension.${id}.`))
      return loaded?.state === 'running' && loaded.toolNames.length === registered.length && loaded.toolNames.every(name => registered.includes(name))
    }) && observation.services.filter(service=>item.packages.includes(service.owner)).every(service=>service.state==='ready'))
}

/** Persist each restart intent before invoking it. Unknown operations are reconciled by observation only. */
export async function applyExtensionOperation(configuration: string, ports: {
  restart(): Promise<'confirmed' | 'unknown'>
  observe(): Promise<ExtensionObservation>
}, operationId?: string, reconcileOnly = false) {
  const store = createExtensionRegistry(configuration), release = await store.lock()
  try {
    let document = await store.read()
    let op = document.value.operation
    if(operationId&&op?.id!==operationId) {
      const historical=await readExtensionOperation(configuration,operationId)
      if(historical&&['completed','rolled-back'].includes(historical.phase))return historical
    }
    if (!op || operationId !== undefined && op.id !== operationId) throw new FrameworkError('EXTENSION_OPERATION_NOT_FOUND', '找不到原扩展操作。')
    const save = async (phase: ExtensionOperation['phase'], items: readonly ManagedExtension[], error: string | null = null) => {
      if (!op) throw new Error('EXTENSION_OPERATION_NOT_FOUND')
      op = { ...op, phase, error }; document = await store.write(document.revision, { schema: 1, items, operation: op })
    }
    if (['completed','rolled-back'].includes(op.phase)) return op
    if (op.phase !== 'prepared' || reconcileOnly) {
      const observation = await ports.observe()
      if(op.phase==='prepared'&&extensionObservationMatches(op.before,observation)&&!extensionObservationMatches(op.after,observation))return op
      if(observation.operationId!==op.id)throw new FrameworkError('EXTENSION_OPERATION_UNKNOWN','尚未取得加载过原操作的宿主证据；保留操作编号，只读核对，不重复重启。')
      const restoring = op.phase === 'restoring' || op.error === 'EXTENSION_ROLLBACK_UNKNOWN'
      if (!restoring && extensionObservationMatches(op.after, observation)) await save('completed', op.after)
      else if (extensionObservationMatches(op.before, observation)) await save('rolled-back', op.before)
      else throw new FrameworkError('EXTENSION_OPERATION_UNKNOWN', '扩展应用结果尚未确认；请保留原操作编号核对，不重复重启。')
      return op
    }
    await save('applying', op.after)
    let restarted: 'confirmed' | 'unknown'
    try { restarted = await ports.restart() } catch { restarted = 'unknown' }
    if (restarted === 'unknown') { await save('unknown',op.after,'EXTENSION_RESTART_UNKNOWN'); return op }
    let observation: ExtensionObservation
    try { observation = await ports.observe() }
    catch { await save('unknown',op.after,'EXTENSION_OBSERVATION_UNKNOWN'); return op }
    if (extensionObservationMatches(op.after,observation)) { await save('completed',op.after); return op }
    if (extensionObservationMatches(op.before,observation)) { await save('rolled-back',op.before,'EXTENSION_APPLY_FAILED'); return op }
    if (observation.registryRevision !== extensionSetRevision(op.after)) {
      await save('unknown',op.after,'EXTENSION_RUNTIME_IDENTITY_UNKNOWN'); return op
    }
    try {
      await save('restoring', op.before, 'EXTENSION_APPLY_FAILED')
      if (await ports.restart() !== 'confirmed' || !extensionObservationMatches(op.before, await ports.observe())) throw new Error('EXTENSION_ROLLBACK_NOT_VERIFIED')
      await save('rolled-back', op.before, 'EXTENSION_APPLY_FAILED')
    } catch { await save('unknown', op.before, 'EXTENSION_ROLLBACK_UNKNOWN') }
    return op
  } finally { await release() }
}
