import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readdir, writeFile, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createMlccServer, parseCliArgs } from './server.mjs'

const INVITE = 'mlcc-invite-test'
const WORKER_TOKEN = 'worker-token-for-tests'

const VISUALIZATION_CASES = [
  {
    id: 'extxyz', name: 'trajectory.extxyz', mimeType: 'application/octet-stream',
    source: `2
Properties="species:S:1:pos:R:3" Lattice="3 0 0 0 3 0 0 0 3" pbc="T T T"
Si 0 0 0
O 1.5 -2 3
`, kind: 'trajectory', format: 'extxyz', resourceRoles: ['trajectory.coordinates', 'trajectory.cells'],
  },
  {
    id: 'xdatcar', name: 'XDATCAR', mimeType: 'application/octet-stream',
    source: `VASP fixture
2.0
1 0 0
0 1 0
0 0 1
Si O
1 1
Direct configuration=     1
0 0 0
0.5 0.5 0.5
`, kind: 'trajectory', format: 'xdatcar', resourceRoles: ['trajectory.coordinates', 'trajectory.cells'],
  },
  {
    id: 'lammps', name: 'run.lammpstrj', mimeType: 'application/octet-stream',
    source: `ITEM: TIMESTEP
0
ITEM: NUMBER OF ATOMS
2
ITEM: BOX BOUNDS pp pp pp
0 10
0 10
0 10
ITEM: ATOMS id type x y z
2 1 1 1 1
1 2 2 2 2
`, kind: 'trajectory', format: 'lammps-dump', resourceRoles: ['trajectory.coordinates', 'trajectory.cells', 'trajectory.preview'],
  },
  {
    id: 'cube', name: 'density.cube', mimeType: 'application/octet-stream',
    source: `CUBE fixture
second comment
1 0 0 0
2 0.5 0 0
2 0 0.5 0
2 0 0 0.5
14 0 0 0 0
0 1 2 3 4 5 6 7
`, kind: 'volume', format: 'cube', resourceRoles: ['volume.values'],
  },
  {
    id: 'chgcar', name: 'CHGCAR', mimeType: 'application/octet-stream',
    source: `CHGCAR fixture
1.0
1 0 0
0 1 0
0 0 1
Si
1
Direct
0 0 0

2 2 1
1 2
3 4
`, kind: 'volume', format: 'chgcar', resourceRoles: ['volume.values'],
  },
  {
    id: 'elfcar', name: 'ELFCAR', mimeType: 'application/octet-stream',
    source: `ELFCAR fixture
1.0
1 0 0
0 1 0
0 0 1
Si
1
Direct
0 0 0

1 1 2
0.125 0.25
`, kind: 'volume', format: 'elfcar', resourceRoles: ['volume.values'],
  },
  {
    id: 'eigenval', name: 'EIGENVAL', mimeType: 'application/octet-stream',
    source: `1 1 1 1
0 1 2 3 4
5.0
CAR
band fixture
8.0 1 1

0.0 0.0 0.0 1.0
1 -1.0 0.1
`, kind: 'band', format: 'vasp-eigenval', resourceRoles: ['plot.values'],
  },
  {
    id: 'doscar', name: 'DOSCAR', mimeType: 'application/octet-stream',
    source: `1 1 0 0
0 1 2 3 4
5.0
CAR
DOS fixture
10.0 -2.0 2 1.5 1.0
-2.0 0.1 0.01
0.0 0.2 0.03
`, kind: 'dos', format: 'vasp-doscar', resourceRoles: ['plot.values'],
  },
]

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return `http://127.0.0.1:${address.port}`
}

