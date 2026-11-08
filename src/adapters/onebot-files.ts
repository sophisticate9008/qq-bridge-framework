import { isAbsolute } from 'node:path'
import type { DeliveryReceipt } from '../core/types.ts'
import { createOneBotFileUploadHttpPort } from './onebot-file-upload-http.ts'

export interface OneBotFileUploadRequest {
  readonly file: string
  readonly name: string
  readonly signal: AbortSignal
}
export interface OneBotFileUploadPort {
  uploadPrivate(request: OneBotFileUploadRequest & { readonly userId: string }): Promise<DeliveryReceipt>
  uploadGroup(request: OneBotFileUploadRequest & { readonly groupId: string }): Promise<DeliveryReceipt>
}

export function validOneBotUploadSource(file: unknown): file is string {
  if (typeof file !== 'string' || file.length < 1 || /[\x00-\x1f\x7f]/.test(file)) return false
  if (isAbsolute(file)) return file.length <= 4096
  try {
    const url = new URL(file)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && /^\/qbf-work-stream\/[a-f0-9]{64}$/.test(url.pathname) && !url.search && !url.hash
  } catch { return false }
}

/** Assistant resources accept only host-resolved paths and genuine streaming channels. */
export function createOneBotFileUploadPort(options: { readonly endpoint: string; readonly accessToken?: string;
  readonly fetch?: typeof globalThis.fetch; readonly timeoutMs?: number }): OneBotFileUploadPort {
  return createOneBotFileUploadHttpPort(options, validOneBotUploadSource)
}
