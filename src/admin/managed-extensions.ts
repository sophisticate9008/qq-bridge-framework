import type { NativeChatRuntime } from '../host/native-chat-runtime.ts'
import type { AdminRoute } from './server.ts'
import { AdminRequestError } from './server.ts'

/** Observation is read-only; installation is an explicit local operator command. */
export function createManagedExtensionRoutes(runtime?: Pick<NativeChatRuntime, 'managedExtensionObservation'>): readonly AdminRoute[] {
  return [{ method: 'GET', pathname: '/api/chat/extensions/installed', maxResponseBytes: 131072, handle({query}) {
    if (query.size !== 0) throw new AdminRequestError(400, 'invalid_extension_query')
    return { schema: 1, observation: runtime?.managedExtensionObservation() ?? null }
  } }]
}
