import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile, stat, rename, unlink } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, extname, join, relative, resolve } from 'node:path'

import { MlccStore, StoreError, MAX_ARTIFACT_BYTES } from './standalone/store.mjs'
import { ArtifactTransportError, assertContentLength, parseArtifactUploadHeaders, streamArtifactBytes } from './standalone/artifact-transport.mjs'
import { createVisualizationRuntime, prepareArtifactVisualization } from './standalone/visualization/runtime.mjs'
import { parseServerArtifactVisualizationResourceId, parseServerArtifactVisualizationResponse } from './standalone/visualization/scientific-visualization.mjs'

export const SESSION_COOKIE_NAME = 'catalysis_research_session'

const MAX_LOGIN_BODY_BYTES = 16 * 1024
const MAX_REGISTER_BODY_BYTES = 16 * 1024
const MAX_CHAT_BODY_BYTES = 16 * 1024
const MAX_RUN_BODY_BYTES = 32 * 1024
const MAX_WORKER_BODY_BYTES = 17 * 1024 * 1024
const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,160}$/
const AUTH_RATE_WINDOW_MS = 60_000
const AUTH_RATE_LIMIT = 30
const AUTH_RATE_MAX_KEYS = 2_048
const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.ttf', 'font/ttf'],
  ['.wasm', 'application/wasm'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
])

class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

function objectBody(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'validation_failed', `${label} must be a JSON object.`)
  return value
}

function exactKeys(value, required, optional = []) {
  const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key))
}

function parseId(value, label = 'id') {
  let decoded
  try { decoded = decodeURIComponent(value) } catch { throw new HttpError(404, 'not_found', 'Route was not found.') }
  if (!ID_PATTERN.test(decoded)) throw new HttpError(404, 'not_found', 'Route was not found.')
  return decoded
}

function parseContact(value) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 254) throw new HttpError(400, 'validation_failed', 'Contact is required.')
  const trimmed = value.trim()
  if (trimmed.includes('@')) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) throw new HttpError(400, 'validation_failed', 'Contact is invalid.')
    return trimmed.toLowerCase()
  }
  const phone = trimmed.replace(/[\s()-]/g, '')
  if (/^1[3-9]\d{9}$/.test(phone)) return `+86${phone}`
  if (/^\+[1-9]\d{7,14}$/.test(phone)) return phone
  throw new HttpError(400, 'validation_failed', 'Contact is invalid.')
}

function parsePassword(value) {
  if (typeof value !== 'string' || value.length < 10 || value.length > 256) throw new HttpError(400, 'validation_failed', 'Password is invalid.')
  return value
}

function parseRegisterRequest(value) {
  const body = objectBody(value, 'Register request')
  if (!exactKeys(body, ['contact', 'password', 'name', 'inviteCode']) || typeof body.name !== 'string' || body.name.trim().length < 1 || body.name.length > 80) throw new HttpError(400, 'validation_failed', 'Register request is invalid.')
  return { contact: parseContact(body.contact), password: parsePassword(body.password), name: body.name.trim(), inviteCode: body.inviteCode }
}

function parseLoginRequest(value) {
  const body = objectBody(value, 'Login request')
  if (!exactKeys(body, ['contact', 'password'])) throw new HttpError(400, 'validation_failed', 'Login request is invalid.')
  return { contact: parseContact(body.contact), password: parsePassword(body.password) }
}

function parseChatRequest(value) {
  const body = objectBody(value, 'Chat request')
  if (!exactKeys(body, [], ['title']) || (body.title !== undefined && (typeof body.title !== 'string' || body.title.trim().length > 120))) throw new HttpError(400, 'validation_failed', 'Chat request is invalid.')
  return { title: body.title?.trim() || '新的研究' }
}

function parseRunRequest(value) {
  const body = objectBody(value, 'Run request')
  if (!exactKeys(body, ['clientRequestId', 'message']) || typeof body.clientRequestId !== 'string' || !REQUEST_ID_PATTERN.test(body.clientRequestId) || typeof body.message !== 'string' || body.message.trim().length < 1 || body.message.length > 20_000 || body.message.includes('\0')) throw new HttpError(400, 'validation_failed', 'Run request is invalid.')
  return { clientRequestId: body.clientRequestId, message: body.message }
}

