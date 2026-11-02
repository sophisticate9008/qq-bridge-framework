import { isRecord } from './values.ts'

export type StickerSendingConfiguration = {
  readonly dshSelectionTimeoutSeconds: number
}
export const DEFAULT_STICKER_SENDING_CONFIGURATION: StickerSendingConfiguration = Object.freeze({
  dshSelectionTimeoutSeconds: 10,
})
export function validateStickerSendingConfiguration(value: unknown): StickerSendingConfiguration {
  // Read the retired toggle for existing installations; selection always requires a model.
  if (!isRecord(value) || !Object.keys(value).every(key => ['useAiSelection', 'dshSelectionTimeoutSeconds'].includes(key))
    || value.useAiSelection !== undefined && typeof value.useAiSelection !== 'boolean'
    || !Number.isSafeInteger(value.dshSelectionTimeoutSeconds) || Number(value.dshSelectionTimeoutSeconds) < 1
    || Number(value.dshSelectionTimeoutSeconds) > 60) throw new TypeError('Invalid sticker sending configuration')
  return { dshSelectionTimeoutSeconds: Number(value.dshSelectionTimeoutSeconds) }
}
