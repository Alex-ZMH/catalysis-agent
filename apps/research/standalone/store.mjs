import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { constants as fsConstants, mkdirSync, renameSync, writeFileSync, lstatSync, unlinkSync, chmodSync, realpathSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const RUN_STALE_MS = 90_000
export const WORKER_ONLINE_MS = 45_000
export const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024
export const MAX_LEGACY_BASE64_ARTIFACT_BYTES = 12 * 1024 * 1024
export const MAX_ARTIFACT_PATH_LENGTH = 512

const PASSWORD_KEY_LENGTH = 32
const PASSWORD_SALT_LENGTH = 16
const PASSWORD_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
const TERMINAL_STATUS = new Set(['completed', 'failed', 'cancelled'])
const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/
const MIME_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+\/-]{0,126}$/
const ARTIFACT_PATH_SEGMENT_MAX_LENGTH = 120
const ARTIFACT_PATH_MAX_DEPTH = 16
const EVENT_TYPES = new Set([
  'run.started', 'assistant.delta', 'assistant.progress', 'tool.status',
  'run.completed', 'run.failed', 'run.cancelled', 'artifact.created',
])

export class StoreError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'StoreError'
    this.status = status
    this.code = code
  }
}

function asNumber(value) {
  return typeof value === 'bigint' ? Number(value) : Number(value)
}

function nowIso(ms) {
  return new Date(ms).toISOString()
}

function json(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  try { return JSON.parse(value) } catch { return fallback }
}

function hashText(value) {
  return createHash('sha256').update(value).digest('hex')
}

