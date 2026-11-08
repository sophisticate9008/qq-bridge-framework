import { constants, lstatSync, realpathSync, type Stats } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { chmod, lstat } from 'node:fs/promises';

export const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
export const readOnlyFlags = constants.O_RDONLY | noFollow | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK);
const aclScript = String.raw`
$ErrorActionPreference='Stop'
$utf8=New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding=$utf8
[Console]::OutputEncoding=$utf8
$r=ConvertFrom-Json ([Console]::In.ReadToEnd())
$p=[string]$r.path
$item=Get-Item -LiteralPath $p -Force
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point' }
$current=[Security.Principal.WindowsIdentity]::GetCurrent().User
$system=New-Object Security.Principal.SecurityIdentifier 'S-1-5-18'
$admins=New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544'
$allowed=@($current.Value,$system.Value,$admins.Value)
$acl=Get-Acl -LiteralPath $p
if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $allowed) { throw 'Unexpected owner' }
if ($r.protect) {
 if ($item.PSIsContainer) { $acl=New-Object Security.AccessControl.DirectorySecurity; $inherit=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' }
 else { $acl=New-Object Security.AccessControl.FileSecurity; $inherit=[Security.AccessControl.InheritanceFlags]::None }
 $acl.SetOwner($current); $acl.SetAccessRuleProtection($true,$false)
 foreach($sid in @($current,$system,$admins)) {
  $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
 }
 Set-Acl -LiteralPath $p -AclObject $acl
 $acl=Get-Acl -LiteralPath $p
}
$rules=$acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
if ($rules.Count -eq 0) { throw 'Empty ACL' }
foreach($rule in $rules) {
 if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
 if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $rule.IdentityReference.Value -notin $allowed) { throw 'Non-private ACL' }
}
[Console]::Out.Write('private')
`;
async function windowsAcl(filename: string, protect: boolean): Promise<void> {
  await new Promise<void>((accept, reject) => {
    const program = join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const child = spawn(program, ['-NoProfile', '-NonInteractive', '-Command', aclScript], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let output = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('WORK_STORAGE_ACL_UNAVAILABLE')); }, 15000);
    child.stdout.setEncoding('utf8'); child.stdout.on('data', (part: string) => { output += part; if (output.length > 1024) child.kill(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); if (code === 0 && output.trim() === 'private') accept(); else reject(new Error('WORK_STORAGE_ACL_UNSAFE')); });
    child.stdin.on('error', reject); child.stdin.end(JSON.stringify({ path: resolve(filename), protect }));
  });
}
export function canonicalPathMatches(actual: string, expected: string): boolean {
  if (process.platform !== 'win32') return actual === expected;
  try {
    let path = resolve(expected);
    for (;;) {
      if (lstatSync(path).isSymbolicLink()) return false;
      const parent = dirname(path); if (parent === path) break; path = parent;
    }
    return realpathSync.native(actual).toLowerCase() === realpathSync.native(expected).toLowerCase();
  } catch { return false; }
}
/** Same private-owner/SYSTEM/Administrators SID policy as the framework; no POSIX-mode bypass on Windows. */
export async function privatePermissions(filename: string, before: Stats, mode: number): Promise<boolean> {
  if (before.isSymbolicLink() || !before.isFile() && !before.isDirectory() || before.isFile() && before.nlink !== 1) return false;
  if (process.platform !== 'win32') return before.uid === process.getuid?.() && (before.mode & 0o777) === mode;
  try {
    await windowsAcl(filename, false); const after = await lstat(filename);
    return !after.isSymbolicLink() && before.dev === after.dev && before.ino === after.ino
      && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
  } catch { return false; }
}
/** Called only for newly created private storage. Existing data is checked, never silently repaired. */
export async function secureNewPath(filename: string, mode: number): Promise<void> {
  if (process.platform === 'win32') await windowsAcl(filename, true);
  else await chmod(filename, mode);
}
