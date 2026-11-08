import { readOnlyFlags } from './file-security.js';
import { randomBytes, createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { WorkPathDescriptor } from './work-path.js';

export const WORK_STREAM_ROUTE = '/qbf-work-stream';
/** Capability is issued only by owner-authenticated resolution, never by model input.
 * No file copy, size quota or time based expiry. A ticket ends with its one HTTP request. */
export function createWorkStreamChannel() {
  const tickets = new Map<string, { resourceId: string; dispose: () => void; descriptor: WorkPathDescriptor; verify: (signal: AbortSignal) => Promise<WorkPathDescriptor> }>();
  const active = new Map<string, { resourceId: string; controller: AbortController; dispose: () => void }>();
  function revoke(resourceId: string, onlyToken?: string) {
    for (const [token, ticket] of tickets) if (ticket.resourceId === resourceId && (!onlyToken || onlyToken === token)) { ticket.dispose(); tickets.delete(token); }
    for (const [token, reader] of active) if (reader.resourceId === resourceId && (!onlyToken || onlyToken === token)) {
      reader.dispose(); reader.controller.abort(); active.delete(token);
    }
  }
  return {
    revoke,
    pending: () => tickets.size,
    active: () => active.size,
    issue(descriptor: WorkPathDescriptor, verify: (signal: AbortSignal) => Promise<WorkPathDescriptor>, resourceId = descriptor.path, lifetime?: AbortSignal) {
      lifetime?.throwIfAborted();
      for (const [prior, ticket] of tickets) if (ticket.resourceId === resourceId) { ticket.dispose(); tickets.delete(prior); }
      const token = randomBytes(32).toString('hex');
      const abort = () => revoke(resourceId, token);
      lifetime?.addEventListener('abort', abort, { once: true });
      tickets.set(token, { resourceId, descriptor, verify, dispose: () => lifetime?.removeEventListener('abort', abort) });
      return `${WORK_STREAM_ROUTE}/${token}`;
    },
    close() { for (const ticket of tickets.values()) ticket.dispose(); tickets.clear(); for (const reader of active.values()) { reader.dispose(); reader.controller.abort(); } active.clear(); },
    async handle(req: IncomingMessage, res: ServerResponse) {
      const token = new URL(req.url ?? '/', 'http://local').pathname.slice(WORK_STREAM_ROUTE.length + 1);
      const ticket = tickets.get(token);
      if (req.method !== 'GET' || !ticket) { res.writeHead(410); res.end('文件已失效'); return; }
      tickets.delete(token);
      const controller = new AbortController();
      active.set(token, { resourceId: ticket.resourceId, controller, dispose: ticket.dispose });
      const abort = () => { if (!res.writableFinished) controller.abort(); };
      res.once('close', abort);
      try {
        const descriptor = await ticket.verify(controller.signal);
        const handle = await open(descriptor.path, readOnlyFlags);
        try {
          const before = await handle.stat();
          if (before.dev !== descriptor.dev || before.ino !== descriptor.ino || before.size !== descriptor.bytes
            || before.mtimeMs !== descriptor.mtimeMs || before.ctimeMs !== descriptor.ctimeMs) throw new Error('文件已失效');
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': descriptor.bytes,
            'cache-control': 'no-store', 'x-content-sha256': descriptor.sha256 });
          async function* chunks() {
            const hash = createHash('sha256'); let position = 0;
            for (;;) {
              controller.signal.throwIfAborted();
              const buffer = Buffer.alloc(256 * 1024);
              const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
              if (!bytesRead) break;
              position += bytesRead; hash.update(buffer.subarray(0, bytesRead));
              if (position > descriptor.bytes) throw new Error('文件已失效');
              // Hold the last chunk until end checks finish, so an altered stream cannot complete.
              if (position < descriptor.bytes) yield buffer.subarray(0, bytesRead);
              else {
                const after = await handle.stat();
                if (position !== descriptor.bytes || hash.digest('hex') !== descriptor.sha256
                  || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.size !== before.size)
                  throw new Error('文件已失效');
                await ticket!.verify(controller.signal);
                yield buffer.subarray(0, bytesRead); return;
              }
            }
            throw new Error('文件已失效：流被截断');
          }
          await pipeline(Readable.from(chunks()), res, { signal: controller.signal });
        } finally { await handle.close(); }
      } catch {
        if (!res.headersSent) { res.writeHead(410); res.end('文件已失效'); }
        else res.destroy(new Error('文件已失效'));
      } finally { res.removeListener('close', abort); ticket.dispose(); active.delete(token); }
    },
  };
}
