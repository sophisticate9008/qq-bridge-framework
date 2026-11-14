#!/usr/bin/env node
import { acquireFrameworkProcessLease } from '../src/host/framework-process-lease.ts';
import { resolveRuntimeConfiguration, resolveLivePath } from './runtime-configuration.ts';
import { MAX_DISTRIBUTION_BYTES } from '../src/contracts/framework-distribution.ts';
import { privatePermissions, securePermissions } from '../src/storage/file-security.ts';

import { parseNativeConversationDiagnostics } from '../src/contracts/native-diagnostics.ts';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, realpathSync, rmSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { connect, isIP } from 'node:net';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  gatewayAdminAddress,
  loadGatewayAdminConfiguration,
  startGatewayAdmin,
  type GatewayAdminConfiguration
} from '../src/admin/gateway.ts';
import { errorCode, isRecord } from '../src/core/values.ts';
import {
  loadOneBotGatewayConfiguration,
  startOneBotGateway,
  type OneBotGatewayConfiguration
} from '../src/host/onebot-gateway.ts';
import { loadSelectedNativeBootstrap } from './bootstrap-loader.ts';
import { printAdminHealth, readAdminHealth } from './admin-health.ts';
import { runTestFiles } from './test-runner.ts';
import { discoverTestFiles, parseTestShard, shardTestFiles, testConcurrency, testExecutionBatches, testNeedsBuild, TEST_SUITES, type TestShard, type TestSuite } from './test-discovery.ts';

const PLAYWRIGHT_VERSION = '1.61.1';
const BROWSER_TYPESCRIPT_VERSION = '5.9.3';
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const PROJECT_ROOT = basename(sourceRoot) === 'dist' ? dirname(sourceRoot) : sourceRoot;
const BROWSER_TARGETS = Object.freeze({
  browser: 'scripts/browser-smoke.ts',
  management: 'scripts/management-smoke.ts',
  'page-navigation': 'scripts/page-navigation-smoke.ts',
  activity: 'scripts/activity-smoke.ts',
  usage: 'scripts/usage-smoke.ts',
  markdown: 'scripts/markdown-smoke.ts',
  presentation: 'scripts/presentation-smoke.ts',
  'virtual-list-perf': 'scripts/virtual-list-perf-smoke.ts',
  'native-chat-ui': 'scripts/native-chat-ui-smoke.ts',
  'execution-journal': 'scripts/execution-journal-smoke.ts'
});

type CliCommand = 'init' | 'start' | 'status' | 'doctor' | 'version' | 'test' | 'build' | 'install' | 'uninstall';
type BrowserTarget = keyof typeof BROWSER_TARGETS;

export interface ParsedCliArguments {
  readonly command: CliCommand;
  readonly help: boolean;
  readonly config?: string;
  readonly gatewayConfig?: string;
  readonly conversation?: string;
  readonly account?: string;
  readonly json?: boolean;
  readonly serviceManager?: string;
  readonly bootstrap?: string;
  readonly host?: string;
  readonly port?: number;
  readonly browser: boolean;
  readonly withDeps: boolean;
  readonly adminOnly: boolean;
  readonly suite?: TestSuite;
  readonly built?: boolean;
  readonly skipBuild?: boolean;
  readonly shard?: TestShard;
  readonly target?: BrowserTarget;
  readonly skipBrowserDownload?: boolean;
}

