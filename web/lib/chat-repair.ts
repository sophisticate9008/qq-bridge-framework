import { useEffect, useSyncExternalStore } from 'react';
import { CHAT_REPAIR_PATH, parseChatRepairSnapshot, type ChatRepairSnapshot } from '../../src/contracts/chat-repair.ts';
import { parseNativeApplicationEnvelope } from '../../src/contracts/native-application.ts';
import { parseNativeDshRestartSnapshot } from '../../src/contracts/native-dsh-restart.ts';
import { ApiError, errorMessage, type ApiClient } from './api.ts';
import { chatApplicationStore, newChatApplicationId } from './chat-application.ts';
import { dshRestartStore } from './dsh-restart.ts';
import { invalidateReadResources } from './resource-reader.ts';
import { useReadResource } from './use-read-resource.ts';

export interface ChatRepairState {
  readonly snapshot: ChatRepairSnapshot | null;
  readonly operationId: string | null;
  readonly requestActive: boolean;
  readonly uncertain: boolean;
  readonly watchingId: string | null;
  readonly acceptedId: string | null;
  readonly epoch: number;
  readonly error: string;
}
export function chatRepairPending(state: ChatRepairState): boolean {
  return state.requestActive || state.uncertain || state.snapshot?.operation?.state === 'running'
    || state.watchingId !== null && state.snapshot?.operation?.state === 'completed' && state.snapshot.operation.id === state.watchingId && state.acceptedId !== state.watchingId;
}
function createStore(api: ApiClient) {
  let state: ChatRepairState = { snapshot: null, operationId: null, requestActive: false, uncertain: false,
    watchingId: null, acceptedId: null, epoch: 0, error: '' };
  let ownership: { application: number; dsh: number } | null = null;
  const captureOwnership = () => ({ application: chatApplicationStore(api).getOwnershipGeneration(), dsh: dshRestartStore(api).getOwnershipGeneration() });
  let reconciling = false;
  let settling = false;
  const listeners = new Set<() => void>();
  const update = (next: ChatRepairState) => { state = next; for (const listener of listeners) listener(); };
  return {
    getSnapshot: () => state,
    getOwnership: () => ownership,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    begin(id: string) {
      if (chatRepairPending(state)) return false;
      ownership = captureOwnership();
      update({ ...state, operationId: id, requestActive: true, uncertain: true, watchingId: id,
        snapshot: state.snapshot ? { ...state.snapshot, operation: null } : null, epoch: state.epoch + 1, error: '' });
      return true;
    },
    observe(snapshot: ChatRepairSnapshot, acknowledgement = false): boolean {
      const next = snapshot.operation;
      const previous = state.snapshot?.operation;
      if (chatRepairPending(state) && state.operationId && next?.id !== state.operationId && !acknowledgement) return false;
      if (previous && next && previous.id === next.id && (next.createdAt !== previous.createdAt || next.updatedAt < previous.updatedAt
        || previous.state !== 'running' && next.state === 'running')) return false;
      const startsWatching = next !== null && (next.state === 'running' || acknowledgement) && state.watchingId !== next.id;
      if (startsWatching && (!acknowledgement || state.watchingId === null)) ownership = captureOwnership();
      update({ ...state, snapshot, operationId: next?.id ?? null, uncertain: false, error: next ? '' : state.error,
        ...(next?.state === 'failed' ? { watchingId: null } : startsWatching ? { watchingId: next.id, epoch: state.epoch + 1 } : {}) });
      return true;
    },
    fail(error: unknown, rejected: boolean) {
      update({ ...state, uncertain: !rejected, error: error instanceof ApiError && error.code === 'chat_repair_not_received'
        ? '原修复请求未被受理，尚未执行；可以重新点击一键恢复。'
        : rejected ? errorMessage(error) : '正在等待后台修复结果，服务恢复后页面会自动更新。',
        ...(rejected ? { operationId: null, watchingId: null, snapshot: state.snapshot ? { ...state.snapshot, operation: null } : null } : {}) });
    },
    finish() { update({ ...state, requestActive: false }); },
    beginReconciliation() { if (reconciling || state.requestActive) return false; reconciling = true; return true; },
    finishReconciliation() { reconciling = false; },
    beginSettlement(id: string) {
      if (settling || state.watchingId !== id || state.acceptedId === id) return false;
      settling = true; return true;
    },
    finishSettlement(id: string, accepted: boolean) {
      settling = false;
      if (accepted && state.watchingId === id) update({ ...state, acceptedId: id, watchingId: null, error: '' });
    },
  };
}
const stores = new WeakMap<ApiClient, ReturnType<typeof createStore>>();
export function chatRepairStore(api: ApiClient): ReturnType<typeof createStore> {
  let store = stores.get(api);
  if (!store) { store = createStore(api); stores.set(api, store); }
  return store;
}

