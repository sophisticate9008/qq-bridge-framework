import assert from 'node:assert/strict'
import test from 'node:test'
import type { PluginModelClient, PluginModelRunRequest } from '../src/contracts/plugin-model.ts'
import { validateStickerSendingConfiguration } from '../src/contracts/sticker-sending.ts'
import { createStickerDshSelector, type StickerSelectionRequest } from '../src/host/sticker-dsh-selector.ts'
import { STICKER_SENDING_CONFIGURATION } from '../src/host/sticker-sending-configuration.ts'

test('retired local selection settings remain readable but cannot disable model selection', () => {
  for (const useAiSelection of [true, false]) assert.deepEqual(validateStickerSendingConfiguration({ useAiSelection, dshSelectionTimeoutSeconds: 15 }), { dshSelectionTimeoutSeconds: 15 })
  assert.deepEqual(validateStickerSendingConfiguration({ dshSelectionTimeoutSeconds: 10 }), { dshSelectionTimeoutSeconds: 10 })
  assert(!STICKER_SENDING_CONFIGURATION.descriptor.fields.some(field => field.path.includes('useAiSelection')))
  assert.throws(() => validateStickerSendingConfiguration({ dshSelectionTimeoutSeconds: 0 }))
})

test('the model sees context, reply text and the full shortlist and can choose a lower ranked candidate or reject all', async () => {
  const calls: PluginModelRunRequest[] = []
  let answer = '{"choice":12}'
  const client: PluginModelClient = {
    list: () => [], models: async () => [], unbind: async () => false,
    bind: async () => { throw new Error('unexpected bind') }, create: async () => { throw new Error('unexpected create') },
    async run(request) { calls.push(request); return { text: answer, requestId: 'selection', sessionId: 'helper', usage: null } },
  }
  const select = createStickerDshSelector({ client: () => client, model: () => undefined })
  const request: StickerSelectionRequest = { intent: '嘴硬但已经缓和，被摸头', replyText: '哼，就让你摸一下',
    context: ['机器人：还生气呢', '发言者1：轻轻摸摸你的头'], conversationId: 'group:fixture',
    candidates: Array.from({ length: 12 }, (_, index) => ({ id: `image-${index + 1}`, score: 12 - index,
      annotation: { description: `真实候选${index + 1}`, tags: ['被摸头'], avoid: '认真拒绝时' } })),
    signal: new AbortController().signal, deadlineAt: Date.now() + 5000 }
  assert.equal(await select(request), 'image-12')
  assert(calls[0]!.prompt.includes('哼，就让你摸一下'))
  assert(calls[0]!.prompt.includes('机器人：还生气呢'))
  assert(calls[0]!.prompt.includes('真实候选12'))
  for (answer of ['{"choice":null}', '{"choice":13}', '{"choice":1,"extra":"ignore"}', 'not json']) assert.equal(await select(request), null)
  answer = '{"choice":null}'
  assert.equal(await select({ ...request, candidates: request.candidates.slice(0, 1) }), null)
  assert.equal(await createStickerDshSelector({ client: () => undefined, model: () => undefined })(request), null)
})
