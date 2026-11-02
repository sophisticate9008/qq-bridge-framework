import type { DshHealth } from '../contracts/dsh-health.ts';
import { probeDshHealth } from '../adapters/dsh-health.ts';
import { NativeConfigurationRepository } from './native-configuration-repository.ts';
import { AdminRequestError, type AdminRoute } from './server.ts';

export function createNativeDshHealthRoutes(directory: string): readonly AdminRoute[] {
  const repository = new NativeConfigurationRepository(directory);
  return [{ method: 'GET', pathname: '/api/chat/dsh/health', async handle({ query, signal }) {
    if (query.size) throw new AdminRequestError(400, 'invalid_query');
    try {
      const before = await repository.readAdapterDocument();
      const result = await probeDshHealth(before.value.adapters.dshAgent, signal);
      if ((await repository.readAdapterDocument()).revision !== before.revision) {
        return { ...result, state: 'unknown', reason: 'configuration_changed' } satisfies DshHealth;
      }
      return result;
    } catch {
      if (signal.aborted) throw new AdminRequestError(499, 'request_aborted');
      return { schema: 1, state: 'unknown', reason: 'configuration_unavailable', checkedAt: Date.now(),
        scope: 'authenticated-api', modelExecutionVerified: false } satisfies DshHealth;
    }
  } }];
}
