import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isRecord } from '../src/core/values.ts';

// Upload verified CI artifacts to an existing draft. Publishing stays a separate action.
const [tag, sourceCommit, runId, directoryArgument] = process.argv.slice(2);
assert(tag && /^v\d+\.\d+\.\d+$/.test(tag));
assert(sourceCommit && /^[a-f0-9]{40}$/.test(sourceCommit));
assert(runId && /^[1-9][0-9]+$/.test(runId));
assert(directoryArgument);
const directory = resolve(directoryArgument), version = tag.slice(1);
const gh = (args: string[]): unknown => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }));
const fields = ['headSha', 'headBranch', 'status', 'conclusion', 'workflowName', 'jobs'];
const run = gh(['run', 'view', runId, '--json', fields.join(',')]);
assert(isRecord(run) && run.headSha === sourceCommit && run.headBranch === tag
  && run.status === 'completed' && run.conclusion === 'success' && run.workflowName === '发行包安装验证'
  && Array.isArray(run.jobs) && run.jobs.length >= 6
  && run.jobs.every(job => isRecord(job) && job.status === 'completed' && job.conclusion === 'success'), 'Use a successful tag installation run');
const required = ['框架验证', '完整验证（手动）', '发行包安装验证'];
const runs = gh(['run', 'list', '--commit', sourceCommit, '--limit', '100', '--json', 'workflowName,status,conclusion']);
assert(Array.isArray(runs) && required.every(name => runs.some(row => isRecord(row) && row.workflowName === name))
  && runs.filter(row => isRecord(row) && required.includes(String(row.workflowName)))
    .every(row => isRecord(row) && row.status === 'completed' && row.conclusion === 'success'), 'Exact-commit checks must all pass');
const repository = process.env.GITHUB_REPOSITORY;
assert(repository && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository));
const ref = gh(['api', `repos/${repository}/git/ref/tags/${tag}`]);
assert(isRecord(ref) && isRecord(ref.object) && typeof ref.object.sha === 'string');
let tagCommit: unknown = ref.object.sha;
if (ref.object.type === 'tag') {
  const annotated = gh(['api', `repos/${repository}/git/tags/${ref.object.sha}`]);
  assert(isRecord(annotated) && isRecord(annotated.object)); tagCommit = annotated.object.sha;
}
assert.equal(tagCommit, sourceCommit, 'Tag changed after verification');
const release = gh(['release', 'view', tag, '--json', 'tagName,isDraft']);
assert(isRecord(release) && release.tagName === tag && release.isDraft === true, 'Upload only to an existing draft');
const names = await readdir(directory);
const expected = [`qq-bridge-framework-${version}.tar.gz`, `qq-bridge-framework-${version}-windows-x64.zip`,
  `qq-bridge-framework-${version}-docker-amd64.tar.gz`, `qq-bridge-framework-${version}-docker-arm64.tar.gz`,
  `qq-bridge-framework-sdk-${version}.tgz`, `qq-bridge-framework-dsh-bridge-plugin-${version}.tgz`];
assert.equal(names.length, 10);
assert(names.includes('SHA256SUMS') && expected.every(name => names.includes(name)));
const native = names.filter(name => /^qbf-html-renderer-[a-f0-9]{64}-(?:linux-x64|linux-arm64|win32-x64)\.tgz$/.test(name));
assert.equal(native.length, 3);
assert.equal(new Set(native.map(name => name.slice('qbf-html-renderer-'.length, 'qbf-html-renderer-'.length + 64))).size, 1);
for (const target of ['linux-x64', 'linux-arm64', 'win32-x64']) assert(native.some(name => name.endsWith(`-${target}.tgz`)));
const checksums = (await readFile(join(directory, 'SHA256SUMS'), 'utf8')).trim().split(/\r?\n/);
assert.equal(checksums.length, 9);
const verified = new Set<string>();
for (const line of checksums) {
  const match = /^([a-f0-9]{64})  ([a-zA-Z0-9.-]+)$/.exec(line);
  assert(match && names.includes(match[2]!) && match[2] !== 'SHA256SUMS' && !verified.has(match[2]!));
  const file = join(directory, match[2]!), metadata = await lstat(file);
  assert(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= 1024 * 1024 * 1024);
  assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'), match[1]);
  verified.add(match[2]!);
}
const distribution: unknown = JSON.parse(execFileSync('tar', ['-xOf', join(directory, expected[0]!),
  `qq-bridge-framework-${version}/distribution.json`], { encoding: 'utf8' }));
assert(isRecord(distribution) && distribution.sourceCommit === sourceCommit && distribution.sourceModified === false && distribution.version === version);
execFileSync('gh', ['release', 'upload', tag, '--clobber', ...names.sort().map(name => join(directory, name))],
  { stdio: 'inherit', timeout: 180000 });
console.log(`Uploaded ${names.length} verified assets to draft ${tag}; release remains unpublished.`);
