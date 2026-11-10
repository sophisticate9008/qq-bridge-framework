import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { canonicalPathMatches, privatePermissions, securePermissions, trustedAncestorPermissions, trustedPermissions } from '../src/storage/file-security.ts';
import { loadNativeBootstrap } from '../scripts/bootstrap-loader.ts';

const windows = process.platform === 'win32';
test('Windows private ACL is enforced and cached grants are invalidated after an ACL change', { skip: !windows }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'qqbf-权限-acl-'));
  const file = join(directory, 'private.json');
  try {
    securePermissions(directory, 0o700);
    writeFileSync(file, '{}');
    assert(privatePermissions(directory, lstatSync(directory), 0o700));
    assert(privatePermissions(file, lstatSync(file), 0o600));
    assert(trustedPermissions(file, lstatSync(file)));
    const icacls = join(process.env.SystemRoot ?? 'C:/Windows', 'System32/icacls.exe');
    execFileSync(icacls, [file, '/grant', '*S-1-1-0:(R)'], { windowsHide: true, stdio: 'pipe' });
    assert.equal(privatePermissions(file, lstatSync(file)), false, 'Public read must never be private');
    assert.equal(trustedPermissions(file, lstatSync(file)), true, 'Read-only source files remain trusted');
    execFileSync(icacls, [file, '/grant', '*S-1-1-0:(W)'], { windowsHide: true, stdio: 'pipe' });
    assert.equal(trustedPermissions(file, lstatSync(file)), false, 'Public write must never be trusted');
    securePermissions(file, 0o600);
    assert(privatePermissions(file, lstatSync(file)));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Windows canonical paths reject junction ancestors', { skip: !windows }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'qqbf-junction-'));
  try {
    const target = join(directory, 'target'), link = join(directory, 'link');
    mkdirSync(target);
    writeFileSync(join(target, 'file'), 'content');
    symlinkSync(target, link, 'junction');
    assert(canonicalPathMatches(target, target));
    assert.equal(canonicalPathMatches(join(target, 'file'), join(link, 'file')), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Windows bootstrap ancestors permit new siblings but reject deletion of existing children', { skip: !windows }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qqbf-bootstrap-acl-'));
  const child = join(directory, 'owned'), filename = join(child, 'index.ts');
  const icacls = join(process.env.SystemRoot ?? 'C:/Windows', 'System32/icacls.exe');
  try {
    securePermissions(directory, 0o700);
    mkdirSync(child); securePermissions(child, 0o700);
    writeFileSync(filename, "export default {manifest:{id:'acl-example',version:'1.0.0',apiVersion:1},create(){return {}}};\n");
    securePermissions(filename, 0o600);
    execFileSync(icacls, [directory, '/grant', '*S-1-1-0:(WD,AD)'], { stdio: 'pipe' });
    assert.equal(trustedPermissions(directory, lstatSync(directory)), false);
    assert.equal(trustedAncestorPermissions(directory, lstatSync(directory)), true);
    assert.equal((await loadNativeBootstrap(filename)).metadata.manifest.id, 'acl-example');
    await assert.rejects(loadNativeBootstrap(join(directory, 'index.ts')), { code: 'NATIVE_BOOTSTRAP_DIRECTORY_DENIED' });
    execFileSync(icacls, [directory, '/grant', '*S-1-1-0:(DC)'], { stdio: 'pipe' });
    assert.equal(trustedAncestorPermissions(directory, lstatSync(directory)), false);
    await assert.rejects(loadNativeBootstrap(filename), { code: 'NATIVE_BOOTSTRAP_DIRECTORY_DENIED' });
  } catch (error) {
    const parents: string[] = [];
    for (let parent = directory, depth = 0; depth < 32; depth++) {
      parents.push(parent);
      console.error(JSON.stringify({ path: parent, trusted: trustedPermissions(parent, lstatSync(parent)), ancestor: trustedAncestorPermissions(parent, lstatSync(parent)) }));
      console.error(execFileSync(icacls, [parent], { encoding: 'utf8', maxBuffer: 16384 }));
      const next = dirname(parent); if (next === parent) break; parent = next;
    }
    const ownerScript = '$paths = ConvertFrom-Json ([Console]::In.ReadToEnd()); foreach ($p in $paths) { $a = Get-Acl -LiteralPath $p; [Console]::Out.WriteLine(($p + " owner=" + $a.Owner)) }';
    console.error(execFileSync(join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ownerScript, 'utf16le').toString('base64')],
      { input: JSON.stringify(parents), encoding: 'utf8', maxBuffer: 16384 }));
    throw error;
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
