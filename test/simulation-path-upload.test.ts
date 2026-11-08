import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSimulatedOneBot } from '../scripts/simulate-qq-onebot.ts';
import { isRecord } from '../src/core/values.ts';

test('simulation streams a 100MiB absolute-path upload to disk while retaining the byte-source bound', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'simulation-path-upload-'));
  const events: Record<string, unknown>[] = [];
  const peer = await startSimulatedOneBot({ directory, selfId: '900000000001', ownerId: '123', memberId: '900000000002', groupId: '900000000003', record: e => events.push(e) });
  t.after(async () => { await peer.close(); await rm(directory, { recursive: true, force: true }); });
  const path = join(directory, 'large.bin'); const file = await open(path, 'wx', 0o600);
  try { await file.truncate(100 * 1024 * 1024); } finally { await file.close(); }
  async function upload(source: string) {
    const response = await fetch(`${peer.endpoint}/upload_private_file`, { method: 'POST', headers: { authorization: `Bearer ${peer.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: 123, file: source, name: 'large.bin' }), signal: AbortSignal.timeout(15000) });
    const value: unknown = await response.json(); assert(isRecord(value)); return value;
  }
  assert.equal((await upload(path)).status, 'ok');
  const event = events.find(e => e.type === 'outbound'); assert(event && Array.isArray(event.capturedAssets));
  const captured: unknown = event.capturedAssets[0]; assert(isRecord(captured) && typeof captured.filename === 'string');
  assert.equal(captured.size, 100 * 1024 * 1024); assert.equal((await stat(captured.filename)).size, captured.size);
  assert.equal(captured.sha256, '20492a4d0d84f8beb1767f6616229f85d44c2827b64bdbfb260ee12fa1109e0e');
  const oversized = 'base64://' + Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64');
  assert.equal((await upload(oversized)).status, 'failed');
});
