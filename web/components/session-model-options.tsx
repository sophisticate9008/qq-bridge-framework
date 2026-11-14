import type { PluginModelDescription } from '../../src/contracts/plugin-model.ts';
import { findSessionModel, sessionModelKey } from '../lib/session-model-options.ts';

export function SessionModelOptions({ models, selectedValue = '' }: { readonly models: readonly PluginModelDescription[]; readonly selectedValue?: string }) {
  const suppliers = new Map<string, PluginModelDescription[]>();
  for (const model of models) {
    const entries = suppliers.get(model.providerName) ?? [];
    entries.push(model); suppliers.set(model.providerName, entries);
  }
  return <>{selectedValue && !findSessionModel(models, selectedValue) && <option value={selectedValue} disabled>当前保存的模型</option>}{[...suppliers].map(([supplier, entries]) => <optgroup key={supplier} label={supplier}>
    {entries.map(model => <option key={sessionModelKey(model)} value={sessionModelKey(model)}>{model.modelName}</option>)}
  </optgroup>)}</>;
}
