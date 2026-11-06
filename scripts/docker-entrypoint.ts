import { resolveRuntimeConfiguration } from './runtime-configuration.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from './cli.ts';
import { superviseFramework } from './framework-supervisor.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const configuration = resolveRuntimeConfiguration(root, undefined, process.env, root);
if (process.argv.length > 2) throw new Error('通过持久卷中的配置与环境变量配置容器。');
if (!existsSync(configuration)) {
  const code = await runCli(['init', '--config', configuration, '--host', '0.0.0.0']);
  if (code !== 0) throw new Error('docker_initialization_failed');
}
await superviseFramework(root, ['--config', configuration]);
