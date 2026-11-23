/**
 * HTTP transport primitives owned by the standalone server.
 *
 * Artifact metadata is carried in headers so the body can remain a raw,
 * streaming byte sequence. The worker and public contract use the
 * X-MLCC-Artifact-* spelling; legacy X-Artifact-* aliases remain accepted
 * for older workers, with conflicting duplicate values rejected.
 */

const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/
const MIME_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+\/-]{0,126}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const MAX_NAME_BYTES = 500
const MAX_PATH_BYTES = 512

export const ARTIFACT_STREAM_HEADERS = Object.freeze({
  leaseToken: 'x-mlcc-lease-token',
  artifactId: 'x-mlcc-artifact-id',
  name: 'x-mlcc-artifact-name',
  path: 'x-mlcc-artifact-path',
  mimeType: 'x-mlcc-artifact-mime',
  size: 'x-mlcc-artifact-size',
  sha256: 'x-mlcc-artifact-sha256',
})

const HEADER_ALIASES = Object.freeze({
  leaseToken: ['x-artifact-lease-token', 'x-lease-token'],
  artifactId: ['x-artifact-id'],
  name: ['x-artifact-name'],
  path: ['x-artifact-path'],
  mimeType: ['x-artifact-mime-type'],
  size: ['x-artifact-size'],
  sha256: ['x-artifact-sha256'],
})

export class ArtifactTransportError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'ArtifactTransportError'
    this.status = status
    this.code = code
  }
}

function headerValue(headers, name) {
  const value = headers?.[name]
  if (value === undefined) return undefined
  if (Array.isArray(value)) throw new ArtifactTransportError(400, 'validation_failed', 'Artifact metadata is invalid.')
  if (typeof value !== 'string' || value.length === 0) throw new ArtifactTransportError(400, 'validation_failed', 'Artifact metadata is invalid.')
  return value
}

function readHeader(headers, key, { required = true } = {}) {
  const canonical = headerValue(headers, ARTIFACT_STREAM_HEADERS[key])
  const aliases = HEADER_ALIASES[key] ?? []
  const values = aliases.map((name) => headerValue(headers, name)).filter((value) => value !== undefined)
  if (new Set(values).size > 1) {
    throw new ArtifactTransportError(400, 'validation_failed', 'Conflicting artifact metadata headers.')
  }
  if (canonical !== undefined && values.some((value) => value !== canonical)) {
    throw new ArtifactTransportError(400, 'validation_failed', 'Conflicting artifact metadata headers.')
  }
  const value = canonical ?? values[0]
  if (required && value === undefined) throw new ArtifactTransportError(400, 'validation_failed', 'Artifact metadata is incomplete.')
  return value
}

function decodeHeader(value, maxBytes, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxBytes * 4 + 32) {
    throw new ArtifactTransportError(400, 'validation_failed', `${label} is invalid.`)
  }
  let decoded
  try { decoded = decodeURIComponent(value) } catch {
    throw new ArtifactTransportError(400, 'validation_failed', `${label} is invalid.`)
  }
  if (Buffer.byteLength(decoded, 'utf8') > maxBytes || /[\u0000-\u001f\u007f\r\n]/.test(decoded)) {
    throw new ArtifactTransportError(400, 'validation_failed', `${label} is invalid.`)
  }
  return decoded
}

function parseDecimal(value, maxBytes) {
  if (typeof value !== 'string' || !/^\d+$/.test(value) || value.length > 16) {
    throw new ArtifactTransportError(400, 'validation_failed', 'Artifact size is invalid.')
  }
  const size = Number(value)
  if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
    throw new ArtifactTransportError(413, 'artifact_too_large', 'Artifact is too large.')
  }
  return size
}

