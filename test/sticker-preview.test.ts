import assert from 'node:assert/strict'
import test from 'node:test'
import sharp from 'sharp'
import { createStickerPreview } from '../src/host/sticker-preview.ts'
import { parseStickerLibraryThumbnail } from '../src/contracts/sticker-library.ts'

async function animation(pages: number, delay: readonly number[], width = 24, height = 16) {
  const pixels = Buffer.alloc(width * height * pages * 3)
  for (let frame = 0; frame < pages; frame++) for (let pixel = 0; pixel < width * height; pixel++) {
    pixels[(frame * width * height + pixel) * 3 + frame % 3] = 255
  }
  return sharp(pixels, { raw: { width, height: height * pages, channels: 3, pageHeight: height } })
    .gif({ loop: 2, delay: [...delay] }).toBuffer()
}

test('animated previews retain the full frame sequence, timing, loop and source layout dimensions', async () => {
  const data = await animation(3, [100, 200, 300])
  const preview = await createStickerPreview(data, { width: 24, height: 16 }, new AbortController().signal)
  assert.equal(preview.animation, 'animated')
  assert.deepEqual(parseStickerLibraryThumbnail(preview), preview)
  assert(preview.image.length <= 200_000)
  const metadata = await sharp(Buffer.from(preview.image.split(',')[1]!, 'base64'), { animated: true }).metadata()
  assert.equal(metadata.format, 'webp'); assert.equal(metadata.pages, 3)
  assert.deepEqual(metadata.delay, [100, 200, 300]); assert.equal(metadata.loop, 2)
  assert.equal(preview.width, 24); assert.equal(preview.height, 16)
})

test('animations exceeding the frame budget keep a labelled static preview', async () => {
  const data = await animation(257, Array.from({ length: 257 }, () => 100))
  const preview = await createStickerPreview(data, { width: 24, height: 16 }, new AbortController().signal)
  assert.equal(preview.animation, 'static')
  assert(preview.image.startsWith('data:image/jpeg;base64,'))
  assert.deepEqual(parseStickerLibraryThumbnail(preview), preview)
})

test('many-frame previews shrink to a bounded total decoded pixel count', async () => {
  const data = await animation(64, Array.from({ length: 64 }, () => 100), 200, 200)
  const preview = await createStickerPreview(data, { width: 200, height: 200 }, new AbortController().signal)
  assert.equal(preview.animation, 'animated')
  const metadata = await sharp(Buffer.from(preview.image.split(',')[1]!, 'base64'), { animated: true }).metadata()
  assert(metadata.width && metadata.pageHeight && metadata.pages)
  assert(metadata.width * metadata.pageHeight * metadata.pages <= 2_000_000)
})
