import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isRecord } from '../src/contracts/values.ts';
import { applyFrameworkUpdate, rollbackFrameworkUpdate } from '../src/host/framework-updater.ts';
import { readFrameworkUpdateState, writeFrameworkUpdateState } from '../src/host/framework-update-state.ts';
import { frameworkUpdateStage } from './framework-update-download.ts';
import { loadGatewayAdminConfiguration, gatewayAdminAddress } from '../src/admin/gateway.ts';
import { resolveRuntimeConfiguration } from './runtime-configuration.ts';
import { acquireFrameworkProcessLease } from '../src/host/framework-process-lease.ts';

/** A parent outside the serving child owns restarts and code replacement. No shell or Docker socket is exposed. */
export async function superviseFramework(root: string, args: readonly string[]): Promise<void> {
  if (process.env.QQ_BRIDGE_FRAMEWORK_SUPERVISED === '1') throw new Error('nested_supervisor_rejected');
  if (!existsSync(join(root, 'distribution.json'))) throw new Error('supervisor_requires_release_archive');
  const release = await acquireFrameworkProcessLease(root, 'supervisor');
  let child: ChildProcess | undefined, exited: Promise<number> = Promise.resolve(0);
  let stopping = false, lastStart = 0, childFinished = false, requireChatReady = false;
  const controller = new AbortController();
  const configIndex = args.indexOf('--config');
  const configurationFilename = resolveRuntimeConfiguration(root, configIndex < 0 ? undefined : args[configIndex + 1], process.env, root);
  const cli = join(root, 'dist/scripts/cli.js');
  const crashes: number[] = [];
  function stop() { stopping = true; controller.abort(); }
  const onMessage = (value: unknown) => { if (isRecord(value) && value.type === 'qqbridge.shutdown') stop(); };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, stop);
  process.on('message', onMessage);
  if (process.send) process.once('disconnect', stop);
  async function stopChild(): Promise<void> {
    const current = child;
    if (!current || current.exitCode !== null || current.signalCode !== null) return;
    if (current.connected) current.send({ type: 'qqbridge.shutdown' }, () => undefined);
    else current.kill('SIGTERM');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([exited, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('supervisor_drain_timeout')), 30_000);
      })]);
    } finally { clearTimeout(timer); }
  }
  function startChild(): void {
    lastStart = Date.now(); childFinished = false;
    child = spawn(process.execPath, [cli, 'start', ...args], { cwd: root,
      env: { ...process.env, QQ_BRIDGE_FRAMEWORK_SUPERVISED: '1' }, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
    const current = child;
    exited = new Promise<number>(resolve => {
      current.once('error', () => { childFinished = true; resolve(1); });
      current.once('exit', (code, signal) => { childFinished = true; resolve(code ?? (signal ? 1 : 0)); });
    });
  }
  async function healthy(): Promise<boolean> {
    try {
      const config = loadGatewayAdminConfiguration(configurationFilename);
      const url = new URL(gatewayAdminAddress(config));
      if (['0.0.0.0', '[::]'].includes(url.hostname)) url.hostname = '127.0.0.1';
      const response = await fetch(new URL('/api/setup', url), { signal: AbortSignal.timeout(2000) });
      const value: unknown = await response.json();
      if (!response.ok || !isRecord(value) || typeof value.initialized !== 'boolean') return false;
      return !requireChatReady || await chatReady();
    } catch { return false; }
  }
  async function chatReady(): Promise<boolean> {
    try {
      const config = loadGatewayAdminConfiguration(configurationFilename);
      const origin = new URL(gatewayAdminAddress(config));
      if (['0.0.0.0', '[::]'].includes(origin.hostname)) origin.hostname = '127.0.0.1';
      const token = (await readFile(config.tokenFile, 'utf8')).trim();
      const response = await fetch(new URL('/api/chat/runtime', origin), {
        headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
      const value: unknown = await response.json();
      return response.ok && isRecord(value) && value.chatReady === true;
    } catch { return false; }
  }
  try {
    if (!existsSync(join(root, 'distribution.json'))) throw new Error('supervisor_requires_release_archive');
    if (existsSync(join(root, '.framework-update.lock'))) {
      const id = (await readFile(join(root, '.framework-update.lock'), 'utf8')).trim();
      // An interrupted transaction is restored before any runtime opens its data.
      await rollbackFrameworkUpdate(root, id);
    }
    const interrupted = await readFrameworkUpdateState(root);
    if (interrupted && ['applying', 'verifying'].includes(interrupted.state)) {
      if (interrupted.transactionId) await rollbackFrameworkUpdate(root, interrupted.transactionId);
      await writeFrameworkUpdateState(root, { ...interrupted, state: 'rolled-back', error: 'update_supervisor_interrupted', updatedAt: Date.now() });
    }
    startChild();
    while (!stopping) {
      await delay(2000, undefined, { signal: controller.signal }).catch(() => undefined);
      if (stopping) break;
      const update = await readFrameworkUpdateState(root);
      if (update?.state === 'ready' && process.env.QQ_BRIDGE_FRAMEWORK_CONTAINER !== '1') {
        requireChatReady = await chatReady();
        await writeFrameworkUpdateState(root, { ...update, state: 'applying', updatedAt: Date.now() });
        let transactionId: string | null = null;
        try {
          await stopChild();
          transactionId = await applyFrameworkUpdate({ source: join(frameworkUpdateStage(root, update.id), `qq-bridge-framework-${update.version}`), target: root, dependencies: true, retainLock: true });
          await writeFrameworkUpdateState(root, { ...update, state: 'verifying', transactionId, updatedAt: Date.now() });
          await rm(join(root, '.framework-update.lock'));
          startChild();
          let ready = false;
          for (let attempt = 0; attempt < 30 && !stopping; attempt++) {
            if (childFinished) break;
            if (await healthy()) { ready = true; break; }
            await delay(1000, undefined, { signal: controller.signal }).catch(() => undefined);
          }
          if (!ready) throw new Error('update_start_failed');
          await writeFrameworkUpdateState(root, { ...update, state: 'completed', transactionId, updatedAt: Date.now() });
          await rm(frameworkUpdateStage(root, update.id), { recursive: true, force: true });
        } catch {
          await stopChild();
          if (transactionId) await rollbackFrameworkUpdate(root, transactionId);
          await writeFrameworkUpdateState(root, { ...update, state: transactionId ? 'rolled-back' : 'failed', transactionId,
            error: 'update_apply_failed', updatedAt: Date.now() });
          if (!stopping) startChild();
        }
        continue;
      }
      if (update?.state === 'preparing' && Date.now() - update.updatedAt > 20 * 60_000) {
        // Preparation has bounded network/npm deadlines; never apply a partial or abandoned stage.
        await writeFrameworkUpdateState(root, { ...update, state: 'failed', updatedAt: Date.now(), error: 'update_preparation_interrupted' });
      }
      if (child && childFinished) {
        const code = await exited;
        if (code === 0) break;
        const at = Date.now();
        while (crashes.length && crashes[0] < at - 15 * 60_000) crashes.shift();
        if (crashes.length >= 5) throw new Error('supervisor_restart_budget_exhausted');
        crashes.push(at);
        await delay(Math.min(30_000, 1000 * 2 ** (crashes.length - 1)), undefined, { signal: controller.signal }).catch(() => undefined);
        if (!stopping) startChild();
      }
      if (Date.now() - lastStart > 15 * 60_000) crashes.splice(0);
    }
  } finally {
    await stopChild();
    await release();
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.off(signal, stop);
    process.off('message', onMessage); process.off('disconnect', stop);
    if (process.connected) process.disconnect();
  }
}
if (process.argv[1]?.endsWith('framework-supervisor.js') || process.argv[1]?.endsWith('framework-supervisor.ts')) {
  const root = fileURLToPath(new URL(import.meta.url.endsWith('.js') ? '../../' : '../', import.meta.url));
  await superviseFramework(root, process.argv.slice(2));
}
