#!/usr/bin/env node
import { resolveLivePath } from './runtime-configuration.ts';
import { chmod, copyFile, lstat, mkdir, readFile, readlink, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { registerProductCommands } from '../src/host/product-commands.ts';
import { isRecord } from '../src/core/values.ts';

class InstallError extends Error {}

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const root = basename(sourceRoot) === 'dist' ? dirname(sourceRoot) : sourceRoot;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('安装 qbf-cli：node scripts/install-service-manager.ts [--bin-dir /usr/local/bin] [--admin-config /绝对路径/config.json] [--boot /绝对路径/service-boot.sh]\n先配置 data/live/services.json；--boot 核对 qbf-cli 的启动、停止、状态和日志分发。');
    return;
  }
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]; const value = args[index + 1];
    if (!name || !['--bin-dir', '--admin-config', '--boot'].includes(name) || !value || !value.startsWith('/') || options.has(name)) throw new InstallError('参数无效。');
    options.set(name, value);
  }
  const binDirectory = options.get('--bin-dir') ?? '/usr/local/bin';
  const adminPath = options.get('--admin-config') ?? resolveLivePath(root, 'framework-admin.json');
  const bootPath = options.get('--boot');
  const target = join(root, 'ops/qbf-cli');
  const cliTarget = join(root, existsSync(join(root, '.git')) ? 'scripts/cli.ts' : 'dist/scripts/cli.js');
  const cli = join(binDirectory, 'qbf-cli');
  if (!/^\/[A-Za-z0-9_./-]+$/.test(cli)) throw new InstallError('命令安装路径不支持空格或特殊字符。');
  const adminSource = await readFile(adminPath, 'utf8');
  const admin: unknown = JSON.parse(adminSource);
  if (!isRecord(admin) || typeof admin.tokenFile !== 'string') throw new InstallError('管理配置格式无效。');
  const services: unknown = JSON.parse(await readFile(resolveLivePath(root, 'services.json'), 'utf8'));
  if (!isRecord(services) || services.schema !== 1 || !isRecord(services.services) || !isRecord(services.services.dsh)) throw new InstallError('请先配置本框架的服务清单。');
  const originalLink = await lstat(cli).catch(error => {
    if (isRecord(error) && error.code === 'ENOENT') return null;
    throw error;
  });
  if (originalLink && (!originalLink.isSymbolicLink() || ![join(root, 'scripts/cli.ts'), join(root, 'dist/scripts/cli.js')]
    .includes(resolve(binDirectory, await readlink(cli))))) throw new InstallError('qbf-cli 已被其他程序占用。');

  let bootSource: string | undefined;
  let bootNext: string | undefined;
  if (bootPath) {
    bootSource = await readFile(bootPath, 'utf8');
    bootNext = bootSource;
    for (const action of ['service start', 'stop', 'service status', 'logs']) {
      if (!bootNext.includes(`${cli} ${action}`)) throw new InstallError('boot 不包含已支持的运维分发入口，未修改。');
    }
  }

  const backupDirectory = join(root, 'private/maintenance/ops-backups', new Date().toISOString().replace(/[:.]/g, '-'));
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  await copyFile(adminPath, join(backupDirectory, 'admin.json'));
  await chmod(join(backupDirectory, 'admin.json'), 0o600);
  if (bootPath) {
    await copyFile(bootPath, join(backupDirectory, 'boot.sh'));
    await chmod(join(backupDirectory, 'boot.sh'), 0o600);
  }
  const replace = async (filename: string, before: string, after: string, mode: number): Promise<void> => {
    if (before === after) return;
    if (await readFile(filename, 'utf8') !== before) throw new InstallError('配置在安装期间被修改，停止覆盖。');
    const temporary = join(dirname(filename), `.qbf-cli-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, after, { mode, flag: 'wx' });
      await rename(temporary, filename);
    } finally { await unlink(temporary).catch(() => undefined); }
  };
  await mkdir(binDirectory, { recursive: true });
  await chmod(target, 0o755);
  await chmod(cliTarget, 0o755);
  if (!originalLink) await symlink(cliTarget, cli);
  else if (resolve(binDirectory, await readlink(cli)) !== cliTarget) {
    const temporary = join(binDirectory, `.qbf-cli-${randomUUID()}`);
    try { await symlink(cliTarget, temporary); await rename(temporary, cli); }
    finally { await unlink(temporary).catch(() => undefined); }
  }
  await replace(adminPath, adminSource, `${JSON.stringify({ ...admin, serviceManager: target }, null, 2)}\n`, 0o600);
  if (bootPath && bootSource !== undefined && bootNext !== undefined) {
    const mode = (await lstat(bootPath)).mode & 0o777;
    await replace(bootPath, bootSource, bootNext, mode);
  }
  const registrations: Array<{ path: string; target: string } | { path: string; sha256: string }> = [{ path: cli, target: cliTarget }];
  if (process.getuid?.() === 0) {
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const logDirectory = join(root, 'data/logs');
    await mkdir(logDirectory, { recursive: true, mode: 0o700 });
    const cron = `# Managed runtime retention; the service manager owns the operation lock.\n17 * * * * root ${quote(target)} maintenance --apply >> ${quote(join(logDirectory, 'storage-maintenance.log'))} 2>&1\n`;
    await writeFile('/etc/cron.d/qq-bridge-framework-storage', cron, { mode: 0o644 });
    registrations.push({ path: '/etc/cron.d/qq-bridge-framework-storage', sha256: createHash('sha256').update(cron).digest('hex') });
  }
  await registerProductCommands(root, registrations);
  console.log('已安装 qbf-cli 并更新管理配置。' + (bootPath ? ' boot 已切换到本框架运维入口。' : ''));
  console.log('已有进程保持运行；管理服务下次启动时读取新的维护入口。备份位于 private/maintenance/ops-backups。');
}

void main().catch(error => {
  console.error(error instanceof InstallError ? error.message : '安装失败，请检查路径和权限；已有备份保留在 private/maintenance/ops-backups。');
  process.exitCode = 1;
});