function hashToken(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

function equalSecret(left, right) {
  const leftHash = createHash('sha256').update(String(left)).digest()
  const rightHash = createHash('sha256').update(String(right)).digest()
  return timingSafeEqual(leftHash, rightHash)
}

function userFromRow(row) {
  if (!row) return null
  return { id: row.id, name: row.name, contact: row.contact }
}

function chatFromRow(row) {
  return {
    id: row.id,
    title: row.title,
    createdAt: nowIso(asNumber(row.created_at)),
    updatedAt: nowIso(asNumber(row.updated_at)),
    activeRunId: row.active_run_id ?? null,
  }
}

function runFromRow(row) {
  if (!row) return null
  return {
    id: row.id,
    status: row.status,
  }
}

function ensureSafeName(name) {
  if (
    typeof name !== 'string' || name.length < 1 || name.length > 500 || name.includes('\0') ||
    basename(name) !== name || name === '.' || name === '..' ||
    /[\u0000-\u001f\u007f"\\/\r\n]/.test(name)
  ) {
    throw new StoreError(400, 'validation_failed', 'Artifact name is invalid.')
  }
  if (/^(?:\.env(?:\..*)?|.*(?:secret|password|token|credential|config).*)$/i.test(name)) {
    throw new StoreError(400, 'validation_failed', 'Configuration and secret files cannot be uploaded.')
  }
  return name
}

function ensureSafeArtifactPath(path, fallbackName) {
  if (path === undefined || path === null || path === '') return fallbackName
  if (
    typeof path !== 'string' || path.length < 1 || path.length > MAX_ARTIFACT_PATH_LENGTH ||
    path.startsWith('/') || path.includes('\\') || path.includes('\0') ||
    /[\u0000-\u001f\u007f"\r\n]/.test(path)
  ) throw new StoreError(400, 'validation_failed', 'Artifact path is invalid.')
  const segments = path.split('/')
  if (
    segments.length > ARTIFACT_PATH_MAX_DEPTH ||
    segments.some((segment) => (
      segment.length < 1 || segment.length > ARTIFACT_PATH_SEGMENT_MAX_LENGTH ||
      segment === '.' || segment === '..'
    ))
  ) throw new StoreError(400, 'validation_failed', 'Artifact path is invalid.')
  return path
}

function ensureMimeType(mimeType) {
  if (typeof mimeType !== 'string' || !MIME_TYPE_PATTERN.test(mimeType)) {
    throw new StoreError(400, 'validation_failed', 'Artifact mime type is invalid.')
  }
  return mimeType
}

function isBase64(value) {
  if (value.length % 4 !== 0) return false
  let padding = 0
  while (padding < value.length && value[value.length - 1 - padding] === '=') padding += 1
  if (padding > 2) return false
  const bodyLength = value.length - padding
  for (let index = 0; index < bodyLength; index += 1) {
    const code = value.charCodeAt(index)
    if (!(
      (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) || code === 0x2b || code === 0x2f
    )) return false
  }
  return true
}

function ensureEvent(event) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    throw new StoreError(400, 'validation_failed', 'Worker event is invalid.')
  }
  if (typeof event.eventId !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(event.eventId)) {
    throw new StoreError(400, 'validation_failed', 'Worker event id is invalid.')
  }
  if (!EVENT_TYPES.has(event.type)) {
    throw new StoreError(400, 'validation_failed', 'Worker event type is invalid.')
  }
  if (event.type === 'assistant.delta' || event.type === 'assistant.progress' || event.type === 'run.failed' || event.type === 'run.cancelled') {
    const key = event.type === 'run.failed' || event.type === 'run.cancelled' ? 'message' : 'text'
    if (typeof event[key] !== 'string' || event[key].length > 100_000) {
      throw new StoreError(400, 'validation_failed', 'Worker event text is invalid.')
    }
  }
  if (event.type === 'tool.status') {
    if (typeof event.toolCallId !== 'string' || typeof event.name !== 'string' || typeof event.status !== 'string' || event.name.length > 200 || event.status.length > 80) {
      throw new StoreError(400, 'validation_failed', 'Tool event is invalid.')
    }
  }
  if (event.type === 'run.completed' && event.summary !== undefined && (typeof event.summary !== 'string' || event.summary.length > 100_000)) {
    throw new StoreError(400, 'validation_failed', 'Completion summary is invalid.')
  }
  return event
}

export class MlccStore {
  constructor(options = {}) {
    this.dataDir = resolve(options.dataDir ?? process.env.MLCC_DATA_DIR ?? '/var/lib/mlcc-studio')
    this.artifactDir = join(this.dataDir, 'artifacts')
    this.now = options.now ?? (() => Date.now())
    this.sessionTtlMs = options.sessionTtlMs ?? SESSION_TTL_MS
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 })
    mkdirSync(this.artifactDir, { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(join(this.dataDir, 'mlcc.sqlite'))
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        contact TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        locked_until INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS login_limits (
        contact TEXT PRIMARY KEY,
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        locked_until INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chats_owner_idx ON chats(owner_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        client_request_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        message TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_lease_at INTEGER,
        worker_id TEXT,
        lease_hash TEXT,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        terminal_message TEXT,
        user_message_id TEXT NOT NULL,
        assistant_message_id TEXT NOT NULL,
        UNIQUE(owner_id, client_request_id)
      );
      CREATE INDEX IF NOT EXISTS runs_queue_idx ON runs(status, created_at);
      CREATE INDEX IF NOT EXISTS runs_owner_status_idx ON runs(owner_id, status);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user','assistant')),
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        tools_json TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_chat_idx ON messages(chat_id, created_at, id);
      CREATE TABLE IF NOT EXISTS run_events (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(run_id, sequence),
        UNIQUE(run_id, event_id)
      );
      CREATE TABLE IF NOT EXISTS worker_state (
        worker_id TEXT PRIMARY KEY,
        ready INTEGER NOT NULL DEFAULT 0,
        last_seen INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        artifact_key TEXT NOT NULL,
        name TEXT NOT NULL,
        path TEXT,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        relative_path TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        UNIQUE(run_id, artifact_key)
      );
    `)
    const artifactColumns = this.db.prepare('PRAGMA table_info(artifacts)').all().map((column) => column.name)
    if (!artifactColumns.includes('content_hash')) this.db.exec("ALTER TABLE artifacts ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''")
    if (!artifactColumns.includes('path')) this.db.exec('ALTER TABLE artifacts ADD COLUMN path TEXT')
  }

  close() {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }

  transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = callback()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* preserve original error */ }
      throw error
    }
  }

  createUser({ contact, password, name }) {
    const now = this.now()
    const salt = randomBytes(PASSWORD_SALT_LENGTH).toString('base64url')
    const passwordHash = scryptSync(password, salt, PASSWORD_KEY_LENGTH, PASSWORD_OPTIONS).toString('base64url')
    const id = randomUUID()
    try {
      this.db.prepare('INSERT INTO users(id, contact, name, password_salt, password_hash, created_at) VALUES($id,$contact,$name,$salt,$hash,$created)').run({
        $id: id, $contact: contact, $name: name, $salt: salt, $hash: passwordHash, $created: now,
      })
    } catch (error) {
      if (String(error?.message).includes('UNIQUE')) throw new StoreError(409, 'contact_exists', 'An account already exists for this contact.')
      throw error
    }
    return { id, name, contact }
  }

  authenticate(contact, password) {
    const now = this.now()
    const user = this.db.prepare('SELECT * FROM users WHERE contact=$contact').get({ $contact: contact })
    const limit = this.db.prepare('SELECT * FROM login_limits WHERE contact=$contact').get({ $contact: contact })
    const lockedUntil = Math.max(asNumber(user?.locked_until ?? 0), asNumber(limit?.locked_until ?? 0))
    if (lockedUntil > now) throw new StoreError(429, 'rate_limited', 'Too many login attempts. Try again later.')

    let valid = false
    if (user) {
      const actual = scryptSync(password, user.password_salt, PASSWORD_KEY_LENGTH, PASSWORD_OPTIONS)
      const expected = Buffer.from(user.password_hash, 'base64url')
      valid = actual.length === expected.length && timingSafeEqual(actual, expected)
    } else {
      const dummy = scryptSync(password, 'mlcc-dummy-salt', PASSWORD_KEY_LENGTH, PASSWORD_OPTIONS)
      valid = timingSafeEqual(dummy, Buffer.alloc(PASSWORD_KEY_LENGTH))
    }
    if (!valid) {
      this.transaction(() => {
        const previous = limit ? asNumber(limit.failed_attempts) : 0
        const failures = previous + 1
        const lock = failures >= 5 ? now + 60_000 : 0
        this.db.prepare(`INSERT INTO login_limits(contact,failed_attempts,locked_until,updated_at) VALUES($contact,$failures,$locked,$updated)
          ON CONFLICT(contact) DO UPDATE SET failed_attempts=excluded.failed_attempts, locked_until=excluded.locked_until, updated_at=excluded.updated_at`).run({
          $contact: contact, $failures: failures, $locked: lock, $updated: now,
        })
      })
      if (limit && asNumber(limit.failed_attempts) >= 5) throw new StoreError(429, 'rate_limited', 'Too many login attempts. Try again later.')
      throw new StoreError(401, 'invalid_credentials', 'Invalid contact or password.')
    }
    this.transaction(() => {
      this.db.prepare('DELETE FROM login_limits WHERE contact=$contact').run({ $contact: contact })
      this.db.prepare('UPDATE users SET failed_attempts=0, locked_until=0 WHERE id=$id').run({ $id: user.id })
    })
    return userFromRow(user)
  }

  createSession(userId) {
    const token = randomBytes(32).toString('base64url')
    const now = this.now()
    const expiresAt = now + this.sessionTtlMs
    this.db.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES($hash,$user,$created,$expires)').run({
      $hash: hashToken(token), $user: userId, $created: now, $expires: expiresAt,
    })
    return { token, expiresAt, maxAge: Math.max(1, Math.floor(this.sessionTtlMs / 1000)) }
  }

  getSession(token) {
    if (typeof token !== 'string' || token.length < 20) return null
    const now = this.now()
    const row = this.db.prepare(`SELECT s.*, u.id, u.name, u.contact FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=$hash`).get({ $hash: hashToken(token) })
    if (!row) return null
    if (asNumber(row.expires_at) <= now) {
      this.db.prepare('DELETE FROM sessions WHERE token_hash=$hash').run({ $hash: hashToken(token) })
      return null
    }
    return { id: row.user_id, user: userFromRow(row), expiresAt: asNumber(row.expires_at) }
  }

  deleteSession(token) {
    if (typeof token === 'string' && token.length > 0) this.db.prepare('DELETE FROM sessions WHERE token_hash=$hash').run({ $hash: hashToken(token) })
  }

  createChat(ownerId, title = '新的研究') {
    const id = randomUUID()
    const now = this.now()
    this.db.prepare('INSERT INTO chats(id,owner_id,title,created_at,updated_at) VALUES($id,$owner,$title,$created,$updated)').run({
      $id: id, $owner: ownerId, $title: title, $created: now, $updated: now,
    })
    return { id, title, createdAt: nowIso(now), updatedAt: nowIso(now), activeRunId: null }
  }

  listChats(ownerId) {
    const rows = this.db.prepare(`SELECT c.*, (SELECT r.id FROM runs r WHERE r.chat_id=c.id AND r.status IN ('queued','running') LIMIT 1) AS active_run_id
      FROM chats c WHERE c.owner_id=$owner ORDER BY c.updated_at DESC, c.id DESC`).all({ $owner: ownerId })
    return rows.map(chatFromRow)
  }

  getChat(ownerId, chatId) {
    const row = this.db.prepare(`SELECT c.*, (SELECT r.id FROM runs r WHERE r.chat_id=c.id AND r.status IN ('queued','running') LIMIT 1) AS active_run_id
      FROM chats c WHERE c.owner_id=$owner AND c.id=$id`).get({ $owner: ownerId, $id: chatId })
    if (!row) throw new StoreError(404, 'not_found', 'Chat was not found.')
    const messages = this.db.prepare('SELECT * FROM messages WHERE chat_id=$chat ORDER BY created_at ASC, rowid ASC').all({ $chat: chatId }).map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text,
      status: message.status,
      ...(message.tools_json ? { tools: json(message.tools_json, []) } : {}),
      artifacts: message.role === 'assistant' ? this.listArtifacts(ownerId, chatId, message.run_id) : [],
    }))
    const active = this.db.prepare(`SELECT id,status FROM runs WHERE owner_id=$owner AND chat_id=$chat AND status IN ('queued','running') LIMIT 1`).get({ $owner: ownerId, $chat: chatId })
    const activeRun = runFromRow(active)
    if (activeRun) {
      const cursor = this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS after FROM run_events WHERE run_id=$run').get({ $run: active.id })
      activeRun.after = asNumber(cursor.after)
    }
    return { chat: chatFromRow(row), messages, activeRun }
  }

  hasWorker(now = this.now()) {
    const row = this.db.prepare('SELECT 1 FROM worker_state WHERE ready=1 AND last_seen>$cutoff LIMIT 1').get({ $cutoff: now - WORKER_ONLINE_MS })
    return Boolean(row)
  }

  status() {
    const now = this.now()
    this.sweepStaleRuns()
    if (!this.hasWorker(now)) return { mode: 'independent', status: 'offline' }
    const active = this.db.prepare("SELECT 1 FROM runs WHERE status IN ('queued','running') LIMIT 1").get()
    return { mode: 'independent', status: active ? 'busy' : 'online' }
  }

  createRun(ownerId, chatId, clientRequestId, message) {
    this.sweepStaleRuns()
    const chat = this.db.prepare('SELECT * FROM chats WHERE id=$id AND owner_id=$owner').get({ $id: chatId, $owner: ownerId })
    if (!chat) throw new StoreError(404, 'not_found', 'Chat was not found.')
    const requestHash = hashText(JSON.stringify({ chatId, message }))
    const existing = this.db.prepare('SELECT * FROM runs WHERE owner_id=$owner AND client_request_id=$request').get({ $owner: ownerId, $request: clientRequestId })
    if (existing) {
      if (!equalSecret(existing.request_hash, requestHash)) throw new StoreError(409, 'idempotency_conflict', 'Client request id was already used with different input.')
      return { run: runFromRow(existing), duplicate: true }
    }
    if (!this.hasWorker()) throw new StoreError(503, 'worker_offline', 'MLCC compute service is offline.')
    const activeAccount = this.db.prepare("SELECT 1 FROM runs WHERE owner_id=$owner AND status IN ('queued','running') LIMIT 1").get({ $owner: ownerId })
    if (activeAccount) throw new StoreError(409, 'run_in_progress', 'Only one unfinished run is allowed per account.')
    const activeChat = this.db.prepare("SELECT 1 FROM runs WHERE chat_id=$chat AND status IN ('queued','running') LIMIT 1").get({ $chat: chatId })
    if (activeChat) throw new StoreError(409, 'run_in_progress', 'Only one unfinished run is allowed per chat.')
    const now = this.now()
    const runId = randomUUID()
    const userMessageId = randomUUID()
    const assistantMessageId = randomUUID()
    this.transaction(() => {
      this.db.prepare('INSERT INTO runs(id,chat_id,owner_id,client_request_id,request_hash,message,status,created_at,updated_at,user_message_id,assistant_message_id) VALUES($id,$chat,$owner,$request,$hash,$message,$status,$created,$updated,$userMessage,$assistantMessage)').run({
        $id: runId, $chat: chatId, $owner: ownerId, $request: clientRequestId, $hash: requestHash, $message: message, $status: 'queued', $created: now, $updated: now, $userMessage: userMessageId, $assistantMessage: assistantMessageId,
      })
      this.db.prepare('INSERT INTO messages(id,chat_id,owner_id,run_id,role,text,status,created_at) VALUES($id,$chat,$owner,$run,$role,$text,$status,$created)').run({
        $id: userMessageId, $chat: chatId, $owner: ownerId, $run: runId, $role: 'user', $text: message, $status: 'completed', $created: now,
      })
      this.db.prepare('INSERT INTO messages(id,chat_id,owner_id,run_id,role,text,status,tools_json,created_at) VALUES($id,$chat,$owner,$run,$role,$text,$status,$tools,$created)').run({
        $id: assistantMessageId, $chat: chatId, $owner: ownerId, $run: runId, $role: 'assistant', $text: '', $status: 'queued', $tools: '[]', $created: now + 1,
      })
      this.db.prepare('UPDATE chats SET updated_at=$updated WHERE id=$id').run({ $updated: now, $id: chatId })
    })
    return { run: { id: runId, status: 'queued' }, duplicate: false }
  }

  claimJob(workerId) {
    this.sweepStaleRuns()
    const now = this.now()
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM runs WHERE status='queued' ORDER BY created_at ASC, id ASC LIMIT 1").get()
      this.db.prepare('INSERT INTO worker_state(worker_id,ready,last_seen,updated_at) VALUES($id,1,$now,$now) ON CONFLICT(worker_id) DO UPDATE SET ready=1,last_seen=excluded.last_seen,updated_at=excluded.updated_at').run({ $id: workerId, $now: now })
      if (!row) return null
      const leaseToken = randomBytes(32).toString('base64url')
      this.db.prepare("UPDATE runs SET status='running', updated_at=$now, last_lease_at=$now, worker_id=$worker, lease_hash=$lease, cancel_requested=0 WHERE id=$id AND status='queued'").run({
        $now: now, $worker: workerId, $lease: hashToken(leaseToken), $id: row.id,
      })
      const history = this.db.prepare(`SELECT role,text FROM messages WHERE chat_id=$chat AND id NOT IN ($user,$assistant)
        AND status IN ('completed','done') ORDER BY created_at ASC, rowid ASC`).all({ $chat: row.chat_id, $user: row.user_message_id, $assistant: row.assistant_message_id }).map((item) => ({ role: item.role, content: item.text }))
      return { id: row.id, chatId: row.chat_id, ownerId: row.owner_id, message: row.message, history, leaseToken }
    })
  }

  heartbeat(workerId, ready) {
    const now = this.now()
    this.db.prepare('INSERT INTO worker_state(worker_id,ready,last_seen,updated_at) VALUES($id,$ready,$now,$now) ON CONFLICT(worker_id) DO UPDATE SET ready=excluded.ready,last_seen=excluded.last_seen,updated_at=excluded.updated_at').run({ $id: workerId, $ready: ready ? 1 : 0, $now: now })
  }

  getRun(ownerId, runId) {
    const row = this.db.prepare('SELECT * FROM runs WHERE id=$id AND owner_id=$owner').get({ $id: runId, $owner: ownerId })
    if (!row) throw new StoreError(404, 'not_found', 'Run was not found.')
    return row
  }

  eventsForRun(ownerId, runId, after = 0) {
    this.sweepStaleRuns()
    const run = this.getRun(ownerId, runId)
    const rows = this.db.prepare('SELECT * FROM run_events WHERE run_id=$run AND sequence>$after ORDER BY sequence ASC').all({ $run: runId, $after: after })
    const events = rows.map((event) => ({ sequence: asNumber(event.sequence), ...json(event.payload_json, {}) }))
    return { events, run: runFromRow(run) }
  }

  appendServerEvent(runId, type, payload, now = this.now(), suffix = '') {
    const row = this.db.prepare('SELECT * FROM runs WHERE id=$id').get({ $id: runId })
    if (!row) return
    const eventId = `server-${type}-${runId}${suffix ? `-${suffix}` : ''}`
    const payloadWithType = { eventId, type, ...payload }
    const exists = this.db.prepare('SELECT 1 FROM run_events WHERE run_id=$run AND event_id=$event').get({ $run: runId, $event: eventId })
    if (exists) return
    const sequence = asNumber(this.db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM run_events WHERE run_id=$run').get({ $run: runId }).next)
    this.db.prepare('INSERT INTO run_events(run_id,sequence,event_id,type,payload_json,payload_hash,created_at) VALUES($run,$sequence,$event,$type,$payload,$hash,$created)').run({
      $run: runId, $sequence: sequence, $event: eventId, $type: type, $payload: JSON.stringify(payloadWithType), $hash: hashText(JSON.stringify(payloadWithType)), $created: now,
    })
  }

  sweepStaleRuns() {
    const now = this.now()
    const stale = this.db.prepare("SELECT * FROM runs WHERE status='running' AND COALESCE(last_lease_at,updated_at) <= $cutoff").all({ $cutoff: now - RUN_STALE_MS })
    if (stale.length === 0) return
    this.transaction(() => {
      for (const run of stale) {
        this.db.prepare("UPDATE runs SET status='failed', updated_at=$now, terminal_message=$message, lease_hash=NULL WHERE id=$id AND status='running'").run({ $now: now, $message: 'Worker lease expired after 90 seconds.', $id: run.id })
        this.db.prepare("UPDATE messages SET status='failed', text=CASE WHEN text='' THEN $message WHEN instr(text,$message)=0 THEN text || char(10) || char(10) || $message ELSE text END WHERE id=$id").run({ $message: '研究任务因计算节点失联而中断。', $id: run.assistant_message_id })
        this.appendServerEvent(run.id, 'run.failed', { message: 'Worker lease expired after 90 seconds.' }, now)
      }
    })
  }

  leaseMatches(row, leaseToken) {
    return typeof leaseToken === 'string' && typeof row.lease_hash === 'string' && equalSecret(row.lease_hash, hashToken(leaseToken))
  }

  appendWorkerEvents(runId, leaseToken, events) {
    this.sweepStaleRuns()
    const now = this.now()
    return this.transaction(() => {
      const run = this.db.prepare('SELECT * FROM runs WHERE id=$id').get({ $id: runId })
      if (!run || !this.leaseMatches(run, leaseToken)) throw new StoreError(409, 'stale_lease', 'Worker lease is no longer valid.')
      if (!Array.isArray(events) || events.length > 100) throw new StoreError(400, 'validation_failed', 'Events must be an array of at most 100 items.')
      if (run.status !== 'running') {
        for (const rawEvent of events) {
          const event = ensureEvent(rawEvent)
          const duplicate = this.db.prepare('SELECT payload_hash FROM run_events WHERE run_id=$run AND event_id=$event').get({ $run: runId, $event: event.eventId })
          if (!duplicate || !equalSecret(duplicate.payload_hash, hashText(JSON.stringify(event)))) throw new StoreError(409, 'run_terminal', 'Run is already terminal.')
        }
        return { cancelRequested: Boolean(run.cancel_requested), run: runFromRow(run) }
      }
      let assistant = this.db.prepare('SELECT * FROM messages WHERE id=$id').get({ $id: run.assistant_message_id })
      for (const rawEvent of events) {
        const event = ensureEvent(rawEvent)
        const payload = { ...event }
        const payloadJson = JSON.stringify(payload)
        const duplicate = this.db.prepare('SELECT payload_hash FROM run_events WHERE run_id=$run AND event_id=$event').get({ $run: runId, $event: event.eventId })
        if (duplicate) {
          if (!equalSecret(duplicate.payload_hash, hashText(payloadJson))) throw new StoreError(409, 'event_conflict', 'Worker event id was reused with different content.')
          continue
        }
        if (TERMINAL_STATUS.has(run.status)) throw new StoreError(409, 'run_terminal', 'Run is already terminal.')
        const sequence = asNumber(this.db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM run_events WHERE run_id=$run').get({ $run: runId }).next)
        this.db.prepare('INSERT INTO run_events(run_id,sequence,event_id,type,payload_json,payload_hash,created_at) VALUES($run,$sequence,$event,$type,$payload,$hash,$created)').run({
          $run: runId, $sequence: sequence, $event: event.eventId, $type: event.type, $payload: payloadJson, $hash: hashText(payloadJson), $created: now,
        })
        if (event.type === 'assistant.delta') {
          assistant.text += event.text
          assistant.status = 'running'
        } else if (event.type === 'assistant.progress') {
          assistant.status = 'running'
        } else if (event.type === 'tool.status') {
          const tools = json(assistant.tools_json, [])
          const existing = tools.find((tool) => tool.id === event.toolCallId)
          if (existing) Object.assign(existing, { name: event.name, status: event.status })
          else tools.push({ id: event.toolCallId, name: event.name, status: event.status })
          assistant.tools_json = JSON.stringify(tools)
        } else if (event.type === 'run.completed') {
          run.status = 'completed'
          run.terminal_message = event.summary ?? null
          assistant.status = 'completed'
          if (!assistant.text && event.summary) assistant.text = event.summary
        } else if (event.type === 'run.failed') {
          run.status = 'failed'
          run.terminal_message = event.message
          assistant.status = 'failed'
          assistant.text = assistant.text ? `${assistant.text}\n\n${event.message}` : event.message
        } else if (event.type === 'run.cancelled') {
          run.status = 'cancelled'
          run.terminal_message = event.message ?? 'Run cancelled.'
          assistant.status = 'cancelled'
          assistant.text = assistant.text ? `${assistant.text}\n\n${event.message ?? '研究任务已停止。'}` : (event.message ?? '研究任务已停止。')
        }
        if (event.type === 'run.started') run.status = 'running'
      }
      const terminal = TERMINAL_STATUS.has(run.status)
      this.db.prepare(`UPDATE messages SET text=$text,status=$status,tools_json=$tools WHERE id=$id`).run({
        $text: assistant.text, $status: assistant.status, $tools: assistant.tools_json, $id: assistant.id,
      })
      this.db.prepare('UPDATE runs SET status=$status,updated_at=$now,last_lease_at=$lease,lease_hash=$hash,terminal_message=$terminal WHERE id=$id').run({
        $status: run.status, $now: now, $lease: now, $hash: run.lease_hash, $terminal: run.terminal_message, $id: runId,
      })
      this.db.prepare('UPDATE chats SET updated_at=$now WHERE id=$id').run({ $now: now, $id: run.chat_id })
      return { cancelRequested: Boolean(run.cancel_requested), run: runFromRow(run) }
    })
  }

  cancelRun(ownerId, runId) {
    this.sweepStaleRuns()
    return this.transaction(() => {
      const run = this.getRun(ownerId, runId)
      const now = this.now()
      if (run.status === 'queued') {
        this.db.prepare("UPDATE runs SET status='cancelled',updated_at=$now,terminal_message='Run cancelled.' WHERE id=$id").run({ $now: now, $id: runId })
        this.db.prepare("UPDATE messages SET status='cancelled',text='研究任务已停止。' WHERE id=$id").run({ $id: run.assistant_message_id })
        this.appendServerEvent(runId, 'run.cancelled', { message: '研究任务已停止。' }, now)
        return { id: runId, status: 'cancelled' }
      }
      if (run.status === 'running') {
        this.db.prepare("UPDATE runs SET cancel_requested=1,updated_at=$now WHERE id=$id").run({ $now: now, $id: runId })
        return { id: runId, status: 'running', cancelRequested: true }
      }
      return runFromRow(run)
    })
  }

  assertArtifactLease(runId, leaseToken) {
    const run = this.db.prepare('SELECT * FROM runs WHERE id=$id').get({ $id: runId })
    if (!run || run.status !== 'running' || asNumber(run.cancel_requested) !== 0 || !this.leaseMatches(run, leaseToken)) {
      throw new StoreError(409, 'stale_lease', 'Worker lease is no longer valid.')
    }
    return run
  }

  artifactDirectory(runId, { create = true } = {}) {
    if (typeof runId !== 'string' || !ARTIFACT_ID_PATTERN.test(runId)) throw new StoreError(400, 'validation_failed', 'Run id is invalid.')
    const dataRoot = resolve(this.dataDir)
    const artifactRoot = resolve(this.artifactDir)
    const runDirectory = resolve(this.artifactDir, runId)
    const artifactRelative = relative(dataRoot, artifactRoot)
    const artifactComponents = artifactRelative.split(/[\\/]/).filter(Boolean)
    if (
      !artifactRelative || isAbsolute(artifactRelative) || artifactRelative === '..' ||
      artifactRelative.startsWith(`..${sep}`) || artifactComponents.some((component) => component === '.' || component === '..') ||
      resolve(dataRoot, ...artifactComponents) !== artifactRoot
    ) throw new StoreError(400, 'validation_failed', 'Artifact path is invalid.')
    const directories = [dataRoot]
    let currentDirectory = dataRoot
    for (const component of [...artifactComponents, runId]) {
      currentDirectory = join(currentDirectory, component)
      directories.push(currentDirectory)
    }
    if (resolve(currentDirectory) !== runDirectory) throw new StoreError(400, 'validation_failed', 'Artifact path is invalid.')
    const inspectDirectories = (allowMissing) => {
      for (const directory of directories) {
        let stat
        try {
          stat = lstatSync(directory)
        } catch (error) {
          if (allowMissing && error?.code === 'ENOENT') break
          throw new StoreError(404, 'not_found', 'Artifact was not found.')
        }
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new StoreError(400, 'validation_failed', 'Artifact path cannot be a link.')
      }
    }
    if (create) {
      // Validate every existing component before mkdir can follow a link.
      inspectDirectories(true)
      mkdirSync(this.artifactDir, { recursive: true, mode: 0o700 })
      mkdirSync(runDirectory, { recursive: true, mode: 0o700 })
    }
    for (const directory of directories) {
      let stat
      try { stat = lstatSync(directory) } catch { throw new StoreError(404, 'not_found', 'Artifact was not found.') }
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new StoreError(400, 'validation_failed', 'Artifact path cannot be a link.')
      try {
        const realDirectory = realpathSync(directory)
        const realParent = realpathSync(join(directory, '..'))
        if (resolve(realParent, basename(realDirectory)) !== realDirectory) throw new Error('realpath mismatch')
      } catch { throw new StoreError(400, 'validation_failed', 'Artifact path cannot be a link.') }
    }
    return runDirectory
  }

  verifyArtifactFile(path, expectedSize, reference) {
    let stat
    try { stat = lstatSync(path) } catch { throw new StoreError(404, 'not_found', 'Artifact was not found.') }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size !== expectedSize) {
      throw new StoreError(404, 'not_found', 'Artifact was not found.')
    }
    if (reference !== undefined && (stat.dev !== reference.dev || stat.ino !== reference.ino || stat.size !== reference.size)) {
      throw new StoreError(404, 'not_found', 'Artifact was not found.')
    }
    try {
      const realPath = realpathSync(path)
      const realParent = realpathSync(join(path, '..'))
      if (resolve(realParent, basename(realPath)) !== realPath) throw new Error('realpath mismatch')
    } catch { throw new StoreError(404, 'not_found', 'Artifact was not found.') }
    return stat
  }

  commitArtifactTemp(runId, leaseToken, metadata, temporary, observed) {
    try {
      return this.transaction(() => {
        const run = this.assertArtifactLease(runId, leaseToken)
        const existing = this.db.prepare('SELECT * FROM artifacts WHERE run_id=$run AND artifact_key=$key').get({ $run: runId, $key: metadata.artifactId })
        if (existing) {
          const existingPath = existing.path ?? existing.name
          if (
            asNumber(existing.size) !== metadata.size || existing.content_hash !== metadata.sha256 ||
            existing.name !== metadata.name || existingPath !== metadata.path || existing.mime_type !== metadata.mimeType
          ) throw new StoreError(409, 'artifact_conflict', 'Artifact id was reused with different metadata.')
          return {
            artifact: {
              id: existing.id, name: existing.name, path: existingPath, mimeType: existing.mime_type, size: asNumber(existing.size),
            },
            duplicate: true,
          }
        }

        const artifactId = randomUUID()
        const relativePath = join('artifacts', runId, `${metadata.artifactId}-${artifactId}.bin`)
        const target = resolve(this.dataDir, relativePath)
        const root = resolve(this.dataDir)
        if (!(target.startsWith(`${root}/`)) || target === root) throw new StoreError(400, 'validation_failed', 'Artifact path is invalid.')
        const temporaryStat = this.verifyArtifactFile(temporary, metadata.size, observed)
        if (lstatSync(target, { throwIfNoEntry: false }) !== undefined) throw new StoreError(409, 'artifact_conflict', 'Artifact storage path already exists.')
        renameSync(temporary, target)
        try {
          this.verifyArtifactFile(target, metadata.size, temporaryStat)
          const artifact = {
            id: artifactId, name: metadata.name, path: metadata.path, mimeType: metadata.mimeType, size: metadata.size,
          }
          this.db.prepare('INSERT INTO artifacts(id,run_id,chat_id,owner_id,artifact_key,name,path,mime_type,size,content_hash,relative_path,created_at) VALUES($id,$run,$chat,$owner,$key,$name,$displayPath,$mime,$size,$contentHash,$path,$created)').run({
            $id: artifactId, $run: runId, $chat: run.chat_id, $owner: run.owner_id, $key: metadata.artifactId, $name: metadata.name, $displayPath: metadata.path, $mime: metadata.mimeType, $size: metadata.size, $contentHash: metadata.sha256, $path: relativePath, $created: this.now(),
          })
          this.verifyArtifactFile(target, metadata.size, temporaryStat)
          this.appendServerEvent(runId, 'artifact.created', {
            path: metadata.path, name: metadata.name, mimeType: metadata.mimeType, artifact: { ...artifact },
          }, this.now(), metadata.artifactId)
          return { artifact, duplicate: false }
        } catch (error) {
          try { unlinkSync(target) } catch { /* best effort cleanup */ }
          throw error
        }
      })
    } finally {
      try { unlinkSync(temporary) } catch { /* already renamed or cleaned */ }
    }
  }

  uploadArtifact(runId, leaseToken, input) {
    this.sweepStaleRuns()
    if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new StoreError(400, 'validation_failed', 'Worker artifact is invalid.')
    const artifactId = input.artifactId
    if (typeof artifactId !== 'string' || !ARTIFACT_ID_PATTERN.test(artifactId)) throw new StoreError(400, 'validation_failed', 'Artifact id is invalid.')
    const name = ensureSafeName(input.name)
    const path = ensureSafeArtifactPath(input.path ?? input.relativePath, name)
    const mimeType = ensureMimeType(input.mimeType)
    if (
      typeof input.base64 !== 'string' ||
      input.base64.length > Math.ceil(MAX_LEGACY_BASE64_ARTIFACT_BYTES * 4 / 3) + 16 ||
      !isBase64(input.base64)
    ) throw new StoreError(400, 'validation_failed', 'Artifact contents are invalid.')
    const contents = Buffer.from(input.base64, 'base64')
    if (contents.byteLength > MAX_LEGACY_BASE64_ARTIFACT_BYTES) throw new StoreError(413, 'artifact_too_large', 'Legacy JSON artifacts are limited to 12 MiB.')
    const sha256 = hashText(contents)
    if (input.sha256 !== undefined && (typeof input.sha256 !== 'string' || input.sha256 !== sha256)) throw new StoreError(409, 'artifact_digest_mismatch', 'Artifact digest does not match its contents.')
    const runDirectory = this.artifactDirectory(runId)
    this.assertArtifactLease(runId, leaseToken)
    const temporary = join(runDirectory, `.upload-${randomUUID()}.tmp`)
    try {
      writeFileSync(temporary, contents, { mode: 0o600, flag: 'wx' })
      chmodSync(temporary, 0o600)
      const observed = this.verifyArtifactFile(temporary, contents.byteLength)
      return this.commitArtifactTemp(runId, leaseToken, { artifactId, name, path, mimeType, size: contents.byteLength, sha256 }, temporary, observed)
    } finally {
      try { unlinkSync(temporary) } catch { /* already renamed or cleaned */ }
    }
  }

  async uploadArtifactStream(runId, leaseToken, metadata, body, { signal } = {}) {
    this.sweepStaleRuns()
    const artifactId = metadata?.artifactId
    if (typeof artifactId !== 'string' || !ARTIFACT_ID_PATTERN.test(artifactId)) throw new StoreError(400, 'validation_failed', 'Artifact id is invalid.')
    const name = ensureSafeName(metadata.name)
    const path = ensureSafeArtifactPath(metadata.path, name)
    const mimeType = ensureMimeType(metadata.mimeType)
    const size = metadata.size
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ARTIFACT_BYTES) throw new StoreError(413, 'artifact_too_large', 'Artifact is too large.')
    const sha256 = metadata.sha256
    if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) throw new StoreError(400, 'validation_failed', 'Artifact digest is invalid.')
    const runDirectory = this.artifactDirectory(runId)
    this.assertArtifactLease(runId, leaseToken)
    const temporary = join(runDirectory, `.upload-${randomUUID()}.tmp`)
    let handle
    let observed
    const digest = createHash('sha256')
    let received = 0
    let lastLeaseCheck = 0
    try {
      try {
        handle = await open(temporary, 'wx', 0o600)
        await handle.chmod(0o600)
        const writeChunk = async (chunk) => {
          received += chunk.byteLength
          if (!Number.isSafeInteger(received) || received > size) throw new StoreError(400, 'artifact_size_mismatch', 'Artifact size does not match its metadata.')
          digest.update(chunk)
          let offset = 0
          while (offset < chunk.byteLength) {
            const result = await handle.write(chunk, offset, chunk.byteLength - offset)
            if (!result.bytesWritten) throw new StoreError(500, 'artifact_io_failed', 'Artifact upload failed.')
            offset += result.bytesWritten
          }
          const now = Date.now()
          if (now - lastLeaseCheck >= 250) {
            lastLeaseCheck = now
            this.sweepStaleRuns()
            this.assertArtifactLease(runId, leaseToken)
          }
        }
        try {
          for await (const chunk of body) {
            if (signal?.aborted) throw new StoreError(499, 'upload_aborted', 'Artifact upload was aborted.')
            if (!(chunk instanceof Uint8Array)) throw new StoreError(400, 'validation_failed', 'Artifact body is invalid.')
            await writeChunk(chunk)
          }
        } catch (error) {
          if (error instanceof StoreError) throw error
          throw new StoreError(400, 'validation_failed', 'Artifact upload failed.')
        }
        if (signal?.aborted) throw new StoreError(499, 'upload_aborted', 'Artifact upload was aborted.')
        await handle.sync()
        observed = await handle.stat()
        if (!observed.isFile() || observed.nlink !== 1 || observed.size !== size) throw new StoreError(400, 'artifact_size_mismatch', 'Artifact size does not match its metadata.')
        if (digest.digest('hex') !== sha256) throw new StoreError(409, 'artifact_digest_mismatch', 'Artifact digest does not match its contents.')
      } finally {
        await handle?.close().catch(() => undefined)
      }
      const finalObserved = this.verifyArtifactFile(temporary, size, observed)
      this.sweepStaleRuns()
      this.assertArtifactLease(runId, leaseToken)
      return this.commitArtifactTemp(runId, leaseToken, { artifactId, name, path, mimeType, size, sha256 }, temporary, finalObserved)
    } finally {
      try { unlinkSync(temporary) } catch { /* already renamed or cleaned */ }
    }
  }

  listArtifacts(ownerId, chatId, runId) {
    if (!runId) return []
    return this.db.prepare('SELECT id,name,path,mime_type,size FROM artifacts WHERE owner_id=$owner AND chat_id=$chat AND run_id=$run ORDER BY created_at ASC, rowid ASC').all({ $owner: ownerId, $chat: chatId, $run: runId }).map((artifact) => ({ id: artifact.id, name: artifact.name, path: artifact.path ?? artifact.name, mimeType: artifact.mime_type, size: asNumber(artifact.size) }))
  }

  readArtifact(ownerId, artifactId) {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id=$id AND owner_id=$owner').get({ $id: artifactId, $owner: ownerId })
    if (!row) throw new StoreError(404, 'not_found', 'Artifact was not found.')
    const target = resolve(this.dataDir, row.relative_path)
    const root = resolve(this.dataDir)
    const expectedSize = asNumber(row.size)
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > MAX_ARTIFACT_BYTES || !target.startsWith(`${root}/`)) throw new StoreError(404, 'not_found', 'Artifact was not found.')
    try { this.artifactDirectory(row.run_id, { create: false }) } catch { throw new StoreError(404, 'not_found', 'Artifact was not found.') }
    try {
      const realRoot = realpathSync(root)
      const realTarget = realpathSync(target)
      if (realTarget === realRoot || !realTarget.startsWith(`${realRoot}/`)) throw new Error('artifact outside data root')
    } catch { throw new StoreError(404, 'not_found', 'Artifact was not found.') }
    const initial = this.verifyArtifactFile(target, expectedSize)
    const expectedHash = typeof row.content_hash === 'string' && /^[a-f0-9]{64}$/.test(row.content_hash) ? row.content_hash : null
    const bytes = (async function* (store) {
      let handle
      const digest = createHash('sha256')
      try {
        handle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
        const opened = await handle.stat()
        if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== initial.dev || opened.ino !== initial.ino || opened.size !== expectedSize) throw new StoreError(404, 'not_found', 'Artifact was not found.')
        const openedMtime = opened.mtimeMs
        const openedCtime = opened.ctimeMs
        const chunk = Buffer.alloc(64 * 1024)
        let offset = 0
        let pending
        while (offset < expectedSize) {
          const result = await handle.read({ buffer: chunk, offset: 0, length: Math.min(chunk.byteLength, expectedSize - offset), position: offset })
          if (result.bytesRead <= 0) throw new StoreError(404, 'not_found', 'Artifact was not found.')
          offset += result.bytesRead
          const part = chunk.subarray(0, result.bytesRead)
          digest.update(part)
          if (pending !== undefined) yield pending
          pending = Buffer.from(part)
        }
        const beforeClose = await handle.stat()
        if (beforeClose.mtimeMs !== openedMtime || beforeClose.ctimeMs !== openedCtime) throw new StoreError(404, 'not_found', 'Artifact was not found.')
        if (expectedHash !== null && digest.digest('hex') !== expectedHash) throw new StoreError(404, 'not_found', 'Artifact was not found.')
        const final = store.verifyArtifactFile(target, expectedSize, initial)
        if (final.size !== expectedSize || final.mtimeMs !== openedMtime || final.ctimeMs !== openedCtime) throw new StoreError(404, 'not_found', 'Artifact was not found.')
        if (pending !== undefined) yield pending
      } catch (error) {
        if (error instanceof StoreError) throw error
        throw new StoreError(404, 'not_found', 'Artifact was not found.')
      } finally {
        await handle?.close().catch(() => undefined)
      }
    })(this)
    return { id: row.id, name: row.name, path: row.path ?? row.name, mimeType: row.mime_type, contentLength: expectedSize, bytes }
  }
}
