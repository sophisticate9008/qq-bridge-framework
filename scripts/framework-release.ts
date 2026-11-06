import { isDistributionPath, type DistributionFile } from '../src/contracts/framework-distribution.ts';
import { htmlRendererBuildHash } from './html-renderer-component.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isRecord } from '../src/core/values.ts';

export function assertFrameworkReleasePath(filename: string): void {
  assert(filename && !filename.startsWith('/') && !/[\\\x00-\x1f\x7f]/.test(filename)
    && filename.split('/').every(part => part && !['.', '..', '.git', 'private', 'runtime', 'data', 'workspace', 'node_modules', '.cache'].includes(part))
    && !/(?:^|\/)\.env(?:\.|$)/.test(filename) && !/\.(?:sqlite(?:-wal|-shm)?|zstd|jsonl)$/.test(filename),
  `Private or invalid release path: ${filename}`);
}

/** Keep the source checkout's commands; the end-user archive starts its prebuilt backend. */
export function frameworkRuntimeManifest(value: unknown): Record<string, unknown> {
  assert(isRecord(value) && value.name === 'qq-bridge-framework' && typeof value.version === 'string'
    && isRecord(value.scripts) && isRecord(value.bin));
  return { ...value, scripts: { ...value.scripts, start: 'node dist/scripts/cli.js start', cli: 'node dist/scripts/cli.js' },
    bin: { 'qbf-cli': 'dist/scripts/cli.js', 'qq-bridge-framework': 'dist/scripts/cli.js',
      'qqbridge-framework': 'dist/scripts/legacy-service-cli.js' } };
}

export async function packFrameworkRelease(options: {
  readonly root: string;
  readonly destination: string;
  readonly version: string;
  readonly components: readonly string[];
}): Promise<string> {
  assert(/^\d+\.\d+\.\d+$/.test(options.version));
  const root = await realpath(options.root);
  const temporary = await mkdtemp(join(tmpdir(), 'qqbf-release-'));
  const name = `qq-bridge-framework-${options.version}`;
  const stage = join(temporary, name);
  await mkdir(stage);
  let count = 0;
  async function copy(filename: string): Promise<void> {
    assertFrameworkReleasePath(filename);
    const source = join(root, filename), metadata = await lstat(source);
    assert(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= 32 * 1024 * 1024);
    assert.equal(await realpath(source), resolve(root, filename), 'Release files cannot traverse symlinks');
    const target = join(stage, filename);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    await chmod(target, metadata.mode & 0o111 ? 0o755 : 0o644);
    count++;
  }
  async function built(directory: string): Promise<void> {
    const metadata = await lstat(join(root, directory));
    assert(metadata.isDirectory() && !metadata.isSymbolicLink());
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const filename = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await built(filename);
      else { assert(entry.isFile() && !entry.isSymbolicLink()); await copy(filename); }
    }
  }
  try {
    // Only version-controlled public sources; never copy a checkout or deployment directory wholesale.
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const files = tracked.split('\0').filter(Boolean);
    assert(files.length > 0);
    for (const filename of files) { assert(!filename.endsWith('.tgz')); await copy(filename); }
    for (const directory of ['dist/src', 'dist/scripts', 'dist/admin-web', 'dist/assets']) await built(directory);
    for (const target of ['linux-x64', 'linux-arm64', 'win32-x64']) {
      const path = join(stage, 'dist/assets/native/html-renderer', target);
      const component: unknown = JSON.parse(await readFile(join(path, 'component.json'), 'utf8'));
      assert(isRecord(component) && component.protocol === 1 && component.target === target
        && component.buildHash === await htmlRendererBuildHash(root)
        && component.binary === (target.startsWith('win32-') ? 'qbf-html-renderer.exe' : 'qbf-html-renderer')
        && component.resourcePolicy === 'no-network-no-files-no-scripts', 'Build the matching native HTML components before release');
      assert.equal(createHash('sha256').update(await readFile(join(path, String(component.binary)))).digest('hex'), component.sha256);
    }
    for (const required of ['README.md', 'docs/DIRECTORIES.md', 'docs/EXTENDING.md', 'docs/SERVICE_CONVENTIONS.md',
      'examples/reloadable-plugin/README.md', 'packages/framework-sdk/README.md', 'dist/scripts/cli.js', 'dist/src/admin/server.js', 'dist/admin-web/index.html',
      'dist/admin-web/app.js', 'dist/src/storage/windows-acl-worker.js', 'dist/assets/fonts/wqy-microhei.ttc',
      'dist/assets/fonts/NotoSansMath-Regular.ttf', 'dist/assets/fonts/NotoSansSymbols2-Regular.ttf',
      'dist/assets/fonts/NotoSans-Regular.ttf']) assert((await lstat(join(stage, required))).isFile());
    assert((await readFile(join(stage, 'dist/src/admin/gateway.js'), 'utf8'))
      .includes(`const FRAMEWORK_VERSION = '${options.version}'`), 'Build the matching framework before packing');
    const manifest = frameworkRuntimeManifest(JSON.parse(await readFile(join(stage, 'package.json'), 'utf8')));
    assert.equal(manifest.version, options.version);
    await writeFile(join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    const lock: unknown = JSON.parse(await readFile(join(stage, 'package-lock.json'), 'utf8'));
    assert(isRecord(lock) && isRecord(lock.packages) && isRecord(lock.packages['']));
    lock.packages[''].bin = manifest.bin;
    await writeFile(join(stage, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
    await chmod(join(stage, 'dist/scripts/cli.js'), 0o755);
    const components: { filename: string; sha256: string }[] = [];
    await mkdir(join(stage, 'components'));
    for (const filename of options.components) {
      assert(/^qq-bridge-framework-(?:sdk|dsh-bridge-plugin)-\d+\.\d+\.\d+\.tgz$/.test(filename));
      const source = join(options.destination, filename), metadata = await lstat(source);
      assert(metadata.isFile() && !metadata.isSymbolicLink());
      const sha256 = createHash('sha256').update(await readFile(source)).digest('hex');
      await copyFile(source, join(stage, 'components', filename));
      components.push({ filename, sha256 });
    }
    const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const sourceModified = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() !== '';
    assert(!sourceModified, 'Commit the reviewed public sources before packing a framework release');
    const inventory: DistributionFile[] = [];
    async function inventoryDirectory(relative = ''): Promise<void> {
      for (const entry of await readdir(join(stage, relative), { withFileTypes: true })) {
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        assert(isDistributionPath(path), `Invalid managed update path: ${path}`);
        if (entry.isDirectory()) await inventoryDirectory(path);
        else {
          assert(entry.isFile() && !entry.isSymbolicLink());
          const metadata = await lstat(join(stage, path));
          inventory.push({ path, size: metadata.size, executable: Boolean(metadata.mode & 0o111),
            sha256: createHash('sha256').update(await readFile(join(stage, path))).digest('hex') });
        }
      }
    }
    await inventoryDirectory();
    await writeFile(join(stage, 'distribution.json'), JSON.stringify({ schema: 1, kind: 'framework-runtime',
      version: options.version, sourceCommit, sourceModified, components, publicFiles: count,
      compatibility: { data: 1, overwrite: 1 }, files: inventory.sort((a, b) => a.path.localeCompare(b.path)) }, null, 2) + '\n');
    const filename = join(options.destination, `${name}.tar.gz`);
    execFileSync('tar', ['-czf', filename, '-C', temporary, name], { stdio: 'pipe' });
    execFileSync('zip', ['-q', '-r', join(options.destination, `${name}-windows-x64.zip`), name], { cwd: temporary, stdio: 'pipe' });
    return filename;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
