import test from 'node:test'
import assert from 'node:assert/strict'
import { createDshWorkPort, dshWorkRpcError } from '../src/adapters/dsh-work.ts'

const address = { issuerEpoch: 'epoch', id: 'work', parentSessionId: 'parent', childId: 'child', generation: 3 }
const asset = { type: 'media-reference' as const, kind: 'file' as const, attachmentId: 'attachment-123', name: 'report.txt', bytes: 400000 }

test('removed byte API fails explicitly without invoking RPC or allocating file bytes', async () => {
  const port = createDshWorkPort(async () => { throw new Error('Must not invoke byte RPC'); });
  await assert.rejects(port.readAsset!({ ...address, kind: 'file', attachmentId: asset.attachmentId }, new AbortController().signal),
    { code: 'WORK_BYTE_ATTACHMENTS_REMOVED' });
});

test('full-access start requires explicit supported scope and verified child permission evidence', async () => {
  let available = true
  let supported: boolean | undefined
  let fullAccess: boolean | undefined
  const port = createDshWorkPort(async method => method === 'bridgePlugin/verifyWork'
    ? { schema: 1, issuerEpoch: 'epoch', available, provider: 'spawn', continuable: true,
      externalToolAuthorizationVerified: false, pathAttachmentsSupported: true, childFullAccessSupported: supported }
    : { ...address, schema: 1, state: 'running', result: null, error: null, ...(fullAccess === undefined ? {} : { fullAccess }) })
  const target = { issuerEpoch: 'epoch', parentSessionId: 'parent', modelProvider: 'provider', model: 'model', agentPreset: 'assistant', fullAccess: true }
  const signal = new AbortController().signal
  await assert.rejects(port.verify(target, signal), { code: 'DSH_WORK_INVALID_RESPONSE' })
  available = false
  assert.equal(await port.verify(target, signal), false)
  available = true; supported = true
  assert.equal(await port.verify(target, signal), true)
  const start = { ...address, ...target, task: 'Owner task', context: '', timeoutMs: 1000 }
  await assert.rejects(port.start(start, signal), { code: 'DSH_WORK_INVALID_RESPONSE' })
  fullAccess = true
  assert.equal((await port.start(start, signal)).fullAccess, true)
})

test('continuous work requires explicit bridge support while finite legacy requests remain compatible', async () => {
  let supported = false
  const port = createDshWorkPort(async () => ({ schema: 1, issuerEpoch: 'epoch', available: true,
    provider: 'spawn', continuable: true, externalToolAuthorizationVerified: false, pathAttachmentsSupported: true,
    ...(supported ? { continuousWorkSupported: true } : {}) }))
  const target = { issuerEpoch: 'epoch', parentSessionId: 'parent', modelProvider: 'provider', model: 'model', agentPreset: 'assistant' }
  const signal = new AbortController().signal
  assert.equal(await port.verify(target, signal), true)
  assert.equal(await port.verify({ ...target, continuous: true }, signal), false)
  supported = true
  assert.equal(await port.verify({ ...target, continuous: true }, signal), true)
})

test('only explicit invalidation maps to file expiry; unavailable, not-this-work and network causes remain distinct', async () => {
  for (const [remote, code] of [
    ['bridgePlugin/work-path-invalidated', 'WORK_PATH_INVALIDATED'],
    ['bridgePlugin/work-path-not-this-work', 'WORK_PATH_NOT_THIS_WORK'],
    ['bridgePlugin/work-stream-unavailable', 'WORK_STREAM_UNAVAILABLE'],
    ['DSH_PLUGIN_UNAVAILABLE', 'DSH_WORK_CHANNEL_UNAVAILABLE'],
    ['DSH_AUTH_REJECTED', 'DSH_WORK_CHANNEL_UNAVAILABLE'],
  ]) {
    const port = createDshWorkPort(async () => { throw dshWorkRpcError(remote); });
    await assert.rejects(port.readPath!({ ...address, attachmentId: 'resource', kind: 'file' }, new AbortController().signal), { code });
  }
});
