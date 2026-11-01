import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_STICKER_LIBRARY_CONFIGURATION, parseStickerLibraryDeleteResult, parseStickerLibrarySnapshot,
  parseStickerLibraryThumbnail, parseStickerLibraryIdentityUpdate, parseStickerLibraryIdentityUpdateResult,
  parseStickerLibraryAnnotationUpdate, parseStickerLibraryAnnotationUpdateResult,
  validateStickerLibraryConfiguration } from '../src/contracts/sticker-library.ts'

const item = { id: 'a'.repeat(64), revision: 1, name: '招手', description: '开心招手', tags: ['开心', '问候'], avoid: '',
  storage: 'account', state: 'ready', canDelete: true, createdAt: 1 }
const snapshot = { schema: 1, accountCollection: 'confirmed', capacity: { count: 1, nearFullAt: 240, capacityKnown: false },
  items: [item], limited: false, pending: 0 }

test('sticker settings use two separate 15 percent defaults and accept fractional percentages', () => {
  assert.equal(DEFAULT_STICKER_LIBRARY_CONFIGURATION.triggerProbabilityPercent, 15)
  assert.equal(DEFAULT_STICKER_LIBRARY_CONFIGURATION.collectProbabilityPercent, 15)
  assert.deepEqual(validateStickerLibraryConfiguration({ ...DEFAULT_STICKER_LIBRARY_CONFIGURATION,
    triggerProbabilityPercent: 0.5, collectProbabilityPercent: 99.9 }), { ...DEFAULT_STICKER_LIBRARY_CONFIGURATION,
    triggerProbabilityPercent: 0.5, collectProbabilityPercent: 99.9 })
  for (const invalid of [-1, 101, Infinity, NaN, '15']) assert.throws(() => validateStickerLibraryConfiguration({
    ...DEFAULT_STICKER_LIBRARY_CONFIGURATION, triggerProbabilityPercent: invalid }))
  assert.throws(() => validateStickerLibraryConfiguration({ ...DEFAULT_STICKER_LIBRARY_CONFIGURATION, accountNearFullAt: 1.5 }))
  assert.throws(() => validateStickerLibraryConfiguration({ ...DEFAULT_STICKER_LIBRARY_CONFIGURATION, ownerOnly: true }))
})

test('complete manual annotations distinguish preserved, cleared and user-authored roles without inventing provenance', () => {
  const annotation = { description: '', tags: [], avoid: '',
    facets: { emotions: [], actions: [], intents: [], scenes: [], visibleText: '' }, visual: { colors: [], styles: [], entities: [] } }
  const input = { id: item.id, revision: 1, annotation }
  assert.deepEqual(parseStickerLibraryAnnotationUpdate(input), input)
  assert.deepEqual(parseStickerLibraryAnnotationUpdate({ ...input, identity: null }), { ...input, identity: null })
  assert.deepEqual(parseStickerLibraryAnnotationUpdate({ ...input, identity: { character: ' 角色甲 ', aliases: ['甲', '甲'] } })?.identity,
    { character: '角色甲', aliases: ['甲'] })
  for (const invalid of [{ ...input, annotation: { ...annotation, tags: ['重复', '重复'] } },
    { ...input, identity: { character: '角色甲', aliases: [], source: 'user' } },
    { ...input, annotation: { ...annotation, facets: { ...annotation.facets, emotions: ['1', '2', '3', '4', '5'] } } },
    { ...input, annotation: { ...annotation, description: 'a'.repeat(241) } }]) assert.equal(parseStickerLibraryAnnotationUpdate(invalid), null)
  assert.deepEqual(parseStickerLibraryAnnotationUpdateResult({ status: 'confirmed', id: item.id, revision: 2, annotation, identity: null }),
    { status: 'confirmed', id: item.id, revision: 2, annotation, identity: null })
  assert.equal(parseStickerLibraryAnnotationUpdateResult({ status: 'confirmed', id: item.id, revision: 2, annotation }), null)
})

test('optional sticker delivery statistics remain bounded and do not affect legacy snapshots', () => {
  const usage = { sentCount: 3, lastSentAt: 1000 }
  assert.deepEqual(parseStickerLibrarySnapshot({ ...snapshot, items: [{ ...item, usage }] })?.items[0]?.usage, usage)
  assert.deepEqual(parseStickerLibrarySnapshot({ ...snapshot, items: [{ ...item, usage: { sentCount: 0, lastSentAt: null } }] })?.items[0]?.usage,
    { sentCount: 0, lastSentAt: null })
  for (const invalid of [{ sentCount: -1, lastSentAt: null }, { sentCount: 1.5, lastSentAt: 1 },
    { sentCount: 1, lastSentAt: -1 }, { sentCount: Number.MAX_SAFE_INTEGER + 1, lastSentAt: 1 }])
    assert.equal(parseStickerLibrarySnapshot({ ...snapshot, items: [{ ...item, usage: invalid }] }), null)
})

