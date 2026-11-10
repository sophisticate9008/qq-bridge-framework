import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isRecord } from '../src/contracts/values.ts';
import { rollbackFrameworkUpdate } from '../src/host/framework-updater.ts';
import { readFrameworkUpdateState, writeFrameworkUpdateState } from '../src/host/framework-update-state.ts';
import { frameworkUpdateStage } from './framework-update-download.ts';
import { loadGatewayAdminConfiguration, gatewayAdminAddress } from '../src/admin/gateway.ts';
import { resolveRuntimeConfiguration } from './runtime-configuration.ts';
import { acquireFrameworkProcessLease } from '../src/host/framework-process-lease.ts';
import { readProductUpdate } from '../src/host/product-update.ts';
import { createProductUpdateRuntime } from './product-update.ts';
import { NativeConfigurationRepository } from '../src/admin/native-configuration-repository.ts';
import { dirname } from 'node:path';

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
    if (child && !childFinished && child.exitCode === null && child.signalCode === null) return;
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
      if (!response.ok || !isRecord(value) || value.chatReady !== true) return false;
      const health = await fetch(new URL('/api/chat/health', origin), {
        headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
      const chain: unknown = await health.json();
      return health.ok && isRecord(chain) && chain.healthy === true;
    } catch { return false; }
  }
  async function verifyProduct(version: string, wasRunning: boolean): Promise<void> {
    requireChatReady = wasRunning;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline && !stopping && !childFinished) {
      try {
        if (await healthy()) {
          const config = loadGatewayAdminConfiguration(configurationFilename);
          const origin = new URL(gatewayAdminAddress(config));
          if (['0.0.0.0', '[::]'].includes(origin.hostname)) origin.hostname = '127.0.0.1';
          const token = (await readFile(config.tokenFile, 'utf8')).trim();
          const response = await fetch(new URL('/api/framework/version', origin), {
            headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
          const current: unknown = await response.json();
          if (response.ok && isRecord(current) && current.currentVersion === version) return;
        }
      } catch { /* Only read-only readiness checks repeat within this deadline. */ }
      await delay(1000, undefined, { signal: controller.signal }).catch(() => undefined);
    }
    throw new Error('product_start_unconfirmed');
  }
  const productRuntime = (source?: string) => createProductUpdateRuntime({ root, source, configurationFilename,
    stop: stopChild, start: async () => { if (!stopping) startChild(); }, verify: verifyProduct });
  try {
    if (!existsSync(join(root, 'distribution.json'))) throw new Error('supervisor_requires_release_archive');
    const pendingProduct = await readProductUpdate(root);
    const pendingWeb = await readFrameworkUpdateState(root);
    if (pendingProduct && (!['completed', 'rolled-back'].includes(pendingProduct.phase)
      || pendingProduct.phase === 'completed' && pendingWeb?.id === pendingProduct.id && ['applying', 'verifying', 'unknown'].includes(pendingWeb.state))) {
      const runtime = await productRuntime();
      try {
        const result = await runtime.updater.rollback(pendingProduct.id);
        if (result.phase !== 'rolled-back') throw new Error('product_update_requires_reconciliation');
        const web = await readFrameworkUpdateState(root);
        if (web?.id === result.id && ['applying', 'verifying', 'unknown'].includes(web.state)) {
          await writeFrameworkUpdateState(root, { ...web, state: 'rolled-back', transactionId: result.runtimeTransactionId,
            error: 'update_supervisor_interrupted', updatedAt: Date.now() });
        }
      } finally { await runtime.close(); }
    } else if (existsSync(join(root, '.framework-update.lock'))) {
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
        const config = loadGatewayAdminConfiguration(configurationFilename);
        const intent = await new NativeConfigurationRepository(join(dirname(config.tokenFile), 'runtime')).readRunningIntent();
        requireChatReady = intent.value.desiredRunning;
        await writeFrameworkUpdateState(root, { ...update, state: 'applying', updatedAt: Date.now() });
        let runtime: Awaited<ReturnType<typeof productRuntime>> | undefined;
        try {
          runtime = await productRuntime(join(frameworkUpdateStage(root, update.id), `qq-bridge-framework-${update.version}`));
          const result = await runtime.updater.execute({ id: update.id, version: update.version, wasRunning: requireChatReady });
          const state = result.phase === 'completed' ? 'completed' : result.phase === 'rolled-back' ? 'rolled-back' : 'unknown';
          await writeFrameworkUpdateState(root, { ...update, state, transactionId: result.runtimeTransactionId,
            error: result.error, updatedAt: Date.now() });
          if (state === 'completed') await rm(frameworkUpdateStage(root, update.id), { recursive: true, force: true });
          if (state === 'unknown') throw new Error('product_update_requires_reconciliation');
        } catch {
          const product = await readProductUpdate(root, update.id);
          const current = await readFrameworkUpdateState(root);
          if (current?.state === 'applying') await writeFrameworkUpdateState(root, { ...update,
            state: product && !['completed', 'rolled-back'].includes(product.phase) ? 'unknown' : 'failed',
            error: 'update_apply_failed', updatedAt: Date.now() });
          if (product && !['completed', 'rolled-back'].includes(product.phase)) throw new Error('product_update_requires_reconciliation');
          if (!stopping) startChild();
        } finally { await runtime?.close(); }
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
