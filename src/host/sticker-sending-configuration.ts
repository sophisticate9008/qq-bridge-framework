import { DEFAULT_STICKER_SENDING_CONFIGURATION, validateStickerSendingConfiguration, type StickerSendingConfiguration } from '../contracts/sticker-sending.ts'
import type { PackageConfigurationContribution } from './package-configuration.ts'

export const STICKER_SENDING_CONFIGURATION: PackageConfigurationContribution<StickerSendingConfiguration> = {
  descriptor: { id: 'sticker-sending', owner: 'sticker-sending', schemaVersion: 1, title: '表情发送', application: 'live',
    description: '先按本地标注检索，明确的唯一候选直接选取，其余可由独立DSH会话筛选。', fields: [
      { id: 'ai-selection', path: ['useAiSelection'], kind: 'boolean', label: 'AI筛选表情',
        description: '排名第一且唯一明确命中动作或用途的候选直接本地选取；其余候选开启时由独立DSH筛选，关闭时按本地适配度选择。' },
      { id: 'dsh-timeout', path: ['dshSelectionTimeoutSeconds'], kind: 'integer', label: 'AI选图等待上限',
        description: '默认10秒，仅开启AI筛选时生效；超时放弃图片并保留本轮文字，纯图静默结束，后台可补充语义标注供下次使用。', minimum: 1, maximum: 60, unit: '秒' },
    ] }, defaults: DEFAULT_STICKER_SENDING_CONFIGURATION, validate: validateStickerSendingConfiguration,
}
