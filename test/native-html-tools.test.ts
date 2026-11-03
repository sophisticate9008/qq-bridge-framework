import assert from 'node:assert/strict'
import test from 'node:test'
import { NATIVE_REPLY_TOOLS } from '../src/host/native-reply-tools.ts'
import { normalizeContent } from '../src/core/content.ts'
import { isRecord } from '../src/core/values.ts'
import { parseNativeOutputContent } from '../src/host/native-output.ts'

test('HTML rendering tool admits only current-conversation source and creates an explicit image envelope', () => {
  const tool = NATIVE_REPLY_TOOLS.find(item => item.definition.name === 'qbf_render_html')!
  const value = tool.validate({ html: '<h1 style="color:purple">中文</h1>', title: '标题' })
  assert(isRecord(value))
  const output = parseNativeOutputContent(normalizeContent(value.content))
  assert('format' in output)
  assert.equal(output.format, 'html-image')
  assert.equal(output.title, '标题')
  assert.throws(() => tool.validate({ html: '<p>text</p>', conversationId: 'group:999' }))
  assert.throws(() => tool.validate({ html: '<p>text</p>', outputPath: '/tmp/uncontrolled.png' }))
  assert.throws(() => tool.validate({ html: ' ' }))
  assert.throws(() => tool.validate({ html: '<p>x</p>', title: 123 }))
})