function parseWorkerHeartbeat(value) {
  const body = objectBody(value, 'Worker heartbeat')
  if (!exactKeys(body, ['workerId', 'ready']) || typeof body.workerId !== 'string' || !ID_PATTERN.test(body.workerId) || typeof body.ready !== 'boolean') throw new HttpError(400, 'validation_failed', 'Worker heartbeat is invalid.')
  return body
}

function parseWorkerClaim(value) {
  const body = objectBody(value, 'Worker claim')
  if (!exactKeys(body, ['workerId']) || typeof body.workerId !== 'string' || !ID_PATTERN.test(body.workerId)) throw new HttpError(400, 'validation_failed', 'Worker claim is invalid.')
  return body
}

function parseWorkerEvents(value) {
  const body = objectBody(value, 'Worker events')
  if (!exactKeys(body, ['leaseToken', 'events']) || typeof body.leaseToken !== 'string' || body.leaseToken.length < 20 || !Array.isArray(body.events)) throw new HttpError(400, 'validation_failed', 'Worker events are invalid.')
  return body
}

function parseWorkerArtifact(value) {
  const body = objectBody(value, 'Worker artifact')
  if (!exactKeys(body, ['leaseToken', 'artifactId', 'name', 'mimeType', 'base64'], ['path', 'relativePath', 'sha256']) || typeof body.leaseToken !== 'string' || typeof body.artifactId !== 'string' || typeof body.name !== 'string' || typeof body.mimeType !== 'string' || typeof body.base64 !== 'string') throw new HttpError(400, 'validation_failed', 'Worker artifact is invalid.')
  return body
}

function parseAfter(url) {
  if ([...url.searchParams.keys()].some((key) => key !== 'after') || url.searchParams.getAll('after').length > 1) throw new HttpError(404, 'not_found', 'Route was not found.')
  const raw = url.searchParams.get('after') ?? '0'
  if (!/^(0|[1-9]\d*)$/.test(raw)) throw new HttpError(400, 'validation_failed', 'Invalid event cursor.')
  const after = Number(raw)
  if (!Number.isSafeInteger(after)) throw new HttpError(400, 'validation_failed', 'Invalid event cursor.')
  return after
}

async function readJson(request, maxBytes, label) {
  const length = request.headers['content-length']
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new HttpError(400, 'validation_failed', `${label} is too large.`)
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.byteLength
    if (total > maxBytes) throw new HttpError(400, 'validation_failed', `${label} is too large.`)
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new HttpError(400, 'validation_failed', `${label} must be valid JSON.`) }
}

function parseCookies(header) {
  const cookies = new Map()
  if (typeof header !== 'string') return cookies
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index > 0) cookies.set(part.slice(0, index).trim(), part.slice(index + 1).trim())
  }
  return cookies
}

function expectedRequestOrigin(request) {
  const forwarded = request.headers['x-forwarded-proto']
  const protocol = typeof forwarded === 'string' && ['http', 'https'].includes(forwarded.split(',', 1)[0].trim()) ? forwarded.split(',', 1)[0].trim() : request.socket.encrypted ? 'https' : 'http'
  if (typeof request.headers.host !== 'string' || !request.headers.host) return null
  try { return new URL(`${protocol}://${request.headers.host}`).origin } catch { return null }
}

function isLoopbackHostname(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
}

function assertSameOrigin(request, allowedOrigins = new Set()) {
  const origin = request.headers.origin
  if (typeof origin !== 'string' || origin === 'null') throw new HttpError(403, 'forbidden', 'Request origin is not allowed.')
  const expected = expectedRequestOrigin(request)
  if (origin === expected || allowedOrigins.has(origin)) return
  try {
    const supplied = new URL(origin)
    const expectedUrl = expected ? new URL(expected) : null
    if (expectedUrl && supplied.origin === origin && isLoopbackHostname(supplied.hostname) && isLoopbackHostname(expectedUrl.hostname)) return
  } catch { /* reject below */ }
  throw new HttpError(403, 'forbidden', 'Request origin is not allowed.')
}

function sendJson(response, status, body, extraHeaders = {}) {
  if (response.headersSent) return
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  })
  response.end(payload)
}

