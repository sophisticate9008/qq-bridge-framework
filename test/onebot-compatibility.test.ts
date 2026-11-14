import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectOneBotCompatibility, oneBotCompatibilityProfile } from '../src/adapters/onebot-compatibility.ts';

test('compatibility profiles require an exact registered fingerprint and supported version', () => {
  const fingerprint = '519040c4771fe50b0dab116577b7be81849836646457c60bf9562ea678f1b0a2';
  assert.deepEqual(oneBotCompatibilityProfile(fingerprint, '4.18.41'), { qqCatalog: true, qzone: true });
  assert.deepEqual(oneBotCompatibilityProfile(fingerprint, '4.18.13'), { qqCatalog: false, qzone: false });
  assert.deepEqual(oneBotCompatibilityProfile(fingerprint, '4.18.14'), { qqCatalog: false, qzone: true });
  assert.deepEqual(oneBotCompatibilityProfile(fingerprint, '4.18.42'), { qqCatalog: false, qzone: true });
  assert.deepEqual(oneBotCompatibilityProfile('unregistered', '4.18.41'), { qqCatalog: false, qzone: false });
  assert.deepEqual(oneBotCompatibilityProfile(fingerprint, null), { qqCatalog: false, qzone: false });
  assert.deepEqual(inspectOneBotCompatibility('OneBot.Fixture', '4.18.41'), { qqCatalog: false, qzone: false });
});
