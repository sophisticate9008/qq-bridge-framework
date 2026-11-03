import { isRecord } from './values.ts'
import { isNativeApplicationId } from './native-application.ts'

export const CHAT_REPAIR_PATH = '/api/chat/repair'
export const CHAT_REPAIR_PHASES = ['checking', 'stopping', 'starting-services', 'applying', 'starting-chat', 'verifying'] as const
export interface ChatRepairOperation {
  readonly id: string
  readonly state: 'running' | 'completed' | 'failed'
  readonly phase: typeof CHAT_REPAIR_PHASES[number]
  readonly createdAt: number
  readonly updatedAt: number
  readonly reasons: readonly string[]
}
export interface ChatRepairSnapshot {
  readonly schema: 1
  readonly available: boolean
  readonly operation: ChatRepairOperation | null
}
export function parseChatRepairOperation(value: unknown): ChatRepairOperation | null {
  if (!isRecord(value) || !isNativeApplicationId(value.id) || !['running', 'completed', 'failed'].includes(String(value.state))
    || !(CHAT_REPAIR_PHASES as readonly unknown[]).includes(value.phase)
    || ![value.createdAt, value.updatedAt].every(at => typeof at === 'number' && Number.isSafeInteger(at) && at >= 0)
    || (value.updatedAt as number) < (value.createdAt as number)
    || !Array.isArray(value.reasons) || value.reasons.length > 16
    || value.reasons.some(reason => typeof reason !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(reason))) return null
  return { id: value.id, state: value.state as ChatRepairOperation['state'], phase: value.phase as ChatRepairOperation['phase'],
    createdAt: value.createdAt as number, updatedAt: value.updatedAt as number, reasons: value.reasons as string[] }
}
export function parseChatRepairSnapshot(value: unknown): ChatRepairSnapshot | null {
  if (!isRecord(value) || value.schema !== 1 || typeof value.available !== 'boolean') return null
  const operation = value.operation === null ? null : parseChatRepairOperation(value.operation)
  return value.operation !== null && !operation ? null : { schema: 1, available: value.available, operation }
}