function sendError(response, error) {
  if (response.destroyed || response.writableEnded) return
  const known = error instanceof HttpError || error instanceof StoreError || error instanceof ArtifactTransportError
  const status = known ? error.status : 500
  const code = known ? error.code : 'internal_error'
  const message = known ? error.message : 'MLCC Studio encountered an internal error.'
  sendJson(response, status, { error: { code, message } })
}

function requestAbortController(request, response) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  const onResponseClose = () => {
    if (!response.writableEnded) abort()
  }
  request.once('aborted', abort)
  request.once('error', abort)
  response.once('close', onResponseClose)
  return {
    signal: controller.signal,
    cleanup: () => {
      request.off('aborted', abort)
      request.off('error', abort)
      response.off('close', onResponseClose)
    },
  }
}

function sessionCookie(value, request, maxAge) {
  const secure = request.socket.encrypted || request.headers['x-forwarded-proto'] === 'https'
  return `${SESSION_COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`
}

function safeStaticPath(root, pathname) {
  let decoded
  try { decoded = decodeURIComponent(pathname) } catch { return null }
  if (decoded.includes('\0') || decoded.includes('\\')) return null
  if (decoded.split('/').some(part => part.startsWith('.'))) return null
  const relativePath = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')
  const candidate = resolve(root, relativePath)
  const rootRelative = relative(root, candidate)
  if (rootRelative === '..' || rootRelative.startsWith('..' + '/') || rootRelative.startsWith('..' + '\\')) return null
  return { candidate, relativePath }
}

async function serveStatic(root, request, response, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(404, 'not_found', 'Route was not found.')
  const safe = safeStaticPath(root, url.pathname)
  if (!safe) throw new HttpError(404, 'not_found', 'Route was not found.')
  let candidate = safe.candidate
  let contents
  try {
    const metadata = await stat(candidate)
    if (!metadata.isFile()) throw new Error('not a file')
    contents = await readFile(candidate)
  } catch {
    if (extname(safe.relativePath) || safe.relativePath === 'index.html') throw new HttpError(404, 'not_found', 'Route was not found.')
    candidate = resolve(root, 'index.html')
    try { contents = await readFile(candidate) } catch { throw new HttpError(404, 'not_found', 'Route was not found.') }
  }
  const type = CONTENT_TYPES.get(extname(candidate).toLowerCase()) ?? 'application/octet-stream'
  response.writeHead(200, { 'cache-control': 'no-cache', 'content-type': type, 'content-length': contents.byteLength, 'x-content-type-options': 'nosniff' })
  if (request.method === 'GET') response.end(contents)
  else response.end()
}

function bearerToken(request) {
  const value = request.headers.authorization
  if (typeof value !== 'string' || !/^Bearer\s+\S+$/.test(value)) throw new HttpError(401, 'unauthorized', 'Worker authentication required.')
  return value.slice(value.indexOf(' ') + 1)
}

function sameSecret(left, right) {
  const leftHash = createHash('sha256').update(String(left)).digest()
  const rightHash = createHash('sha256').update(String(right)).digest()
  return leftHash.length === rightHash.length && timingSafeEqual(leftHash, rightHash)
}

