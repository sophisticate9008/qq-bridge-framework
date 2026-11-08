import { createOneBotFileUploadHttpPort } from './onebot-file-upload-http.ts'
import type { OneBotFileUploadPort } from './onebot-files.ts'

/** Existing bounded protocol media, independent of assistant work attachments. */
export function validProtocolMediaBytes(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('base64://')) return false
  const data = value.slice(9)
  return data.length > 0 && data.length <= Math.ceil(8 * 1024 * 1024 / 3) * 4
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
    && Buffer.byteLength(data, 'base64') <= 8 * 1024 * 1024 && Buffer.from(data, 'base64').toString('base64') === data
}
export function createProtocolMediaFileUploadPort(options: { readonly endpoint: string; readonly accessToken?: string;
  readonly fetch?: typeof globalThis.fetch; readonly timeoutMs?: number }): OneBotFileUploadPort {
  return createOneBotFileUploadHttpPort(options, validProtocolMediaBytes)
}