async function close(server) {
  if (server.listening) {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
  server.store?.close()
}

async function startFixture(options = {}) {
  const dataDir = options.dataDir ?? await mkdtemp(join(tmpdir(), 'mlcc-independent-'))
  const distDir = options.distDir ?? await mkdtemp(join(tmpdir(), 'mlcc-dist-'))
  if (options.distDir === undefined) {
    await writeFile(join(distDir, 'index.html'), '<main>MLCC</main>')
    await mkdir(join(distDir, 'assets'), { recursive: true })
    await writeFile(join(distDir, 'assets', 'app.js'), 'console.log(1)')
    await writeFile(join(distDir, 'assets', 'pdf.worker.mjs'), 'export const ready = true')
    await writeFile(join(distDir, 'assets', 'decoder.wasm'), new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))
  }
  const app = createMlccServer({
    dataDir,
    distDir,
    inviteCode: INVITE,
    workerToken: WORKER_TOKEN,
    now: options.now,
    sessionTtlMs: options.sessionTtlMs,
  })
  const origin = await listen(app)
  const fixture = {
    app,
    origin,
    dataDir,
    distDir,
  }
  fixture.cleanup = async () => {
    await close(fixture.app)
    if (options.dataDir === undefined) await rm(dataDir, { recursive: true, force: true })
    if (options.distDir === undefined) await rm(distDir, { recursive: true, force: true })
  }
  return fixture
}

