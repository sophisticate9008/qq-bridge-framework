import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { isRecord } from '../src/core/values.ts';

function start(code: string) {
  const state = new Int32Array(new SharedArrayBuffer(8)), output = new Uint8Array(new SharedArrayBuffer(65536));
  const worker = new Worker(new URL(import.meta.url.endsWith('.ts') ? '../src/storage/windows-acl-worker.ts' : '../src/storage/windows-acl-worker.js', import.meta.url), {
    execArgv: [], workerData: { executable: process.execPath, args: ['--input-type=module', '-e', code],
      state: state.buffer, output: output.buffer }
  });
  return { state, output, worker, request(value: unknown) {
    Atomics.store(state, 0, 0); worker.postMessage(JSON.stringify(value));
    assert.notEqual(Atomics.wait(state, 0, 0, 5000), 'timed-out');
    return Atomics.load(state, 0);
  } };
}
test('ACL transport reuses one child, preserves bounded JSON and closes on shutdown', async () => {
  const fixture = start(`import { createInterface } from 'node:readline';
    for await (const line of createInterface({ input: process.stdin }))
      process.stdout.write(JSON.stringify({ pid: process.pid, value: JSON.parse(line) }) + '\\n');`);
  try {
    assert.equal(fixture.request({ path: '中文目录', protect: false }), 1);
    const first: unknown = JSON.parse(Buffer.from(fixture.output.subarray(0, Atomics.load(fixture.state, 1))).toString());
    assert(isRecord(first));
    assert.deepEqual(first.value, { path: '中文目录', protect: false });
    assert.equal(fixture.request({ path: 'second', protect: true }), 1);
    const second: unknown = JSON.parse(Buffer.from(fixture.output.subarray(0, Atomics.load(fixture.state, 1))).toString());
    assert(isRecord(second));
    assert.equal(first.pid, second.pid);
    const exited = once(fixture.worker, 'exit');
    fixture.worker.postMessage(null);
    const timer = setTimeout(() => { void fixture.worker.terminate(); }, 5000);
    try { assert.deepEqual(await exited, [0]); } finally { clearTimeout(timer); }
  } finally { await fixture.worker.terminate(); }
});
test('ACL transport reports an exited OS helper without accepting missing permission evidence', async () => {
  const fixture = start('process.exit(2)');
  try { assert.equal(fixture.request({ path: 'missing' }), 2); }
  finally { await fixture.worker.terminate(); }
});
