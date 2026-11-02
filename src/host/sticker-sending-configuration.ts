import { DEFAULT_STICKER_SENDING_CONFIGURATION, validateStickerSendingConfiguration, type StickerSendingConfiguration } from '../contracts/sticker-sending.ts'
import type { PackageConfigurationContribution } from './package-configuration.ts'

export const STICKER_SENDING_CONFIGURATION: PackageConfigurationContribution<StickerSendingConfiguration> = {
  descriptor: { id: 'sticker-sending', owner: 'sticker-sending', schemaVersion: 1, title: '表情发送', application: 'live',
    description: '主聊天模型提供表达意图，独立DSH模型结合语境和回复文字决定候选是否适合。', fields: [
      { id: 'dsh-timeout', path: ['dshSelectionTimeoutSeconds'], kind: 'integer', label: 'AI选图等待上限',
        description: '默认10秒；超时放弃图片并保留本轮文字，纯图静默结束，后台可补充语义标注供下次使用。', minimum: 1, maximum: 60, unit: '秒' },
    ] }, defaults: DEFAULT_STICKER_SENDING_CONFIGURATION, validate: validateStickerSendingConfiguration,
}
