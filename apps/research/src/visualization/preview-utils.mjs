/**
 * Small, DOM-free helpers shared by the generic artifact preview and its
 * standalone tests. Keeping the table parser here makes the browser-facing
 * JSX easy to exercise without importing Vite CSS or mounting React.
 */

export const HTML_PREVIEW_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "script-src 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "navigate-to 'none'",
  "frame-src 'none'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
].join('; ')

const PREVIEW_RASTER_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'])

function previewBaseMime(value) {
  return String(value ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

function previewSuffix(value) {
  const name = String(value ?? '').replace(/[\\/\u0000-\u001f\u007f]/g, '_').trim().toLowerCase()
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1)
}

/** Resolve the generic preview route from filename first, MIME second. */
export function previewKindForArtifact(reference) {
  const mime = previewBaseMime(reference?.mimeType)
  const suffix = previewSuffix(reference?.name)
  if (mime === 'image/svg+xml' || suffix === 'svg') return 'svg'
  if (PREVIEW_RASTER_MIME_TYPES.has(mime) || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'].includes(suffix)) return 'image'
  if (mime === 'application/pdf' || suffix === 'pdf') return 'pdf'
  if (
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    || mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    || suffix === 'docx'
    || suffix === 'pptx'
  ) return 'office'
  if (
    mime === 'text/csv'
    || mime === 'application/csv'
    || mime === 'text/tab-separated-values'
    || mime === 'text/tsv'
    || suffix === 'csv'
    || suffix === 'tsv'
  ) return 'table'
  if (mime === 'text/html' || suffix === 'html' || suffix === 'htm') return 'html'
  if (
    mime === 'application/json'
    || mime === 'text/json'
    || mime === 'text/plain'
    || mime === 'text/markdown'
    || mime === 'text/x-markdown'
    || ['json', 'md', 'markdown', 'txt'].includes(suffix)
  ) return 'source'
  return 'download'
}

export function artifactDownloadHref(apiBase, artifactId) {
  const base = String(apiBase ?? '/api').trim().replace(/\/+$/, '') || '/api'
  return `${base}/artifacts/${encodeURIComponent(String(artifactId ?? ''))}`
}

export function parseDelimited(source, delimiter) {
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? ''
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          cell += '"'
          index += 1
        } else quoted = false
      } else cell += character
      continue
    }
    if (character === '"' && cell.length === 0) {
      quoted = true
    } else if (character === delimiter) {
      row.push(cell)
      cell = ''
    } else if (character === '\n' || character === '\r') {
      row.push(cell)
      cell = ''
      if (row.length > 1 || row[0] !== '' || rows.length === 0) rows.push(row)
      row = []
      if (character === '\r' && source[index + 1] === '\n') index += 1
    } else cell += character
  }
  if (cell.length > 0 || row.length > 0 || source.length === 0) {
    row.push(cell)
    rows.push(row)
  }
  return {
    rows: rows.slice(0, 100).map((entry) => entry.slice(0, 50)),
    truncated: rows.length > 100 || rows.some((entry) => entry.length > 50),
  }
}

export function htmlSrcDoc(source) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}"></head><body>${source}</body></html>`
}

/**
 * A preview fetch must be bounded before it becomes a Blob.  The browser
 * normally exposes a streaming response body; keeping this helper free of
 * React makes the byte accounting and cancellation contract testable in
 * isolation.
 */
export class PreviewSizeLimitError extends Error {
  constructor(maximumBytes) {
    super(`preview response exceeds ${maximumBytes} bytes`)
    this.name = 'PreviewSizeLimitError'
    this.maximumBytes = maximumBytes
  }
}

function abortError() {
  if (typeof DOMException === 'function') return new DOMException('The operation was aborted', 'AbortError')
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

function contentLengthBytes(response) {
  const raw = response?.headers?.get?.('content-length')
  if (raw === null || raw === undefined || raw.trim() === '') return null
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

/**
 * Read at most `maximumBytes` from a Response.  A declared oversized body is
 * rejected before reading; an undeclared oversized body is cancelled as soon
 * as the accumulated chunks cross the same limit.
 */
export async function readResponseBytes(response, maximumBytes, signal) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new TypeError('maximumBytes must be a non-negative safe integer')
  }
  if (signal?.aborted) throw abortError()
  const declaredLength = contentLengthBytes(response)
  if (declaredLength !== null && declaredLength > maximumBytes) {
    try {
      await response?.body?.cancel?.()
    } catch {
      // The fetch may already have closed the body.
    }
    throw new PreviewSizeLimitError(maximumBytes)
  }

  const body = response?.body
  if (body === null || body === undefined) {
    if (declaredLength !== null && declaredLength !== 0) throw new Error('preview response body is unavailable')
    return new Uint8Array()
  }
  const reader = body?.getReader?.()
  if (reader === undefined) {
    throw new Error('preview response body is not streamable')
  }

  const chunks = []
  let total = 0
  let abortHandler = null
  const cancelReader = async () => {
    try {
      await reader.cancel()
    } catch {
      // Cancellation is best effort after a fetch abort/stream failure.
    }
  }
  try {
    if (signal !== undefined) {
      abortHandler = () => { void cancelReader() }
      signal.addEventListener('abort', abortHandler, { once: true })
    }
    while (true) {
      if (signal?.aborted) throw abortError()
      const next = await reader.read()
      if (signal?.aborted) throw abortError()
      if (next.done) break
      const chunk = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value)
      total += chunk.byteLength
      if (total > maximumBytes) {
        await cancelReader()
        throw new PreviewSizeLimitError(maximumBytes)
      }
      chunks.push(chunk)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return bytes
  } catch (error) {
    await cancelReader()
    throw error
  } finally {
    if (abortHandler !== null) signal?.removeEventListener('abort', abortHandler)
    try {
      reader.releaseLock?.()
    } catch {
      // A locked stream can be released by the browser after cancellation.
    }
  }
}

/**
 * PDF.js 6 owns worker/document teardown on the loading task. The resolved
 * PDFDocumentProxy intentionally has no destroy method in that release.
 */
export function destroyPdfLoadingTask(task) {
  if (task === null || task === undefined || typeof task.destroy !== 'function') return
  try {
    const result = task.destroy()
    if (result !== null && result !== undefined && typeof result.catch === 'function') {
      void result.catch(() => {})
    }
  } catch {
    // Cleanup must not mask the pane close/unmount that requested it.
  }
}
