import { validWorkPath } from '../storage/work-path.ts';
import type { DshWorkAddress, DshWorkMediaReference } from '../contracts/dsh-work.ts';
import type { EffectRequest } from '../core/types.ts';
import type { MessageContent } from '../contracts/messages.ts';
import type { OneBotAssetResolutionRequest } from '../adapters/onebot.ts';
import type { DshWorkPort } from '../adapters/dsh-work.ts';
import { assert, errorCode } from '../core/values.ts';
import type { DurableStore } from './types.ts';
import { digest, json, object } from './data.ts';

/** Metadata and chat authorization only. The filesystem host signs and revalidates files. */
export function createNativeWorkAssets(options: {
  readonly directory: string; readonly store: DurableStore; readonly accountId: string;
  readonly port: DshWorkPort; readonly clock?: () => number; readonly signal?: AbortSignal;
  readonly onMaintenanceFault?: (code: string) => void;
  readonly parent: (sessionId: string) => { conversationId: string; generation: number } | null;
  readonly authorize: (conversationId: string, signal: AbortSignal) => Promise<void>;
}) {
  const namespace = 'native-work.paths';
  let closed = false;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  const openChannels = new Set<string>();
  const toolChannels = new Map<string, { assetId: string; token: string }[]>();
  const scopeKey = (scope: { conversationId: string; sessionId?: string; generation?: number }) => digest([scope.conversationId, scope.sessionId, scope.generation]);
  options.store.createIndex?.({ namespace, field: 'resourceId' });
  function binding(address: DshWorkAddress) {
    const parent = options.parent(address.parentSessionId);
    assert(!closed && !options.signal?.aborted, 'WORK_ASSET_CLOSED', 'Attachment resolver is closed.');
    assert(parent?.generation === address.generation, 'WORK_PARENT_UNAVAILABLE', '原工作会话已失效。');
    return parent;
  }
  async function lookup(address: DshWorkAddress, asset: DshWorkMediaReference, signal: AbortSignal, metadataOnly = false) {
    assert(asset.storage === 'path', 'WORK_BYTE_ATTACHMENTS_REMOVED', '旧字节附件已失效，请重新登记路径。');
    assert(options.port.readPath, 'WORK_PATH_READER_UNAVAILABLE', '请配套升级宿主与桥接插件。');
    const resolved = await options.port.readPath({ ...address, metadataOnly, kind: asset.kind, attachmentId: asset.attachmentId }, signal);
    assert(digest(resolved.asset) === digest(asset) && validWorkPath(resolved.descriptor)
      && resolved.descriptor.bytes === asset.bytes, 'WORK_PATH_INVALIDATED', '文件已失效，登记信息发生变化。');
    return resolved;
  }
  function scheduleCleanup() {
    if (closed || cleanupTimer) return;
    cleanupTimer = setTimeout(() => { cleanupTimer = undefined; void api.maintenance().catch(() => scheduleCleanup()); }, 60000);
    cleanupTimer.unref();
  }
  const api = Object.freeze({
    async maintenance(): Promise<void> {
      let after: string | undefined;
      for (;;) {
        const page = options.store.list(namespace, { limit: 128, ...(after ? { after } : {}) });
        for (const row of page) {
          const v = object(row.value);
          if (v.schema === 2 && v.delivered === true) await api.delivered(v.kind === 'image'
            ? { type: 'image', assetId: row.key } : { type: 'file', assetId: row.key, name: 'attachment' }, AbortSignal.timeout(10000));
        }
        if (page.length < 128) break; after = page.at(-1)!.key;
      }
    },
    async close() {
      closed = true; clearTimeout(cleanupTimer);
      for (const assetId of openChannels) await api.unconfirmed({ type: 'file', assetId, name: 'attachment' }, AbortSignal.timeout(10000));
      openChannels.clear();
      for (const key of toolChannels.keys()) await api.closeToolChannels(key);
    },
    async closeToolChannels(scope: string | { conversationId: string; sessionId: string; generation: number }) {
      const key = typeof scope === 'string' ? scope : scopeKey(scope);
      const channels = toolChannels.get(key) ?? []; toolChannels.delete(key);
      for (const channel of channels) {
        const row = options.store.read(namespace, channel.assetId); if (!row) continue;
        const v = object(row.value); const asset = object(v.asset) as unknown as DshWorkMediaReference;
        try { await options.port.releasePath?.({ ...object(v.address) as unknown as DshWorkAddress, kind: asset.kind,
          attachmentId: asset.attachmentId, keepRegistration: true, channelToken: channel.token }, AbortSignal.timeout(10000)); }
        catch { try { options.onMaintenanceFault?.('WORK_CHANNEL_RELEASE_FAILED'); } catch {} }
      }
    },
    async register({ address, asset, signal }: { readonly address: DshWorkAddress; readonly asset: DshWorkMediaReference; readonly signal: AbortSignal }): Promise<MessageContent> {
      const parent = binding(address);
      await options.authorize(parent.conversationId, signal);
      const resolved = await lookup(address, asset, signal, true);
      binding(address); signal.throwIfAborted();
      await options.authorize(parent.conversationId, signal);
      const assetId = `work-path-${digest([options.accountId, parent.conversationId, address.id, address.childId, address.parentSessionId, address.generation, asset])}`;
      const prior = options.store.read(namespace, assetId);
      if (prior) assert(digest(object(prior.value).descriptor) === digest(resolved.descriptor), 'WORK_PATH_INVALIDATED', '文件已失效，登记内容发生变化。');
      options.store.write(namespace, assetId, json({ schema: 2, assetId, accountId: options.accountId,
        conversationId: parent.conversationId, parentSessionId: address.parentSessionId, generation: address.generation,
        kind: asset.kind, resourceId: asset.attachmentId, address, asset, descriptor: resolved.descriptor }), { expectedRevision: prior?.revision ?? null });
      return asset.kind === 'file' ? { type: 'file', assetId, name: asset.name! } : { type: 'image', assetId };
    },
    async delivered(content: MessageContent, signal: AbortSignal) {
      if (!('assetId' in content) || !content.assetId.startsWith('work-path-')) return;
      try {
        const row = options.store.read(namespace, content.assetId);
        if (!row) return;
        const value = object(row.value);
        options.store.write(namespace, content.assetId, json({ ...value, delivered: true }), { expectedRevision: row.revision });
        const asset = object(value.asset) as unknown as DshWorkMediaReference;
        await options.port.releasePath?.({ ...object(value.address) as unknown as DshWorkAddress,
          kind: asset.kind, attachmentId: asset.attachmentId }, signal);
        openChannels.delete(content.assetId);
        options.store.delete(namespace, content.assetId);
      } catch { scheduleCleanup(); try { options.onMaintenanceFault?.('WORK_PATH_RELEASE_FAILED'); } catch {} }
    },
    async unconfirmed(content: MessageContent, signal: AbortSignal) {
      if (!('assetId' in content)) return;
      const row = options.store.read(namespace, content.assetId);
      if (!row) return;
      const value = object(row.value); const asset = object(value.asset) as unknown as DshWorkMediaReference;
      try { await options.port.releasePath?.({ ...object(value.address) as unknown as DshWorkAddress,
        kind: asset.kind, attachmentId: asset.attachmentId, keepRegistration: true }, signal); }
      catch { try { options.onMaintenanceFault?.('WORK_CHANNEL_RELEASE_FAILED'); } catch {} }
      finally { openChannels.delete(content.assetId); }
    },
    async resolveResource(resourceId: string, scope: EffectRequest['scope'], signal: AbortSignal): Promise<{ resourceId: string; assetId: string; channel: { kind: string; path?: string; url?: string } }> {
      assert(typeof scope.sessionId === 'string' && typeof scope.generation === 'number', 'WORK_ASSET_SCOPE_MISMATCH', '需要当前聊天会话上下文。');
      assert(/^work-path-(?:ref-)?[a-f0-9]{64}$/.test(resourceId), 'WORK_PATH_INVALIDATED', '文件已失效，资源编号无效。');
      let assetId = resourceId;
      if (resourceId.startsWith('work-path-ref-')) {
        let row = options.store.lookup?.({ namespace, field: 'resourceId', equals: resourceId, limit: 1 })[0];
        if (!row) {
          // The assistant may report a registered ID before its final result. Only this chat's works are candidates.
          let after: string | undefined;
          outer: for (;;) {
            const page = options.store.list('native-work.executions', { limit: 128, ...(after ? { after } : {}) });
            for (const work of page) {
              const v = object(work.value);
              if (v.conversationId !== scope.conversationId || v.parentSessionId !== scope.sessionId || v.generation !== scope.generation) continue;
              const address: DshWorkAddress = { issuerEpoch: '', id: work.key, parentSessionId: String(v.parentSessionId), childId: String(v.childId), generation: Number(v.generation) };
              binding(address); await options.authorize(scope.conversationId, signal);
              for (const kind of ['file', 'image'] as const) try {
                assert(options.port.readPath, 'WORK_PATH_READER_UNAVAILABLE', 'Attachment resolver is unavailable.');
                const resolved = await options.port.readPath({ ...address, attachmentId: resourceId, kind, metadataOnly: true }, signal);
                const registered = await api.register({ address, asset: resolved.asset, signal });
                if ('assetId' in registered) row = options.store.read(namespace, registered.assetId) ?? undefined;
                break outer;
              } catch (error) { if (signal.aborted || errorCode(error) !== 'WORK_PATH_NOT_THIS_WORK') throw error; }
            }
            if (page.length < 128) break; after = page.at(-1)!.key;
          }
        }
        assert(row, 'WORK_PATH_INVALIDATED', '文件已失效或不属于当前会话。');
        assetId = row.key;
      }
      const saved = options.store.read(namespace, assetId); assert(saved, 'WORK_PATH_INVALIDATED', '文件已失效。');
      const value = object(saved.value);
      const resolved = await api.resolve({ assetId, type: value.kind === 'image' ? 'image' : 'file',
        conversationId: scope.conversationId, sessionId: scope.sessionId, generation: scope.generation, signal });
      if (resolved.file.startsWith('http://') || resolved.file.startsWith('https://')) {
        const key = scopeKey(scope);
        const prior = (toolChannels.get(key) ?? []).filter(c => c.assetId !== assetId);
        prior.push({ assetId, token: new URL(resolved.file).pathname.split('/').at(-1)! }); toolChannels.set(key, prior);
      }
      return { resourceId, assetId, channel: resolved.file.startsWith('http://') || resolved.file.startsWith('https://')
        ? { kind: 'http-stream', url: resolved.file } : { kind: 'path', path: resolved.file } };
    },
    async resolve(request: OneBotAssetResolutionRequest): Promise<{ file: string }> {
      assert(!request.assetId.startsWith('work-asset-'), 'WORK_BYTE_ATTACHMENTS_REMOVED', '旧字节附件已失效，请重新登记路径。');
      const row = options.store.read(namespace, request.assetId);
      assert(row, 'WORK_PATH_INVALIDATED', '文件已失效，找不到登记记录。');
      const value = object(row.value);
      assert(value.schema === 2 && value.delivered !== true, 'WORK_PATH_INVALIDATED', '旧附件已失效，请重新登记路径。');
      const address = object(value.address) as unknown as DshWorkAddress;
      const parent = binding(address);
      assert(value.accountId === options.accountId && value.conversationId === request.conversationId
        && request.sessionId === address.parentSessionId && request.generation === address.generation
        && parent.conversationId === request.conversationId && value.kind === request.type,
      'WORK_ASSET_SCOPE_MISMATCH', '附件不属于当前账号、会话或代次。');
      await options.authorize(request.conversationId, request.signal);
      const resolved = await lookup(address, object(value.asset) as unknown as DshWorkMediaReference, request.signal);
      assert(digest(resolved.descriptor) === digest(value.descriptor), 'WORK_PATH_INVALIDATED', '文件已失效，登记内容发生变化。');
      binding(address); request.signal.throwIfAborted();
      await options.authorize(request.conversationId, request.signal);
      if (resolved.file) openChannels.add(request.assetId);
      return { file: resolved.file ?? resolved.descriptor.path };
    },
  });
  return api;
}