export interface CliIo {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

/** Explicit service namespace plus unambiguous maintenance shortcuts. */
export function serviceArguments(argumentsList: readonly string[]): string[] | null {
  if (argumentsList[0] === 'service') return argumentsList.length === 1 ? ['help'] : argumentsList.slice(1);
  return ['stop', 'restart', 'repair-chat', 'logs', 'console', 'protocol', 'extensions', 'maintenance', 'describe'].includes(argumentsList[0] ?? '')
    ? [...argumentsList] : null;
}

class CliUsageError extends Error {}
class CliOperationError extends Error {}

const DEFAULT_IO: CliIo = {
  cwd: process.cwd(),
  env: process.env,
  stdout: message => console.log(message),
  stderr: message => console.error(message)
};

const GENERAL_HELP = `QQ Bridge Framework 命令行

用法：
  qbf-cli init [--config <管理配置>] [--service-manager <可信程序>] [--host <地址>] [--port <端口>]
  qbf-cli init --gateway-config <网关配置> [--config <管理配置>] [--service-manager <可信程序>] [--host <地址>] [--port <端口>]
  qbf-cli start [--config <管理配置>] [--admin-only] [--bootstrap <可信本机TS绝对路径>]
  qbf-cli status [--config <管理配置>] [--account <账号ID>] [--json]
  qbf-cli doctor [--conversation <group:群号|private:QQ号>] [--account <账号ID>] [--config <管理配置>] [--json]
  qbf-cli service <start|stop|restart|status|doctor|logs|console|protocol> [组件] [--json]
  qbf-cli restart [组件]
  qbf-cli stop [组件]
  qbf-cli logs [组件] [-f]
  qbf-cli protocol [协议组标识]
  qbf-cli extensions init <目录> --id <标识>
  qbf-cli extensions install <目录> [--stage] [--config <管理配置>]
  qbf-cli extensions <enable|disable|remove> <标识> [--stage] [--config <管理配置>]
  qbf-cli extensions <list|verify|apply|reconcile|reload> [标识或操作编号] [--config <管理配置>]
  qbf-cli maintenance [--apply]
  qbf-cli bridge <status|download|install|update|rollback|remove|reconcile> [参数]
  qbf-cli serve [--config <管理配置>] [--admin-only]
  qbf-cli update <新包目录> [--allow-major]
  qbf-cli --version
  qbf-cli test [--suite all|fast|deadline|integration|artifacts] [--built] [--skip-build] [--shard <序号/总数>]
  qbf-cli test --browser [--target <项目>] [--with-deps]
  qbf-cli install --browser [--skip-browser-download] [--with-deps]
  qbf-cli uninstall --browser
  qbf-cli uninstall --framework [--keep-bridge] [--operation-id <UUID>]
  qbf-cli build

配置优先级：--config > QQ_BRIDGE_FRAMEWORK_CONFIG > 已登记的本机配置 > 当前目录 data/admin/config.json
qbf-cli 为统一入口；源码目录可用 npm run cli -- <命令>。start 为前台启动，service start 为本机后台服务启动。
status 与不指定会话的 doctor 分别核对管理服务、网关、DSH、QQ、聊天及配置应用；某项读取失败仍显示其他项。
doctor --conversation 读取所属会话的详细诊断；service status/doctor 可在管理服务不可用时独立检查各后台组件。
init 默认创建独立的本机 OneBot HTTP 网关配置；--gateway-config 可复用已严格校验的高级网关配置。
默认上游为 http://127.0.0.1:3000，网关监听 127.0.0.1:3131，管理端监听 127.0.0.1:3210。
新配置不允许任何会话发送；请首次访问管理网页生成管理令牌，再显式配置外部 OneBot 和发送范围。
只有显式提供 --service-manager 时才启用服务管理，不会自动猜测或执行脚本。
start 默认启动或复用配置匹配的 gateway；--admin-only 仅启动管理界面。
--bootstrap 在本次 start 显式选择可信本机 TypeScript 扩展；未指定时读取管理配置旁的固定版本选择，不自动授予权限。
普通安装、构建、启动和单元测试不需要 Playwright。
test 默认执行 fast 源码测试，无需构建；--suite all 执行完整源码测试，--built 默认执行完整编译后测试。
--suite 可单独选择 integration、deadline 或 artifacts；需要产物时自动构建，--built --skip-build 复用已有产物。
--shard 1/3 按文件稳定分片；QQ_TEST_CONCURRENCY 设置每个进程的文件并发数（默认 4）。
install --browser 或 test --browser 才准备 .cache/testing/ 内的独立浏览器测试工具。
--skip-browser-download 只安装测试包；--with-deps 额外安装系统库，可能需要管理员权限。
--target 可选：${Object.keys(BROWSER_TARGETS).join('、')}；省略时执行全部浏览器测试。
uninstall --browser 只清理 .cache/testing/，不修改项目依赖、配置、会话或测试证据。`;

function usage(message: string): never {
  throw new CliUsageError(message);
}

function optionValue(argumentsList: readonly string[], index: number, option: string): string {
  const value = argumentsList[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith('--')) usage(`参数 ${option} 缺少值。`);
  return value;
}

export function parseCliArguments(argumentsList: readonly string[]): ParsedCliArguments {
  const first = argumentsList[0];
  if (first === undefined) usage('缺少命令。');
  if (['--version', '-v', 'version'].includes(first)) {
    if (argumentsList.length !== 1) usage('版本命令不接受其他参数。');
    return { command: 'version', help: false, browser: false, withDeps: false, adminOnly: false };
  }
  if (first === '--help' || first === '-h' || first === 'help') {
    if (argumentsList.length !== 1) usage('帮助命令不接受其他参数。');
    return { command: 'start', help: true, browser: false, withDeps: false, adminOnly: false };
  }
  if (!['init', 'start', 'status', 'doctor', 'test', 'build', 'install', 'uninstall'].includes(first)) usage('未知命令。');
  const command = first as CliCommand;
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 1; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index]!;
    if (argument === '--help' || argument === '-h') {
      if (argumentsList.length !== 2) usage('帮助参数不能与其他参数同时使用。');
      return { command, help: true, browser: false, withDeps: false, adminOnly: false };
    }
    if (['--browser', '--with-deps', '--admin-only', '--skip-browser-download', '--built', '--skip-build', '--json'].includes(argument)) {
      if (flags.has(argument)) usage(`参数 ${argument} 不能重复。`);
      flags.add(argument);
      continue;
    }
    if (['--config', '--gateway-config', '--service-manager', '--host', '--port', '--target', '--bootstrap', '--suite', '--shard', '--conversation', '--account'].includes(argument)) {
      if (values.has(argument)) usage(`参数 ${argument} 不能重复。`);
      values.set(argument, optionValue(argumentsList, index, argument));
      index += 1;
      continue;
    }
    usage('存在无法识别的参数。');
  }

  const allowed = command === 'init'
    ? new Set(['--config', '--gateway-config', '--service-manager', '--host', '--port'])
    : command === 'start' ? new Set(['--config', '--admin-only', '--bootstrap'])
      : command === 'doctor' ? new Set(['--config', '--conversation', '--account', '--json'])
      : command === 'status' ? new Set(['--config', '--account', '--json'])
      : command === 'test' ? new Set(['--browser', '--with-deps', '--target', '--suite', '--built', '--skip-build', '--shard'])
        : command === 'install' ? new Set(['--browser', '--with-deps', '--skip-browser-download'])
          : command === 'uninstall' ? new Set(['--browser']) : new Set<string>();
  for (const option of [...values.keys(), ...flags]) {
    if (!allowed.has(option)) usage(`命令 ${command} 不支持参数 ${option}。`);
  }
  if (flags.has('--with-deps') && !flags.has('--browser')) usage('--with-deps 只能与 --browser 一起使用。');
  const suite = values.get('--suite');
  if (suite !== undefined && !TEST_SUITES.some(value => value === suite)) usage(`--suite 可选：${TEST_SUITES.join('、')}。`);
  if (flags.has('--browser') && (suite !== undefined || flags.has('--built') || flags.has('--skip-build') || values.has('--shard'))) usage('--browser 不能与 --suite、--built、--skip-build 或 --shard 同时使用。');
  if (flags.has('--skip-build') && !flags.has('--built')) usage('--skip-build 需要 --built，且调用前须准备好编译产物。');
  const shardText = values.get('--shard');
  const shard = shardText === undefined ? undefined : parseTestShard(shardText);
  if ((command === 'install' || command === 'uninstall') && !flags.has('--browser')) usage('请指定 --browser，只管理可选的浏览器测试工具。');
  if (flags.has('--skip-browser-download') && flags.has('--with-deps')) usage('--skip-browser-download 不能与 --with-deps 同时使用。');
  const target = values.get('--target');
  if (target !== undefined && (!flags.has('--browser') || !Object.hasOwn(BROWSER_TARGETS, target))) {
    usage(`--target 必须与 --browser 一起使用，可选：${Object.keys(BROWSER_TARGETS).join('、')}。`);
  }
  const conversation = values.get('--conversation');
  if (conversation !== undefined && !/^(?:group|private):[1-9][0-9]{0,31}$/.test(conversation)) usage('会话需要 group:群号 或 private:QQ号。');
  const account = values.get('--account');
  if (account !== undefined && !/^[0-9a-f]{64}$/.test(account)) usage('--account 需要账号管理中的完整账号ID。');
  const portText = values.get('--port');
  if (portText !== undefined && !/^[1-9]\d{0,4}$/.test(portText)) usage('--port 必须是 1 到 65535 的整数。');
  const port = portText === undefined ? undefined : Number(portText);
  if (port !== undefined && port > 65_535) usage('--port 必须是 1 到 65535 的整数。');
  const bootstrap = values.get('--bootstrap');
  if (bootstrap !== undefined && (!isAbsolute(bootstrap) || resolve(bootstrap) !== bootstrap
    || !bootstrap.endsWith('.ts') || bootstrap.length > 4096 || /[\x00-\x1f\x7f?#]/.test(bootstrap))) {
    usage('--bootstrap 必须是明确的本机 .ts 文件绝对路径，不能使用 URL、相对路径或查询参数。');
  }
  return {
    command,
    help: false,
    ...(flags.has('--json') ? { json: true } : {}),
    ...(conversation === undefined ? {} : { conversation }),
    ...(account === undefined ? {} : { account }),
    ...(values.has('--config') ? { config: values.get('--config')! } : {}),
    ...(values.has('--gateway-config') ? { gatewayConfig: values.get('--gateway-config')! } : {}),
    ...(values.has('--service-manager') ? { serviceManager: values.get('--service-manager')! } : {}),
    ...(bootstrap === undefined ? {} : { bootstrap }),
    ...(values.has('--host') ? { host: values.get('--host')! } : {}),
    ...(port === undefined ? {} : { port }),
    browser: flags.has('--browser'),
    withDeps: flags.has('--with-deps'),
    adminOnly: flags.has('--admin-only'),
    ...(suite === undefined ? {} : { suite: suite as TestSuite }),
    ...(flags.has('--built') ? { built: true } : {}),
    ...(flags.has('--skip-build') ? { skipBuild: true } : {}),
    ...(shard === undefined ? {} : { shard }),
    ...(target === undefined ? {} : { target: target as BrowserTarget }),
    ...(flags.has('--skip-browser-download') ? { skipBrowserDownload: true } : {})
  };
}

export function resolveConfigurationFilename(
  explicit: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()
): string {
  try { return resolveRuntimeConfiguration(PROJECT_ROOT, explicit, environment, cwd); }
  catch { return usage('QQ_BRIDGE_FRAMEWORK_CONFIG 不能为空。'); }
}

function trustedServiceManager(filename: string, cwd: string): string {
  const selected = resolve(cwd, filename);
  let metadata: Stats;
  try {
    metadata = lstatSync(selected);
  } catch {
    throw new CliOperationError('--service-manager 必须指向已存在的可信可执行文件。');
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o111) === 0 || (metadata.mode & 0o022) !== 0) {
    throw new CliOperationError('--service-manager 必须是不可被组或其他用户写入的普通可执行文件，且不能是符号链接。');
  }
  return selected;
}

