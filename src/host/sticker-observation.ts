import sharp from 'sharp'
import { observeGif } from '../adapters/gif-observation.ts'
import { PLUGIN_MODEL_IMAGE_LIMITS, type PluginModelImage } from '../contracts/plugin-model.ts'
import type { MediaObservationVersion } from '../contracts/native-media-configuration.ts'
import { assert } from '../core/values.ts'

export interface StickerObservation { readonly images: readonly PluginModelImage[]; readonly guidance: string }

/** Share the normal GIF decoder, time sampling, disposal and V1/V2 limits. */
export async function prepareStickerObservation(input: {
  readonly data: Uint8Array; readonly signal: AbortSignal; readonly version?: MediaObservationVersion; readonly maxImages?: number
}): Promise<StickerObservation> {
  input.signal.throwIfAborted()
  const bytes = Buffer.from(input.data)
  const gif = ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
  const observed = gif ? await observeGif({ data: bytes, signal: input.signal, version: input.version ?? 'v1' }) : null
  input.signal.throwIfAborted()
  assert(observed?.status !== 'rejected', 'STICKER_GIF_OBSERVATION_FAILED', 'GIF observation could not be completed within the existing media limits.')
  if (observed?.status !== 'animated') {
    const image = await sharp(bytes, { pages: 1, limitInputPixels: 40_000_000 }).timeout({ seconds: 3 })
      .rotate().resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer()
    input.signal.throwIfAborted()
    return { images: [{ mediaType: 'image/jpeg', data: image.toString('base64') }],
      guidance: gif ? '这是静态单帧GIF，不包含可观察的动画。' : '这是本次实际读取的静态图片。' }
  }
  const budget = input.maxImages ?? PLUGIN_MODEL_IMAGE_LIMITS.count
  assert(Number.isSafeInteger(budget) && budget >= 1 && budget <= PLUGIN_MODEL_IMAGE_LIMITS.count,
    'STICKER_OBSERVATION_INVALID', 'Use the current helper image capacity.')
  const frames = observed.frames, images: PluginModelImage[] = [], layouts: unknown[] = []
  const groupSize = Math.ceil(frames.length / budget)
  for (let offset = 0; offset < frames.length; offset += groupSize) {
    input.signal.throwIfAborted()
    const group = frames.slice(offset, offset + groupSize)
    const metadata = await Promise.all(group.map(frame => sharp(frame.data, { limitInputPixels: 40_000_000 }).metadata()))
    const cellWidth = Math.max(...metadata.map(item => item.width ?? 0)), cellHeight = Math.max(...metadata.map(item => item.height ?? 0))
    assert(cellWidth > 0 && cellHeight > 0, 'STICKER_OBSERVATION_INVALID', 'Observed frames need real dimensions.')
    const columns = Math.ceil(Math.sqrt(group.length)), rows = Math.ceil(group.length / columns)
    const scale = Math.min(1, 3072 / (columns * cellWidth), 3072 / (rows * cellHeight))
    const tileWidth = Math.max(1, Math.floor(cellWidth * scale)), tileHeight = Math.max(1, Math.floor(cellHeight * scale))
    const tiles: Buffer[] = []
    if (group.length > 1) for (const frame of group) {
      input.signal.throwIfAborted()
      tiles.push(await sharp(frame.data, { limitInputPixels: 40_000_000 }).resize({ width: tileWidth, height: tileHeight,
        fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).timeout({ seconds: 3 }).toBuffer())
    }
    const image = group.length === 1 ? Buffer.from(group[0]!.data) : await sharp({ create: {
      width: columns * tileWidth, height: rows * tileHeight, channels: 3, background: '#ffffff' } })
      .composite(tiles.map((tile, index) => ({ input: tile,
        left: index % columns * tileWidth, top: Math.floor(index / columns) * tileHeight })))
      .jpeg({ quality: 75 }).timeout({ seconds: 3 }).toBuffer()
    input.signal.throwIfAborted()
    assert(image.length <= PLUGIN_MODEL_IMAGE_LIMITS.bytesPerImage, 'STICKER_OBSERVATION_LIMIT', 'The observed image exceeds helper capacity.')
    images.push({ mediaType: 'image/jpeg', data: image.toString('base64') })
    layouts.push({ image: images.length, columns, rows, cells: group.map((frame, index) => ({ cell: index + 1,
      timeSeconds: frame.timeSeconds, ...(frame.grid ? { grid: frame.grid } : {}) })) })
  }
  return { images, guidance: `本图是GIF动画，以下仅为现有${input.version ?? 'v1'}路线的真实时间抽样，并非逐帧观看。每张图及格子均按从左到右、从上到下的顺序；格子内若有grid，则同样按其网格时间顺序读取，空白格不是新帧。不要沿用历史图片的动画结论。${JSON.stringify({
    durationSeconds: observed.durationSeconds, frameCount: observed.frameCount, loopCount: observed.loopCount, layouts })}` }
}
