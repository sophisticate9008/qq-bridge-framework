import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { selectServiceProcesses } from '../scripts/service-processes.ts';

const extension = import.meta.url.endsWith('.js') ? 'js' : 'ts';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'qbf-service-scope-'));
  mkdirSync(join(directory, 'scripts'));
  mkdirSync(join(directory, 'data/live'), { recursive: true });
  const entry = join(directory, `scripts/service-manager.${extension}`);
  copyFileSync(new URL(`../scripts/service-manager.${extension}`, import.meta.url), entry);
  copyFileSync(new URL(`../scripts/runtime-configuration.${extension}`, import.meta.url), join(directory, `scripts/runtime-configuration.${extension}`));
  copyFileSync(new URL(`../scripts/service-processes.${extension}`, import.meta.url), join(directory, `scripts/service-processes.${extension}`));
  copyFileSync(new URL(`../scripts/service-lifecycle.${extension}`, import.meta.url), join(directory, `scripts/service-lifecycle.${extension}`));
  copyFileSync(new URL(`../scripts/repair-service-start.${extension}`, import.meta.url), join(directory, `scripts/repair-service-start.${extension}`));
  const service = (id: string, extra: Record<string, unknown> = {}) => ({
    command: process.execPath, args: [], cwd: directory, screen: `qbf-scope-${basename(directory)}-${id}`,
    group: 'core', ...extra,
  });
  const configuration = {
    schema: 1, activeProtocol: 'napcat', dshHome: directory, logDirectory: directory,
    lockFile: join(directory, 'control.lock'), services: {
      'framework-admin': service('admin'),
      'framework-gateway': service('gateway'),
      dsh: service('dsh', { managed: true, env: { DSH_HOME: directory } }),
      napcat: service('napcat', { group: 'napcat', enabled: true }),
      snowluma: service('snowluma', { group: 'snowluma' }),
      auxiliary: service('auxiliary', { group: 'optional', enabled: true }),
      external: service('external', { enabled: true }),
    },
  };
  const save = () => writeFileSync(join(directory, 'data/live/services.json'), JSON.stringify(configuration), { mode: 0o600 });
  const run = (...args: string[]) => spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', timeout: 60_000 });
  save();
  return { directory, configuration, save, run };
}

test('self restart preserves its detached controller and helpers while stopping the service tree', () => {
  const process = (pid: number, parent: number, session: number) => ({ pid, parent, session, started: String(pid) });
  const processes = [process(10, 1, 10), process(11, 10, 10), process(12, 11, 12), process(13, 12, 12),
    process(20, 13, 20), process(21, 20, 20), process(22, 21, 20), process(23, 22, 23),
    process(30, 13, 30), process(40, 1, 40)];
  assert.deepEqual(selectServiceProcesses(processes, [10], 20).map(item => item.pid), [11, 12, 13, 30]);
  assert.deepEqual(selectServiceProcesses(processes, [10], 40).map(item => item.pid), [11, 12, 13, 20, 21, 22, 23, 30]);
});

test('service lists require explicit management for additional local processes', () => {
  const values = fixture();
  try {
    const result = values.run('status', '--json');
    const output = JSON.parse(result.stdout) as { items: { id: string }[] };
    assert.deepEqual(output.items.map(item => item.id), ['framework-admin', 'framework-gateway', 'dsh']);
    Object.assign(values.configuration.services['framework-gateway'], { managed: false });
    Object.assign(values.configuration.services.auxiliary, { managed: true });
    values.save();
    const updated = JSON.parse(values.run('status', '--json').stdout) as { items: { id: string }[] };
    assert.deepEqual(updated.items.map(item => item.id), ['framework-admin', 'dsh', 'auxiliary']);
  } finally { rmSync(values.directory, { recursive: true, force: true }); }
});

test('named lifecycle commands and protocol switching cannot take over external processes', () => {
  const values = fixture();
  try {
    for (const action of ['start', 'stop', 'restart', 'run']) {
      const result = values.run(action, 'napcat');
      assert.equal(result.status, 1);
      assert.match(result.stderr, /外部服务.*未登记/);
      assert.equal(result.stdout, '');
    }
    // Skip flock so this rejection is portable and cannot depend on real processes.
    const result = spawnSync(process.execPath, [join(values.directory, `scripts/service-manager.${extension}`), 'protocol', 'snowluma'], {
      encoding: 'utf8', timeout: 15_000, env: { ...process.env, QQ_BRIDGE_FRAMEWORK_OPS_LOCKED: '1' },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /目标协议端未登记/);
    assert.equal(result.stdout, '');
  } finally { rmSync(values.directory, { recursive: true, force: true }); }
});

test('real restart restores stopped framework processes when a later worker cannot be stopped', {
  skip: process.platform !== 'linux' || !existsSync('/usr/bin/screen') || !existsSync('/usr/bin/flock'),
  timeout: 90_000,
}, async () => {
  const values = fixture();
  const external = createServer();
  try {
    await new Promise<void>(resolve => external.listen(0, '127.0.0.1', resolve));
    const address = external.address();
    assert(address && typeof address !== 'string');
    const originalPids = new Map<string, string>();
    for (const id of ['framework-gateway', 'framework-admin'] as const) {
      const marker = join(values.directory, `${id}.pid`);
      Object.assign(values.configuration.services[id], { args: ['-e',
        'const fs=require("node:fs"), file=process.argv[1]; fs.writeFileSync(file,String(process.pid));'
        + 'process.on("SIGTERM",()=>{fs.unlinkSync(file);process.exit(0)});setInterval(()=>{},1000)', marker],
        ready: { kind: 'command', command: process.execPath, args: ['-e', 'process.exit(require("node:fs").existsSync(process.argv[1])?0:1)', marker] },
      });
    }
    Object.assign(values.configuration.services.auxiliary, { managed: true, port: { host: '127.0.0.1', port: address.port } });
    // Reverse shutdown reaches this occupied, unowned worker after the two real services.
    Object.assign(values.configuration, { order: ['auxiliary', 'framework-gateway', 'framework-admin'] });
    Object.assign(values.configuration.services.dsh, { managed: false });
    values.save();
    for (const id of ['framework-gateway', 'framework-admin']) {
      const started = values.run('start', id);
      assert.equal(started.status, 0, started.stderr);
      originalPids.set(id, readFileSync(join(values.directory, `${id}.pid`), 'utf8'));
    }
    const result = values.run('restart');
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /无法安全停止/);
    assert.match(result.stderr, /恢复已确认停止/);
    for (const id of ['framework-gateway', 'framework-admin']) {
      const pid = readFileSync(join(values.directory, `${id}.pid`), 'utf8');
      assert.notEqual(pid, originalPids.get(id));
      assert.doesNotThrow(() => process.kill(Number(pid), 0));
    }
    assert.equal(external.listening, true);
  } finally {
    for (const id of ['framework-admin', 'framework-gateway']) values.run('stop', id);
    await new Promise<void>(resolve => external.close(() => resolve()));
    rmSync(values.directory, { recursive: true, force: true });
  }
});