async function api(fixture, path, options = {}) {
  const headers = { ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...(options.headers ?? {}) }
  if (options.origin !== false && options.method && options.method !== 'GET' && options.method !== 'HEAD') {
    headers.origin ??= fixture.origin
  }
  if (options.cookie) headers.cookie = options.cookie
  const response = await fetch(`${fixture.origin}${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  const text = await response.text()
  let body = null
  if (text) {
    try { body = JSON.parse(text) } catch { body = text }
  }
  return { response, body, text }
}

async function rawStatus(origin, path) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(new URL(origin), { method: 'GET', path }, (response) => {
      response.resume()
      response.on('end', () => resolve(response.statusCode))
    })
    request.on('error', reject)
    request.end()
  })
}

function cookieFrom(result) {
  const value = result.response.headers.get('set-cookie')
  assert.ok(value, 'response should set a session cookie')
  return value.split(';', 1)[0]
}

async function register(fixture, contact = 'researcher@example.com', name = 'Researcher') {
  const result = await api(fixture, '/api/register', {
    method: 'POST',
    body: { contact, password: 'correct-horse-battery', name, inviteCode: INVITE },
  })
  assert.equal(result.response.status, 201)
  return { ...result, cookie: cookieFrom(result) }
}

async function worker(fixture, path, options = {}) {
  return api(fixture, path, {
    ...options,
    origin: false,
    headers: { authorization: `Bearer ${WORKER_TOKEN}`, ...(options.headers ?? {}) },
  })
}

test('CLI has standalone defaults and no upstream target', () => {
  assert.deepEqual(parseCliArgs([], {}), { port: 4318, host: '127.0.0.1' })
  assert.deepEqual(parseCliArgs(['--port', '4321', '--host', '0.0.0.0'], {}), { port: 4321, host: '0.0.0.0' })
  assert.throws(() => parseCliArgs(['--port', 'nope'], {}), /Invalid server address/)
})

test('invite registration uses scrypt-backed persistent accounts and sessions survive restart', async () => {
  const fixture = await startFixture()
  try {
    const wrongInvite = await api(fixture, '/api/register', {
      method: 'POST',
      body: { contact: 'a@example.com', password: 'correct-horse-battery', name: 'A', inviteCode: 'wrong' },
    })
    assert.equal(wrongInvite.response.status, 403)

    const first = await register(fixture)
    assert.equal(first.body.authenticated, true)
    assert.equal(first.body.user.contact, 'researcher@example.com')
    assert.doesNotMatch(first.text, /correct-horse|scrypt\$/i)

    const session = await api(fixture, '/api/session', { cookie: first.cookie })
    assert.deepEqual(session.body, { authenticated: true, user: first.body.user })
    const chat = await api(fixture, '/api/chats', { method: 'POST', cookie: first.cookie, body: { title: '氧空位' } })
    assert.equal(chat.response.status, 201)

    await close(fixture.app)
    const restarted = createMlccServer({ dataDir: fixture.dataDir, distDir: fixture.distDir, inviteCode: INVITE, workerToken: WORKER_TOKEN })
    fixture.app = restarted
    const restartedOrigin = await listen(restarted)
    fixture.origin = restartedOrigin
    const persisted = await api(fixture, '/api/session', { cookie: first.cookie })
    assert.deepEqual(persisted.body, { authenticated: true, user: first.body.user })
    const chats = await api(fixture, '/api/chats', { cookie: first.cookie })
    assert.equal(chats.response.status, 200)
    assert.equal(chats.body.chats.length, 1)
  } finally {
    await fixture.cleanup()
  }
})

test('login rate limiting and same-origin write protection are local', async () => {
  const fixture = await startFixture()
  try {
    await register(fixture)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await api(fixture, '/api/login', {
        method: 'POST',
        body: { contact: 'researcher@example.com', password: 'wrong-password-1' },
      })
      assert.equal(failed.response.status, 401)
    }
    const limited = await api(fixture, '/api/login', {
      method: 'POST',
      body: { contact: 'researcher@example.com', password: 'correct-horse-battery' },
    })
    assert.equal(limited.response.status, 429)

    const crossSite = await api(fixture, '/api/login', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
      body: { contact: 'new@example.com', password: 'correct-horse-battery' },
    })
    assert.equal(crossSite.response.status, 403)
  } finally {
    await fixture.cleanup()
  }
})

test('chat runs are owner-scoped, durable, idempotent, and claimed with prior history', async () => {
  const fixture = await startFixture()
  try {
    const first = await register(fixture)
    await worker(fixture, '/api/worker/heartbeat', { method: 'POST', body: { workerId: 'worker-1', ready: true } })
    const chatResult = await api(fixture, '/api/chats', { method: 'POST', cookie: first.cookie, body: { title: '电场分布' } })
    const chatId = chatResult.body.chat.id

    const started = await api(fixture, `/api/chats/${chatId}/runs`, {
      method: 'POST', cookie: first.cookie,
      body: { clientRequestId: 'request-one', message: '分析介质层厚度' },
    })
    assert.equal(started.response.status, 202)
    assert.equal(started.body.run.status, 'queued')

    const duplicate = await api(fixture, `/api/chats/${chatId}/runs`, {
      method: 'POST', cookie: first.cookie,
      body: { clientRequestId: 'request-one', message: '分析介质层厚度' },
    })
    assert.equal(duplicate.response.status, 202)
    assert.equal(duplicate.body.run.id, started.body.run.id)

    const conflict = await api(fixture, `/api/chats/${chatId}/runs`, {
      method: 'POST', cookie: first.cookie,
      body: { clientRequestId: 'request-one', message: '换一个问题' },
    })
    assert.equal(conflict.response.status, 409)

    const privateChat = await api(fixture, `/api/chats/${chatId}`, { cookie: first.cookie })
    assert.equal(privateChat.response.status, 200)
    assert.equal(privateChat.body.messages.find((message) => message.role === 'user').text, '分析介质层厚度')

    const claimed = await worker(fixture, '/api/worker/claim', { method: 'POST', body: { workerId: 'worker-1' } })
    assert.equal(claimed.response.status, 200)
    assert.equal(claimed.body.job.chatId, chatId)
    assert.equal(claimed.body.job.message, '分析介质层厚度')
    assert.deepEqual(claimed.body.job.history, [])
    const leaseToken = claimed.body.job.leaseToken
    assert.match(leaseToken, /^[A-Za-z0-9_-]{20,}$/)

    const emitted = await worker(fixture, `/api/worker/runs/${started.body.run.id}/events`, {
      method: 'POST', body: { leaseToken, events: [
        { eventId: 'e1', type: 'run.started' },
        { eventId: 'e2', type: 'assistant.delta', text: '厚度增加会降低局部电场。' },
        { eventId: 'e3', type: 'run.completed', summary: '已完成分析' },
      ] },
    })
    assert.equal(emitted.response.status, 200)
    assert.equal(emitted.body.cancelRequested, false)

    const terminalRetry = await worker(fixture, `/api/worker/runs/${started.body.run.id}/events`, {
      method: 'POST', body: { leaseToken, events: [
        { eventId: 'e1', type: 'run.started' },
        { eventId: 'e2', type: 'assistant.delta', text: '厚度增加会降低局部电场。' },
        { eventId: 'e3', type: 'run.completed', summary: '已完成分析' },
      ] },
    })
    assert.equal(terminalRetry.response.status, 200)
    assert.equal(terminalRetry.body.run.status, 'completed')

    const events = await api(fixture, `/api/runs/${started.body.run.id}/events?after=0`, { cookie: first.cookie })
    assert.equal(events.response.status, 200)
    assert.deepEqual(events.body.events.map((event) => event.type), ['run.started', 'assistant.delta', 'run.completed'])
    assert.equal(events.body.run.status, 'completed')

    const chat = await api(fixture, `/api/chats/${chatId}`, { cookie: first.cookie })
    assert.equal(chat.body.messages.at(-1).role, 'assistant')
    assert.match(chat.body.messages.at(-1).text, /厚度增加/)

    const oldToken = await worker(fixture, `/api/worker/runs/${started.body.run.id}/events`, {
      method: 'POST', body: { leaseToken: 'wrong-lease-token-long-enough', events: [] },
    })
    assert.equal(oldToken.response.status, 409)

    const foreign = await register(fixture, 'second@example.com', 'Second')
    const hiddenChat = await api(fixture, `/api/chats/${chatId}`, { cookie: foreign.cookie })
    assert.equal(hiddenChat.response.status, 404)
  } finally {
    await fixture.cleanup()
  }
})

test('queued cancellation, running cancellation signal, worker heartbeat, and stale runs are durable', async () => {
  let now = Date.parse('2026-11-15T00:00:00.000Z')
  const fixture = await startFixture({ now: () => now })
  try {
    const account = await register(fixture)
    await worker(fixture, '/api/worker/heartbeat', { method: 'POST', body: { workerId: 'worker-1', ready: true } })
    const chat = await api(fixture, '/api/chats', { method: 'POST', cookie: account.cookie, body: {} })
    const started = await api(fixture, `/api/chats/${chat.body.chat.id}/runs`, {
      method: 'POST', cookie: account.cookie,
      body: { clientRequestId: 'stale-request', message: '检查极化畴' },
    })
    const claimed = await worker(fixture, '/api/worker/claim', { method: 'POST', body: { workerId: 'worker-1' } })
    assert.equal(claimed.body.job.id, started.body.run.id)

    const heartbeat = await worker(fixture, '/api/worker/heartbeat', { method: 'POST', body: { workerId: 'worker-1', ready: true } })
    assert.deepEqual(heartbeat.body, { ok: true })
    now += 91_000
    const status = await api(fixture, '/api/status')
    assert.equal(status.body.status, 'offline')
    const expired = await api(fixture, `/api/runs/${started.body.run.id}/events`, { cookie: account.cookie })
    assert.equal(expired.body.run.status, 'failed')
    const staleChat = await api(fixture, `/api/chats/${chat.body.chat.id}`, { cookie: account.cookie })
    assert.match(staleChat.body.messages.at(-1).text, /失联而中断/)

    await worker(fixture, '/api/worker/heartbeat', { method: 'POST', body: { workerId: 'worker-1', ready: true } })
    const nextChat = await api(fixture, '/api/chats', { method: 'POST', cookie: account.cookie, body: {} })
    const queued = await api(fixture, `/api/chats/${nextChat.body.chat.id}/runs`, {
      method: 'POST', cookie: account.cookie,
      body: { clientRequestId: 'cancel-request', message: '停止这个任务' },
    })
    const cancelled = await api(fixture, `/api/runs/${queued.body.run.id}/cancel`, { method: 'POST', cookie: account.cookie, body: {} })
    assert.equal(cancelled.response.status, 200)
    assert.equal(cancelled.body.run.status, 'cancelled')
  } finally {
    await fixture.cleanup()
  }
})

test('worker artifacts are size-limited, owner-scoped, downloadable, and evented', async () => {
  const fixture = await startFixture()
  try {
    const first = await register(fixture)
    await worker(fixture, '/api/worker/heartbeat', { method: 'POST', body: { workerId: 'worker-1', ready: true } })
    const chat = await api(fixture, '/api/chats', { method: 'POST', cookie: first.cookie, body: {} })
    const started = await api(fixture, `/api/chats/${chat.body.chat.id}/runs`, {
      method: 'POST', cookie: first.cookie,
      body: { clientRequestId: 'artifact-request', message: '生成电场图' },
    })
    const claimed = await worker(fixture, '/api/worker/claim', { method: 'POST', body: { workerId: 'worker-1' } })
    const uploaded = await worker(fixture, `/api/worker/runs/${started.body.run.id}/artifacts`, {
      method: 'POST',
      body: { leaseToken: claimed.body.job.leaseToken, artifactId: 'field-map', name: 'field-map.json', mimeType: 'application/json', base64: Buffer.from('{"ok":true}').toString('base64') },
    })
    assert.equal(uploaded.response.status, 201)
    assert.equal(uploaded.body.artifact.size, 11)
    const download = await api(fixture, `/api/artifacts/${uploaded.body.artifact.id}`, { cookie: first.cookie })
    assert.equal(download.response.status, 200)
    assert.equal(download.response.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(download.text, '{"ok":true}')

    const duplicate = await worker(fixture, `/api/worker/runs/${started.body.run.id}/artifacts`, {
      method: 'POST',
      body: { leaseToken: claimed.body.job.leaseToken, artifactId: 'field-map', name: 'field-map.json', mimeType: 'application/json', base64: Buffer.from('{"ok":true}').toString('base64') },
    })
    assert.equal(duplicate.response.status, 200)

    const changedDuplicate = await worker(fixture, `/api/worker/runs/${started.body.run.id}/artifacts`, {
      method: 'POST',
      body: { leaseToken: claimed.body.job.leaseToken, artifactId: 'field-map', name: 'field-map.json', mimeType: 'application/json', base64: Buffer.from('{"no":true}').toString('base64') },
    })
    assert.equal(changedDuplicate.response.status, 409)

    const secondArtifact = await worker(fixture, `/api/worker/runs/${started.body.run.id}/artifacts`, {
      method: 'POST',
      body: { leaseToken: claimed.body.job.leaseToken, artifactId: 'field-map-2', name: 'field-map-2.json', mimeType: 'application/json', base64: Buffer.from('{"ok":true}').toString('base64') },
    })
    assert.equal(secondArtifact.response.status, 201)
    const orderedChat = await api(fixture, `/api/chats/${chat.body.chat.id}`, { cookie: first.cookie })
    assert.deepEqual(orderedChat.body.messages.at(-1).artifacts.map((artifact) => artifact.name), ['field-map.json', 'field-map-2.json'])

    const unsafe = await worker(fixture, `/api/worker/runs/${started.body.run.id}/artifacts`, {
      method: 'POST',
      body: { leaseToken: claimed.body.job.leaseToken, artifactId: 'secret', name: '.env', mimeType: 'text/plain', base64: Buffer.from('secret').toString('base64') },
    })
    assert.equal(unsafe.response.status, 400)

    const second = await register(fixture, 'second@example.com', 'Second')
    const forbidden = await api(fixture, `/api/artifacts/${uploaded.body.artifact.id}`, { cookie: second.cookie })
    assert.equal(forbidden.response.status, 404)
  } finally {
    await fixture.cleanup()
  }
})

test('stream artifact transport commits raw bytes with exact metadata and idempotency', async () => {
  const fixture = await startFixture()
  try {
    const first = await register(fixture, 'stream@example.com', 'Stream')
    await worker(fixture, '/api/worker/heartbeat', { method: 'POST', body: { workerId: 'worker-stream', ready: true } })
    const chat = await api(fixture, '/api/chats', { method: 'POST', cookie: first.cookie, body: {} })
    const started = await api(fixture, `/api/chats/${chat.body.chat.id}/runs`, {
      method: 'POST', cookie: first.cookie,
      body: { clientRequestId: 'stream-request', message: '发布原始结果' },
    })
    const claimed = await worker(fixture, '/api/worker/claim', { method: 'POST', body: { workerId: 'worker-stream' } })
    const bytes = Buffer.from('raw stream bytes\n')
    const headers = {
      authorization: `Bearer ${WORKER_TOKEN}`,
      'content-type': 'application/octet-stream',
      'content-length': String(bytes.byteLength),
      'x-mlcc-lease-token': claimed.body.job.leaseToken,
      'x-mlcc-artifact-id': 'stream-result',
      'x-mlcc-artifact-name': 'field-map.json',
      'x-mlcc-artifact-path': 'results/field-map.json',
      'x-mlcc-artifact-mime': 'application/json',
      'x-mlcc-artifact-size': String(bytes.byteLength),
      'x-mlcc-artifact-sha256': createHash('sha256').update(bytes).digest('hex'),
    }
    const uploaded = await fetch(`${fixture.origin}/api/worker/runs/${started.body.run.id}/artifacts/stream`, {
      method: 'POST', headers, body: bytes,
    })
    assert.equal(uploaded.status, 201)
    const uploadedBody = await uploaded.json()
    assert.equal(uploadedBody.artifact.path, 'results/field-map.json')
    assert.equal(uploadedBody.artifact.size, bytes.byteLength)

    const duplicate = await fetch(`${fixture.origin}/api/worker/runs/${started.body.run.id}/artifacts/stream`, {
      method: 'POST', headers, body: bytes,
    })
    assert.equal(duplicate.status, 200)
    assert.equal((await duplicate.json()).artifact.id, uploadedBody.artifact.id)

    const download = await api(fixture, `/api/artifacts/${uploadedBody.artifact.id}`, { cookie: first.cookie })
    assert.equal(download.response.status, 200)
    assert.equal(download.response.headers.get('content-length'), String(bytes.byteLength))
    assert.equal(download.text, bytes.toString())

    const badDigest = await fetch(`${fixture.origin}/api/worker/runs/${started.body.run.id}/artifacts/stream`, {
      method: 'POST',
      headers: { ...headers, 'x-mlcc-artifact-id': 'stream-result-2', 'x-mlcc-artifact-sha256': '0'.repeat(64) },
      body: bytes,
    })
    assert.equal(badDigest.status, 409)

    const sizeMismatch = await fetch(`${fixture.origin}/api/worker/runs/${started.body.run.id}/artifacts/stream`, {
      method: 'POST',
      headers: { ...headers, 'x-mlcc-artifact-id': 'stream-result-3', 'x-mlcc-artifact-size': String(bytes.byteLength + 1) },
      body: bytes,
    })
    assert.equal(sizeMismatch.status, 400)

    const overOneGiB = await fetch(`${fixture.origin}/api/worker/runs/${started.body.run.id}/artifacts/stream`, {
      method: 'POST',
      headers: { ...headers, 'content-length': '0', 'x-mlcc-artifact-id': 'stream-result-4', 'x-mlcc-artifact-size': String(1024 * 1024 * 1024 + 1) },
      body: Buffer.alloc(0),
    })
    const overOneGiBText = await overOneGiB.text()
    assert.equal(overOneGiB.status, 413, overOneGiBText)

    const aliasConflict = await fetch(`${fixture.origin}/api/worker/runs/${started.body.run.id}/artifacts/stream`, {
      method: 'POST',
      headers: { ...headers, 'x-mlcc-artifact-id': 'stream-result-5', 'x-artifact-id': 'different-id' },
      body: bytes,
    })
    assert.equal(aliasConflict.status, 400)

    const queryRejected = await fetch(`${fixture.origin}/api/worker/runs/${started.body.run.id}/artifacts/stream?path=outside`, {
      method: 'POST', headers, body: bytes,
    })
    assert.equal(queryRejected.status, 404)

    const legacyTooLarge = await worker(fixture, `/api/worker/runs/${started.body.run.id}/artifacts`, {
      method: 'POST',
      body: {
        leaseToken: claimed.body.job.leaseToken,
        artifactId: 'legacy-too-large', name: 'legacy.bin', mimeType: 'application/octet-stream',
        base64: Buffer.alloc(12 * 1024 * 1024 + 1).toString('base64'),
      },
    })
    assert.equal(legacyTooLarge.response.status, 413)

    const abortController = new AbortController()
    const abortedBody = (async function* () {
      abortController.abort()
      yield Buffer.from('aborted')
    })()
    await assert.rejects(
      () => fixture.app.store.uploadArtifactStream(
        started.body.run.id,
        claimed.body.job.leaseToken,
        {
          artifactId: 'cancelled-stream', name: 'cancelled.bin', path: 'cancelled.bin',
          mimeType: 'application/octet-stream', size: 7, sha256: createHash('sha256').update('aborted').digest('hex'),
        },
        abortedBody,
        { signal: abortController.signal },
      ),
      (error) => error?.code === 'upload_aborted',
    )
    const runFiles = await readdir(join(fixture.dataDir, 'artifacts', started.body.run.id))
    assert.equal(runFiles.some((name) => name.startsWith('.upload-')), false)
  } finally {
    await fixture.cleanup()
  }
})

test('standalone visualization endpoints parse every supported family and fence resources', async () => {
  const fixture = await startFixture()
  try {
    const first = await register(fixture, 'visualization@example.com', 'Visualization')
    await worker(fixture, '/api/worker/heartbeat', { method: 'POST', body: { workerId: 'worker-visualization', ready: true } })
    const chat = await api(fixture, '/api/chats', { method: 'POST', cookie: first.cookie, body: {} })
    const started = await api(fixture, `/api/chats/${chat.body.chat.id}/runs`, {
      method: 'POST', cookie: first.cookie,
      body: { clientRequestId: 'visualization-request', message: '生成全套可视化结果' },
    })
    const claimed = await worker(fixture, '/api/worker/claim', { method: 'POST', body: { workerId: 'worker-visualization' } })
    assert.equal(claimed.body.job.id, started.body.run.id)

    const artifacts = []
    for (const item of VISUALIZATION_CASES) {
      const uploaded = await worker(fixture, `/api/worker/runs/${started.body.run.id}/artifacts`, {
        method: 'POST',
        body: {
          leaseToken: claimed.body.job.leaseToken,
          artifactId: item.id,
          name: item.name,
          mimeType: item.mimeType,
          base64: Buffer.from(item.source).toString('base64'),
        },
      })
      assert.equal(uploaded.response.status, 201)
      artifacts.push({ ...item, artifactId: uploaded.body.artifact.id })
    }

    const unauthenticated = await api(fixture, `/api/artifacts/${artifacts[0].artifactId}/visualization`)
    assert.equal(unauthenticated.response.status, 401)

    for (const item of artifacts) {
      const manifestResult = await api(fixture, `/api/artifacts/${item.artifactId}/visualization`, { cookie: first.cookie })
      assert.equal(manifestResult.response.status, 200)
      assert.deepEqual(manifestResult.body.state, 'ready')
      assert.equal(manifestResult.body.manifest.kind, item.kind)
      assert.equal(manifestResult.body.manifest.format, item.format)
      assert.equal(manifestResult.body.manifest.source.runId, item.artifactId)
      assert.equal(manifestResult.body.manifest.source.sequence, 1)
      assert.equal(manifestResult.body.manifest.source.name, item.name)
      assert.deepEqual(manifestResult.body.manifest.resources.map((resource) => resource.role), item.resourceRoles)

      for (const resource of manifestResult.body.manifest.resources) {
        const response = await fetch(`${fixture.origin}/api/artifacts/${item.artifactId}/visualization/resources/${resource.id}`, {
          headers: { cookie: first.cookie },
        })
        assert.equal(response.status, 200)
        assert.equal(response.headers.get('content-type'), resource.mimeType)
        const bytes = Buffer.from(await response.arrayBuffer())
        assert.equal(bytes.byteLength, resource.byteLength)
        if (resource.id === 'preview_gif') assert.deepEqual(bytes.subarray(0, 6), Buffer.from('GIF89a'))
      }
    }

    const second = await register(fixture, 'visualization-other@example.com', 'Other')
    const crossOwner = await api(fixture, `/api/artifacts/${artifacts[0].artifactId}/visualization`, { cookie: second.cookie })
    assert.equal(crossOwner.response.status, 404)
    const crossOwnerResource = await api(fixture, `/api/artifacts/${artifacts[0].artifactId}/visualization/resources/coordinates`, { cookie: second.cookie })
    assert.equal(crossOwnerResource.response.status, 404)
    const querySmuggling = await api(fixture, `/api/artifacts/${artifacts[0].artifactId}/visualization?path=secret`, { cookie: first.cookie })
    assert.equal(querySmuggling.response.status, 404)
    const unknownResource = await api(fixture, `/api/artifacts/${artifacts[0].artifactId}/visualization/resources/secret`, { cookie: first.cookie })
    assert.equal(unknownResource.response.status, 404)
    const pathResource = await api(fixture, `/api/artifacts/${artifacts[0].artifactId}/visualization/resources/path%2Fsecret`, { cookie: first.cookie })
    assert.equal(pathResource.response.status, 404)

    const malformed = await worker(fixture, `/api/worker/runs/${started.body.run.id}/artifacts`, {
      method: 'POST',
      body: {
        leaseToken: claimed.body.job.leaseToken,
        artifactId: 'broken', name: 'broken.extxyz', mimeType: 'application/octet-stream',
        base64: Buffer.from('not a valid trajectory').toString('base64'),
      },
    })
    assert.equal(malformed.response.status, 201)
    const brokenVisualization = await api(fixture, `/api/artifacts/${malformed.body.artifact.id}/visualization`, { cookie: first.cookie })
    assert.equal(brokenVisualization.response.status, 200)
    assert.deepEqual(brokenVisualization.body, { state: 'unsupported', reason: 'malformed' })
    const brokenDownload = await fetch(`${fixture.origin}/api/artifacts/${malformed.body.artifact.id}`, { headers: { cookie: first.cookie } })
    assert.equal(brokenDownload.status, 200)
    assert.equal(await brokenDownload.text(), 'not a valid trajectory')
  } finally {
    await fixture.cleanup()
  }
})

test('status reflects worker readiness and static files keep path isolation', async () => {
  const fixture = await startFixture()
  try {
    const before = await api(fixture, '/api/status')
    assert.deepEqual(before.body, { mode: 'independent', status: 'offline' })
    const heartbeat = await worker(fixture, '/api/worker/heartbeat', { method: 'POST', body: { workerId: 'worker-1', ready: true } })
    assert.deepEqual(heartbeat.body, { ok: true })
    const online = await api(fixture, '/api/status')
    assert.deepEqual(online.body, { mode: 'independent', status: 'online' })
    const index = await fetch(`${fixture.origin}/`)
    assert.equal(index.status, 200)
    assert.equal(await index.text(), '<main>MLCC</main>')
    const asset = await fetch(`${fixture.origin}/assets/app.js`)
    assert.equal(asset.headers.get('content-type'), 'text/javascript; charset=utf-8')
    const moduleWorker = await fetch(`${fixture.origin}/assets/pdf.worker.mjs`)
    assert.equal(moduleWorker.status, 200)
    assert.equal(moduleWorker.headers.get('content-type'), 'text/javascript; charset=utf-8')
    const wasm = await fetch(`${fixture.origin}/assets/decoder.wasm`)
    assert.equal(wasm.headers.get('content-type'), 'application/wasm')
    assert.equal(await rawStatus(fixture.origin, '/assets/%2e%2e/%2e%2e/etc/passwd'), 404)
    await writeFile(join(fixture.distDir, '.env'), 'not-public')
    assert.equal(await rawStatus(fixture.origin, '/.env'), 404)
    const oldProxy = await api(fixture, '/api/projects')
    assert.equal(oldProxy.response.status, 404)
  } finally {
    await fixture.cleanup()
  }
})
