import assert from 'node:assert/strict'
import test from 'node:test'

import { JSDOM } from 'jsdom'
import {
  HTML_PREVIEW_CSP,
  PreviewSizeLimitError,
  artifactDownloadHref,
  htmlSrcDoc,
  parseDelimited,
  previewKindForArtifact,
  readResponseBytes,
} from '../preview-utils.mjs'
import { OfficePreviewError, prepareOfficePreview } from '../OfficeArtifactPreview'
import { sanitizeSvgSource } from '../SvgPreviewSanitizer'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1/' })
Object.assign(globalThis, {
  document: dom.window.document,
  window: dom.window,
  DOMParser: dom.window.DOMParser,
  XMLSerializer: dom.window.XMLSerializer,
})

test('sanitizes SVG scripts, events, and external resources while retaining safe geometry', () => {
  const source = '<svg xmlns="http://www.w3.org/2000/svg" onload="evil()"><script>evil()</script>'
    + '<image href="https://attacker.invalid/pixel"/><rect width="10" height="10" fill="#123456"/></svg>'
  const sanitized = sanitizeSvgSource(source)
  assert.ok(sanitized)
  assert.match(sanitized, /<rect/)
  assert.doesNotMatch(sanitized, /script|onload|attacker\.invalid|<image/i)
})

test('rejects malformed Office archives without exposing parser internals', async () => {
  const reference = {
    runId: 'run-test', sequence: 1, name: 'broken.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }
  await assert.rejects(
    prepareOfficePreview(reference, new Blob(['not a ZIP archive'], { type: reference.mimeType })),
    (error: unknown) => error instanceof OfficePreviewError && error.message === 'Office 文件损坏或格式不受支持。',
  )
})

test('bounds hostile CSV cells as text and preserves quoted delimiters', () => {
  const source = 'name,notes\n"<script>evil()</script>","a,b"\n'
    + Array.from({ length: 105 }, (_, index) => `${index},safe`).join('\n')
  const parsed = parseDelimited(source, ',')
  assert.equal(parsed.rows[1]?.[0], '<script>evil()</script>')
  assert.equal(parsed.rows[1]?.[1], 'a,b')
  assert.equal(parsed.rows.length, 100)
  assert.equal(parsed.truncated, true)
})

test('wraps hostile HTML in a sandbox CSP with scripts and navigation disabled', () => {
  const source = '<script>parent.location="https://attacker.invalid"</script><form action="https://attacker.invalid">'
  const srcDoc = htmlSrcDoc(source)
  assert.match(srcDoc, /script-src 'none'/)
  assert.match(srcDoc, /form-action 'none'/)
  assert.match(srcDoc, /navigate-to 'none'/)
  assert.match(srcDoc, /parent\.location/)
  assert.equal(srcDoc.includes(HTML_PREVIEW_CSP), true)
})

test('keeps the complete 600018-byte CSV source before the 100x50 table cap', () => {
  const source = `col\n${'x'.repeat(600013)}\n`
  assert.equal(new TextEncoder().encode(source).byteLength, 600018)
  const parsed = parseDelimited(source, ',')
  assert.equal(parsed.rows[1]?.[0]?.length, 600013)
  assert.equal(parsed.truncated, false)
})

test('enforces declared and streamed byte limits before making a preview Blob', async () => {
  let declaredReaderCalls = 0
  let declaredCancelled = false
  const declaredResponse = {
    headers: new Headers({ 'content-length': '9' }),
    body: {
      getReader() {
        declaredReaderCalls += 1
        throw new Error('reader must not be acquired')
      },
      cancel() {
        declaredCancelled = true
      },
    },
  }
  await assert.rejects(
    readResponseBytes(declaredResponse, 8),
    (error: unknown) => error instanceof PreviewSizeLimitError && error.maximumBytes === 8,
  )
  assert.equal(declaredReaderCalls, 0)
  assert.equal(declaredCancelled, true)

  let streamedCancelled = false
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([0xe4, 0xbd]))
      controller.enqueue(new Uint8Array([0xa0, 0xe5]))
      controller.enqueue(new Uint8Array([0xa5, 0xbd]))
    },
    cancel() {
      streamedCancelled = true
    },
  })
  const response = new Response(stream)
  await assert.rejects(
    readResponseBytes(response, 5),
    (error: unknown) => error instanceof PreviewSizeLimitError && error.maximumBytes === 5,
  )
  assert.equal(streamedCancelled, true)

  const utf8 = new TextEncoder().encode('中文预览')
  const exact = await readResponseBytes(new Response(utf8), utf8.byteLength)
  assert.equal(new TextDecoder().decode(exact), '中文预览')
  await assert.rejects(
    readResponseBytes(new Response(utf8), utf8.byteLength - 1),
    (error: unknown) => error instanceof PreviewSizeLimitError,
  )
})

test('aborting a preview cancels its pending reader and rejects the request', async () => {
  const controller = new AbortController()
  let resolveRead: ((result: ReadableStreamReadResult<Uint8Array>) => void) | null = null
  let cancelCalls = 0
  const response = {
    headers: new Headers(),
    body: {
      getReader() {
        return {
          read() {
            return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => { resolveRead = resolve })
          },
          cancel() {
            cancelCalls += 1
            resolveRead?.({ done: true, value: undefined as never })
            return Promise.resolve()
          },
          releaseLock() {},
        }
      },
    },
  }
  const pending = readResponseBytes(response, 4, controller.signal)
  controller.abort()
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === 'AbortError')
  assert.equal(cancelCalls >= 1, true)
})

test('uses filename routing for octet-stream AVIF, HTML, and Markdown and keeps downloads native', () => {
  assert.equal(previewKindForArtifact({ name: 'preview.avif', mimeType: 'application/octet-stream' }), 'image')
  assert.equal(previewKindForArtifact({ name: 'preview.htm', mimeType: 'application/octet-stream' }), 'html')
  assert.equal(previewKindForArtifact({ name: 'notes.markdown', mimeType: 'application/octet-stream' }), 'source')
  assert.equal(previewKindForArtifact({ name: 'raw.bin', mimeType: 'application/octet-stream' }), 'download')
  assert.equal(artifactDownloadHref('/mlcc/api/', 'result/id'), '/mlcc/api/artifacts/result%2Fid')
})
