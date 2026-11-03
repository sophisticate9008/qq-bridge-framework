import type { FrameworkEvent } from '../core/types.ts'
import type { DurableStore, SessionBinding, StoredRecord } from './types.ts'
import type { createBridgeHost } from './bridge.ts'
import { digest, object } from './data.ts'
import { isRecord } from '../core/values.ts'
import type { HistoryMessage } from './history.ts'
import { nativeUnsentReplyRequest, selectNativeChatMessages, type NativeUnsentReplyRequest } from './native-chat-input.ts'

const namespace = 'native-chat.unsent-replies'

interface PreparedReply {
  readonly mode: 'same-speaker' | 'group-observation' | 'preserved'
  readonly actors: readonly string[]
  readonly contextMessageIds: readonly string[]
  readonly contextRequests: readonly NativeUnsentReplyRequest[]
  readonly source: { readonly id: string; readonly actor: string }
  readonly addressedMessageIds: readonly string[]
  held: boolean
}

/** Merge a stale reply once, retaining its actual input and explicit request sources. */
export function createNativeReplyFreshness(options: {
  readonly host: ReturnType<typeof createBridgeHost>
  readonly store: DurableStore
  readonly hasWaitingFrom: (conversationId: string, userId: string, messageId: string, mode?: 'same-speaker' | 'group-observation') => boolean | Promise<boolean>
  readonly onDeferred: (conversationId: string) => void
}) {
  const prepared = new Map<string, StoredRecord>()
  const modes = new Map<string, PreparedReply>()
  const key = (binding: SessionBinding, userId: string) => digest([binding.conversationId, binding.sessionId, binding.generation, binding.conversationId.startsWith('group:') ? 'group' : userId])
  return Object.freeze({
    async hold(event: FrameworkEvent): Promise<boolean> {
      const requestId = object(event.data.agentData ?? {}).nativeRequestId
      const binding = options.host.sessions.get(event.conversationId)
      if (typeof requestId !== 'string' || !binding || binding.sessionId !== event.sessionId
        || binding.generation !== event.data.generation) return false
      const preparation = modes.get(requestId)
      if (preparation?.held) return true
      if (preparation?.mode === 'preserved') return false
      const source = options.host.history.snapshot(event.conversationId, { afterSequence: 0, limit: 100 }).messages
        .find(item => digest([event.conversationId, item.id, 'prompt']) === requestId) ?? preparation?.source
      if (!source || source.actor === 'system' || source.actor === 'assistant') return false
      const mode = preparation?.mode ?? 'same-speaker'
      const actors = preparation?.actors.length ? preparation.actors : [source.actor]
      const waiting = await Promise.all(actors.map(actor => options.hasWaitingFrom(event.conversationId, actor, source.id, mode)))
      if (!waiting.some(Boolean)) return false
      const current = options.host.sessions.get(event.conversationId)
      if (current?.sessionId !== binding.sessionId || current.generation !== binding.generation) return false
      const id = key(binding, source.actor)
      const previous = options.store.read(namespace, id)
      const ids = previous ? object(previous.value).messageIds : []
      const messageIds = Array.isArray(ids) ? ids.filter((value): value is string => typeof value === 'string') : []
      if (!messageIds.includes(source.id)) {
        options.store.write(namespace, id, { schema: 1,
          messageIds: selectNativeChatMessages([...new Set([...messageIds, ...(preparation?.contextMessageIds ?? []), source.id])]
            .map(id => ({ id })), preparation?.addressedMessageIds ?? []).map(item => item.id),
          addressedMessageIds: [...(preparation?.addressedMessageIds ?? [])],
          requests: (preparation?.contextRequests ?? []).map(item => ({ ...item })) },
          { expectedRevision: previous?.revision ?? null, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 })
        options.onDeferred(event.conversationId)
      }
      if (preparation) preparation.held = true
      const pending = options.host.replies.get(event.conversationId)
      if (pending?.sessionId === binding.sessionId && pending.generation === binding.generation && pending.requestId === source.id)
        options.host.replies.suppress(binding, source.id)
      return true
    },
    prepare(binding: SessionBinding, userId: string, messageId: string, input: {
      readonly addressedMessages: readonly { readonly messageId: string; readonly actor: string }[]
      readonly contextMessageIds: readonly string[]
      readonly contextMessages?: readonly HistoryMessage[]
    }): { readonly unsentReplyMessageIds?: readonly string[]; readonly unsentReplyRequests?: readonly NativeUnsentReplyRequest[];
      readonly addressedMessageIds: readonly string[] } {
      const record = options.store.read(namespace, key(binding, userId))
      const requestId = digest([binding.conversationId, messageId, 'prompt'])
      const value = record ? object(record.value) : {}
      const ids = Array.isArray(value.messageIds) ? value.messageIds.filter((id): id is string => typeof id === 'string').slice(-32) : []
      const retained = Array.isArray(value.addressedMessageIds)
        ? value.addressedMessageIds.filter((id): id is string => typeof id === 'string' && ids.includes(id)) : []
      const addressedMessageIds = [...new Set([...retained, ...input.addressedMessages.map(item => item.messageId)])].slice(-32)
      if (modes.size >= 256) modes.delete(modes.keys().next().value!)
      // A successor carrying a withheld reply may finish despite further chatter,
      // including the same speaker. Queued input still forms the next single batch.
      modes.set(requestId, { mode: record ? 'preserved'
        : binding.conversationId.startsWith('group:') && !addressedMessageIds.length ? 'group-observation' : 'same-speaker',
        actors: [...new Set(input.addressedMessages.map(item => item.actor))],
        contextMessageIds: selectNativeChatMessages(input.contextMessageIds.map(id => ({ id })), addressedMessageIds).map(item => item.id),
        contextRequests: selectNativeChatMessages(input.contextMessages ?? [], addressedMessageIds).map(nativeUnsentReplyRequest),
        source: { id: messageId, actor: userId }, addressedMessageIds, held: false })
      if (!record || !ids.length) return { addressedMessageIds }
      if (prepared.size >= 256) prepared.delete(prepared.keys().next().value!)
      prepared.set(requestId, record)
      const requests: NativeUnsentReplyRequest[] = Array.isArray(value.requests) ? value.requests.flatMap(item =>
        isRecord(item) && typeof item.id === 'string' && ids.includes(item.id) && typeof item.actor === 'string'
          && typeof item.receivedAt === 'number' && Number.isFinite(item.receivedAt) && typeof item.text === 'string'
          && typeof item.truncated === 'boolean'
          ? [{ id: item.id, actor: item.actor, receivedAt: item.receivedAt, text: item.text.slice(0, 800),
            truncated: item.truncated || item.text.length > 800,
            ...(typeof item.displayName === 'string' ? { displayName: item.displayName } : {}) }] : []).slice(-32) : []
      return { unsentReplyMessageIds: ids, unsentReplyRequests: requests, addressedMessageIds }
    },
    settled(requestId: string, accepted: boolean) {
      const record = prepared.get(requestId)
      prepared.delete(requestId)
      if (accepted && record && options.store.read(namespace, record.key)?.revision === record.revision)
        options.store.delete(namespace, record.key, record.revision)
    },
    clear() { prepared.clear(); modes.clear() }
  })
}