function gatewayRuntimeDirectory(configurationFilename: string): string {
  const configurationDirectory = dirname(configurationFilename);
  const privateRoot = basename(configurationDirectory) === 'admin'
    ? dirname(configurationDirectory)
    : configurationDirectory;
  return join(privateRoot, 'gateway');
}

function pathExists(filename: string): boolean {
  try {
    lstatSync(filename);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function preflightAbsent(files: readonly string[]): void {
  const duplicate = new Set(files).size !== files.length;
  if (duplicate) throw new CliOperationError('初始化目标路径发生冲突，未创建任何文件。');
  const existing = files.find(pathExists);
  if (existing !== undefined) throw new CliOperationError(`初始化目标已存在，拒绝覆盖：${existing}`);
}

function privateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') securePermissions(directory, 0o700);
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !privatePermissions(directory, metadata, 0o700)) {
    throw new CliOperationError(`初始化目录必须是权限 0700 的真实目录：${directory}`);
  }
}

function writePrivateFile(filename: string, content: string, createdFiles: string[]): void {
  writeFileSync(filename, content, { mode: 0o600, flag: 'wx' });
  createdFiles.push(filename);
  chmodSync(filename, 0o600);
  if (process.platform === 'win32') securePermissions(filename, 0o600);
  const metadata = lstatSync(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink() || !privatePermissions(filename, metadata, 0o600)) {
    throw new CliOperationError(`初始化文件必须是权限 0600 的普通文件：${filename}`);
  }
}