test('framework-only repair leaves a healthy DSH, protocol clients and auxiliary listeners running even when explicitly managed', {
  skip: process.platform !== 'linux' || !existsSync('/usr/bin/screen'), timeout: 20_000,
}, async () => {
  const values = fixture();
  const external = createServer();
  try {
    await new Promise<void>(resolve => external.listen(0, '127.0.0.1', resolve));
    const address = external.address();
    assert(address && typeof address !== 'string');
    for (const id of ['dsh', 'napcat', 'auxiliary'] as const) {
      Object.assign(values.configuration.services[id], { managed: true, port: { host: '127.0.0.1', port: address.port } });
    }
    values.save();
    const result = spawnSync(process.execPath, [join(values.directory, `scripts/service-manager.${extension}`), 'repair-services-stop'], {
      encoding: 'utf8', timeout: 15_000, env: { ...process.env, QQ_BRIDGE_FRAMEWORK_OPS_LOCKED: '1' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(external.listening, true);
  } finally {
    await new Promise<void>(resolve => external.close(() => resolve()));
    rmSync(values.directory, { recursive: true, force: true });
  }
});

test('DSH recovery really cycles only the managed engine and framework, retaining unrelated listeners', {
  skip: process.platform !== 'linux' || !existsSync('/usr/bin/screen') || !existsSync('/usr/bin/flock'), timeout: 90_000,
}, async () => {
  const values = fixture();
  const external = createServer();
  try {
    await new Promise<void>(resolve => external.listen(0, '127.0.0.1', resolve));
    const address = external.address();
    assert(address && typeof address !== 'string');
    for (const id of ['napcat', 'auxiliary'] as const) {
      Object.assign(values.configuration.services[id], { managed: true, port: { host: '127.0.0.1', port: address.port } });
    }
    const original = new Map<string, string>();
    for (const id of ['framework-admin', 'framework-gateway', 'dsh'] as const) {
      const marker = join(values.directory, `${id}.pid`);
      Object.assign(values.configuration.services[id], { args: ['-e',
        'const fs=require("node:fs"),file=process.argv[1];fs.writeFileSync(file,String(process.pid));'
        + 'process.on("SIGTERM",()=>{fs.unlinkSync(file);process.exit(0)});setInterval(()=>{},1000)', marker],
        ready: { kind: 'command', command: process.execPath, args: ['-e', 'process.exit(require("node:fs").existsSync(process.argv[1])?0:1)', marker] } });
    }
    values.save();
    for (const id of ['framework-admin', 'dsh', 'framework-gateway']) {
      const result = values.run('start', id);
      assert.equal(result.status, 0, result.stderr);
      original.set(id, readFileSync(join(values.directory, `${id}.pid`), 'utf8'));
    }
    const stopped = values.run('repair-services-stop', '--with-dsh');
    assert.equal(stopped.status, 0, stopped.stderr);
    for (const id of original.keys()) assert.equal(existsSync(join(values.directory, `${id}.pid`)), false);
    assert.equal(external.listening, true);
    const restored = values.run('repair-services-start', '--with-dsh');
    assert.equal(restored.status, 0, restored.stderr);
    for (const [id, pid] of original) {
      assert.notEqual(readFileSync(join(values.directory, `${id}.pid`), 'utf8'), pid);
    }
    assert.equal(external.listening, true);
    Object.assign(values.configuration.services.dsh, { managed: false });
    values.save();
    const rejected = values.run('repair-services-stop', '--with-dsh');
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /未登记/);
    assert.equal(existsSync(join(values.directory, 'framework-admin.pid')), true);
  } finally {
    Object.assign(values.configuration.services.dsh, { managed: true });
    values.save();
    for (const id of ['framework-admin', 'framework-gateway', 'dsh']) values.run('stop', id);
    await new Promise<void>(resolve => external.close(() => resolve()));
    rmSync(values.directory, { recursive: true, force: true });
  }
});
