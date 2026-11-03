import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { htmlRendererBuildHash } from '../scripts/html-renderer-component.ts';

test('component identity ignores checkout line endings but changes for real source edits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qbf-html-identity-'));
  try {
    const names = ['tools/html-renderer/config.json', 'tools/html-renderer/Cargo.lock',
      'tools/html-renderer/main.rs', 'tools/html-renderer/prepare.ts', 'tools/html-renderer/package.ts', 'tools/blitz-probe/prepare.ts'];
    const original = await htmlRendererBuildHash(process.cwd());
    for (const name of names) {
      await mkdir(dirname(join(directory, name)), { recursive: true });
      await writeFile(join(directory, name), (await readFile(name, 'utf8')).replace(/\r?\n/g, '\r\n'));
    }
    assert.equal(await htmlRendererBuildHash(directory), original);
    await writeFile(join(directory, names[2]!), '// changed renderer source\n');
    assert.notEqual(await htmlRendererBuildHash(directory), original);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