function assertDistinctGatewayEndpoint(configuration: Readonly<OneBotGatewayConfiguration>): void {
  const upstream = new URL(configuration.upstreamEndpoint);
  const upstreamPort = Number(upstream.port || '80');
  if (configuration.port !== 0 && upstreamPort === configuration.port) {
    throw new CliOperationError('OneBot 上游端点不能指向网关自身，存在自代理风险，拒绝初始化。');
  }
}

function writeAdminConfiguration(options: {
  readonly filename: string;
  readonly gatewayConfiguration: string;
  readonly serviceManager?: string;
  readonly host?: string;
  readonly port?: number;
  readonly createdFiles: string[];
}): void {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 3210;
  if (host !== 'localhost' && isIP(host) === 0) {
    throw new CliOperationError('--host 必须是明确的 IP 地址或 localhost。');
  }
  const tokenFile = join(dirname(options.filename), 'gateway-admin.token');
  const markerFile = `${tokenFile}.initialized`;
  preflightAbsent([options.filename, tokenFile, markerFile]);
  privateDirectory(dirname(options.filename));
  writePrivateFile(options.filename, JSON.stringify({
    host,
    port,
    tokenFile,
    gatewayConfiguration: options.gatewayConfiguration,
    ...(options.serviceManager === undefined ? {} : { serviceManager: options.serviceManager })
  }, null, 2) + '\n', options.createdFiles);
  loadGatewayAdminConfiguration(options.filename);
}

function standaloneGatewayFiles(configurationFilename: string): {
  readonly configuration: string;
  readonly token: string;
  readonly store: string;
} {
  const directory = gatewayRuntimeDirectory(configurationFilename);
  return Object.freeze({
    configuration: join(directory, 'config.json'),
    token: join(directory, 'gateway.token'),
    store: join(directory, 'gateway.sqlite')
  });
}

function adminInitializationFiles(configurationFilename: string): readonly string[] {
  const tokenFile = join(dirname(configurationFilename), 'gateway-admin.token');
  return Object.freeze([configurationFilename, tokenFile, `${tokenFile}.initialized`]);
}

function writeStandaloneGateway(configurationFilename: string, createdFiles: string[]): string {
  const files = standaloneGatewayFiles(configurationFilename);
  preflightAbsent([files.configuration, files.token, files.store]);
  privateDirectory(dirname(files.configuration));
  writePrivateFile(files.token, `${randomBytes(32).toString('hex')}\n`, createdFiles);
  writePrivateFile(files.configuration, JSON.stringify({
    port: 3131,
    upstreamEndpoint: 'http://127.0.0.1:3000',
    tokenFile: './gateway.token',
    storeFilename: './gateway.sqlite',
    allowedConversations: [],
    persona: { id: 'standalone-onebot', version: '1.0.0' },
    timeoutMs: 60_000,
    budgetEnabled: false
  }, null, 2) + '\n', createdFiles);
  const configuration = loadOneBotGatewayConfiguration(files.configuration);
  assertDistinctGatewayEndpoint(configuration);
  return files.configuration;
}

function cliErrorMessage(error: unknown): string {
  if (error instanceof CliOperationError) return error.message;
  return errorCode(error, 'CLI_FAILED');
}

function runProcess(executable: string, argumentsList: readonly string[], options: {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
} = {}): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, argumentsList, {
      cwd: options.cwd ?? PROJECT_ROOT,
      env: options.env ?? process.env,
      shell: false,
      stdio: 'inherit'
    });
    child.once('error', rejectPromise);
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new CliOperationError(signal === null
        ? `子进程退出，状态码 ${code ?? 'unknown'}。`
        : `子进程被信号 ${signal} 终止。`));
    });
  });
}

async function build(webOnly = false): Promise<void> {
  await runProcess(process.execPath, [resolve(PROJECT_ROOT, 'scripts/build.ts'), ...(webOnly ? ['--web'] : [])]);
}

export function browserToolchainPaths(root = PROJECT_ROOT) {
  const directory = resolve(root, '.cache/testing');
  return Object.freeze({
    directory,
    manifest: join(directory, 'package.json'),
    browsers: join(directory, 'browsers'),
    configuration: join(directory, 'tsconfig.json'),
    playwright: join(directory, 'node_modules/playwright/cli.js'),
    typescript: join(directory, 'node_modules/typescript/bin/tsc'),
    resolver: resolve(root, 'scripts/browser-toolchain.ts')
  });
}

export function browserSmokeFiles(target?: BrowserTarget): readonly string[] {
  return target === undefined ? Object.values(BROWSER_TARGETS) : [BROWSER_TARGETS[target]];
}

