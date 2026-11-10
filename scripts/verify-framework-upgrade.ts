import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { isRecord } from '../src/contracts/values.ts';

// A real previous release is the upgrade fixture; never synthesize an older version by editing metadata.
const previous = '1.12.0';
export async function verifyFrameworkUpgrade(candidate: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'qbf-previous-release-'));
  const run = promisify(execFile), prefix = `qq-bridge-framework-${previous}`;
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:/Windows', 'System32/tar.exe') : 'tar';
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' }; delete env.QQ_BRIDGE_FRAMEWORK_CONFIG;
  try {
    const base = `https://github.com/sophisticate9008/qq-bridge-framework/releases/download/v${previous}`;
    const sums = await fetch(`${base}/SHA256SUMS`, { signal: AbortSignal.timeout(60_000) }); assert(sums.ok);
    const line = (await sums.text()).split(/\r?\n/).find(line => line.endsWith(`  ${prefix}.tar.gz`));
    assert(line && /^[a-f0-9]{64}  /.test(line));
    const response = await fetch(`${base}/${prefix}.tar.gz`, { signal: AbortSignal.timeout(180_000) }); assert(response.ok);
    const bytes = new Uint8Array(await response.arrayBuffer()); assert(bytes.byteLength < 256 * 1024 * 1024);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), line.slice(0, 64));
    const archive = join(directory, 'old.tar.gz'); await writeFile(archive, bytes);
    await run(tar, ['-xzf', archive, '-C', directory], { timeout: 60_000 });
    const old = join(directory, prefix), cli = join(old, 'dist/scripts/cli.js');
    const npm = process.platform === 'win32' ? process.execPath : 'npm';
    const npmArgs = process.platform === 'win32' ? [join(old, 'dist/scripts/windows-launcher.js'), '--install-dependencies'] : ['ci', '--omit=dev', '--no-audit', '--no-fund'];
    await run(npm, npmArgs, { cwd: old, env, timeout: 240_000, maxBuffer: 1024 * 1024 });
    await run(process.execPath, [cli, 'init'], { cwd: old, env, timeout: 60_000 });
    const config = await readFile(join(old, 'runtime/admin/config.json'), 'utf8');
    await mkdir(join(old, 'private/extensions/custom'), { recursive: true });
    await writeFile(join(old, 'private/extensions/custom/local.ts'), 'export const retained = true;');
    await writeFile(join(old, 'custom-settings.json'), '{"retained":true}');
    const database = new DatabaseSync(join(old, 'runtime/upgrade-proof.sqlite'));
    database.exec('CREATE TABLE evidence (id TEXT PRIMARY KEY, value TEXT); INSERT INTO evidence VALUES (\'session-1\', \'retained history\');'); database.close();
    const expected: unknown = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8')); assert(isRecord(expected) && typeof expected.version === 'string');
    const majorChanged = expected.version.split('.')[0] !== previous.split('.')[0];
    const updater = join(candidate, 'dist/scripts/update-framework.js');
    if (majorChanged) {
      await assert.rejects(run(process.execPath, [updater, '--target', old],
        { cwd: old, env, timeout: 360_000, maxBuffer: 1024 * 1024 }));
      assert.equal(JSON.parse(await readFile(join(old, 'package.json'), 'utf8')).version, previous);
      assert.equal(await readFile(join(old, 'runtime/admin/config.json'), 'utf8'), config);
    }
    const result = await run(process.execPath, [updater, '--target', old, ...(majorChanged ? ['--allow-major'] : [])],
      { cwd: old, env, timeout: 360_000, maxBuffer: 1024 * 1024 });
    assert.match(result.stdout, /已更新到/);
    assert.equal(await readFile(join(old, 'runtime/admin/config.json'), 'utf8'), config);
    assert.equal(await readFile(join(old, 'private/extensions/custom/local.ts'), 'utf8'), 'export const retained = true;');
    assert.equal(await readFile(join(old, 'custom-settings.json'), 'utf8'), '{"retained":true}');
    const reopened = new DatabaseSync(join(old, 'runtime/upgrade-proof.sqlite'), { readOnly: true });
    try { assert.equal(reopened.prepare('SELECT value FROM evidence WHERE id = ?').get('session-1')?.value, 'retained history'); } finally { reopened.close(); }
    const actual: unknown = JSON.parse(await readFile(join(old, 'package.json'), 'utf8')); assert(isRecord(actual));
    assert.equal(actual.version, expected.version);
    await run(process.execPath, [cli, '--version'], { cwd: old, env, timeout: 30_000 });
    console.log(`Previous release ${previous} -> ${String(actual.version)}: configuration, SQLite data and private extension preserved.`);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
