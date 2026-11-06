import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Registered local service data has one fixed location. */
export function resolveLivePath(root: string, name: string): string {
  return resolve(root, 'data/live', name);
}

/** Shared by CLI and its independently loaded supervisor. */
export function resolveRuntimeConfiguration(root: string, explicit: string | undefined,
  environment: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const live = resolveLivePath(root, 'framework-admin.json');
  const current = resolve(cwd, 'data/admin/config.json');
  const selected = explicit ?? environment.QQ_BRIDGE_FRAMEWORK_CONFIG
    ?? (resolve(cwd) === resolve(root) && existsSync(live) ? live
      : current);
  if (!selected) throw new Error('QQ_BRIDGE_FRAMEWORK_CONFIG 不能为空。');
  return resolve(cwd, selected);
}