test('sticker snapshot strips private fields and refuses ambiguous identifiers or deletion state', () => {
  const parsed = parseStickerLibrarySnapshot({ ...snapshot, accountId: 'private-account', directory: '/private',
    items: [{ ...item, url: 'https://private.example', source: { path: '/private/image' } }] })
  assert.deepEqual(parsed, snapshot)
  for (const invalid of [{ ...item, state: 'unknown' }, { ...item, revision: 0 }, { ...item, id: '../image' },
    { ...item, tags: ['开心', '开心'] }, { ...item, tags: [''] }, { ...item, createdAt: -1 }]) {
    assert.equal(parseStickerLibrarySnapshot({ ...snapshot, items: [invalid] }), null)
  }
  assert.equal(parseStickerLibrarySnapshot({ ...snapshot, items: [item, item] }), null)
  assert.equal(parseStickerLibrarySnapshot({ ...snapshot, capacity: { ...snapshot.capacity, capacityKnown: true } }), null)
})

test('sticker snapshot accommodates full account and extra storage without truncating the contract', () => {
  const items = Array.from({ length: 6100 }, (_, index) => ({ ...item, id: index.toString(16).padStart(64, '0') }))
  assert.equal(parseStickerLibrarySnapshot({ ...snapshot, items })?.items.length, 6100)
  assert.equal(parseStickerLibrarySnapshot({ ...snapshot, items: Array.from({ length: 7001 }, (_, index) => ({ ...item,
    id: index.toString(16).padStart(64, '0') })) }), null)
})

test('sticker previews accept bounded JPEG or animated WebP data and deletion receipts cannot request retries', () => {
  assert.deepEqual(parseStickerLibraryThumbnail({ image: 'data:image/jpeg;base64,/9j/', url: 'private' }), { image: 'data:image/jpeg;base64,/9j/' })
  const animated = { image: 'data:image/webp;base64,UklGRg==', animation: 'animated' }
  assert.deepEqual(parseStickerLibraryThumbnail(animated), animated)
  assert.equal(parseStickerLibraryThumbnail({ image: 'data:image/jpeg;base64,/9j/', animation: 'animated' }), null)
  assert.equal(parseStickerLibraryThumbnail({ ...animated, animation: 'unknown' }), null)
  for (const image of ['https://private.example', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/jpeg;base64,',
    'data:image/jpeg;base64,abc==', `data:image/jpeg;base64,${'a'.repeat(200_000)}`]) assert.equal(parseStickerLibraryThumbnail({ image }), null)
  for (const status of ['confirmed', 'rejected', 'unknown']) {
    assert.deepEqual(parseStickerLibraryDeleteResult({ status, debugPath: '/private' }), { status, retry: false })
  }
  assert.equal(parseStickerLibraryDeleteResult({ status: 'confirmed', retry: true }), null)
  assert.equal(parseStickerLibraryDeleteResult({ status: 'success' }), null)
})

test('layout dimensions remain optional and describe a bounded original aspect ratio', () => {
  const dimensions = { width: 1200, height: 600 }
  assert.deepEqual(parseStickerLibrarySnapshot({ ...snapshot, items: [{ ...item, dimensions }] })?.items[0]?.dimensions, dimensions)
  assert.deepEqual(parseStickerLibraryThumbnail({ image: 'data:image/jpeg;base64,/9j/', ...dimensions }), { image: 'data:image/jpeg;base64,/9j/', ...dimensions })
  for (const invalid of [{ width: 0, height: 10 }, { width: 1.5, height: 10 }, { width: 100_001, height: 1 }, { width: 8000, height: 8000 }]) {
    assert.equal(parseStickerLibrarySnapshot({ ...snapshot, items: [{ ...item, dimensions: invalid }] }), null)
    assert.equal(parseStickerLibraryThumbnail({ image: 'data:image/jpeg;base64,/9j/', ...invalid }), null)
  }
  assert.equal(parseStickerLibraryThumbnail({ image: 'data:image/jpeg;base64,/9j/', width: 100 }), null)
})

test('manual character inputs normalize aliases without accepting provenance or empty clearing', () => {
  const input = { id: item.id, revision: 1, identity: { character: ' 角色甲 ', aliases: ['角色_A', '角色 A', '角色甲'] } }
  assert.deepEqual(parseStickerLibraryIdentityUpdate(input), { id: item.id, revision: 1, identity: { character: '角色甲', aliases: ['角色_A'] } })
  for (const invalid of [{ ...input, revision: 0 }, { ...input, identity: { character: '', aliases: [] } },
    { ...input, identity: { ...input.identity, source: 'user' } }, { ...input, identity: { ...input.identity, references: [] } }]) {
    assert.equal(parseStickerLibraryIdentityUpdate(invalid), null)
  }
  assert.equal(parseStickerLibraryIdentityUpdateResult({ status: 'confirmed', id: item.id, revision: 2,
    identity: { character: '角色甲', aliases: [], source: 'model' } }), null)
})
