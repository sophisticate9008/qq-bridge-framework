import assert from 'node:assert/strict';
import test from 'node:test';
import { createSqliteStore } from '../src/storage/sqlite.ts';
import { createNativeUsage, type NativeUsageTurn } from '../src/host/native-usage.ts';
import { createNativeUsageProjection } from '../src/host/native-usage-projection.ts';
import { formatActivityCost, formatUsageCount, parseUsageSnapshot, sumUsageCounts } from '../web/lib/activity.ts';
import { parseUsageConversation, parseUsageRecent, parseUsageSeries } from '../web/lib/usage-details.ts';
import { parseUsagePricing, parseUsagePricingProviders, pricesFromDraft, validUsagePriceRoutes } from '../web/lib/usage-pricing.ts';

const turn: NativeUsageTurn = { conversationId: 'private:123', sessionId: 'synthetic-session', generation: 1, turnId: 'turn:non-numeric', stepId: 'step:one',
  coverage: 'complete', provider: 'fixture-provider', model: 'fixture-model', status: 'completed', tokens: { input: 100, output: 20, cacheRead: 40, cacheWrite: 10, total: 170 }, reportedCost: null };
const price = { provider: turn.provider, model: turn.model, currency: 'USD', inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0.1, cacheWritePerMillion: 0.5 };

test('actual native projections parse empty, complete, partial and mixed-currency data without invented zeros', context => {
  const store = createSqliteStore({ filename: ':memory:' });
  context.after(() => store.close());
  const clock = () => Date.UTC(2026, 9, 25);
  const usage = createNativeUsage({ store, clock });
  const projection = createNativeUsageProjection({ usage, clock });
  const empty = parseUsageSnapshot(projection.summary());
  assert(empty);
  assert.equal(empty.totals.totalTokens, null);
  assert.equal(empty.totals.cost, null);
  assert.equal(empty.coverage?.tokenUsageAvailable, false);
  assert.equal(parseUsageSeries(projection.series())?.buckets.every(bucket => bucket.tokens === null && bucket.cost === null), true);
  usage.setPricing([price], null);
  const recorded = usage.append(turn);
  assert(!('retired' in recorded));
  const summary = parseUsageSnapshot(projection.summary());
  assert(summary);
  assert.equal(summary.totals.totalTokens, 170);
  assert.equal(summary.totals.reasoningTokens, null);
  assert.equal(summary.nowTier?.tier, 'flat');
  assert.equal(summary.priceTable?.pricingMode, 'flat');
  assert.equal(summary.ledger, null);
  assert.equal(summary.resetAvailable, true);
  const series = parseUsageSeries(projection.series());
  assert(series);
  assert.equal(series.totals.tokens, 170);
  assert.equal(series.buckets.filter(bucket => bucket.tokens !== null).length, 1);
  const details = parseUsageConversation(projection.conversation(turn.conversationId), turn.conversationId);
  assert(details);
  assert.equal(details.turns[0].turn, null);
  assert.equal(details.turns[0].turnId, turn.turnId);
  const recent = parseUsageRecent(projection.recent());
  assert(recent);
  assert.equal(recent.entries[0].retry, null);
  assert.equal(recent.entries[0].knownCost?.currency, 'USD');
  usage.setPricing([{ ...price, inputPerMillion: 100 }], usage.pricing().revision);
  assert.equal(usage.recent().items[0].cost?.amount, recorded.cost?.amount);
  usage.append({ ...turn, turnId: 'unknown', coverage: 'unknown', tokens: { input: null, output: null, cacheRead: null, cacheWrite: null, total: null } });
  const partial = parseUsageSnapshot(projection.summary());
  assert(partial);
  assert.equal(partial.totals.totalTokens, 170);
  assert.equal(partial.totals.cost, recorded.cost?.amount);
  assert.equal(partial.coverage?.knownTokens.total, 170);
  assert.equal(partial.coverage?.missingTokens.total, 1);
  assert.equal(partial.conversations[0].knownCosts?.USD, recorded.cost?.amount);
  usage.append({ ...turn, turnId: 'other-currency', reportedCost: { amount: 3, currency: 'CNY' } });
  const mixed = parseUsageSnapshot(projection.summary());
  assert(mixed);
  assert.equal(mixed.currency, 'MULTI');
  assert.equal(mixed.totals.cost, null);
  assert.equal(mixed.coverage?.knownCosts.CNY, 3);
  assert.equal(parseUsageRecent(projection.recent())?.entries.find(entry => entry.turnId === 'other-currency')?.knownCost?.currency, 'CNY');
});