export function createMlccServer(options = {}) {
  const moduleRoot = dirname(fileURLToPath(import.meta.url))
  const distRoot = resolve(options.distDir ?? join(moduleRoot, 'dist'))
  const inviteCode = options.inviteCode ?? process.env.MLCC_INVITE_CODE ?? ''
  const workerToken = options.workerToken ?? process.env.MLCC_WORKER_TOKEN ?? ''
  if (typeof workerToken !== 'string' || workerToken.length < 16) throw new TypeError('MLCC_WORKER_TOKEN must be configured')
  const allowedOrigins = new Set(options.allowedOrigins ?? [])
  const store = options.store ?? new MlccStore({ dataDir: options.dataDir, now: options.now, sessionTtlMs: options.sessionTtlMs })
  const visualizationRuntime = createVisualizationRuntime(options.visualizationStateRoot ?? store.dataDir)
  const authRate = new Map()
  const staleSweep = setInterval(() => {
    try { store.sweepStaleRuns() } catch { /* next request will retry */ }
  }, 15_000)
  staleSweep.unref?.()

  function sessionFromRequest(request) {
    return store.getSession(parseCookies(request.headers.cookie).get(SESSION_COOKIE_NAME))
  }

  function requireSession(request) {
    const session = sessionFromRequest(request)
    if (!session) throw new HttpError(401, 'unauthorized', 'Authentication required.')
    return session
  }

  function requireWorker(request) {
    if (!sameSecret(bearerToken(request), workerToken)) throw new HttpError(401, 'unauthorized', 'Worker authentication required.')
  }

  function enforceAuthRate(request) {
    const key = request.socket.remoteAddress ?? 'unknown'
    const now = store.now()
    let bucket = authRate.get(key)
    if (!bucket || bucket.resetAt <= now) bucket = { count: 0, resetAt: now + AUTH_RATE_WINDOW_MS }
    bucket.count += 1
    authRate.set(key, bucket)
    if (authRate.size > AUTH_RATE_MAX_KEYS) {
      const oldest = [...authRate.entries()].sort((left, right) => left[1].resetAt - right[1].resetAt)[0]?.[0]
      if (oldest !== undefined && oldest !== key) authRate.delete(oldest)
    }
    if (bucket.count > AUTH_RATE_LIMIT) throw new HttpError(429, 'rate_limited', 'Too many authentication attempts. Try again later.')
  }

  async function handleApi(request, response, url) {
    const pathname = url.pathname
    if (pathname === '/api/desktop-session' && request.method === 'POST' && process.env.CATALYSIS_DESKTOP === '1') {
      assertSameOrigin(request, allowedOrigins)
      const {token} = await readJson(request, 512, 'Desktop login')
      if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) throw new HttpError(401, 'invalid_ticket', 'Invalid desktop ticket.')
      const path = join(store.dataDir, 'desktop-grants', createHash('sha256').update(token).digest('hex'))
      try { await rename(path,path+'.claimed') } catch { throw new HttpError(401,'invalid_ticket','请重新双击启动器。') }
      let ticket
      try { ticket=JSON.parse(await readFile(path+'.claimed','utf8')) } finally { await unlink(path+'.claimed') }
      if (Date.now()>ticket.expires) throw new HttpError(401,'expired_ticket','请重新双击启动器。')
      const session=store.createSession(ticket.user.id)
      sendJson(response,200,{authenticated:true,user:ticket.user},{'set-cookie':sessionCookie(session.token,request,session.maxAge)})
      return
    }
    if (pathname === '/api/session' && request.method === 'GET' && url.searchParams.size === 0) {
      const session = sessionFromRequest(request)
      sendJson(response, 200, session ? { authenticated: true, user: session.user } : { authenticated: false })
      return
    }
    if (pathname === '/api/status' && request.method === 'GET' && url.searchParams.size === 0) {
      sendJson(response, 200, store.status())
      return
    }
    if (pathname === '/api/register' && request.method === 'POST') {
      assertSameOrigin(request, allowedOrigins)
      enforceAuthRate(request)
      if (url.searchParams.size) throw new HttpError(404, 'not_found', 'Route was not found.')
      const input = parseRegisterRequest(await readJson(request, MAX_REGISTER_BODY_BYTES, 'Register request'))
      if (!inviteCode || !sameSecret(input.inviteCode, inviteCode)) throw new HttpError(403, 'invalid_invite', 'A valid invitation is required.')
      const user = store.createUser(input)
      const session = store.createSession(user.id)
      sendJson(response, 201, { authenticated: true, user }, { 'set-cookie': sessionCookie(session.token, request, session.maxAge) })
      return
    }
    if (pathname === '/api/login' && request.method === 'POST') {
      assertSameOrigin(request, allowedOrigins)
      enforceAuthRate(request)
      if (url.searchParams.size) throw new HttpError(404, 'not_found', 'Route was not found.')
      const input = parseLoginRequest(await readJson(request, MAX_LOGIN_BODY_BYTES, 'Login request'))
      const user = store.authenticate(input.contact, input.password)
      const session = store.createSession(user.id)
      sendJson(response, 200, { authenticated: true, user }, { 'set-cookie': sessionCookie(session.token, request, session.maxAge) })
      return
    }
    if (pathname === '/api/logout' && request.method === 'POST') {
      assertSameOrigin(request, allowedOrigins)
      if (url.searchParams.size) throw new HttpError(404, 'not_found', 'Route was not found.')
      store.deleteSession(parseCookies(request.headers.cookie).get(SESSION_COOKIE_NAME))
      sendJson(response, 200, { ok: true }, { 'set-cookie': sessionCookie('', request, 0) })
      return
    }
    if (pathname === '/api/chats' && request.method === 'GET' && url.searchParams.size === 0) {
      const session = requireSession(request)
      sendJson(response, 200, { chats: store.listChats(session.id) })
      return
    }
    if (pathname === '/api/chats' && request.method === 'POST') {
      assertSameOrigin(request, allowedOrigins)
      const session = requireSession(request)
      if (url.searchParams.size) throw new HttpError(404, 'not_found', 'Route was not found.')
      const input = parseChatRequest(await readJson(request, MAX_CHAT_BODY_BYTES, 'Chat request'))
      sendJson(response, 201, { chat: store.createChat(session.id, input.title) })
      return
    }
    const chatMatch = pathname.match(/^\/api\/chats\/([^/]+)$/)
    if (chatMatch && request.method === 'GET') {
      const session = requireSession(request)
      if (url.searchParams.size) throw new HttpError(404, 'not_found', 'Route was not found.')
      sendJson(response, 200, store.getChat(session.id, parseId(chatMatch[1], 'chatId')))
      return
    }
    const runStartMatch = pathname.match(/^\/api\/chats\/([^/]+)\/runs$/)
    if (runStartMatch && request.method === 'POST') {
      assertSameOrigin(request, allowedOrigins)
      const session = requireSession(request)
      if (url.searchParams.size) throw new HttpError(404, 'not_found', 'Route was not found.')
      const chatId = parseId(runStartMatch[1], 'chatId')
      const input = parseRunRequest(await readJson(request, MAX_RUN_BODY_BYTES, 'Run request'))
      const result = store.createRun(session.id, chatId, input.clientRequestId, input.message)
      sendJson(response, 202, { chat: store.getChat(session.id, chatId).chat, run: result.run })
      return
    }
    const eventsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/events$/)
    if (eventsMatch && request.method === 'GET') {
      const session = requireSession(request)
      sendJson(response, 200, store.eventsForRun(session.id, parseId(eventsMatch[1], 'runId'), parseAfter(url)))
      return
    }
    const cancelMatch = pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/)
    if (cancelMatch && request.method === 'POST') {
      assertSameOrigin(request, allowedOrigins)
      const session = requireSession(request)
      if (url.searchParams.size) throw new HttpError(404, 'not_found', 'Route was not found.')
      await readJson(request, MAX_CHAT_BODY_BYTES, 'Cancel request')
      sendJson(response, 200, { run: store.cancelRun(session.id, parseId(cancelMatch[1], 'runId')) })
      return
    }
    const visualizationMatch = pathname.match(/^\/api\/artifacts\/([^/]+)\/visualization$/)
    if (visualizationMatch && request.method === 'GET') {
      const session = requireSession(request)
      if (url.searchParams.size) throw new HttpError(404, 'not_found', 'Route was not found.')
      const artifact = store.readArtifact(session.id, parseId(visualizationMatch[1], 'artifactId'))
      const abort = requestAbortController(request, response)
      try {
        const preparation = await prepareArtifactVisualization(visualizationRuntime, artifact, abort.signal)
        if (abort.signal.aborted || response.destroyed || response.writableEnded) return
        if (preparation.state === 'unsupported') {
          sendJson(response, 200, preparation, { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' })
          return
        }
        const parsed = parseServerArtifactVisualizationResponse({ state: 'ready', manifest: preparation.manifest })
        if (parsed.state !== 'ready') throw new Error('Invalid visualization manifest.')
        sendJson(response, 200, parsed, { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' })
      } finally {
        abort.cleanup()
      }
      return
    }
    const visualizationResourceMatch = pathname.match(/^\/api\/artifacts\/([^/]+)\/visualization\/resources\/([^/]+)$/)
    if (visualizationResourceMatch && request.method === 'GET') {
      const session = requireSession(request)
      if (url.searchParams.size) throw new HttpError(404, 'not_found', 'Route was not found.')
      const artifact = store.readArtifact(session.id, parseId(visualizationResourceMatch[1], 'artifactId'))
      const resourceId = parseId(visualizationResourceMatch[2], 'resourceId')
      try {
        const abort = requestAbortController(request, response)
        try {
          const preparation = await prepareArtifactVisualization(visualizationRuntime, artifact, abort.signal)
          if (abort.signal.aborted || response.destroyed || response.writableEnded) return
          if (preparation.state === 'unsupported') throw new HttpError(404, 'not_found', 'Visualization resource was not found.')
          const parsed = parseServerArtifactVisualizationResponse({ state: 'ready', manifest: preparation.manifest })
          if (parsed.state !== 'ready') throw new HttpError(404, 'not_found', 'Visualization resource was not found.')
          const descriptor = parsed.manifest.resources.find((resource) => resource.id === resourceId)
          if (descriptor === undefined) throw new HttpError(404, 'not_found', 'Visualization resource was not found.')
          let opened
          try {
            opened = await visualizationRuntime.preprocessor.openPreparedResource(preparation, resourceId)
          } catch {
            throw new HttpError(404, 'not_found', 'Visualization resource was not found.')
          }
          if (
            opened.descriptor.id !== descriptor.id ||
            opened.descriptor.role !== descriptor.role ||
            opened.descriptor.mimeType !== descriptor.mimeType ||
            opened.descriptor.byteLength !== descriptor.byteLength
          ) throw new HttpError(404, 'not_found', 'Visualization resource was not found.')
          if (abort.signal.aborted || response.destroyed || response.writableEnded) return
          response.writeHead(200, {
            'cache-control': 'private, no-store',
            'content-type': descriptor.mimeType,
            'content-length': descriptor.byteLength,
            'x-content-type-options': 'nosniff',
          })
          await streamArtifactBytes(response, opened.bytes, descriptor.byteLength, { signal: abort.signal })
        } finally {
          abort.cleanup()
        }
      } catch (error) {
        if (error instanceof HttpError) throw error
        throw new HttpError(404, 'not_found', 'Visualization resource was not found.')
      }
      return
    }
    const artifactMatch = pathname.match(/^\/api\/artifacts\/([^/]+)$/)
    if (artifactMatch && request.method === 'GET') {
      const session = requireSession(request)
      if (url.searchParams.size) throw new HttpError(404, 'not_found', 'Route was not found.')
      const artifact = store.readArtifact(session.id, parseId(artifactMatch[1], 'artifactId'))
      const safeName = artifact.name.replace(/["\\\r\n]/g, '_')
      const asciiName = safeName.replace(/[^\x20-\x7E]/g, '_') || `artifact-${artifact.id}`
      response.writeHead(200, {
        'cache-control': 'private, no-store',
        'content-type': artifact.mimeType,
        'content-length': artifact.contentLength,
        'content-disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(artifact.name)}`,
        'x-content-type-options': 'nosniff',
      })
      const abort = requestAbortController(request, response)
      try {
        await streamArtifactBytes(response, artifact.bytes, artifact.contentLength, { signal: abort.signal })
      } finally {
        abort.cleanup()
      }
      return
    }
    if (pathname === '/api/worker/heartbeat' && request.method === 'POST') {
      requireWorker(request)
      const input = parseWorkerHeartbeat(await readJson(request, MAX_CHAT_BODY_BYTES, 'Worker heartbeat'))
      store.heartbeat(input.workerId, input.ready)
      sendJson(response, 200, { ok: true })
      return
    }
    if (pathname === '/api/worker/claim' && request.method === 'POST') {
      requireWorker(request)
      const input = parseWorkerClaim(await readJson(request, MAX_CHAT_BODY_BYTES, 'Worker claim'))
      sendJson(response, 200, { job: store.claimJob(input.workerId) })
      return
    }
    const workerEventMatch = pathname.match(/^\/api\/worker\/runs\/([^/]+)\/events$/)
    if (workerEventMatch && request.method === 'POST') {
      requireWorker(request)
      const input = parseWorkerEvents(await readJson(request, MAX_WORKER_BODY_BYTES, 'Worker events'))
      sendJson(response, 200, store.appendWorkerEvents(parseId(workerEventMatch[1], 'runId'), input.leaseToken, input.events))
      return
    }
    const workerArtifactMatch = pathname.match(/^\/api\/worker\/runs\/([^/]+)\/artifacts$/)
    if (workerArtifactMatch && request.method === 'POST') {
      requireWorker(request)
      const input = parseWorkerArtifact(await readJson(request, MAX_WORKER_BODY_BYTES, 'Worker artifact'))
      const result = store.uploadArtifact(parseId(workerArtifactMatch[1], 'runId'), input.leaseToken, input)
      sendJson(response, result.duplicate ? 200 : 201, { artifact: result.artifact })
      return
    }
    const workerArtifactStreamMatch = pathname.match(/^\/api\/worker\/runs\/([^/]+)\/artifacts\/stream$/)
    if (workerArtifactStreamMatch && request.method === 'POST') {
      if (url.searchParams.size) throw new HttpError(404, 'not_found', 'Route was not found.')
      requireWorker(request)
      const metadata = parseArtifactUploadHeaders(request.headers, MAX_ARTIFACT_BYTES)
      assertContentLength(request.headers, metadata.size)
      const abort = requestAbortController(request, response)
      try {
        const result = await store.uploadArtifactStream(parseId(workerArtifactStreamMatch[1], 'runId'), metadata.leaseToken, metadata, request, { signal: abort.signal })
        if (!abort.signal.aborted && !response.destroyed) sendJson(response, result.duplicate ? 200 : 201, { artifact: result.artifact })
      } finally {
        abort.cleanup()
      }
      return
    }
    throw new HttpError(404, 'not_found', 'Route was not found.')
  }

  const server = createServer((request, response) => {
    void (async () => {
      try {
        const rawPath = (request.url ?? '/').split('?', 1)[0]
        let decodedRawPath
        try { decodedRawPath = decodeURIComponent(rawPath) } catch { throw new HttpError(404, 'not_found', 'Route was not found.') }
        if (decodedRawPath.split('/').some((segment) => segment === '.' || segment === '..')) throw new HttpError(404, 'not_found', 'Route was not found.')
        const url = new URL(request.url ?? '/', 'http://localhost')
        if (url.pathname === '/api' || url.pathname.startsWith('/api/')) await handleApi(request, response, url)
        else await serveStatic(distRoot, request, response, url)
      } catch (error) {
        sendError(response, error)
      }
    })()
  })
  // A scientific artifact may legitimately take up to the worker's twenty
  // minute lease to arrive. Keep header parsing bounded while allowing the
  // already-authenticated streaming body to complete within that lease.
  server.requestTimeout = 20 * 60_000
  server.headersTimeout = 60_000
  server.store = store
  server.staleSweep = staleSweep
  return server
}

export function parseCliArgs(argv = process.argv.slice(2), env = process.env) {
  let port = Number(env.PORT ?? 4318)
  let host = env.HOST?.trim() || '127.0.0.1'
  let distDir
  let dataDir
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--port') port = Number(argv[++index])
    else if (argument === '--host') host = argv[++index] ?? ''
    else if (argument === '--dist') distDir = argv[++index]
    else if (argument === '--data-dir') dataDir = argv[++index]
    else throw new TypeError(`Unknown argument: ${argument}`)
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535 || !host) throw new TypeError('Invalid server address')
  return { port, host, ...(distDir === undefined ? {} : { distDir }), ...(dataDir === undefined ? {} : { dataDir }) }
}

export async function startCli(argv = process.argv.slice(2), env = process.env) {
  const args = parseCliArgs(argv, env)
  const server = createMlccServer({
    ...(args.distDir === undefined ? {} : { distDir: args.distDir }),
    ...(args.dataDir === undefined ? {} : { dataDir: args.dataDir }),
    inviteCode: env.MLCC_INVITE_CODE,
    workerToken: env.MLCC_WORKER_TOKEN,
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(args.port, args.host, resolveListen)
  })
  return server
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href
if (invokedPath === import.meta.url) {
  startCli().then((server) => {
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 'unknown'
    console.log(`MLCC Studio listening on http://127.0.0.1:${port}`)
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : 'Unable to start MLCC Studio')
    process.exitCode = 1
  })
}
