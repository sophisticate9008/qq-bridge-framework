import type { DurableStore } from '../contracts/ports.ts'
import { parsePluginModelSelection, type PluginModelSelection } from '../contracts/plugin-model.ts'
import { FrameworkError, isRecord } from '../core/values.ts'

export const SESSION_MODELS = 'native-chat.session-models'
export const SESSION_MODEL_APPLIED = 'native-chat.session-model-applied'
export function readSessionModelOverride(store: Pick<DurableStore, 'read'>, conversationId: string) {
  const row = store.read(SESSION_MODELS, conversationId)
  if (!row) return { revision: null, model: null, providerName: null, modelName: null }
  try {
    const value = row.value
    if (!isRecord(value) || value.schema !== 1 || typeof value.providerName !== 'string' || value.providerName.length > 512
      || typeof value.modelName !== 'string' || value.modelName.length > 512) throw new TypeError()
    return { revision: row.revision, model: value.model === null ? null : parsePluginModelSelection(value.model),
      providerName: value.providerName, modelName: value.modelName }
  } catch { throw new FrameworkError('SESSION_MODEL_INVALID_STATE', '会话模型设置无法读取。') }
}
export function recordSessionModelApplied(store: DurableStore, conversationId: string, sessionId: string, model: PluginModelSelection) {
  store.write(SESSION_MODEL_APPLIED, conversationId, { schema: 1, sessionId, model: { ...model }, at: Date.now() })
}
