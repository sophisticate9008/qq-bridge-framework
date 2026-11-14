import assert from 'node:assert/strict'
import test from 'node:test'
import sharp from 'sharp'
import { prepareStickerObservation } from '../src/host/sticker-observation.ts'
import { parsePluginModelImages } from '../src/contracts/plugin-model.ts'

test('a zero-delay first GIF frame does not reject collection or invent a frame duration', async () => {
  const width = 16, height = 16, pages = 3
  const pixels = Buffer.concat([0, 1, 2].map(channel => Buffer.from(Array.from({ length: width * height },
    () => [channel === 0 ? 255 : 0, channel === 1 ? 255 : 0, channel === 2 ? 255 : 0]).flat())))
  const gif = await sharp(pixels, { raw: { width, height: height * pages, channels: 3, pageHeight: height } })
    .gif({ loop: 0, delay: [100, 100, 200] }).toBuffer()
  const control = gif.indexOf(Buffer.from([0x21, 0xf9, 0x04]))
  assert(control >= 0); gif.writeUInt16LE(0, control + 4)
  assert.deepEqual((await sharp(gif).metadata()).delay, [0, 100, 200])
  for (const version of ['v1', 'v2'] as const) {
    const observed = await prepareStickerObservation({ data: gif, signal: new AbortController().signal, version })
    assert(observed.images.length > 0)
    assert.match(observed.guidance, /"durationSeconds":0.3/)
    assert.match(observed.guidance, /"frameCount":3/)
  }
})

test('GIF labelling keeps actual time samples within helper image capacity for both media versions', async () => {
  const width = 24, height = 24, pages = 8
  const data = Buffer.alloc(width * height * pages * 3)
  for (let page = 0; page < pages; page++) for (let pixel = 0; pixel < width * height; pixel++) {
    data[(page * width * height + pixel) * 3 + page % 3] = 255
  }
  const gif = await sharp(data, { raw: { width, height: height * pages, channels: 3, pageHeight: height } })
    .gif({ loop: 0, delay: [100, 200, 100, 300, 200, 100, 200, 100] }).toBuffer()
  for (const version of ['v1', 'v2'] as const) {
    const observed = await prepareStickerObservation({ data: gif, signal: new AbortController().signal, version })
    assert(observed.images.length > 0 && observed.images.length <= 4)
    assert.equal(parsePluginModelImages(observed.images).length, observed.images.length)
    assert.match(observed.guidance, /"durationSeconds":1.3/)
    assert.match(observed.guidance, /"frameCount":8/)
    assert.match(observed.guidance, /"loopCount":0/)
    assert.match(observed.guidance, /timeSeconds/)
    if (version === 'v2') assert.match(observed.guidance, /"times":/)
    const single = await prepareStickerObservation({ data: gif, signal: new AbortController().signal, version, maxImages: 1 })
    assert.equal(single.images.length, 1)
    assert.match(single.guidance, /"frameCount":8/)
  }
})
