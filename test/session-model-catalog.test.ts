import assert from 'node:assert/strict'
import test from 'node:test'
import type { NativeDeploymentPresetBinding } from '../src/contracts/native-deployment.ts'
import type { PluginModelDescription } from '../src/contracts/plugin-model.ts'
import { buildSessionModelCatalog, sessionModelForConversation } from '../src/host/session-model-catalog.ts'
import { buildChatSessionDefinition } from '../src/host/chat-plans.ts'
import { findSessionModel, sessionModelKey, sessionModelOptionValue } from '../web/lib/session-model-options.ts'
import { identifySessionModelAliases } from '../src/host/session-model-aliases.ts'
import { createPluginSessionRoutes } from '../src/admin/plugin-sessions.ts'
import type { NativeModelProvider } from '../src/host/model-providers.ts'

const definition = buildChatSessionDefinition({ id: 'daily', name: 'Daily', description: '', instructions: 'Test instructions', personaId: 'persona',
  provider: 'configured', model: 'chat', reasoningEffort: 'off' }, { id: 'persona', name: 'Persona', identity: 'Test identity', style: 'Test style' })
const bindings: NativeDeploymentPresetBinding[] = ['group', 'private'].map(kind => ({ agentPreset: `preset-${kind}`,
  conversationKind: kind as 'group' | 'private', externalProvider: `generated-current-${kind}`, definition }))
const live: PluginModelDescription[] = [
  { provider: 'official', model: 'chat', providerName: 'Old SDK label', modelName: 'Old SDK model label' },
  ...['generated-current-group', 'generated-current-private', 'generated-obsolete-group', 'generated-obsolete-private']
    .map(provider => ({ provider, model: 'chat', providerName: provider, modelName: 'chat' })),
  { provider: 'unconfigured', model: 'chat', providerName: 'Other', modelName: 'Other' },
]
const providers = [
  { id: 'official', name: '官方服务', enabled: true, models: [{ id: 'chat', name: '聊天模型' }] },
  { id: 'configured', name: '自建供应商', enabled: true, models: [{ id: 'chat', name: '同一模型' }] },
  { id: 'not-loaded', name: '未加载', enabled: true, models: [{ id: 'chat', name: '聊天模型' }] },
  { id: 'unconfigured', name: '已停用', enabled: false, models: [{ id: 'chat', name: '聊天模型' }] },
]

test('management catalog contains supplier models once and excludes historical and unconfigured transport routes', () => {
  const result = buildSessionModelCatalog(providers, bindings, live)
  assert.deepEqual(result, [
    { provider: 'official', model: 'chat', providerName: '官方服务', modelName: '聊天模型' },
    { provider: 'generated-current-private', model: 'chat', providerName: '自建供应商', modelName: '同一模型',
      aliases: ['generated-current-group', 'generated-current-private'] },
  ])
  assert.equal(result.length, 2, 'different suppliers keep their own same-name model')
  assert.deepEqual(live.map(item => item.provider), ['official', 'generated-current-group', 'generated-current-private',
    'generated-obsolete-group', 'generated-obsolete-private', 'unconfigured'], 'projection never mutates SDK routes')
})

test('an existing group selection resolves to the single supplier model option and preserves its identity', () => {
  const models = buildSessionModelCatalog(providers, bindings, live)
  const existing = { provider: 'generated-current-group', model: 'chat', reasoningEffort: 'high' }
  assert.equal(findSessionModel(models, existing)?.providerName, '自建供应商')
  assert.equal(sessionModelOptionValue(models, sessionModelKey(existing)), sessionModelKey(models[1]!))
  assert.equal(findSessionModel(models, '{invalid'), undefined)
  assert.equal(findSessionModel(models, JSON.stringify(['generated-current-group', 'another-model'])), undefined)
})

test('QQ applies the supplier selection through its own group or private route without guessing unrelated providers', () => {
  const selected = { provider: 'generated-current-private', model: 'chat', reasoningEffort: 'high' }
  assert.deepEqual(sessionModelForConversation(selected, 'group:123', bindings), { ...selected, provider: 'generated-current-group' })
  assert.deepEqual(sessionModelForConversation(selected, 'private:123', bindings), selected)
  const official = { provider: 'official', model: 'chat' }
  assert.deepEqual(sessionModelForConversation(official, 'group:123', bindings), official)
})

test('historical supplier attribution checks endpoint, API and credential provenance and leaves ambiguous routes unconfirmed', async () => {
  const base: NativeModelProvider = { id: 'official', name: 'Official', enabled: true, type: 'openai',
    api: 'openai-completions', baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-key', models: [{ id: 'chat', name: 'Chat' }] }
  const config = { providers: {
    'old-route': { api: 'openai-completions', baseURL: base.baseUrl, apiKeyEnv: 'MATCHED' },
    'wrong-key': { api: 'openai-completions', baseURL: base.baseUrl, apiKeyEnv: 'OTHER' },
    'other-endpoint': { api: 'openai-completions', baseURL: 'https://other.invalid/v1', apiKeyEnv: 'MATCHED' },
    'other-api': { api: 'anthropic-messages', baseURL: base.baseUrl, apiKeyEnv: 'MATCHED' },
  } }
  const match = async (candidates: readonly { readonly ref: string; readonly value: string }[]) =>
    candidates.map(item => ({ ref: item.ref, matches: item.ref === 'MATCHED' && item.value === 'fixture-key' }))
  const aliases = await identifySessionModelAliases([base], config, match)
  assert.deepEqual(aliases, [{ alias: 'old-route', providerId: 'official' }])
  assert.deepEqual(await identifySessionModelAliases([base, { ...base, id: 'another' }], config, match), [])
  assert.deepEqual(await identifySessionModelAliases([base, { ...base, id: 'another' }], { providers: {
    official: { api: 'openai-completions', baseURL: base.baseUrl, apiKeyEnv: 'MATCHED' },
    another: { api: 'openai-completions', baseURL: base.baseUrl, apiKeyEnv: 'MATCHED' },
  } }, match), [], 'configured supplier IDs cannot become aliases of another supplier sharing credentials')
  const raw = [...live, { provider: 'old-route', model: 'chat', providerName: 'old-route', modelName: 'chat' }]
  const catalog = buildSessionModelCatalog(providers, bindings, raw, aliases)
  assert.equal(findSessionModel(catalog, { provider: 'old-route', model: 'chat' })?.providerName, '官方服务')
  assert.equal(catalog.length, 2, 'old bindings gain correct names without adding picker options')
})

test('management model endpoint uses the supplier catalog and preserves verified display aliases', async () => {
  const models = buildSessionModelCatalog(providers, bindings, live)
  const route = createPluginSessionRoutes({ getService: () => undefined, managementModels: async () => models })
    .find(route => route.method === 'GET' && route.pathname.endsWith('/models'))!
  assert.deepEqual(await route.handle({ query: new URLSearchParams(), body: null, signal: new AbortController().signal }), { schema: 1, models })
})
