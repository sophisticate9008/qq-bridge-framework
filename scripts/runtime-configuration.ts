import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Shared by CLI and its independently loaded supervisor; does not import an executable entry point. */
export function resolveRuntimeConfiguration(root: string, explicit: string | undefined,
  environment: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const live = resolve(root, 'runtime/live/framework-admin.json');
  const selected = explicit ?? environment.QQ_BRIDGE_FRAMEWORK_CONFIG
    ?? (resolve(cwd) === resolve(root) && existsSync(live) ? live : 'runtime/admin/config.json');
  if (!selected) throw new Error('QQ_BRIDGE_FRAMEWORK_CONFIG 不能为空。');
  return resolve(cwd, selected);
}
