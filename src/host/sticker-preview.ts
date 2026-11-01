import sharp from 'sharp'
import type { StickerImageDimensions, StickerLibraryThumbnail } from '../contracts/sticker-library.ts'
import { assert } from '../core/values.ts'

const MAX_IMAGE_CHARS = 200_000
const MAX_ANIMATION_PIXELS = 16_000_000
const MAX_PREVIEW_PIXELS = 2_000_000
const encoded = (bytes: Buffer, format: 'jpeg' | 'webp'): string => `data:image/${format};base64,${bytes.toString('base64')}`

/** Recognise raster signatures without decoding an original animation in the server. */
export function stickerOriginalMediaType(data: Uint8Array): string | null {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif'
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (bytes.toString('ascii', 4, 8) === 'ftyp' && ['avif', 'avis'].includes(bytes.toString('ascii', 8, 12))) return 'image/avif'
  return null
}

/** Called by the single-flight preview queue; completed previews are persisted on disk. */
export async function createStickerPreview(data: Uint8Array, dimensions: StickerImageDimensions,
  signal: AbortSignal): Promise<StickerLibraryThumbnail> {
  signal.throwIfAborted()
  const bytes = Buffer.from(data)
  const gif = ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
  let animation: StickerLibraryThumbnail['animation']
  if (gif) {
    const metadata = await sharp(bytes, { pages: 1, limitInputPixels: 40_000_000 }).timeout({ seconds: 2 }).metadata()
    signal.throwIfAborted()
    const pages = metadata.pages ?? 1, delays = metadata.delay
    if (pages > 1) {
      animation = 'static'
      // Decode only bounded animations. All frames, timing and loop count stay together;
      // this is a preview of the animation, not the model's sampled contact sheet.
      if (pages <= 256 && dimensions.width * dimensions.height * pages <= MAX_ANIMATION_PIXELS
        && delays?.length === pages && delays.every(delay => Number.isSafeInteger(delay) && delay >= 0 && delay <= 65535)) {
        for (const [preferredEdge, quality] of [[256, 50], [128, 36]] as const) {
          signal.throwIfAborted()
          try {
            const edge = Math.min(preferredEdge, Math.max(1, Math.floor(Math.sqrt(MAX_PREVIEW_PIXELS / pages))))
            const image = encoded(await sharp(bytes, { animated: true, limitInputPixels: MAX_ANIMATION_PIXELS })
              .timeout({ seconds: 2 }).resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
              .webp({ quality, effort: 0, loop: metadata.loop ?? 1, delay: delays }).toBuffer(), 'webp')
            signal.throwIfAborted()
            if (image.length <= MAX_IMAGE_CHARS) return { image, ...dimensions, animation: 'animated' }
          } catch { signal.throwIfAborted() }
        }
      }
    }
  }
  const image = encoded(await sharp(bytes, { pages: 1, limitInputPixels: 40_000_000 }).timeout({ seconds: 2 }).rotate()
    .resize({ width: 384, height: 384, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer(), 'jpeg')
  signal.throwIfAborted()
  assert(image.length <= MAX_IMAGE_CHARS, 'STICKER_PREVIEW_TOO_LARGE', 'The preview exceeds its byte limit.')
  return { image, ...dimensions, ...(animation ? { animation } : {}) }
}
