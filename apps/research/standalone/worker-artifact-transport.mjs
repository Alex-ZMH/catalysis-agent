import { createHash } from 'node:crypto'
import { openConfinedFile, assertUnchanged } from './workspace.mjs'
import { scientificResultArtifactMimeType } from './scientific-artifact.mjs'
import { MAX_RESULT_ARTIFACT_BYTES } from './artifact-harvest.mjs'

const CHUNK_BYTES = 64 * 1024
const MIME_TYPES = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown',
  '.json': 'application/json', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.pdf': 'application/pdf',
  '.svg': 'image/svg+xml', '.html': 'text/html', '.htm': 'text/html', '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

function extension(name) {
  const base = name.toLowerCase().split('/').at(-1) ?? ''
  const index = base.lastIndexOf('.')
  return index < 0 ? '' : base.slice(index)
}

export function artifactMimeType(name) {
  return scientificResultArtifactMimeType(name) ?? MIME_TYPES[extension(name)] ?? 'application/octet-stream'
}

export class ArtifactApiError extends Error {
  constructor(status, message, body = '') {
    super(message)
    this.name = 'ArtifactApiError'
    this.status = status
    this.body = body
  }
}

function fileChangedError(error) {
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return error
  if (error?.status !== undefined) return error
  return Object.assign(error instanceof Error ? error : new Error('File changed while it was being uploaded'), {
    status: 409,
    code: 'artifact_changed',
  })
}

function encodedLabel(value) {
  // The server decodes these headers exactly once. Always encoding avoids a
  // literal '%' (or a space) being mistaken for a malformed escape sequence.
  return encodeURIComponent(value)
}

async function readFileHash(root, value, signal) {
  const file = await openConfinedFile(root, value, MAX_RESULT_ARTIFACT_BYTES, { denyConfig: true })
  const hash = createHash('sha256')
  let total = 0
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES)
  try {
    while (true) {
      signal?.throwIfAborted()
      const result = await file.handle.read({ buffer, offset: 0, length: buffer.byteLength, position: total })
      if (!result.bytesRead) break
      hash.update(buffer.subarray(0, result.bytesRead))
      total += result.bytesRead
      if (total > MAX_RESULT_ARTIFACT_BYTES) throw new Error('File exceeds the artifact upload limit')
    }
    const current = await file.handle.stat()
    assertUnchanged(file.stat, current)
    if (total !== file.stat.size) throw new Error('File changed while it was being read')
    return {
      relativePath: file.rel,
      name: file.rel.split('/').at(-1),
      mimeType: artifactMimeType(file.rel),
      contentLength: total,
      contentSha256: hash.digest('hex'),
      stat: file.stat,
    }
  } finally {
    await file.handle.close().catch(() => {})
  }
}

export async function describeConfinedArtifact(root, value, signal) {
  return readFileHash(root, value, signal)
}

async function* bodyFromFile(file, descriptor, signal) {
  let total = 0
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES)
  try {
    while (true) {
      signal?.throwIfAborted()
      const result = await file.handle.read({ buffer, offset: 0, length: buffer.byteLength, position: total })
      if (!result.bytesRead) break
      total += result.bytesRead
      if (total > descriptor.contentLength) throw new Error('Uploaded bytes exceed the declared content length')
      // Each yielded chunk must own its bytes. Undici may consume a chunk
      // after the generator resumes; reusing one mutable buffer would corrupt
      // the body while keeping memory bounded.
      yield Buffer.from(buffer.subarray(0, result.bytesRead))
    }
    const current = await file.handle.stat()
    try {
      assertUnchanged(file.stat, current)
      if (total !== descriptor.contentLength) throw new Error('File changed while it was being uploaded')
    } catch (error) {
      throw fileChangedError(error)
    }
  } finally {
    await file.handle.close().catch(() => {})
  }
}

export async function uploadArtifactStream(config, job, root, descriptor, signal) {
  signal?.throwIfAborted()
  const file = await openConfinedFile(root, descriptor.relativePath, MAX_RESULT_ARTIFACT_BYTES, { denyConfig: true })
  try {
    try { assertUnchanged(descriptor.stat, file.stat) } catch (error) { throw fileChangedError(error) }
    const response = await fetch(`${config.apiOrigin}/worker/runs/${job.id}/artifacts/stream`, {
      method: 'POST', duplex: 'half',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': descriptor.mimeType,
        'Content-Length': String(descriptor.contentLength),
        'X-MLCC-Lease-Token': job.leaseToken,
        'X-MLCC-Artifact-Id': descriptor.artifactId,
        'X-MLCC-Artifact-Name': encodedLabel(descriptor.name),
        'X-MLCC-Artifact-Mime': descriptor.mimeType,
        'X-MLCC-Artifact-Path': encodedLabel(descriptor.relativePath),
        'X-MLCC-Artifact-Size': String(descriptor.contentLength),
        'X-MLCC-Artifact-SHA256': descriptor.contentSha256,
      },
      body: bodyFromFile(file, descriptor, signal), signal,
    })
    const body = await response.text()
    if (!response.ok) throw new ArtifactApiError(response.status, `MLCC artifact API HTTP ${response.status}`, body)
    if (!body) return { ok: true, artifactId: descriptor.artifactId, relativePath: descriptor.relativePath }
    try {
      const payload = JSON.parse(body)
      return { ...payload, artifactId: descriptor.artifactId, relativePath: descriptor.relativePath }
    } catch {
      throw new ArtifactApiError(response.status, 'MLCC artifact API returned invalid JSON', body)
    }
  } catch (error) {
    await file.handle.close().catch(() => {})
    throw error
  }
}
