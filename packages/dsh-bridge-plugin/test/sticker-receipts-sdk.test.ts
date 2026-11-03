import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Presets from '@deepseek-ai/dsh-agent-preset-registry'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Llm, { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import Registry from '@deepseek-ai/dsh-typert-registry'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import type {} from '../dist/index.js'

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
class StickerAdapter extends LlmAdapter {
  requests = 0
  next: { name: string; input: unknown } | null = null
  readonly responses: ({ name: string; input: unknown } | { text: string })[] = []
  readonly contexts: string[] = []
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests++
    this.contexts.push(JSON.stringify(_options.messages))
    const response = this.next ?? this.responses.shift()
    const call = response && 'name' in response ? response : null
    this.next = null
    if (call) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(`sticker-call-${this.requests}`),
        name: call.name, arguments: JSON.stringify(call.input) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: response && 'text' in response ? response.text : '{"schema":"qbf.reply/1","action":"silent","reason":"already-answered"}' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

test('actual SDK sending stays quiet and explicit collection continues to one factual reply', async context => {
  const ctx = new Context()
  const loader = ctx.plugin(Loader)
  const fibers = [Agents, Sessions, Projections, SystemPrompt, Tools, Llm, Registry, RemoteAccess, Gateway].map(plugin => ctx.plugin(plugin))
  fibers.push(ctx.plugin(Presets, { default: 'fixture' }), ctx.plugin(AgentLoop))
  await Promise.all(fibers.map(fiber => fiber.inertia))
  await loader.inertia
  await ctx.loader.create({ name: import.meta.resolve('@qq-bridge-framework/dsh-bridge-plugin') })
  await ctx.loader.await()
  await new Promise<void>(resolve => setImmediate(resolve))
  const adapter = new StickerAdapter()
  ctx.llm.registerAdapter(['fixture'], adapter)
  const handle = await ctx.agents.create({ sessionId: SessionId('sticker-receipts-sdk'), agentOptions: { provider: 'fixture', model: 'model' } })
  const agent = handle.agent
  const peer = new Peer(ctx, { principal: { kind: 'owner' }, interactions: 'none' })
  context.after(async () => { await handle.dispose(); await peer.dispose(); await ctx.fiber.dispose() })
  const invoke = (method: string, args: Record<string, unknown> = {}) => ctx.typertGateway.invoke({ namespace: 'bridgePlugin', method, args, peer })
  const described = await invoke('describe')
  assert(object(described) && typeof described.issuerEpoch === 'string')
  const issuerEpoch = described.issuerEpoch
  await invoke('installFrameworkTools', { request: { issuerEpoch, sessionId: agent.id, generation: 1, tools: [
    { name: 'qbf_reply', description: 'Reply fixture', timeoutMs: 5000,
      parameters: { type: 'object', required: ['content'], additionalProperties: false, properties: { content: { type: 'string' } } } },
    { name: 'qbf_sticker_send', description: 'Send fixture', timeoutMs: 100,
      parameters: { type: 'object', required: ['intent'], additionalProperties: false, properties: { intent: { type: 'string' } } } },
    { name: 'qbf_sticker_manage', description: 'Collect fixture', timeoutMs: 100,
      parameters: { type: 'object', required: ['action'], additionalProperties: false,
        properties: { action: { type: 'string' }, assetId: { type: 'string' },
          assetIds: { type: 'array', items: { type: 'string' } } } } },
  ] } })
  const sources: string[] = []
  ctx.on('session/event', (session, event) => {
    if (session === agent.session && event.type === 'user/message') sources.push(event.data.source.kind)
  })
  const content = [{ type: 'text' as const, text: '会话事实：\n'
    + JSON.stringify({ senderId: 'ordinary-member', conversationId: 'group:fixture', participation: 'direct' }) + '当前消息：\n收藏或者发一张表情' }]
  async function queuedCall(name?: string) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const result = await invoke('pollFrameworkTools', { request: { issuerEpoch } })
      assert(object(result) && Array.isArray(result.calls))
      const pending = result.calls.find(value => object(value) && object(value.call) && (name === undefined || value.call.name === name))
      if (pending) {
        assert(object(pending) && typeof pending.ticket === 'string')
        return pending
      }
      await new Promise<void>(resolve => setTimeout(resolve, 2))
    }
    assert.fail('SDK sticker call did not arrive')
  }
  for (const name of ['qbf_sticker_send']) {
    const input = name === 'qbf_sticker_send' ? { intent: '开心' } : { action: 'add', assetId: 'registered' }
    for (const result of [
      { status: 'confirmed', value: { status: 'sent' } },
      { status: 'confirmed', value: { status: 'skipped', quiet: true } },
      { status: 'confirmed', value: { status: 'rejected', errorCode: 'STICKER_FILTERED' } },
      { status: 'rejected', code: 'POLICY_DENIED' },
      { status: 'unknown', code: 'TOOL_EXECUTION_UNKNOWN' },
    ]) {
      const before = adapter.requests
      adapter.next = { name, input }
      agent.followup(createUserMessage({ source: { kind: 'user', rpcId: `sticker-${before}` }, content }))
      const pending = await queuedCall()
      await invoke('completeFrameworkTool', { request: { issuerEpoch, ticket: pending.ticket, result } })
      await agent.whenIdle()
      assert.equal(adapter.requests - before, 1, `${name}:${result.status}:${JSON.stringify(result)}`)
    }
    for (const invalid of [false, true]) {
      const before = adapter.requests
      adapter.next = { name, input: invalid ? name === 'qbf_sticker_send' ? {} : { action: 'add' } : input }
      agent.followup(createUserMessage({ source: { kind: 'user', rpcId: `sticker-${before}` }, content }))
      if (!invalid) {
        const pending = await queuedCall()
        await agent.whenIdle()
        const late = await invoke('completeFrameworkTool', { request: { issuerEpoch, ticket: pending.ticket,
          result: { status: 'confirmed', value: { status: 'sent' } } } })
        assert(object(late) && late.accepted === false, 'late receipts are discarded')
      } else await agent.whenIdle()
      assert.equal(adapter.requests - before, 1, `${name}:${invalid ? 'invalid-input' : 'timeout'}`)
    }
  }
  {
    const before = adapter.requests
    adapter.next = { name: 'qbf_reply', input: { content: '# Background document' } }
    agent.followup(createUserMessage({ source: { kind: 'user', rpcId: `markdown-${before}` }, content }))
    const pending = await queuedCall('qbf_reply')
    await invoke('completeFrameworkTool', { request: { issuerEpoch, ticket: pending.ticket,
      result: { status: 'confirmed', value: { status: 'queued', deliveryId: 'synthetic-background-job', receipts: [] } } } })
    await agent.whenIdle()
    assert.equal(adapter.requests - before, 1, 'durably queued Markdown must conclude without another model request')
  }
  for (const action of ['annotate', 'delete', 'describe']) {
    const before = adapter.requests
    adapter.next = { name: 'qbf_sticker_manage', input: { action, assetId: 'registered' } }
    agent.followup(createUserMessage({ source: { kind: 'user', rpcId: `manage-${before}` }, content }))
    const pending = await queuedCall()
    await invoke('completeFrameworkTool', { request: { issuerEpoch, ticket: pending.ticket,
      result: { status: 'confirmed', value: { status: 'confirmed' } } } })
    await agent.whenIdle()
    assert.equal(adapter.requests - before, 2, `${action} does not terminate an ordinary tool workflow`)
  }
  assert(!sources.includes('qbf-reply-decision-repair'), 'sending and completed ordinary workflows need no reminder')

  const collectionCases = [
    { key: 'queued', result: { status: 'confirmed', value: { status: 'queued', completed: false, acceptedCount: 2 } }, text: '交去筛选啦，合适的再收藏～' },
    { key: 'skipped', result: { status: 'confirmed', value: { status: 'skipped', reason: 'busy', completed: false } }, text: '这次还没提交上，筛选那边有点忙。' },
    { key: 'refused', result: { status: 'rejected', code: 'POLICY_DENIED' }, text: '这次没能交去筛选。' },
    { key: 'unknown', result: { status: 'unknown', code: 'TOOL_EXECUTION_UNKNOWN' }, text: '这次还没确认提交上，先不重复交。' },
    { key: 'timeout', result: null, text: '这次提交结果还没确认，先不重复交。' },
    { key: 'invalid', result: null, text: '这次没能提交筛选。' },
  ]
  for (const example of collectionCases) {
    const before = adapter.requests
    adapter.next = { name: 'qbf_sticker_manage', input: example.key === 'invalid'
      ? { action: 'add', assetId: 42 } : { action: 'add', assetIds: ['first', 'second'] } }
    adapter.responses.push({ name: 'qbf_reply', input: { content: example.text } })
    const ordinaryGroup = [{ type: 'text' as const, text: '会话事实：\n'
      + JSON.stringify({ senderId: 'ordinary-member', conversationId: 'group:fixture', participation: 'ambient' })
      + '当前消息：\n这两张帮我收藏一下' }]
    agent.followup(createUserMessage({ source: { kind: 'user', rpcId: `collection-${before}` }, content: ordinaryGroup }))
    let collectionTicket: string | null = null
    if (example.key !== 'invalid') {
      const pending = await queuedCall()
      assert(object(pending.call) && pending.call.name === 'qbf_sticker_manage')
      assert.deepEqual(pending.call.input, { action: 'add', assetIds: ['first', 'second'] })
      assert(typeof pending.ticket === 'string'); collectionTicket = pending.ticket
      if (example.result) await invoke('completeFrameworkTool', { request: { issuerEpoch, ticket: pending.ticket, result: example.result } })
    }
    const reply = await queuedCall('qbf_reply')
    assert(object(reply.call) && reply.call.name === 'qbf_reply', example.key)
    assert(object(reply.call.input)); assert.equal(reply.call.input.content, example.text)
    assert.equal(reply.call.requestId, `collection-${before}`, 'reply retains the original QQ user claim')
    assert.equal(adapter.requests - before, 2, 'one result-processing model step follows collection')
    const receiptContext = adapter.contexts.at(-1)!
    if (example.key === 'queued') assert(receiptContext.includes('queued') && receiptContext.includes('acceptedCount'))
    if (example.key === 'unknown') assert(receiptContext.includes('TOOL_EXECUTION_UNKNOWN'))
    if (example.key === 'timeout') assert(receiptContext.includes('TOOL_HOST_TIMEOUT'))
    await invoke('completeFrameworkTool', { request: { issuerEpoch, ticket: reply.ticket,
      result: { status: 'confirmed', value: { status: 'sent' } } } })
    await agent.whenIdle()
    assert.equal(adapter.requests - before, 2, 'QQ reply receipt does not trigger another acknowledgement')
    if (collectionTicket && example.key === 'timeout') {
      const late = await invoke('completeFrameworkTool', { request: { issuerEpoch, ticket: collectionTicket,
        result: { status: 'confirmed', value: { status: 'queued', completed: false } } } })
      assert(object(late) && late.accepted === false, 'late collection results cannot restart the original chat')
      assert.equal(adapter.requests - before, 2)
    }
  }

  for (const mode of ['repair', 'user-silent']) {
    const before = adapter.requests
    adapter.next = { name: 'qbf_sticker_manage', input: { action: 'add', assetId: 'one' } }
    adapter.responses.push({ text: mode === 'repair' ? 'Bare collection acknowledgement'
      : '{"schema":"qbf.reply/1","action":"silent","reason":"user-requested"}' })
    if (mode === 'repair') adapter.responses.push({ name: 'qbf_reply', input: { content: '先交去筛选啦～' } })
    agent.followup(createUserMessage({ source: { kind: 'user', rpcId: `collection-${mode}` }, content }))
    const pending = await queuedCall()
    await invoke('completeFrameworkTool', { request: { issuerEpoch, ticket: pending.ticket,
      result: { status: 'confirmed', value: { status: 'queued', completed: false } } } })
    if (mode === 'repair') {
      const reply = await queuedCall('qbf_reply')
      assert(object(reply.call) && reply.call.name === 'qbf_reply')
      await invoke('completeFrameworkTool', { request: { issuerEpoch, ticket: reply.ticket, result: { status: 'confirmed', value: { status: 'sent' } } } })
    }
    await agent.whenIdle()
    assert.equal(adapter.requests - before, mode === 'repair' ? 3 : 2, mode)
  }
  assert.equal(sources.filter(source => source === 'qbf-reply-decision-repair').length, 1,
    'only an omitted collection reply gets one reminder; no asynchronous completion is injected')
})
