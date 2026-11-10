import type { ChatHealth } from '../contracts/chat-health.ts';
import { isTransientAssistantHealthReason } from './assistant-health.ts';

/** Shared by manual recovery and the watchdog. A configuration/authentication failure is not a restart request. */
export function chatRepairNeedsDshRestart(health: ChatHealth | null): boolean {
  if (!health) return false;
  if (health.layers.some(layer => layer.reason === 'configuration_changed')) return false;
  const dsh = health.layers.find(layer => layer.id === 'dsh');
  if (dsh && !['ready', 'idle'].includes(dsh.state)) {
    return ['connection_failed', 'timeout'].includes(dsh.reason ?? '');
  }
  if (health.layers.some(layer => layer.id === 'framework'
    && ['pending_reload', 'dsh_live_verification_required', 'dsh_profile_operation_failed'].includes(layer.reason ?? ''))) return true;
  if (health.layers.some(layer => ['replies', 'tools', 'interactions'].includes(layer.id)
    && ['unavailable', 'recovering', 'unknown'].includes(layer.state))) return true;
  return health.assistant?.state === 'unavailable' && isTransientAssistantHealthReason(health.assistant.reason);
}
