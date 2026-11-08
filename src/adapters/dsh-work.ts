import { validWorkPath, type WorkPathDescriptor } from '../storage/work-path.ts'
import { isDshWorkOutput, isDshWorkProgress, isDshWorkUsage } from '../contracts/dsh-work.ts'
import type { DshWorkMediaReference, DshWorkAddress, DshWorkSnapshot, DshWorkStart, DshWorkTarget } from '../contracts/dsh-work.ts'
import { DshAdapterError } from './dsh.ts'
import { isRecord, reference, snapshot } from '../core/values.ts'

/** Preserve explicit path diagnostics without turning transport failure into file expiry. */
export function dshWorkRpcError(code: string): DshAdapterError {
  if (code === 'bridgePlugin/work-path-not-this-work') return new DshAdapterError('WORK_PATH_NOT_THIS_WORK', '编号不属于该工作或类型。')
  if (code === 'bridgePlugin/work-stream-unavailable') return new DshAdapterError('WORK_STREAM_UNAVAILABLE', '远程流通道不可用。')
  if (code === 'bridgePlugin/work-path-invalidated') return new DshAdapterError('WORK_PATH_INVALIDATED', '文件已失效，请重新登记路径。')
  return new DshAdapterError('DSH_WORK_CHANNEL_UNAVAILABLE', '工作通道不可用。')
}

export type DshWorkMethod = 'bridgePlugin/verifyWork' | 'bridgePlugin/startWork' | 'bridgePlugin/inspectWork'
  | 'bridgePlugin/releaseWorkPath' | 'bridgePlugin/readWorkPath' | 'bridgePlugin/followupWork' | 'bridgePlugin/interruptWork' | 'bridgePlugin/readWorkAsset'
export interface DshWorkPort {
  verify(request: DshWorkTarget & { issuerEpoch: string }, signal: AbortSignal): Promise<boolean>
  start(request: DshWorkStart, signal: AbortSignal): Promise<DshWorkSnapshot>
  inspect(request: DshWorkAddress, signal: AbortSignal): Promise<DshWorkSnapshot>
  followup(request: DshWorkAddress & { requestId: string; text: string; delivery: 'queue' | 'steer' }, signal: AbortSignal): Promise<{ messageId: string }>
  releasePath?(request: DshWorkAddress & { keepRegistration?: boolean; channelToken?: string; kind: 'image' | 'file'; attachmentId: string }, signal: AbortSignal): Promise<void>
  readPath?(request: DshWorkAddress & { metadataOnly?: boolean; kind: 'image' | 'file'; attachmentId: string }, signal: AbortSignal): Promise<{ asset: DshWorkMediaReference; descriptor: WorkPathDescriptor; file?: string }>
  /** @deprecated Always rejects; legacy byte attachments cannot be resent. */
  readAsset?(request: DshWorkAddress & { kind: 'image' | 'file'; attachmentId: string }, signal: AbortSignal): Promise<never>
  interrupt(request: DshWorkAddress, signal: AbortSignal): Promise<void>
}

