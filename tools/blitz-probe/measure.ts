import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, writeFile, appendFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const upstream = resolve('.cache/blitz-source');
const output = resolve('runtime/blitz-probe');
const executable = process.platform === 'win32' ? 'qbf-html-probe.exe' : 'qbf-html-probe';
const binary = resolve(upstream, 'target/production/examples', executable);
const packaged = resolve(output, 'package');
await mkdir(resolve(packaged, 'fonts'), { recursive: true });
await copyFile(binary, resolve(packaged, executable));
const font = resolve('assets/fonts/wqy-microhei.ttc');
await copyFile(font, resolve(packaged, 'fonts', basename(font)));
await copyFile(resolve('assets/fonts/LICENSE-WenQuanYi-Micro-Hei.txt'), resolve(packaged, 'fonts/LICENSE.txt'));
for (const license of ['LICENSE-MIT', 'LICENSE-APACHE']) await copyFile(resolve(upstream, license), resolve(packaged, license));
await copyFile(resolve(upstream, 'Cargo.lock'), resolve(output, 'Cargo.lock'));
const results: { name: string; width: number; height: number; pngBytes: number; elapsedMs: number; wallMs: number }[] = [];
for (const name of ['color', 'long']) {
  const started = performance.now();
  // Detached executable has no dependency on the upstream source or Cargo directories.
  const result = spawnSync(resolve(packaged, executable), [resolve(output, `${name}.html`), resolve(output, `${name}.png`), '1080', resolve(packaged, 'fonts', basename(font))], { cwd: packaged, encoding: 'utf8', timeout: 20_000 });
  if (result.error || result.status !== 0) throw new Error(`${name}: ${result.error?.message ?? result.stderr}`);
  const data: unknown = JSON.parse(result.stdout.trim());
  if (typeof data !== 'object' || data === null || !('height' in data) || typeof data.height !== 'number') throw new Error('Invalid renderer result');
  const png = await readFile(resolve(output, `${name}.png`));
  if (png.readUInt32BE(16) !== 1080 || png.readUInt32BE(20) !== data.height) throw new Error('PNG dimensions mismatch');
  if (name === 'long' && data.height <= 4000) throw new Error('Long document unexpectedly clipped');
  results.push({ name, ...data as { width: number; height: number; pngBytes: number; elapsedMs: number }, wallMs: Math.round(performance.now() - started) });
}
const binaryContent = await readFile(binary);
const archive = resolve(output, `blitz-probe-${process.platform}-${process.arch}.tar.gz`);
// Use a relative archive name: GNU tar in Git Bash treats a drive colon as a remote host.
const compressed = spawnSync('tar', ['-czf', `../${basename(archive)}`, '.'], { cwd: packaged, encoding: 'utf8', timeout: 30_000 });
if (compressed.error || compressed.status !== 0) throw new Error(compressed.error?.message ?? compressed.stderr);
const report = {
  frameworkCommit: process.env.GITHUB_SHA ?? null,
  blitzCommit: process.env.BLITZ_REV ?? null,
  platform: process.platform, arch: process.arch, profile: 'production (opt-level=3, LTO, stripped)',
  binaryBytes: binaryContent.length, binarySha256: createHash('sha256').update(binaryContent).digest('hex'),
  fontBytes: (await stat(font)).size, archiveBytes: (await stat(archive)).size,
  cargoLockSha256: createHash('sha256').update(await readFile(resolve(upstream, 'Cargo.lock'))).digest('hex'),
  samples: results,
};
await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
  `### ${process.platform}-${process.arch}\n\nBinary: ${(report.binaryBytes / 1048576).toFixed(2)} MiB; compressed package with Chinese font: ${(report.archiveBytes / 1048576).toFixed(2)} MiB.\n\n${results.map((sample) => `- ${sample.name}: ${sample.width} × ${sample.height}; ${sample.elapsedMs} ms; ${sample.pngBytes} bytes`).join('\n')}\n`);
