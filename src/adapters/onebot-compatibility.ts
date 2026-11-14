import { createHash } from 'node:crypto';

/** Stable implementation fingerprints keep compatibility profiles separate from product names. */
const extendedProtocolFingerprints = new Set([
  'd99735984a6e5fc85daa6feb549e9d2240a70bc79552a9766e9093d94cfb7341',
  '519040c4771fe50b0dab116577b7be81849836646457c60bf9562ea678f1b0a2',
]);
export function oneBotCompatibilityProfile(fingerprint: string, version: string | null): { readonly qqCatalog: boolean; readonly qzone: boolean } {
  if (!extendedProtocolFingerprints.has(fingerprint) || version === null) return { qqCatalog: false, qzone: false };
  const normalized = version.replace(/^v/, '');
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(normalized);
  return { qqCatalog: normalized === '4.18.41', qzone: parts !== null
    && (Number(parts[1]) > 4 || Number(parts[1]) === 4 && (Number(parts[2]) > 18 || Number(parts[2]) === 18 && Number(parts[3]) >= 14)) };
}
export function inspectOneBotCompatibility(name: string, version: string | null) {
  return oneBotCompatibilityProfile(createHash('sha256').update(name.toLowerCase()).digest('hex'), version);
}