export function createDshWorkPort(invoke: (method: DshWorkMethod, request: unknown, signal: AbortSignal) => Promise<unknown>, options: { readonly sharedFilesystem?: boolean; readonly streamBase?: string; readonly currentEpoch?: (signal: AbortSignal) => Promise<string> } = {}): DshWorkPort {
  let pathSupported = false
  const invalid = (): never => { throw new DshAdapterError('DSH_WORK_INVALID_RESPONSE', 'The SDK work result could not be verified.') }
  async function read(method: 'bridgePlugin/startWork' | 'bridgePlugin/inspectWork', address: DshWorkAddress, signal: AbortSignal) {
    const value = snapshot(await invoke(method, address, signal))
    if (!isRecord(value) || value.schema !== 1 || Object.entries(address).some(([key, expected]) =>
      ['issuerEpoch', 'id', 'parentSessionId', 'childId', 'generation'].includes(key) && value[key] !== expected)
      || !['starting', 'running', 'completed', 'unknown'].includes(String(value.state))
      || value.usage !== undefined && !isDshWorkUsage(value.usage)
      || value.progress !== undefined && !isDshWorkProgress(value.progress)
      || value.fullAccess !== undefined && typeof value.fullAccess !== 'boolean'
      || 'fullAccess' in address && address.fullAccess === true && ['running', 'completed'].includes(String(value.state)) && value.fullAccess !== true
      || value.error !== null && (typeof value.error !== 'string' || !/^[A-Z][A-Z_]{1,63}$/.test(value.error))
      || value.result !== null && (!isRecord(value.result) || !reference(value.result.stopReason)
        || !Array.isArray(value.result.output) || value.result.output.length > 256
        || value.result.output.some(block => !isDshWorkOutput(block)))
      || value.state === 'completed' && value.result === null || Buffer.byteLength(JSON.stringify(value)) > 524288) return invalid()
    return value as unknown as DshWorkSnapshot
  }
  return Object.freeze<DshWorkPort>({
    async verify(request, signal) {
      const value = await invoke('bridgePlugin/verifyWork', request, signal)
      if (!isRecord(value) || value.schema !== 1 || value.issuerEpoch !== request.issuerEpoch || typeof value.available !== 'boolean'
        || value.provider !== 'spawn' || value.continuable !== true || value.externalToolAuthorizationVerified !== false
        || request.fullAccess === true && value.available === true && value.childFullAccessSupported !== true) return invalid()
      pathSupported = value.pathAttachmentsSupported === true
      return value.available && pathSupported && (request.continuous !== true || value.continuousWorkSupported === true)
    },
    start(request, signal) {
      if (!pathSupported) throw new DshAdapterError('WORK_PATH_READER_UNAVAILABLE', '请配套升级宿主与桥接插件后再启动工作。')
      const addressed: DshWorkStart = { ...request, attachmentTransport: 'path-v1' }
      return read('bridgePlugin/startWork', addressed, signal)
    },
    inspect: (request, signal) => read('bridgePlugin/inspectWork', request, signal),
    async followup(request, signal) {
      const value = await invoke('bridgePlugin/followupWork', request, signal)
      if (!isRecord(value) || !reference(value.messageId)) return invalid()
      return { messageId: value.messageId }
    },
    async readPath(request, signal) {
      const { metadataOnly, ...address } = request
      const scoped = { ...address, issuerEpoch: options.currentEpoch ? await options.currentEpoch(signal) : request.issuerEpoch }
      const value = await invoke('bridgePlugin/readWorkPath', { ...scoped, ...(options.sharedFilesystem === true || metadataOnly ? {} : { transport: 'stream' }) }, signal)
      if (!isRecord(value) || value.schema !== 1 || Object.entries(scoped).some(([key, expected]) => value[key] !== expected)
        || !isDshWorkOutput(value.asset) || value.asset.type !== 'media-reference' || value.asset.storage !== 'path'
        || value.asset.attachmentId !== request.attachmentId || value.asset.kind !== request.kind
        || !validWorkPath(value.descriptor) || value.descriptor.bytes !== value.asset.bytes) return invalid()
      if (options.sharedFilesystem !== true && !metadataOnly) {
        if (!options.streamBase || typeof value.streamPath !== 'string' || !/^\/qbf-work-stream\/[a-f0-9]{64}$/.test(value.streamPath)) return invalid()
        return { asset: value.asset, descriptor: value.descriptor, file: new URL(value.streamPath, options.streamBase).href }
      }
      return { asset: value.asset, descriptor: value.descriptor }
    },
    async releasePath(request, signal) {
      const value = await invoke('bridgePlugin/releaseWorkPath', { ...request, issuerEpoch: options.currentEpoch ? await options.currentEpoch(signal) : request.issuerEpoch }, signal)
      if (!isRecord(value) || value.released !== true) return invalid()
    },
    async readAsset(request, signal) {
      throw new DshAdapterError('WORK_BYTE_ATTACHMENTS_REMOVED', '旧附件已失效，请在原工作中重新登记路径。')
    },
    async interrupt(request, signal) {
      const value = await invoke('bridgePlugin/interruptWork', request, signal)
      if (!isRecord(value) || value.accepted !== true) return invalid()
    }
  })
}
