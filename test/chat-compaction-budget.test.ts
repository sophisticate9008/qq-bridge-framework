import test from 'node:test'
import assert from 'node:assert/strict'
import { chatCompactionSummaryBudget } from '../src/contracts/chat-capacity.ts'
import { preserveDshChatOutputBudget } from '../src/contracts/dsh-model-settings.ts'
import { prepareDshDeployment } from '../src/adapters/dsh-deployment.ts'

test('metadata refresh preserves the selected reply budget and bounds it by actual capability', () => {
  const metadata = { contextWindow: 500000, maxTokens: 128000, reasoningEfforts: false as const }
  assert.equal(preserveDshChatOutputBudget(metadata, { ...metadata, maxTokens: 16384 }).maxTokens, 16384)
  assert.equal(preserveDshChatOutputBudget({ ...metadata, maxTokens: 4096 }, { ...metadata, maxTokens: 16384 }).maxTokens, 4096)
  assert.equal(preserveDshChatOutputBudget(metadata, null).maxTokens, 128000)
})

test('compaction uses a separate bounded summary allowance and one attempt per pressure check', () => {
  assert.equal(chatCompactionSummaryBudget(157286, 128000), 7321)
  assert.equal(chatCompactionSummaryBudget(157286, 16384), 8192)
  assert.equal(chatCompactionSummaryBudget(8192, 1024), 1024)
  const prepared = prepareDshDeployment({
    definition: { planId: 'chat', personaId: 'persona', instructions: 'Chat.', persona: { identity: 'Assistant', style: 'Concise' },
      contextLimits: { group: 157286, private: 275251 }, model: { provider: 'provider', name: 'model', reasoningEffort: 'off' } },
    providers: [{ id: 'provider', name: 'Provider', type: 'openai', baseUrl: 'https://example.test/v1', enabled: true, apiKey: 'fixture', models: [{ id: 'model', name: 'Model' }] }],
    target: { profilePath: '/isolated/profile.yml', credentialsPath: '/isolated/credentials.yml', schemaVersion: '0.2.1-rc.2', revision: 'before', providerEntryId: 'llm', providerConfig: { providers: {} }, presets: [], credentialChecks: [], configurationLoaded: false },
    modelSettings: { contextWindow: 500000, maxTokens: 16384, reasoningEfforts: false },
  })
  assert.equal(prepared.summary.ready, true)
  const preview = JSON.stringify(prepared.preview())
  assert.match(preview, /"compactionRetries":0/)
  assert.match(preview, /"maxTokens":8192/)
})
