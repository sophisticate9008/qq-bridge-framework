import assert from 'node:assert/strict'
import test from 'node:test'
import sharp from 'sharp'
import { prepareStickerObservation } from '../src/host/sticker-observation.ts'
import { parsePluginModelImages } from '../src/contracts/plugin-model.ts'

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
