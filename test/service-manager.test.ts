import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { selectServiceProcesses } from '../scripts/service-processes.ts';

const extension = import.meta.url.endsWith('.js') ? 'js' : 'ts';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'qbf-service-scope-'));
  mkdirSync(join(directory, 'scripts'));
  mkdirSync(join(directory, 'runtime/live'), { recursive: true });
  const entry = join(directory, `scripts/service-manager.${extension}`);
  copyFileSync(new URL(`../scripts/service-manager.${extension}`, import.meta.url), entry);
  copyFileSync(new URL(`../scripts/service-processes.${extension}`, import.meta.url), join(directory, `scripts/service-processes.${extension}`));
  const service = (id: string, extra: Record<string, unknown> = {}) => ({
    command: process.execPath, args: [], cwd: directory, screen: `qbf-scope-${id}`,
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
  const save = () => writeFileSync(join(directory, 'runtime/live/services.json'), JSON.stringify(configuration), { mode: 0o600 });
  const run = (...args: string[]) => spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', timeout: 15_000 });
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
