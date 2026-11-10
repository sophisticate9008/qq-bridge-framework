import { existsSync } from 'node:fs';
import { readFile, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { NativeConfigurationRepository } from '../src/admin/native-configuration-repository.ts';
import { loadGatewayAdminConfiguration } from '../src/admin/gateway.ts';
import { createDshAuthenticationOptions } from '../src/adapters/dsh-authentication.ts';
import { createDshJsonRpcPort } from '../src/adapters/dsh-jsonrpc.ts';
import { compareReleaseVersions, releaseVersion } from '../src/contracts/framework-release.ts';
import { parseNativeAccountRegistry } from '../src/contracts/native-accounts.ts';
import { prepareBridgeArchive } from '../src/host/bridge-archive.ts';
import { createBridgeManager } from '../src/host/bridge-manager.ts';
import { createLocalDshMaintenance } from '../src/host/local-dsh-maintenance.ts';
import { discoverLocalDshDeployment } from '../src/host/local-dsh-deployment.ts';
import { applyFrameworkUpdate, rollbackFrameworkUpdate, verifyFrameworkDistribution } from '../src/host/framework-updater.ts';
import { createProductUpdater } from '../src/host/product-update.ts';
import { ensureProductEngineReload } from '../src/host/product-engine-reload.ts';
import { readManagedBridge, registerManagedBridge } from '../src/host/product-components.ts';
import { readDocument } from '../src/storage/private-json.ts';
import { resolveRuntimeConfiguration } from './runtime-configuration.ts';

export async function createProductUpdateRuntime(options: { readonly root: string; readonly source?: string; readonly configurationFilename?: string;
  readonly allowMajor?: boolean; readonly stop: () => Promise<void>; readonly start: () => Promise<void>;
  readonly restartDsh?: () => Promise<void>;
  readonly verify: (version: string, wasRunning: boolean) => Promise<void> }) {
  const { root, source } = options;
  const signal = AbortSignal.timeout(900_000);
  const distribution = source ? await verifyFrameworkDistribution(source) : null;
  if (distribution && Number(distribution.version.split('.')[0]) >= 2 && !distribution.components) throw new Error('product_component_manifest_required');
  if (distribution) {
    const previous: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    if (existsSync(join(root, '.git'))) throw new Error('update_source_checkout_unsupported');
    if (!previous || typeof previous !== 'object' || !('version' in previous) || !releaseVersion(previous.version)
      || compareReleaseVersions(distribution.version, previous.version) <= 0) throw new Error('update_not_newer');
    if (!options.allowMajor && previous.version.split('.')[0] !== distribution.version.split('.')[0]) throw new Error('update_major_requires_migration');
    await verifyFrameworkDistribution(root);
  }
  const filename = options.configurationFilename ?? resolveRuntimeConfiguration(root, undefined, process.env, root);
  const admin = existsSync(filename) ? loadGatewayAdminConfiguration(filename) : null;
  const directory = admin ? join(dirname(admin.tokenFile), 'runtime') : null;
  const configuration = directory ? await new NativeConfigurationRepository(directory).read() : null;
  let client: ReturnType<typeof createDshJsonRpcPort> | undefined;
  try {
    // Only this installation's configured DSH can join a product update. Global discovery never selects a different user's engine.
    const adapter = configuration?.adapters.dshAgent;
    const attached = Boolean(adapter?.enabled && (adapter.auth || adapter.localCredentialsPath));
    if (attached && directory) {
      const accounts = (await readDocument(join(directory, 'native-accounts.json'), { schema: 1, accounts: [] }, input => {
        const parsed = parseNativeAccountRegistry(input); if (!parsed) throw new Error('product_account_registry_invalid'); return parsed;
      })).value;
      if (accounts.accounts.length) throw new Error('product_shared_accounts_require_individual_update');
    }
    let home: string | undefined;
    if (attached && adapter) {
      if (!adapter.localCredentialsPath) throw new Error('product_local_component_management_required');
      const target = await discoverLocalDshDeployment({ endpoint: adapter.endpoint, localCredentialsPath: adapter.localCredentialsPath, signal });
      if (await realpath(target.credentialsPath) !== await realpath(adapter.localCredentialsPath)) throw new Error('product_dsh_target_changed');
      home = await realpath(dirname(target.credentialsPath));
      client = createDshJsonRpcPort({ endpoint: adapter.endpoint, ...createDshAuthenticationOptions(adapter), timeoutMs: 300_000 });
    }
    const port = client;
    const archive = (version: string) => {
      if (!home) throw new Error('product_bridge_unavailable');
      return prepareBridgeArchive({ home, version, signal, ...(source && distribution?.version === version ? { offlineRoot: source } : {}) });
    };
    const manager = port && home ? createBridgeManager({ directory: join(home, 'storages/qbf-bridge-management'),
      port: port.pluginManagement, archive, describe: current => port.bridgePlugin!.describe(current) }) : null;
    const updater = createProductUpdater(root, {
      async runtimeVersion() { return String((JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string }).version); },
      bridge: () => port ? port.pluginManagement.read(signal) : Promise.resolve(null),
      prepareArchive: archive,
      async reconcileBridge(id) { return manager && await manager.read(id) ? manager.reconcile(id, signal) : null; },
      async changeBridge(id, version) {
        if (!manager || !port) throw new Error('product_bridge_unavailable');
        if (await manager.read(id)) return manager.reconcile(id, signal);
        const before = await port.pluginManagement.read(signal);
        const action = version === null ? 'remove' : !before.installed ? 'install'
          : before.version && compareReleaseVersions(version, before.version) < 0 ? 'rollback' : 'update';
        return manager.execute({ id, action, version }, signal);
      },
      async ensureBridge(version, enabled, restartRequired, maintenanceId) {
        if (!port || !configuration || !admin) throw new Error('product_bridge_unavailable');
        const live = await port.bridgePlugin!.describe(signal).catch(() => null);
        const verify = async () => {
          const actual = await port.pluginManagement.read(signal);
          const loaded = await port.bridgePlugin!.describe(signal).catch(() => null);
          if (version === null ? actual.installed || loaded !== null
            : !actual.installed || actual.version !== version || actual.enabled !== enabled || enabled && loaded?.pluginVersion !== version) {
            throw new Error('product_bridge_load_unconfirmed');
          }
        };
        if (restartRequired || enabled && live?.pluginVersion !== version || version === null && live !== null) {
          await ensureProductEngineReload(root, maintenanceId, version, enabled, {
            restart: options.restartDsh ?? (() => createLocalDshMaintenance(admin.serviceManager).restart(configuration, signal)), verify });
        } else await verify();
      },
      stop: options.stop, start: options.start,
      async applyRuntime(transactionId) {
        if (!source) throw new Error('product_source_required');
        await applyFrameworkUpdate({ source, target: root, dependencies: true, retainLock: true, allowMajor: options.allowMajor, transactionId });
        // The parent operation already recorded the transaction ID before the first program file changed.
        await rm(join(root, '.framework-update.lock'));
      },
      async rollbackRuntime(transactionId) {
        if (existsSync(join(root, 'data/framework-updates', transactionId, 'journal.json'))) await rollbackFrameworkUpdate(root, transactionId);
        else if (existsSync(join(root, '.framework-update.lock'))) throw new Error('product_runtime_outcome_unknown');
      },
      async verify(version, wasRunning) {
        if ((await verifyFrameworkDistribution(root)).version !== version) throw new Error('product_runtime_version_unconfirmed');
        await options.verify(version, wasRunning);
        if (port && home && adapter) await registerManagedBridge(root, home, adapter.endpoint, await port.pluginManagement.read(signal));
      },
    });
    return { updater, async removeBridge(id: string) {
      const registered = await readManagedBridge(root);
      if (!registered) {
        if (port && (await port.pluginManagement.read(signal)).installed) throw new Error('product_bridge_not_registered_use_keep_bridge');
        return;
      }
      if (!port || !home || !adapter || registered.home !== home || registered.endpoint !== adapter.endpoint) throw new Error('product_bridge_registration_changed');
      const received = await manager?.read(id);
      const before = await port.pluginManagement.read(signal);
      if (!received && (before.legacy || before.version !== registered.version || before.source !== registered.source)) throw new Error('product_bridge_registration_changed');
      const result = manager && (received ? await manager.reconcile(id, signal)
        : await manager.execute({ id, action: 'remove', version: null }, signal));
      if (!result || !['removed', 'restart-required'].includes(result.state)) throw new Error('product_bridge_removal_unconfirmed');
      await ensureProductEngineReload(root, id, null, false, {
        async restart() {
          if (result.restartRequired) {
            if (options.restartDsh) await options.restartDsh();
            else await createLocalDshMaintenance(admin?.serviceManager).restart(configuration!, signal);
          }
        },
        async verify() {
          if ((await port.pluginManagement.read(signal)).installed || await port.bridgePlugin!.describe(signal).catch(() => null)) throw new Error('product_bridge_removal_unconfirmed');
        }
      });
      await registerManagedBridge(root, home, adapter.endpoint, await port.pluginManagement.read(signal));
    }, close: async () => { await client?.close(); } };
  } catch (error) { await client?.close(); throw error; }
}
