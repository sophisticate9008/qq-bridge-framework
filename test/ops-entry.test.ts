import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('the fixed operations entry selects compiled archive code and source checkout code', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'qbf-fixed-entry-'));
  try {
    for (const path of ['ops', 'scripts', 'dist/scripts']) await mkdir(join(root, path), { recursive: true });
    await copyFile(new URL(import.meta.url.endsWith('.js') ? '../../ops/qbf-cli' : '../ops/qbf-cli', import.meta.url), join(root, 'ops/qbf-cli'));
    await writeFile(join(root, 'scripts/service-manager.ts'), 'console.log("source-entry")');
    await writeFile(join(root, 'dist/scripts/service-manager.js'), 'console.log("compiled-entry")');
    const run = () => spawnSync('/bin/sh', [join(root, 'ops/qbf-cli'), 'describe', '--json'], { encoding: 'utf8', timeout: 5000 });
    const archive = run(); assert.equal(archive.status, 0, archive.stderr); assert.equal(archive.stdout.trim(), 'compiled-entry');
    await mkdir(join(root, '.git'));
    const checkout = run(); assert.equal(checkout.status, 0, checkout.stderr); assert.equal(checkout.stdout.trim(), 'source-entry');
  } finally { await rm(root, { recursive: true, force: true }); }
});
