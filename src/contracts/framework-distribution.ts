import { isRecord } from './values.ts';
import { releaseVersion } from './framework-release.ts';

export interface DistributionFile { readonly path: string; readonly sha256: string; readonly size: number; readonly executable: boolean }
export interface FrameworkDistribution {
  readonly schema: 1;
  readonly kind: 'framework-runtime';
  readonly version: string;
  readonly sourceCommit: string;
  readonly sourceModified: false;
  readonly files: readonly DistributionFile[];
  readonly compatibility: { readonly data: 1; readonly overwrite: 1 };
}
export function isDistributionPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    && !/[\\:\x00-\x1f\x7f]/.test(value)
    && value.split('/').every(part => part && !['.', '..', '.git', 'private', 'runtime', 'node_modules', '.cache'].includes(part)
      && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
    && !/(?:^|\/)\.env(?:\.|$)/.test(value) && !/\.(?:sqlite(?:-wal|-shm)?|zstd|jsonl)$/.test(value)
    && !value.startsWith('.framework-') && value !== 'distribution.json';
}
export function parseFrameworkDistribution(value: unknown): FrameworkDistribution | null {
  if (!isRecord(value) || value.schema !== 1 || value.kind !== 'framework-runtime' || !releaseVersion(value.version)
    || typeof value.sourceCommit !== 'string' || !/^[a-f0-9]{40}$/.test(value.sourceCommit) || value.sourceModified !== false
    || !isRecord(value.compatibility) || value.compatibility.data !== 1 || value.compatibility.overwrite !== 1
    || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > 20_000) return null;
  const names = new Set<string>(); let total = 0;
  for (const file of value.files) {
    if (!isRecord(file) || !isDistributionPath(file.path) || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)
      || !Number.isSafeInteger(file.size) || Number(file.size) < 0 || Number(file.size) > 64 * 1024 * 1024 || typeof file.executable !== 'boolean'
      || names.has(file.path.toLowerCase())) return null;
    names.add(file.path.toLowerCase()); total += Number(file.size);
  }
  if (total > 1024 * 1024 * 1024 || !names.has('package.json') || !names.has('dist/scripts/cli.js')) return null;
  return value as unknown as FrameworkDistribution;
}
