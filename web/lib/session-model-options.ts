import type { PluginModelDescription, PluginModelSelection } from '../../src/contracts/plugin-model.ts';

export const sessionModelKey = (model: Pick<PluginModelSelection, 'provider' | 'model'>) => JSON.stringify([model.provider, model.model]);
export function findSessionModel(models: readonly PluginModelDescription[], value: string | PluginModelSelection) {
  const candidate: unknown = typeof value === 'string' ? (() => { try { return JSON.parse(value); } catch { return null; } })() : [value.provider, value.model];
  if (!Array.isArray(candidate) || candidate.length !== 2 || !candidate.every(item => typeof item === 'string')) return undefined;
  return models.find(model => model.model === candidate[1] && (model.provider === candidate[0] || model.aliases?.includes(candidate[0])));
}
export function sessionModelOptionValue(models: readonly PluginModelDescription[], value: string) {
  const selected = value ? findSessionModel(models, value) : undefined;
  return selected ? sessionModelKey(selected) : value;
}
