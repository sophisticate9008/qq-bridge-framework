import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalPathMatches, privatePermissions, securePermissions, trustedPermissions } from '../src/storage/file-security.ts';

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