test('unknown formatting and nullable sums cannot become display or graph zeros', () => {
  assert.equal(formatUsageCount(null), '未知');
  assert.equal(formatActivityCost(null, 'USD', '$'), '未知');
  assert.equal(sumUsageCounts(10, null, 5), null);
  assert.equal(sumUsageCounts(0, 0, 0), 0);
});

test('pricing parser preserves numeric CAS and validates explicit bounded unique component prices', () => {
  assert.deepEqual(parseUsagePricing({ revision: null, prices: [] }), { revision: null, prices: [] });
  assert.equal(parseUsagePricing({ revision: '1', prices: [price] }), null);
  assert.equal(parseUsagePricing({ revision: 0, prices: [price] }), null);
  assert.equal(parseUsagePricing({ revision: 1, prices: [price, price] }), null);
  assert.equal(parseUsagePricing({ revision: 1, prices: [{ ...price, cacheReadPerMillion: null }] }), null);
  assert.equal(parseUsagePricing({ revision: 1, prices: [{ ...price, inputPerMillion: 1_000_001 }] }), null);
  assert.equal(parseUsagePricing({ revision: 1, prices: [{ ...price, provider: 'a'.repeat(129) }] }), null);
  const row = { key: 1, provider: price.provider, model: price.model, currency: 'usd', inputPerMillion: '1', outputPerMillion: '2', cacheReadPerMillion: '0.1', cacheWritePerMillion: '0.5' };
  assert.deepEqual(pricesFromDraft([row]), [price]);
  assert.equal(pricesFromDraft([{ ...row, inputPerMillion: '' }]), null);
  assert.equal(pricesFromDraft([{ ...row, inputPerMillion: 'Infinity' }]), null);
  assert.equal(pricesFromDraft([{ ...row, inputPerMillion: '-1' }]), null);
});

test('new pricing routes require the central enabled catalog while unchanged historical routes retain editable amounts', () => {
  const providers = parseUsagePricingProviders({ providers: [{ id: price.provider, name: '合成模型服务', enabled: true, models: [{ id: price.model, name: '合成聊天模型' }], apiKeyConfigured: true }] });
  assert(providers);
  assert.equal(validUsagePriceRoutes([price], [], providers), true);
  assert.equal(validUsagePriceRoutes([{ ...price, model: 'unregistered' }], [], providers), false);
  assert.equal(validUsagePriceRoutes([price], [], providers.map(provider => ({ ...provider, enabled: false }))), false);
  const historic = { ...price, provider: 'retired-provider', model: 'retired-model' };
  assert.equal(validUsagePriceRoutes([{ ...historic, inputPerMillion: 5 }], [historic], providers), true);
  assert.equal(validUsagePriceRoutes([{ ...historic, model: 'different-route' }], [historic], providers), false);
  assert.equal(Object.hasOwn(providers[0], 'apiKeyConfigured'), false);
});

