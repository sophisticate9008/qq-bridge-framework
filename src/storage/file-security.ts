import { Worker } from 'node:worker_threads';
import { chmodSync, lstatSync, realpathSync, type Stats } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { FrameworkError, isRecord } from '../core/values.ts';

const windows = process.platform === 'win32';
const aclCache = new Map<string, { identity: string; trusted: boolean; private: boolean; ancestor: boolean }>();
// Paths are JSON on stdin, never interpolated into a command or PowerShell code.
const aclScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
while ($null -ne ($line = [Console]::In.ReadLine())) {
try {
$requests = ConvertFrom-Json $line
$results = @(foreach ($r in $requests) {
$p = [string]$r.path
$item = Get-Item -LiteralPath $p -Force
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse points are not accepted' }
$current = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object Security.Principal.SecurityIdentifier 'S-1-5-18'
$admins = New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544'
if ($r.protect) {
  $old = Get-Acl -LiteralPath $p
  if ($old.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @($current.Value,$system.Value,$admins.Value)) { throw 'Unexpected owner' }
  if ($item.PSIsContainer) { $acl = New-Object Security.AccessControl.DirectorySecurity; $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' }
  else { $acl = New-Object Security.AccessControl.FileSecurity; $inherit = [Security.AccessControl.InheritanceFlags]::None }
  $acl.SetOwner($current)
  $acl.SetAccessRuleProtection($true,$false)
  foreach ($sid in @($current,$system,$admins)) {
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $p -AclObject $acl
}
$acl = Get-Acl -LiteralPath $p
$owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
$allowed = @($current.Value,$system.Value,$admins.Value)
$trusted = $owner -in $allowed
$private = $trusted
$ancestor = $trusted
$rules = $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
if ($rules.Count -eq 0) { $trusted=$false; $private=$false; $ancestor=$false }
foreach ($rule in $rules) {
  if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
  if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $rule.IdentityReference.Value -notin $allowed) {
    $private=$false
    # Data/append/extended attributes/attributes/delete/change DACL/take owner, plus generic write/all.
    if (([long]$rule.FileSystemRights -band 0x500d0156) -ne 0) { $trusted=$false }
    # An ancestor may allow adding siblings; replacing/deleting existing children or changing security remains forbidden.
    if (([long]$rule.FileSystemRights -band 0x500d0150) -ne 0) { $ancestor=$false }
  }
}
@{trusted=[bool]$trusted; private=[bool]$private; ancestor=[bool]$ancestor}
})
[Console]::Out.WriteLine((ConvertTo-Json -InputObject $results -Compress))
} catch { [Console]::Out.WriteLine('{"error":true}') }
}
`;
function identity(stat: Stats): string {
  return [stat.dev, stat.ino, stat.ctimeMs, stat.mtimeMs, stat.size, stat.nlink].join(':');
}
let aclWorker: { worker: Worker; state: Int32Array<SharedArrayBuffer>; output: Uint8Array<SharedArrayBuffer> } | undefined;
let workerUnavailable = false;
function connection() {
  if (workerUnavailable) throw new FrameworkError('FILE_SECURITY_UNAVAILABLE', 'The Windows ACL worker is unavailable.');
  if (aclWorker) return aclWorker;
  const state = new Int32Array(new SharedArrayBuffer(8)), output = new Uint8Array(new SharedArrayBuffer(65536));
  const executable = join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const worker = new Worker(new URL(import.meta.url.endsWith('.ts') ? './windows-acl-worker.ts' : './windows-acl-worker.js', import.meta.url), {
    execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8 },
    workerData: { executable, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(aclScript, 'utf16le').toString('base64')], state: state.buffer, output: output.buffer }
  });
  worker.on('error', () => { workerUnavailable = true; });
  worker.unref();
  process.once('beforeExit', () => {
    worker.ref(); worker.postMessage(null);
    const timer = setTimeout(() => { void worker.terminate(); }, 2000);
    timer.unref(); worker.once('exit', () => { clearTimeout(timer); });
  });
  aclWorker = { worker, state, output };
  return aclWorker;
}
function readAcls(requests: readonly { path: string; protect: boolean }[]): unknown[] {
  const { worker, state, output } = connection();
  Atomics.store(state, 0, 0);
  // ASCII JSON also works with Windows PowerShell's legacy console code page.
  worker.postMessage(JSON.stringify(requests).replace(/[^\x00-\x7f]/g, value => `\\u${value.charCodeAt(0).toString(16).padStart(4, '0')}`));
  if (Atomics.wait(state, 0, 0, 15000) === 'timed-out' || Atomics.load(state, 0) !== 1) {
    workerUnavailable = true; void worker.terminate();
    throw new FrameworkError('FILE_SECURITY_UNAVAILABLE', 'Windows file permissions could not be verified in time.');
  }
  const result: unknown = JSON.parse(Buffer.from(output.subarray(0, Atomics.load(state, 1))).toString('utf8'));
  if (!Array.isArray(result) || result.length !== requests.length)
    throw new FrameworkError('FILE_SECURITY_UNAVAILABLE', 'File permissions could not be verified.');
  return result;
}
/** Warm a bounded set of code-file ACLs in one OS call; every use still checks metadata identity. */
export function primePermissions(filenames: readonly string[]): void {
  if (!windows) return;
  const missing = [...new Set(filenames)].map(path => ({ path: resolve(path), stat: lstatSync(path) }))
    .filter(({ path, stat }) => aclCache.get(path.toLowerCase())?.identity !== identity(stat));
  for (let offset = 0; offset < missing.length; offset += 128) {
    const batch = missing.slice(offset, offset + 128);
    const results = readAcls(batch.map(({ path }) => ({ path, protect: false })));
    batch.forEach(({ path, stat }, index) => {
      const value: unknown = results[index];
      const after = lstatSync(path);
      if (stat.isSymbolicLink() || identity(stat) !== identity(after) || !isRecord(value)
        || typeof value.trusted !== 'boolean' || typeof value.private !== 'boolean' || typeof value.ancestor !== 'boolean')
        throw new FrameworkError('FILE_SECURITY_CHANGED', 'File changed during permission verification.');
      if (aclCache.size >= 512) aclCache.delete(aclCache.keys().next().value!);
      aclCache.set(path.toLowerCase(), { identity: identity(after), trusted: value.trusted, private: value.private, ancestor: value.ancestor });
    });
  }
}
function acl(filename: string, stat: Stats, protect = false) {
  if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile() || stat.isFile() && stat.nlink !== 1)
    return { trusted: false, private: false, ancestor: false };
  const key = resolve(filename).toLowerCase();
  const before = identity(stat), cached = aclCache.get(key);
  if (!protect && cached?.identity === before) return cached;
  const result = readAcls([{ path: resolve(filename), protect }])[0];
  const after = lstatSync(filename);
  if (!isRecord(result) || typeof result.trusted !== 'boolean' || typeof result.private !== 'boolean' || typeof result.ancestor !== 'boolean'
    || after.isSymbolicLink() || stat.dev !== after.dev || stat.ino !== after.ino || !protect && before !== identity(after))
    throw new FrameworkError('FILE_SECURITY_CHANGED', 'File identity changed during permission verification.');
  if (aclCache.size >= 512) aclCache.delete(aclCache.keys().next().value!);
  const saved = { identity: identity(after), trusted: result.trusted, private: result.private, ancestor: result.ancestor };
  aclCache.set(key, saved);
  return saved;
}
/** POSIX modes retain their existing meaning; Windows checks owner and effective allow ACEs by SID. */
export function privatePermissions(filename: string, metadata: Stats, exactMode?: number): boolean {
  if (!windows) return exactMode === undefined ? (metadata.mode & 0o077) === 0 : (metadata.mode & 0o777) === exactMode;
  try { return acl(filename, metadata).private; } catch { return false; }
}
export function trustedPermissions(filename: string, metadata: Stats): boolean {
  if (!windows) return (metadata.mode & 0o022) === 0;
  try { return acl(filename, metadata).trusted; } catch { return false; }
}
/** Windows ancestors may permit new siblings, but cannot grant strangers replacement or deletion of the trusted subtree. */
export function trustedAncestorPermissions(filename: string, metadata: Stats): boolean {
  if (!windows) return trustedPermissions(filename, metadata);
  if (!metadata.isDirectory()) return false;
  try { return acl(filename, metadata).ancestor; } catch { return false; }
}
export function securePermissions(filename: string, mode: number): void {
  if (!windows) { chmodSync(filename, mode); return; }
  const stat = lstatSync(filename);
  if (!privatePermissions(filename, stat) && !acl(filename, stat, true).private)
    throw new FrameworkError('FILE_SECURITY_UNAVAILABLE', 'Private Windows file permissions could not be established.');
}
/** Drive casing and Windows short-name aliases are permitted only for the same actual path. */
export function canonicalPathMatches(actual: string, expected: string): boolean {
  if (!windows) return actual === expected;
  try {
    let current = resolve(expected);
    for (let depth = 0; depth < 128; depth++) {
      if (lstatSync(current).isSymbolicLink()) return false;
      const parent = dirname(current);
      if (parent === current) return realpathSync.native(actual).toLowerCase() === realpathSync.native(expected).toLowerCase();
      current = parent;
    }
    return false;
  } catch { return false; }
}
