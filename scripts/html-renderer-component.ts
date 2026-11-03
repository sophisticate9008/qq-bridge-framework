import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Framework versions and source commits deliberately do not invalidate this component. */
export async function htmlRendererBuildHash(root: string): Promise<string> {
  const hash = createHash('sha256');
  for (const name of ['tools/html-renderer/config.json', 'tools/html-renderer/Cargo.lock',
    'tools/html-renderer/main.rs', 'tools/html-renderer/prepare.ts', 'tools/html-renderer/package.ts',
    'tools/blitz-probe/prepare.ts']) {
    hash.update(name + '\0').update(await readFile(join(root, name))).update('\0');
  }
  return hash.digest('hex');
}