/** Parse and validate all streaming upload metadata before reading the body. */
export function parseArtifactUploadHeaders(headers, maxBytes) {
  const leaseToken = readHeader(headers, 'leaseToken')
  if (leaseToken.length > 512) throw new ArtifactTransportError(400, 'validation_failed', 'Lease token is invalid.')

  const artifactId = readHeader(headers, 'artifactId')
  if (!ARTIFACT_ID_PATTERN.test(artifactId)) throw new ArtifactTransportError(400, 'validation_failed', 'Artifact id is invalid.')

  const name = decodeHeader(readHeader(headers, 'name'), MAX_NAME_BYTES, 'Artifact name')
  const pathHeader = readHeader(headers, 'path', { required: false })
  const path = pathHeader === undefined ? name : decodeHeader(pathHeader, MAX_PATH_BYTES, 'Artifact path')
  const mimeType = readHeader(headers, 'mimeType')
  if (!MIME_TYPE_PATTERN.test(mimeType)) throw new ArtifactTransportError(400, 'validation_failed', 'Artifact mime type is invalid.')
  // Content-Length is the worker's wire-level size metadata. The explicit
  // artifact-size header remains accepted for proxies that preserve the
  // standalone contract; if both are supplied they must agree.
  const sizeHeader = readHeader(headers, 'size', { required: false })
  const contentLength = headers?.['content-length']
  const size = parseDecimal(sizeHeader ?? contentLength, maxBytes)
  if (sizeHeader !== undefined && contentLength !== undefined && (!/^\d+$/.test(contentLength) || Number(contentLength) !== size)) {
    throw new ArtifactTransportError(400, 'artifact_size_mismatch', 'Artifact size does not match its metadata.')
  }
  const sha256 = readHeader(headers, 'sha256')
  if (!SHA256_PATTERN.test(sha256)) throw new ArtifactTransportError(400, 'validation_failed', 'Artifact digest is invalid.')

  return Object.freeze({ leaseToken, artifactId, name, path, mimeType, size, sha256 })
}

export function assertContentLength(headers, expected) {
  const raw = headers?.['content-length']
  if (raw === undefined) return
  if (Array.isArray(raw) || typeof raw !== 'string' || !/^\d+$/.test(raw) || Number(raw) !== expected) {
    throw new ArtifactTransportError(400, 'artifact_size_mismatch', 'Artifact size does not match its metadata.')
  }
}

function abortError() {
  return new ArtifactTransportError(499, 'upload_aborted', 'Artifact transfer was aborted.')
}

function waitForDrain(response, signal) {
  if (signal?.aborted || response.destroyed) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      response.off('drain', onDrain)
      response.off('error', onError)
      response.off('close', onClose)
      signal?.removeEventListener('abort', onAbort)
    }
    const finish = (error) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve()
    }
    const onDrain = () => finish()
    const onError = () => finish(abortError())
    const onClose = () => finish(abortError())
    const onAbort = () => finish(abortError())
    response.once('drain', onDrain)
    response.once('error', onError)
    response.once('close', onClose)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted || response.destroyed) finish(abortError())
  })
}

/** Stream an async byte iterable to an HTTP response with exact-length checks. */
export async function streamArtifactBytes(response, bytes, expectedLength, { signal } = {}) {
  if (!Number.isSafeInteger(expectedLength) || expectedLength < 0 || typeof bytes?.[Symbol.asyncIterator] !== 'function') {
    throw new ArtifactTransportError(500, 'artifact_io_failed', 'Artifact stream is invalid.')
  }
  let total = 0
  try {
    for await (const chunk of bytes) {
      if (signal?.aborted || response.destroyed) throw abortError()
      if (!(chunk instanceof Uint8Array) || total + chunk.byteLength > expectedLength) {
        throw new ArtifactTransportError(404, 'not_found', 'Artifact was not found.')
      }
      if (chunk.byteLength === 0) continue
      total += chunk.byteLength
      if (!response.write(chunk)) await waitForDrain(response, signal)
    }
    if (total !== expectedLength) throw new ArtifactTransportError(404, 'not_found', 'Artifact was not found.')
    if (signal?.aborted || response.destroyed) throw abortError()
    response.end()
  } catch (error) {
    if (typeof bytes.return === 'function') await bytes.return().catch(() => {})
    throw error
  }
}
