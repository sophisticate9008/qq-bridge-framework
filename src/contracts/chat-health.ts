import { isRecord } from './values.ts';

export const CHAT_HEALTH_LAYERS = ['framework', 'receive', 'send', 'dsh', 'replies', 'tools', 'interactions'] as const;
export const CHAT_HEALTH_STATES = ['ready', 'idle', 'recovering', 'unavailable', 'unknown', 'stopped'] as const;
export interface ChatHealthLayer {
  readonly id: typeof CHAT_HEALTH_LAYERS[number];
  readonly state: typeof CHAT_HEALTH_STATES[number];
  readonly reason: string | null;
}
export interface ChatHealth {
  readonly schema: 1;
  readonly checkedAt: number;
  readonly healthy: boolean;
  readonly modelExecutionVerified: false;
  readonly layers: readonly ChatHealthLayer[];
}
export function parseChatHealth(value: unknown): ChatHealth | null {
  if (!isRecord(value) || value.schema !== 1 || !Number.isSafeInteger(value.checkedAt) || Number(value.checkedAt) < 0
    || typeof value.healthy !== 'boolean' || value.modelExecutionVerified !== false
    || !Array.isArray(value.layers) || value.layers.length !== CHAT_HEALTH_LAYERS.length) return null;
  const layers: ChatHealthLayer[] = [];
  for (const [index, item] of value.layers.entries()) {
    if (!isRecord(item) || item.id !== CHAT_HEALTH_LAYERS[index] || !CHAT_HEALTH_STATES.some(state => state === item.state)
      || item.reason !== null && (typeof item.reason !== 'string' || !/^[a-z][a-z0-9_]{0,95}$/.test(item.reason))) return null;
    layers.push(item as unknown as ChatHealthLayer);
  }
  if (value.healthy && layers.some(layer => !['ready', 'idle'].includes(layer.state))) return null;
  return { schema: 1, checkedAt: Number(value.checkedAt), healthy: value.healthy, modelExecutionVerified: false, layers };
}
