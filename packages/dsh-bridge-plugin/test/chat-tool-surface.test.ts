import assert from 'node:assert/strict'
import test from 'node:test'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { trimFrameworkChatTools } from '../src/chat-tool-surface.ts'

test('framework leases hide duplicate bridge actions using their registered namespaces', () => {
  let denied: readonly string[] = []
  const names = ['mcp__gateway__qq_reply', 'mcp__gateway__qq_get_prompt', 'mcp__gateway-host__gateway_status',
    'mcp__other__qq_get_recent_messages', 'mcp__gateway__qq_get_group_members', 'mcp__images__image_status', 'qbf_reply']
  const agent = { ctx: { tools: { schemas: () => names.map(name => ({ name })),
    restrict: (input: { deny: readonly string[] }) => { denied = input.deny; return () => {} } } } } as unknown as Agent
  assert.equal(typeof trimFrameworkChatTools(agent), 'function')
  assert.deepEqual(denied, names.slice(0, 4))
})

test('ordinary agents without duplicate bridge registrations keep their tool surface', () => {
  const agent = { ctx: { tools: { schemas: () => [{ name: 'qbf_reply' }],
    restrict: () => { throw new Error('Unexpected restriction') } } } } as unknown as Agent
  assert.equal(trimFrameworkChatTools(agent), undefined)
})
