import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const extension = import.meta.url.endsWith('.js') ? 'js' : 'ts';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'qbf-service-scope-'));
  mkdirSync(join(directory, 'scripts'));
  mkdirSync(join(directory, 'runtime/live'), { recursive: true });
  const entry = join(directory, `scripts/service-manager.${extension}`);
  copyFileSync(new URL(`../scripts/service-manager.${extension}`, import.meta.url), entry);
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
