import { htmlRendererBuildHash } from '../../scripts/html-renderer-component.ts';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const upstream = resolve('.cache/blitz-source');
const target = `${process.platform}-${process.arch}`;
const output = resolve('runtime/html-renderer', target);
await mkdir(join(output, 'licenses'), { recursive: true });
const binary = process.platform === 'win32' ? 'qbf-html-renderer.exe' : 'qbf-html-renderer';
const original = process.platform === 'win32' ? 'qbf-html-probe.exe' : 'qbf-html-probe';
await copyFile(join(upstream, 'target/production/examples', original), join(output, binary));
const metadata: unknown = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--manifest-path', join(upstream, 'Cargo.toml')], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
if (!metadata || typeof metadata !== 'object' || !('packages' in metadata) || !Array.isArray(metadata.packages)) throw new Error('Invalid Cargo metadata');
const notices: { name: string; version: string; license: string | null; files: string[] }[] = [];
for (const entry of metadata.packages as unknown[]) {
  if (!entry || typeof entry !== 'object' || !('name' in entry) || typeof entry.name !== 'string'
    || !('version' in entry) || typeof entry.version !== 'string' || !('manifest_path' in entry) || typeof entry.manifest_path !== 'string') throw new Error('Invalid Cargo package');
  const base = dirname(entry.manifest_path);
  const names = (await readdir(base)).filter((name) => /^(?:licen[cs]e|copying|notice)(?:[._-]|$)/i.test(name));
  if ('license_file' in entry && typeof entry.license_file === 'string') names.push(entry.license_file);
  const files: string[] = [];
  for (const [index, name] of [...new Set(names)].entries()) {
    const path = resolve(base, name);
    const { lstat } = await import('node:fs/promises');
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) continue;
    const filename = `${entry.name}-${entry.version}-${index}.txt`;
    await copyFile(path, join(output, 'licenses', filename));
    files.push(filename);
  }
  notices.push({ name: entry.name, version: entry.version, license: 'license' in entry && typeof entry.license === 'string' ? entry.license : null, files });
}
await copyFile(join(upstream, 'Cargo.lock'), join(output, 'Cargo.lock'));
await writeFile(join(output, 'licenses/dependencies.json'), JSON.stringify(notices, null, 2) + '\n');
await writeFile(join(output, 'component.json'), JSON.stringify({ schema: 1, protocol: 1, engine: 'blitz', target, binary,
  upstream: process.env.BLITZ_REV, sourceCommit: process.env.GITHUB_SHA,
  buildHash: await htmlRendererBuildHash(process.cwd()), rust: "1.92.0",
  sha256: createHash('sha256').update(await readFile(join(output, binary))).digest('hex'), maxHtmlBytes: 4 * 1024 * 1024,
  resourcePolicy: 'no-network-no-files-no-scripts',
}, null, 2) + '\n');
console.log(`Packaged HTML renderer: ${target}`);