test('cache hit rates use paired valid observations across summary, session and turn without partial-record poisoning', context => {
  const store = createSqliteStore({ filename: ':memory:' });
  context.after(() => store.close());
  const usage = createNativeUsage({ store });
  usage.setPricing([price], null);
  usage.append(turn);
  usage.append({ ...turn, stepId: 'step:missing-input', coverage: 'partial',
    tokens: { input: null, output: null, cacheRead: 900, cacheWrite: null, total: null } });
  usage.append({ ...turn, turnId: 'all-unknown', coverage: 'unknown',
    tokens: { input: null, output: null, cacheRead: null, cacheWrite: null, total: null } });
  const projection = createNativeUsageProjection({ usage });
  const summary = parseUsageSnapshot(projection.summary());
  assert(summary);
  const expected = { includedRecords: 1, excludedRecords: 2, inputTokens: 150, cacheHitTokens: 40 };
  assert.equal(summary.totals.cacheHitRate, 40 / 150);
  assert.deepEqual(summary.totals.cacheHitCoverage, expected);
  assert.equal(summary.conversations[0].cacheHitRate, 40 / 150);
  assert.deepEqual(summary.conversations[0].cacheHitCoverage, expected);
  // The skipped observation's known tokens remain visible, but do not pollute the ratio.
  assert.equal(summary.totals.cacheHitTokens, 940);
  assert.equal(summary.coverage?.missingTokens.input, 2);
  const details = parseUsageConversation(projection.conversation(turn.conversationId), turn.conversationId);
  assert(details);
  const mixed = details.turns.find(item => item.turnId === turn.turnId);
  assert(mixed);
  assert.equal(mixed.cacheHitRate, 40 / 150);
  assert.deepEqual(mixed.cacheHitCoverage, { ...expected, excludedRecords: 1 });
  assert.equal(details.turns.find(item => item.turnId === 'all-unknown')?.cacheHitRate, null);
  const bounded = createNativeUsageProjection({ usage: { ...usage, snapshot(query) {
    return { ...usage.snapshot(query), truncated: true };
  }, summary(query) { return { ...usage.summary(query), partial: true }; } } });
  const partial = parseUsageSnapshot(bounded.summary());
  assert(partial?.coverage?.partial);
  assert.equal(partial.totals.cacheHitRate, 40 / 150);
  assert.deepEqual(partial.totals.cacheHitCoverage, expected);
});

test('cache ratios depend on available input and cache counts rather than unrelated coverage and costs', context => {
  const store = createSqliteStore({ filename: ':memory:' });
  context.after(() => store.close());
  const usage = createNativeUsage({ store });
  usage.append({ ...turn, coverage: 'partial', tokens: { input: null, output: 20, cacheRead: 25, cacheWrite: null, total: 120 } });
  const projection = createNativeUsageProjection({ usage });
  const summary = parseUsageSnapshot(projection.summary());
  assert(summary);
  assert.equal(summary.totals.cacheHitRate, 0.25);
  assert.deepEqual(summary.totals.cacheHitCoverage, { includedRecords: 1, excludedRecords: 0, inputTokens: 100, cacheHitTokens: 25 });
  const payload = projection.summary();
  assert(parseUsageSnapshot({ ...payload, totals: { ...payload.totals, cacheHitCoverage: undefined } }));
  assert.equal(parseUsageSnapshot({ ...payload, totals: { ...payload.totals,
    cacheHitCoverage: { includedRecords: 1, excludedRecords: 0, inputTokens: 10, cacheHitTokens: 11 } } }), null);
  usage.append({ ...turn, turnId: 'unknown-cache', tokens: { input: null, output: 20, cacheRead: null, cacheWrite: null, total: 220 } });
  assert.equal(parseUsageSnapshot(projection.summary())?.totals.cacheHitRate, 0.25);
});

test('empty, zero-input and wholly missing cache samples remain distinguishable', context => {
  const store = createSqliteStore({ filename: ':memory:' });
  context.after(() => store.close());
  const usage = createNativeUsage({ store });
  const projection = createNativeUsageProjection({ usage });
  assert.equal(parseUsageSnapshot(projection.summary())?.totals.cacheHitRate, null);
  usage.append({ ...turn, tokens: { input: null, output: null, cacheRead: null, cacheWrite: null, total: null } });
  const missing = parseUsageSnapshot(projection.summary());
  assert.equal(missing?.totals.cacheHitRate, null);
  assert.equal(missing?.totals.cacheHitCoverage?.excludedRecords, 1);
  usage.append({ ...turn, turnId: 'zero', tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  assert.equal(parseUsageSnapshot(projection.summary())?.totals.cacheHitRate, 0);
});
