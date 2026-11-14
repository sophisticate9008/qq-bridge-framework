import { isRecord } from './values.ts'
import { parsePluginModelSelection, pluginModelIdentifier, type PluginModelSelection } from './plugin-model.ts'

export interface SessionModelConfiguration {
  readonly revision: number | null
  readonly override: PluginModelSelection | null
  readonly inherited: PluginModelSelection
  readonly planName: string
  readonly providerName: string
  readonly modelName: string
  readonly lastApplied: { readonly sessionId: string; readonly model: PluginModelSelection; readonly at: number } | null
}

export function parseSessionModelConfiguration(value: unknown): SessionModelConfiguration | null {
  if (!isRecord(value) || value.revision !== null && (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1)
    || ![value.planName, value.providerName, value.modelName].every(item => typeof item === 'string' && item.length <= 512)) return null
  try {
    const last = value.lastApplied
    if (last !== null && (!isRecord(last) || !pluginModelIdentifier(last.sessionId)
      || !Number.isSafeInteger(last.at) || Number(last.at) < 0)) return null
    return { revision: value.revision as number | null,
      override: value.override === null ? null : parsePluginModelSelection(value.override), inherited: parsePluginModelSelection(value.inherited),
      planName: String(value.planName), providerName: String(value.providerName), modelName: String(value.modelName),
      lastApplied: last === null ? null : { sessionId: String(last.sessionId), model: parsePluginModelSelection(last.model), at: Number(last.at) } }
  } catch { return null }
}
