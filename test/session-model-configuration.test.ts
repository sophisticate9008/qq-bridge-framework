import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSessionModelConfiguration } from '../src/contracts/session-model-configuration.ts'
import { parsePluginSessionBinding, parsePluginSessionManagementRequest } from '../src/contracts/plugin-sessions.ts'
import { parseSessionSnapshot } from '../web/lib/session-management.ts'

const model = { provider: 'fixture', model: 'chat' }
const configuration = { revision: null, override: null, inherited: model, providerName: '测试供应商', modelName: '聊天', planName: '日常', lastApplied: null }
test('session model DTO distinguishes inheritance, saved overrides and applied evidence and rejects invalid state', () => {
  assert.deepEqual(parseSessionModelConfiguration(configuration), configuration)
  const applied = { ...configuration, revision: 2, override: model, lastApplied: { sessionId: 'retained-session', model, at: 100 } }
  assert.deepEqual(parseSessionModelConfiguration(applied), applied)
  for (const invalid of [{ ...configuration, revision: 0 }, { ...configuration, inherited: null },
    { ...configuration, override: { ...model, apiKey: 'rejected' } },
    { ...configuration, lastApplied: { sessionId: '', model, at: 100 } }, { ...configuration, providerName: null }])
    assert.equal(parseSessionModelConfiguration(invalid), null)
  const session = { key: 'private:123', sessionId: 'retained-session', owner: true, generation: 1, bindingRevision: 'a'.repeat(64), modelConfiguration: applied }
  assert.deepEqual(parseSessionSnapshot({ revision: 'snapshot', sessions: [session], resetAvailable: true })?.sessions[0]?.modelConfiguration, applied)
  assert.equal(parseSessionSnapshot({ revision: 'snapshot', sessions: [{ ...session, modelConfiguration: { ...applied, revision: -1 } }] }), null)
})
test('plugin model selection requires a concrete binding revision and preserves distinct model preferences', () => {
  const request = { action: 'model', owner: 'fixture', revision: 2, confirm: true, model }
  assert(parsePluginSessionManagementRequest(request))
  assert(parsePluginSessionManagementRequest({ ...request, model: null }))
  for (const invalid of [{ ...request, revision: null }, { ...request, model: undefined }, { ...request, sessionId: 'other-session' }])
    assert.equal(parsePluginSessionManagementRequest(invalid), null)
  const binding = { revision: 3, busy: false, owner: 'fixture', name: 'default', conversationId: null, sessionId: 'retained-session',
    source: 'created', state: 'ready', model, modelOverride: { provider: 'second', model: 'chat' }, modelDefault: model,
    createdAt: 1, updatedAt: 2, lastUsedAt: 2 }
  assert.deepEqual(parsePluginSessionBinding(binding), binding)
})
