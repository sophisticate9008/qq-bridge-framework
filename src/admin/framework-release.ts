import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAMEWORK_REPOSITORY, FRAMEWORK_RELEASE_URL, compareReleaseVersions, releaseVersion, type FrameworkReleaseStatus } from '../contracts/framework-release.ts';
import { isRecord } from '../contracts/values.ts';
import { AdminRequestError, type AdminRoute } from './server.ts';

export function frameworkInstallationRoot(): string {
  const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
  return sourceRoot.replace(/[\\/]$/, '').endsWith(`${process.platform === 'win32' ? '\\' : '/'}dist`) ? dirname(sourceRoot) : sourceRoot;
}

export function createFrameworkReleaseService(options: { readonly version: string; readonly fetch?: typeof fetch;
  readonly installation?: FrameworkReleaseStatus['installation']; readonly now?: () => number }) {
  if (!releaseVersion(options.version)) throw new Error('invalid_release_version');
  const now = options.now ?? Date.now;
  const root = frameworkInstallationRoot();
  const installation = options.installation ?? (process.env.QQ_BRIDGE_FRAMEWORK_CONTAINER === '1' ? 'docker'
    : existsSync(join(root, 'distribution.json')) && !existsSync(join(root, '.git')) ? 'archive' : 'source');
  let cached: FrameworkReleaseStatus | undefined;
  let pending: Promise<FrameworkReleaseStatus> | undefined;
  async function check(): Promise<FrameworkReleaseStatus> {
    const base = { schema: 1 as const, currentVersion: options.version, installation, checkedAt: now() };
    try {
      const response = await (options.fetch ?? fetch)(`https://api.github.com/repos/${FRAMEWORK_REPOSITORY}/releases/latest`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'qq-bridge-framework-version-check' },
        signal: AbortSignal.timeout(8000), redirect: 'error',
      });
      if (!response.ok || !response.body) throw new Error('release_check_failed');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 512 * 1024) throw new Error('release_response_too_large');
          chunks.push(chunk.value);
        }
      } finally { await reader.cancel().catch(() => undefined); }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!isRecord(value) || value.draft !== false || value.prerelease !== false || typeof value.tag_name !== 'string'
        || !value.tag_name.startsWith('v') || !releaseVersion(value.tag_name.slice(1))) throw new Error('invalid_release');
      const latestVersion = value.tag_name.slice(1), comparison = compareReleaseVersions(latestVersion, options.version);
      return { ...base, latestVersion, state: comparison > 0 ? 'available' : comparison < 0 ? 'ahead' : 'current',
        majorUpgrade: Number(latestVersion.split('.')[0]) > Number(options.version.split('.')[0]),
        releaseUrl: `${FRAMEWORK_RELEASE_URL}/tag/v${latestVersion}`, error: null };
    } catch {
      return { ...base, latestVersion: cached?.latestVersion ?? null, state: 'unavailable', majorUpgrade: cached?.majorUpgrade ?? false,
        releaseUrl: cached?.releaseUrl ?? FRAMEWORK_RELEASE_URL, error: 'release_check_failed' };
    }
  }
  return { async read(force = false): Promise<FrameworkReleaseStatus> {
    // Coalesce tabs and bound manual checks as well as page reloads. No polling job calls GitHub.
    if (cached && now() - cached.checkedAt! < (force ? 10_000 : 60_000)) return cached;
    pending ??= check().then(value => { cached = value; return value; }).finally(() => { pending = undefined; });
    return pending;
  } };
}
export function createFrameworkReleaseRoutes(service: ReturnType<typeof createFrameworkReleaseService>): AdminRoute[] {
  return [{ method: 'GET', pathname: '/api/framework/version', async handle({ query }) {
    if (query.size && (query.size !== 1 || query.get('refresh') !== '1')) throw new AdminRequestError(400, 'invalid_query');
    return service.read(query.has('refresh'));
  } }];
}