function requireBrowserToolchainMarker(filename: string): void {
  let descriptor: number | undefined;
  try {
    const pathname = lstatSync(filename);
    if (!pathname.isFile() || pathname.isSymbolicLink() || pathname.size > 4096) throw new Error('invalid_marker');
    descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size > 4096 || before.dev !== pathname.dev || before.ino !== pathname.ino) {
      throw new Error('invalid_marker');
    }
    const buffer = Buffer.alloc(4097);
    const count = readSync(descriptor, buffer, 0, buffer.length, 0);
    const after = fstatSync(descriptor);
    const current = lstatSync(filename);
    if (count === 0 || count > 4096 || count !== before.size || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || !current.isFile() || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino) {
      throw new Error('invalid_marker');
    }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count)));
    if (!isRecord(value) || value.name !== 'qq-bridge-framework-browser-testing' || value.private !== true || value.type !== 'module') {
      throw new Error('invalid_marker');
    }
  } catch {
    throw new CliOperationError('浏览器测试目录缺少有效的本工具安装标记，拒绝覆盖或清理；请保留文件并手动核对。');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

async function prepareBrowser(withDeps: boolean, downloadBrowser: boolean, io: CliIo): Promise<void> {
  const paths = browserToolchainPaths();
  privateDirectory(dirname(paths.directory));
  privateDirectory(paths.directory);
  const manifest = JSON.stringify({
    name: 'qq-bridge-framework-browser-testing',
    private: true,
    type: 'module',
    dependencies: { playwright: PLAYWRIGHT_VERSION, typescript: BROWSER_TYPESCRIPT_VERSION }
  }, null, 2) + '\n';
  if (pathExists(paths.manifest) || readdirSync(paths.directory).length > 0) requireBrowserToolchainMarker(paths.manifest);
  const changed = !existsSync(paths.manifest) || readFileSync(paths.manifest, 'utf8') !== manifest;
  if (changed) writeFileSync(paths.manifest, manifest, { mode: 0o600 });
  const installed = (name: string, version: string): boolean => {
    try {
      const metadata: unknown = JSON.parse(readFileSync(join(paths.directory, 'node_modules', name, 'package.json'), 'utf8'));
      return isRecord(metadata) && metadata.version === version;
    } catch { return false; }
  };
  const environment = { ...io.env, PLAYWRIGHT_BROWSERS_PATH: paths.browsers, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' };
  if (changed || !installed('playwright', PLAYWRIGHT_VERSION) || !installed('playwright-core', PLAYWRIGHT_VERSION)
    || !installed('typescript', BROWSER_TYPESCRIPT_VERSION) || !existsSync(paths.playwright) || !existsSync(paths.typescript)) {
    io.stdout('正在安装独立浏览器测试包，不修改项目依赖。');
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    await runProcess(npm, [
      'install', '--prefix', paths.directory,
      '--ignore-scripts',
      '--package-lock=true',
      '--prefer-offline',
      '--no-audit',
      '--no-fund'
    ], { cwd: paths.directory, env: environment });
  }
  writeFileSync(paths.configuration, JSON.stringify({
    extends: resolve(PROJECT_ROOT, 'tsconfig.browser.json'),
    compilerOptions: {
      paths: {
        '@/*': [resolve(PROJECT_ROOT, 'web/*')],
        playwright: [join(paths.directory, 'node_modules/playwright/index.d.ts')],
        'playwright/*': [join(paths.directory, 'node_modules/playwright/*')],
        'playwright-core': [join(paths.directory, 'node_modules/playwright-core/index.d.ts')]
      }
    }
  }, null, 2) + '\n', { mode: 0o600 });
  if (downloadBrowser && (withDeps || !io.env.CHROMIUM_EXECUTABLE)) {
    io.stdout('正在准备测试用 Chromium；系统库仅在指定 --with-deps 时安装。');
    await runProcess(process.execPath, [paths.playwright, 'install', ...(withDeps ? ['--with-deps'] : []), 'chromium'],
      { cwd: paths.directory, env: environment });
  }
  io.stdout(downloadBrowser ? '浏览器测试工具已就绪。' : '浏览器测试包已安装，未下载浏览器。');
}

export function uninstallBrowserToolchain(root = PROJECT_ROOT): void {
  const paths = browserToolchainPaths(root);
  if (!pathExists(paths.directory)) return;
  if (lstatSync(dirname(paths.directory)).isSymbolicLink() || !lstatSync(paths.directory).isDirectory()
    || lstatSync(paths.directory).isSymbolicLink()) {
    throw new CliOperationError('浏览器测试目录必须是真实目录，拒绝清理符号链接。');
  }
  requireBrowserToolchainMarker(paths.manifest);
  rmSync(paths.directory, { recursive: true, force: true });
}

async function runTests(parsed: ParsedCliArguments, io: CliIo): Promise<void> {
  const { browser, withDeps, target } = parsed;
  if (!browser) {
    const concurrency = testConcurrency(io.env.QQ_TEST_CONCURRENCY);
    const suite = parsed.suite ?? (parsed.built ? 'all' : 'fast');
    if (!parsed.skipBuild && testNeedsBuild(suite, parsed.built === true)) await build();
    const directory = parsed.built ? 'dist/test' : 'test';
    const files = shardTestFiles(discoverTestFiles(resolve(PROJECT_ROOT, directory), parsed.built ? '.js' : '.ts', suite), parsed.shard);
    if (files.length === 0) throw new CliOperationError(`测试集合 ${suite} 未发现测试：${directory}，请核对构建产物和分片数量。`);
    const shardLabel = parsed.shard ? `，分片 ${parsed.shard.index}/${parsed.shard.total}` : '';
    io.stdout(`执行 ${suite} 测试：${directory}（${files.length} 个文件，并发 ${concurrency}${shardLabel}）`);
    const started = Date.now();
    let tests = 0;
    let passed = 0;
    let skipped = 0;
    for (const batch of testExecutionBatches(files)) {
      const result = await runTestFiles(batch, { concurrency, cwd: PROJECT_ROOT, stdout: io.stdout, stderr: io.stderr });
      tests += result.tests;
      passed += result.passed;
      skipped += result.skipped;
      if (result.failed > 0) throw new CliOperationError(`${result.failed} 个测试文件失败。`);
    }
    io.stdout(`测试完成：${suite}，${files.length} 个文件，${tests} 项测试，${passed} 通过，${skipped} 跳过，耗时 ${((Date.now() - started) / 1000).toFixed(1)} 秒。`);

    return;
  }
  await prepareBrowser(withDeps, true, io);
  const paths = browserToolchainPaths();
  await runProcess(process.execPath, [
    paths.typescript,
    '-p',
    paths.configuration,
    '--noEmit'
  ]);
  await build(true);
  for (const smoke of browserSmokeFiles(target)) {
    io.stdout(`执行浏览器测试：${smoke}`);
    await runProcess(process.execPath, ['--import', pathToFileURL(paths.resolver).href, resolve(PROJECT_ROOT, smoke)], {
      env: { ...io.env, QQ_BRIDGE_FRAMEWORK_BROWSER_TOOLCHAIN_ROOT: paths.directory, PLAYWRIGHT_BROWSERS_PATH: paths.browsers }
    });
  }
}

function revision(configuration: Readonly<GatewayAdminConfiguration> | Readonly<OneBotGatewayConfiguration>): string {
  return createHash('sha256').update(JSON.stringify(configuration)).digest('hex');
}

type PortState = 'open' | 'closed' | 'unknown';

function gatewayPortState(port: number): Promise<PortState> {
  return new Promise(resolvePromise => {
    const socket = connect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (state: PortState): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(state);
    };
    socket.setTimeout(1_500);
    socket.once('connect', () => finish('open'));
    socket.once('timeout', () => finish('unknown'));
    socket.once('error', error => finish('code' in error && error.code === 'ECONNREFUSED' ? 'closed' : 'unknown'));
  });
}

export interface PreparedGateway {
  readonly started: boolean;
  close(): Promise<void>;
}

export async function prepareGatewayForStart(configurationFilename: string): Promise<PreparedGateway> {
  const configuration = loadOneBotGatewayConfiguration(configurationFilename);
  assertDistinctGatewayEndpoint(configuration);
  if (configuration.port === 0) {
    throw new CliOperationError('统一启动要求 gateway 配置使用固定非零端口；仅启动管理界面可使用 --admin-only。');
  }
  const portState = await gatewayPortState(configuration.port);
  if (portState === 'unknown') throw new CliOperationError('无法安全确认 gateway 端口状态，未启动任何服务。');
  if (portState === 'open') {
    const token = readFileSync(configuration.tokenFile, 'utf8').trim();
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${configuration.port}/health`, {
        headers: { authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(2_500)
      });
    } catch {
      throw new CliOperationError('gateway 端口已被占用，但无法验证现有服务。');
    }
    const health = await readJson(response);
    if (!response.ok || !isRecord(health) || health.ok !== true
      || health.mode !== 'onebot-egress' || health.revision !== revision(configuration)) {
      throw new CliOperationError('gateway 端口已被其他或配置不匹配的服务占用。');
    }
    return Object.freeze({ started: false, async close() {} });
  }
  const service = await startOneBotGateway(configuration);
  return Object.freeze({ started: true, close: () => service.close() });
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new CliOperationError('管理服务返回了无效响应。');
  }
}

async function status(configurationFilename: string, output: (message: string) => void, account?: string, json = false): Promise<boolean> {
  const report = await readAdminHealth(loadGatewayAdminConfiguration(configurationFilename), account);
  if (json) output(JSON.stringify(report, null, 2));
  else printAdminHealth(report, output);
  return report.healthy;
}

async function doctor(configurationFilename: string, conversationId: string, output: (message: string) => void, account?: string): Promise<boolean> {
  const configuration = loadGatewayAdminConfiguration(configurationFilename);
  if (!existsSync(configuration.tokenFile)) throw new CliOperationError('请先完成管理端初始化，才能读取逐会话诊断。');
  const token = readFileSync(configuration.tokenFile, 'utf8').trim();
  let response: Response;
  const endpoint = new URL(account ? '/api/accounts/dispatch' : '/api/chat/diagnostics', gatewayAdminAddress(configuration));
  endpoint.searchParams.set('conversationId', conversationId);
  if (account) { endpoint.searchParams.set('account', account); endpoint.searchParams.set('path', '/api/chat/diagnostics'); }
  try {
    response = await fetch(endpoint, {
      headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(15_000)
    });
  } catch { throw new CliOperationError('无法读取逐会话诊断；请检查管理服务。'); }
  const result = await readJson(response);
  const parsed = parseNativeConversationDiagnostics(result);
  if (!response.ok || !parsed || parsed.conversationId !== conversationId) {
    throw new CliOperationError('逐会话诊断不可用，尚未确认会话正常。');
  }
  output(JSON.stringify(parsed, null, 2));
  return parsed.state === 'ready';
}

async function start(configurationFilename: string, adminOnly: boolean, output: (message: string) => void,
  bootstrapFilename?: string): Promise<void> {
  const release = existsSync(join(PROJECT_ROOT, 'distribution.json')) && !existsSync(join(PROJECT_ROOT, '.git'))
    ? await acquireFrameworkProcessLease(PROJECT_ROOT, 'runtime') : async () => undefined;
  try { await startRuntime(configurationFilename, adminOnly, output, bootstrapFilename); }
  finally { await release(); }
}

async function startRuntime(configurationFilename: string, adminOnly: boolean, output: (message: string) => void,
  bootstrapFilename?: string): Promise<void> {
  if (existsSync(join(PROJECT_ROOT, '.framework-update.lock'))) throw new CliOperationError('框架更新尚未完成，请使用受监督启动入口恢复或执行更新回滚。');
  const { readProductUpdate, productUpdateAllowsStart } = await import('../src/host/product-update.ts');
  if (!productUpdateAllowsStart(await readProductUpdate(PROJECT_ROOT))) throw new CliOperationError('整套组件更新尚未核对完成，请使用受监督恢复或 qbf-cli update --reconcile <原操作编号>。');
  const { productUninstallPending } = await import('../src/host/product-uninstall.ts');
  if (await productUninstallPending(PROJECT_ROOT)) throw new CliOperationError('本次卸载尚未完成，请用原卸载编号继续核对，保留配置与会话。');
  const configuration = loadGatewayAdminConfiguration(configurationFilename);
  const bootstrap = await loadSelectedNativeBootstrap(configurationFilename, bootstrapFilename);
  await prepareStartupAssets();
  let gateway: PreparedGateway | undefined;
  let service: Awaited<ReturnType<typeof startGatewayAdmin>>;
  try {
    if (!adminOnly) gateway = await prepareGatewayForStart(configuration.gatewayConfiguration);
    service = await startGatewayAdmin(configuration, { configurationFilename, ...(bootstrap === undefined ? {} : { bootstrap }) });
  } catch (error: unknown) {
    if (gateway?.started) await gateway.close();
    throw error;
  }
  output(`${gateway?.started ? 'gateway 与管理服务' : adminOnly ? '管理服务' : '现有 gateway 与管理服务'}已启动：${gatewayAdminAddress({
    ...configuration,
    port: service.address.port
  })}`);
  if (bootstrap !== undefined) {
    output(`可信启动扩展已加载：${bootstrap.metadata.manifest.id}@${bootstrap.metadata.manifest.version}；功能权限仍需独立授权。`);
  }
  await new Promise<void>((resolvePromise, rejectPromise) => {
    let closing = false;
    const handlers = new Map<NodeJS.Signals, () => void>();
    const cleanup = (): void => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      process.off('message', onMessage);
      process.off('disconnect', close);
      if (process.connected) process.disconnect();
    };
    const close = (): void => {
      if (closing) return;
      closing = true;
      void (async () => {
        try {
          await service.close();
          if (gateway?.started) await gateway.close();
          cleanup();
          resolvePromise();
        } catch (error: unknown) {
          if (gateway?.started) await gateway.close().catch(() => undefined);
          cleanup();
          rejectPromise(error);
        }
      })();
    };
    const onMessage = (message: unknown): void => {
      if (isRecord(message) && message.type === 'qqbridge.shutdown') close();
    };
    // Only an existing parent IPC channel can request shutdown; no management endpoint is added.
    if (process.send) { process.on('message', onMessage); process.once('disconnect', close); }
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
      const handler = (): void => close();
      handlers.set(signal, handler);
      process.once(signal, handler);
    }
  });
}

async function prepareStartupAssets(): Promise<void> {
  const filename = resolve(PROJECT_ROOT, 'distribution.json');
  if (import.meta.url.endsWith('.js') && existsSync(filename)) {
    const metadata = lstatSync(filename);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_DISTRIBUTION_BYTES) {
      throw new CliOperationError('发行包标识无效，请重新解压完整框架包。');
    }
    let distribution: unknown;
    let manifest: unknown;
    try {
      distribution = JSON.parse(readFileSync(filename, 'utf8'));
      manifest = JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'package.json'), 'utf8'));
    }
    catch { throw new CliOperationError('发行包标识无效，请重新解压完整框架包。'); }
    if (!isRecord(distribution) || distribution.schema !== 1 || distribution.kind !== 'framework-runtime'
      || typeof distribution.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(distribution.version)) {
      throw new CliOperationError('发行包标识无效，请重新解压完整框架包。');
    }
    if (!isRecord(manifest) || manifest.version !== distribution.version) {
      throw new CliOperationError('发行包版本不一致，请重新解压完整框架包。');
    }
    for (const name of ['index.html', 'app.js']) {
      const asset = resolve(PROJECT_ROOT, 'dist/admin-web', name);
      if (!existsSync(asset) || !lstatSync(asset).isFile() || lstatSync(asset).isSymbolicLink()) {
        throw new CliOperationError('发行包网页资源缺失，请重新解压完整框架包。');
      }
    }
    return;
  }
  await build(true);
}

export async function runCli(argumentsList: readonly string[], io: CliIo = DEFAULT_IO): Promise<number> {
  if (argumentsList[0] === 'bridge') {
    const { bridgeCli } = await import('./bridge-cli.ts');
    return bridgeCli(argumentsList.slice(1), io.stdout, io.stderr);
  }
  if (argumentsList[0] === 'serve') {
    try {
      parseCliArguments(['start', ...argumentsList.slice(1)]);
      const { superviseFramework } = await import('./framework-supervisor.ts');
      await superviseFramework(PROJECT_ROOT, argumentsList.slice(1));
      return 0;
    } catch { io.stderr('受监督启动失败，请检查发行包、配置及更新恢复记录。'); return 1; }
  }
  if (argumentsList[0] === 'update') {
    try { const { updateFrameworkCli } = await import('./update-framework.ts'); await updateFrameworkCli(argumentsList.slice(1), PROJECT_ROOT, io.stdout); return 0; }
    catch (error) { io.stderr(error instanceof Error ? error.message : '更新失败'); return 1; }
  }
  if (argumentsList[0] === 'uninstall' && argumentsList.includes('--framework')) {
    try {
      const { uninstallFrameworkCli } = await import('./uninstall-framework.ts');
      await uninstallFrameworkCli(argumentsList.slice(1), PROJECT_ROOT, io.stdout); return 0;
    } catch (error) { io.stderr(error instanceof Error ? error.message : '卸载未完成，请保留原操作编号核对。'); return 1; }
  }
  const managed = serviceArguments(argumentsList);
  if (argumentsList[0] === 'extensions') {
    try {
      const { managedExtensionCli } = await import('./managed-extension-cli.ts');
      return await managedExtensionCli(argumentsList.slice(1), { cwd: io.cwd, env: io.env, output: io.stdout, framework: PROJECT_ROOT });
    } catch (error) { io.stderr(`${errorCode(error,'EXTENSION_OPERATION_FAILED')}: ${error instanceof Error ? error.message : '扩展管理失败，请保留原操作编号。'}`); return 1; }
  }
  if (managed) return new Promise<number>(resolvePromise => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./service-manager' + (import.meta.url.endsWith('.js') ? '.js' : '.ts'), import.meta.url)), ...managed],
      { cwd: io.cwd, env: io.env, stdio: ['inherit', 'pipe', 'pipe'] });
    child.stdout.on('data', (data: Buffer) => io.stdout(data.toString('utf8').replace(/\n$/, '')));
    child.stderr.on('data', (data: Buffer) => io.stderr(data.toString('utf8').replace(/\n$/, '')));
    const forward = (signal: NodeJS.Signals) => { child.kill(signal); };
    const handlers = new Map<NodeJS.Signals, () => void>();
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) { const handler = () => forward(signal); handlers.set(signal, handler); process.on(signal, handler); }
    const finish = (code: number) => { for (const [signal, handler] of handlers) process.off(signal, handler); resolvePromise(code); };
    child.once('error', () => { io.stderr('无法启动服务管理入口。'); finish(1); });
    child.once('exit', code => finish(code ?? 1));
  });
  let parsed: ParsedCliArguments;
  try {
    parsed = parseCliArguments(argumentsList);
  } catch (error: unknown) {
    io.stderr(error instanceof CliUsageError ? error.message : '参数解析失败。');
    io.stderr(GENERAL_HELP);
    return 1;
  }
  if (parsed.help) {
    io.stdout(GENERAL_HELP);
    return 0;
  }
  const configurationFilename = () => {
    const live = resolveLivePath(PROJECT_ROOT, 'framework-admin.json');
    const explicit = parsed.config ?? (io === DEFAULT_IO && !io.env.QQ_BRIDGE_FRAMEWORK_CONFIG && existsSync(live) ? live : undefined);
    return resolveConfigurationFilename(explicit, io.env, io.cwd);
  };
  try {
    if (parsed.command === 'version') {
      const manifest: unknown = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'));
      if (!isRecord(manifest) || typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new CliOperationError('版本信息不可读。');
      io.stdout(`qbf-cli ${manifest.version}`);
    } else if (parsed.command === 'init') {
      const filename = resolveConfigurationFilename(parsed.config, io.env, io.cwd);
      if (pathExists(filename)) {
        throw new CliOperationError('管理配置已存在，拒绝覆盖已有部署。');
      }
      const serviceManager = parsed.serviceManager === undefined
        ? undefined
        : trustedServiceManager(parsed.serviceManager, io.cwd);
      preflightAbsent(adminInitializationFiles(filename));
      if (parsed.gatewayConfig === undefined) {
        const standalone = standaloneGatewayFiles(filename);
        preflightAbsent([standalone.configuration, standalone.token, standalone.store]);
      }
      const createdFiles: string[] = [];
      try {
        const gatewayConfigurationFilename = parsed.gatewayConfig !== undefined
          ? resolve(io.cwd, parsed.gatewayConfig)
          : writeStandaloneGateway(filename, createdFiles);
        const gatewayConfiguration = loadOneBotGatewayConfiguration(gatewayConfigurationFilename);
        assertDistinctGatewayEndpoint(gatewayConfiguration);
        writeAdminConfiguration({
          filename,
          gatewayConfiguration: gatewayConfigurationFilename,
          ...(serviceManager === undefined ? {} : { serviceManager }),
          ...(parsed.host === undefined ? {} : { host: parsed.host }),
          ...(parsed.port === undefined ? {} : { port: parsed.port }),
          createdFiles
        });
      } catch (error: unknown) {
        for (const filename of createdFiles.reverse()) {
          try { unlinkSync(filename); } catch {}
        }
        throw error;
      }
      io.stdout(`管理配置已创建：${filename}`);
      const address = gatewayAdminAddress(loadGatewayAdminConfiguration(filename));
      io.stdout(`启动后访问 ${address}，首次网页访问将生成管理令牌。`);
    } else if (parsed.command === 'start') {
      await start(configurationFilename(), parsed.adminOnly, io.stdout, parsed.bootstrap);
    } else if (parsed.command === 'doctor') {
      const filename = configurationFilename();
      if (parsed.conversation) return await doctor(filename, parsed.conversation, io.stdout, parsed.account) ? 0 : 1;
      else return await status(filename, io.stdout, parsed.account, parsed.json) ? 0 : 1;
    } else if (parsed.command === 'status') {
      return await status(configurationFilename(), io.stdout, parsed.account, parsed.json) ? 0 : 1;
    } else if (parsed.command === 'test') {
      await runTests(parsed, io);
    } else if (parsed.command === 'install') {
      await prepareBrowser(parsed.withDeps, !parsed.skipBrowserDownload, io);
    } else if (parsed.command === 'uninstall') {
      uninstallBrowserToolchain();
      io.stdout('浏览器测试工具已卸载；项目依赖、配置、会话和测试证据保持不变。');
    } else {
      await build();
    }
    return 0;
  } catch (error: unknown) {
    io.stderr(cliErrorMessage(error));
    return 1;
  }
}

function invokedDirectly(): boolean {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; }
  catch { return false; }
}
if (invokedDirectly()) {
  process.exitCode = await runCli(process.argv.slice(2));
}
