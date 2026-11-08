import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
const version = (JSON.parse(await readFile('package.json', 'utf8')) as { version: string }).version;
const directory = resolve(`private/maintenance/releases/v${version}`);
const name = `qq-bridge-framework-dsh-bridge-plugin-${version}.tgz`;
const sums = (await readFile(join(directory, 'SHA256SUMS'), 'utf8')).split(/\r?\n/);
const expected = sums.find(line => line.endsWith(`  ${name}`))?.split(' ')[0]; assert(expected);
assert.equal(createHash('sha256').update(await readFile(join(directory, name))).digest('hex'), expected);
await mkdir('private/maintenance/work-platform', { recursive: true });
const temporary = await mkdtemp(resolve('private/maintenance/work-platform/component-'));
execFileSync('tar', ['-xzf', join(directory, name), '-C', temporary], { stdio: 'inherit' });
execFileSync(process.execPath, ['--test', 'packages/dsh-bridge-plugin/test/work-platform.test.ts'], {
  env: { ...process.env, QBF_WORK_PLATFORM_PACKAGE: join(temporary, 'package') }, stdio: 'inherit' });
await writeFile('work-path-platform-result.json', JSON.stringify({ platform: process.platform, arch: process.arch, version,
  componentSha256: expected, sourceCommit: process.env.GITHUB_SHA ?? null, status: 'passed', nativePrivateStorageVerified: true,
  bytes: 104857600, wholeFileSha256Verified: true }, null, 2));
