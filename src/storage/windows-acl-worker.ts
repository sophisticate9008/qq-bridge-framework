import { spawn } from 'node:child_process';
import { parentPort, workerData } from 'node:worker_threads';
import { isRecord } from '../core/values.ts';

const data: unknown = workerData;
if (!parentPort || !isRecord(data) || typeof data.executable !== 'string' || !Array.isArray(data.args)
  || !data.args.every((value: unknown) => typeof value === 'string') || !(data.state instanceof SharedArrayBuffer)
  || data.state.byteLength !== 8 || !(data.output instanceof SharedArrayBuffer) || data.output.byteLength !== 65536)
  throw new Error('Invalid ACL worker configuration');
const port = parentPort;
const state = new Int32Array(data.state), output = new Uint8Array(data.output);
const child = spawn(data.executable, data.args as string[], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let active = false, closing = false, failed = false, pending = '';
function finish(value?: string): void {
  active = false;
  const bytes = value === undefined ? undefined : Buffer.from(value);
  if (!bytes || bytes.length > output.length) {
    Atomics.store(state, 1, 0); Atomics.store(state, 0, 2);
  } else {
    output.set(bytes); Atomics.store(state, 1, bytes.length); Atomics.store(state, 0, 1);
  }
  Atomics.notify(state, 0);
}
function fail(): void {
  failed = true;
  if (active) finish();
  child.kill();
}
child.on('error', fail);
child.stdin.on('error', fail);
child.stderr.on('data', () => {}); // Never relay OS diagnostics, paths or ACL details to model/product logs.
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk: string) => {
  pending += chunk;
  if (pending.length > output.length * 2) { fail(); return; }
  const end = pending.indexOf('\n');
  if (end < 0) return;
  const line = pending.slice(0, end).replace(/\r$/, '');
  pending = pending.slice(end + 1);
  if (!active || pending.length > 0) { fail(); return; }
  finish(line);
});
child.once('close', () => {
  failed = true;
  if (active) finish();
  if (closing) port.close();
});
port.on('message', (message: unknown) => {
  if (message === null) {
    closing = true;
    if (failed) port.close();
    else child.stdin.end();
    return;
  }
  if (typeof message !== 'string' || message.length > 1024 * 1024 || /[\r\n]/.test(message) || active || failed || closing) {
    finish(); return;
  }
  active = true;
  child.stdin.write(message + '\n');
});
// Worker termination also closes stdin, so the fixed PowerShell read loop observes EOF.
process.once('exit', () => { child.kill(); });
