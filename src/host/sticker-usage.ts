import { assert, isRecord } from '../core/values.ts'
import { digest } from './data.ts'
import type { DurableStore } from './types.ts'

export interface StickerUsage { readonly sentCount: number; readonly lastSentAt: number | null }

/** Successful image deliveries only; annotation revisions and chat history stay independent. */
export function createStickerUsage(options: { readonly store: DurableStore; readonly accountId: string; readonly now?: () => number }) {
  const namespace = `native-chat.sticker-usage.${digest(options.accountId)}`
  const receipts = `native-chat.sticker-usage-receipts.${digest(options.accountId)}`
  const now = options.now ?? Date.now
  function read(id: string): StickerUsage {
    const value = options.store.read(namespace, id)?.value
    if (!isRecord(value) || value.schema !== 1 || !Number.isSafeInteger(value.sentCount) || Number(value.sentCount) < 0
      || !Number.isSafeInteger(value.lastSentAt) || Number(value.lastSentAt) < 0) return { sentCount: 0, lastSentAt: null }
    return { sentCount: Number(value.sentCount), lastSentAt: Number(value.lastSentAt) }
  }
  return Object.freeze({ read,
    record(input: { readonly id: string; readonly idempotencyKey: string; readonly at?: number }): void {
      assert(/^[a-f0-9]{64}$/.test(input.id) && input.idempotencyKey.length > 0 && input.idempotencyKey.length <= 512,
        'STICKER_USAGE_INVALID', 'A library image and delivery identity are required.')
      const at = input.at ?? now(), key = digest([input.id, input.idempotencyKey])
      assert(Number.isSafeInteger(at) && at >= 0 && options.store.compareAndSetBatch,
        'STICKER_USAGE_UNAVAILABLE', 'Atomic delivery counters are unavailable.')
      if (options.store.read(receipts, key)) return
      const previous = options.store.read(namespace, input.id), usage = read(input.id)
      assert(usage.sentCount < Number.MAX_SAFE_INTEGER, 'STICKER_USAGE_LIMIT', 'The delivery counter has reached its limit.')
      options.store.compareAndSetBatch([
        { kind: 'write', namespace, key: input.id, expectedRevision: previous?.revision ?? null,
          value: { schema: 1, sentCount: usage.sentCount + 1, lastSentAt: Math.max(usage.lastSentAt ?? 0, at) } },
        { kind: 'write', namespace: receipts, key, expectedRevision: null, value: { schema: 1, at },
          expiresAt: now() + 30 * 86400_000 },
      ])
    },
  })
}
