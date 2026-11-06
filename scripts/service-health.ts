#!/usr/bin/env node
import { resolveLivePath } from './runtime-configuration.ts';
import { lstat, readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readNativeAdapterConfiguration } from '../src/admin/native-configuration-repository.ts';
import { probeDshHealth } from '../src/adapters/dsh-health.ts';
import { isRecord } from '../src/core/values.ts';

async function privateText(filename: string): Promise<string> {
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > 65_536
    || (metadata.mode & 0o077) !== 0 || metadata.uid !== process.getuid?.()) throw new Error('private-file');
  return readFile(filename, 'utf8');
}

async function main(): Promise<void> {
  const [component, ...extra] = process.argv.slice(2);
  if (!['dsh', 'qq'].includes(component ?? '') || extra.length > 1 || extra.length === 1 && extra[0] !== '--json') throw new Error('arguments');
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
  const root = basename(sourceRoot) === 'dist' ? dirname(sourceRoot) : sourceRoot;
  const value: unknown = JSON.parse(await privateText(resolveLivePath(root, 'service-health.json')));
  if (!isRecord(value) || value.schema !== 1 || typeof value.nativeDirectory !== 'string' || !isAbsolute(value.nativeDirectory)) throw new Error('configuration');
  const signal = AbortSignal.timeout(6_000);
  const configuration = await readNativeAdapterConfiguration(value.nativeDirectory);
  if (component === 'dsh') {
    const checked = await probeDshHealth(configuration.dshAgent, signal);
    console.log(extra[0] === '--json' ? JSON.stringify(checked) : `dsh：${checked.state === 'ready' ? '鉴权接口就绪' : `状态未就绪（${checked.reason}）`}`);
    if (checked.state !== 'ready') process.exitCode = 1;
    return;
  } else {
    const adapter = configuration.onebotHttp;
    if (!adapter.enabled || typeof value.accountId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value.accountId)) throw new Error('configuration');
    const query = async (action: 'get_status' | 'get_login_info'): Promise<Record<string, unknown>> => {
      const response = await fetch(`${adapter.endpoint.replace(/\/+$/, '')}/${action}`, {
        method: 'POST', headers: { Authorization: `Bearer ${adapter.secret}`, 'Content-Type': 'application/json' }, body: '{}', signal,
      });
      const body: unknown = await response.json();
      if (!response.ok || !isRecord(body) || body.status !== 'ok' || body.retcode !== 0 || !isRecord(body.data)) throw new Error('not-ready');
      return body.data;
    };
    const [status, login] = await Promise.all([query('get_status'), query('get_login_info')]);
    if (status.online !== true || status.good === false || String(login.user_id) !== value.accountId) throw new Error('offline');
  }
  console.log(extra[0] === '--json' ? JSON.stringify({ schema: 1, state: 'ready', reason: null }) : `${component} 已就绪`);
}

void main().catch((error: unknown) => {
  const reason = error instanceof Error && error.message === 'offline' ? 'account_offline' : 'probe_failed';
  if (process.argv.includes('--json')) console.log(JSON.stringify({ schema: 1, state: reason === 'account_offline' ? 'unavailable' : 'unknown', reason }));
  else console.error(`服务状态无法确认，请检查连接、登录状态与运维配置（${reason}）。`);
  process.exitCode = 1;
});
