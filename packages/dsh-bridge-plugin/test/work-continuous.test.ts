import assert from 'node:assert/strict'
import test from 'node:test'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { createWorkChannel, type WorkStart } from '../dist/work.js'
import { createWorkJournal } from '../dist/work-journal.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const request: WorkStart = { issuerEpoch: 'epoch', id: 'continuous', parentSessionId: 'parent', childId: 'child',
  generation: 1, modelProvider: 'provider', model: 'model', agentPreset: 'assistant', task: 'Long work', context: '', timeoutMs: null }

test('continuous bridge work persists, survives elapsed time, supports follow-up and explicit interruption', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'qbf-continuous-'))
  const journal = createWorkJournal(directory)
  let finish!: (result: { stopReason: string; output: [] }) => void
  const result = new Promise<{ stopReason: string; output: [] }>(resolve => { finish = resolve })
  let disposed = 0, interrupted = 0
  const parent = { session: { id: 'parent' } } as unknown as Agent
  const runtime = { getProvider: () => ({ prepareContinuable() {}, inheritsParentContext: false,
    capabilities: { agentOptions: true, agentPreset: true } }),
    async startActivation() { return { childId: 'child', result, async dispose() { disposed++ } } },
    async prompt() { return { messageId: 'continued' } },
    async interruptByParent() { interrupted++ }
  } as unknown as SubagentRuntime
  const channel = createWorkChannel({ issuerEpoch: 'epoch', journal, getAgent: id => id === 'parent' ? parent : undefined,
    runtime: () => runtime, hasPreset: async () => true, continuationAvailable: () => true })
  try {
    assert.equal((await channel.verify(request)).continuousWorkSupported, true)
    context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
    assert.equal((await channel.start(request, new AbortController().signal)).state, 'running')
    context.mock.timers.tick(360_000)
    assert.equal((await channel.inspect(request)).state, 'running')
    assert.equal((await journal.read(request.id))?.target.timeoutMs, null)
    assert.equal(disposed, 0)
    finish({ stopReason: 'completed', output: [] })
    await Promise.resolve()
    assert.equal((await channel.inspect(request)).state, 'completed')
    await channel.followup({ ...request, requestId: 'followup', text: 'Continue', delivery: 'queue' }, new AbortController().signal)
    context.mock.timers.tick(360_000)
    assert.equal((await channel.inspect(request)).state, 'running')
    assert.equal(disposed, 0)
    await channel.interrupt(request)
    assert.equal(interrupted, 1)
  } finally {
    context.mock.timers.reset()
    await channel.close()
    await rm(directory, { recursive: true, force: true })
  }
})