export async function requestChatRepair(api: ApiClient): Promise<void> {
  const store = chatRepairStore(api);
  if (store.getSnapshot().snapshot?.available !== true) return;
  const id = newChatApplicationId();
  if (!store.begin(id)) return;
  try {
    const snapshot = parseChatRepairSnapshot(await api.post(CHAT_REPAIR_PATH, { operationId: id }));
    if (!snapshot?.operation || !store.observe(snapshot, true)) throw new ApiError('chat_repair_result_unknown', 504);
  } catch (error) {
    store.fail(error, error instanceof ApiError && error.status >= 400 && error.status < 500 && !/unknown/.test(error.code));
  } finally { store.finish(); invalidateReadResources(api); }
}

/** Observes one durable repair. A lost acknowledgement never retries the repair command. */
export function useChatRepair(api: ApiClient, connected: boolean) {
  const store = chatRepairStore(api);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const pending = chatRepairPending(state);
  const path = pending && state.operationId ? `${CHAT_REPAIR_PATH}?id=${encodeURIComponent(state.operationId)}` : CHAT_REPAIR_PATH;
  const resource = useReadResource(api, path, connected, parseChatRepairSnapshot, { intervalMs: pending ? 2_000 : 10_000 });
  useEffect(() => {
    if (!resource.snapshot) return;
    const value = resource.snapshot;
    if (pending && state.operationId && value.operation === null && !state.requestActive) {
      if (!store.beginReconciliation()) return;
      const id = state.operationId;
      void api.post(`${CHAT_REPAIR_PATH}/reconcile`, { operationId: id }).then(response => {
        const snapshot = parseChatRepairSnapshot(response);
        if (!snapshot?.operation || snapshot.operation.id !== id) throw new ApiError('chat_repair_result_unknown', 504);
        store.observe(snapshot);
      }).catch(error => {
        store.fail(error, error instanceof ApiError && error.code === 'chat_repair_not_received');
      }).finally(() => { store.finishReconciliation(); invalidateReadResources(api, [path]); });
      return;
    }
    store.observe(value);
  }, [api, store, pending, state.operationId, state.requestActive, resource.snapshot, resource.updatedAt, path]);
  useEffect(() => {
    const operation = state.snapshot?.operation;
    if (operation?.state !== 'completed' || !store.beginSettlement(operation.id)) return;
    let accepted = false;
    const ownership = store.getOwnership();
    const applicationId = state.snapshot?.applicationId;
    if (!applicationId || !ownership) {
      store.finishSettlement(operation.id, true);
      return;
    }
    void Promise.all([api.get(`/api/chat/application?id=${encodeURIComponent(applicationId)}`), api.get('/api/chat/dsh/restart')]).then(([application, dsh]) => {
      const app = parseNativeApplicationEnvelope(application);
      const maintenance = parseNativeDshRestartSnapshot(dsh);
      if (!app?.operation || app.operation.id !== applicationId || app.operation.state !== 'completed' || !maintenance) return;
      if (store.getSnapshot().watchingId !== operation.id) return;
      if (!maintenance.operation || maintenance.operation.createdAt <= operation.updatedAt) {
        dshRestartStore(api).acceptChatRepair(maintenance, ownership.dsh);
      }
      chatApplicationStore(api).acceptChatRepair(app.operation, ownership.application);
      accepted = true;
    }).catch(() => { /* Reconnection retries reads of the same completed operation. */ })
      .finally(() => { store.finishSettlement(operation.id, accepted); if (accepted) invalidateReadResources(api); });
  }, [api, store, state.snapshot, resource.updatedAt]);
  return { state, pending, operation: state.snapshot?.operation ?? null, error: resource.error, refresh: resource.refresh };
}
