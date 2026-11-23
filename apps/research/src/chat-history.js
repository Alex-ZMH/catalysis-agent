const STORAGE_PREFIX = 'mlcc-studio:client-state:v2:'
const MAX_STORAGE_BYTES = 1_048_576
const MAX_OWNER_LENGTH = 180
const MAX_CHAT_ID_LENGTH = 180
const MAX_REQUEST_ID_LENGTH = 180
const MAX_DRAFT_LENGTH = 19_000
const ID_PATTERN = /^[A-Za-z0-9_-]+$/

function byteLength(value) {
  return typeof TextEncoder === 'function'
    ? new TextEncoder().encode(value).byteLength
    : value.length
}

function scopedKey(value, maxLength) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || !ID_PATTERN.test(value)) return undefined
  return value
}

function ownerKey(ownerId) {
  const owner = scopedKey(ownerId, MAX_OWNER_LENGTH)
  return owner === undefined ? undefined : `${STORAGE_PREFIX}${encodeURIComponent(owner)}`
}

function storageMethod(storage, name) {
  return storage !== null && storage !== undefined && typeof storage[name] === 'function'
    ? storage[name].bind(storage)
    : undefined
}

function emptyRecord() {
  return { drafts: Object.create(null), pending: Object.create(null) }
}

function readRecord(getItem, key) {
  if (getItem === undefined || key === undefined) return emptyRecord()
  let raw
  try { raw = getItem(key) } catch { return emptyRecord() }
  if (typeof raw !== 'string' || raw.length === 0 || byteLength(raw) > MAX_STORAGE_BYTES) return emptyRecord()

  let value
  try { value = JSON.parse(raw) } catch { return emptyRecord() }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return emptyRecord()

  const record = emptyRecord()
  if (value.drafts !== null && typeof value.drafts === 'object' && !Array.isArray(value.drafts)) {
    for (const [chatId, draft] of Object.entries(value.drafts)) {
      if (scopedKey(chatId, MAX_CHAT_ID_LENGTH) !== undefined && typeof draft === 'string' && draft.length <= MAX_DRAFT_LENGTH) {
        record.drafts[chatId] = draft
      }
    }
  }
  if (value.pending !== null && typeof value.pending === 'object' && !Array.isArray(value.pending)) {
    for (const [chatId, candidate] of Object.entries(value.pending)) {
      if (scopedKey(chatId, MAX_CHAT_ID_LENGTH) === undefined || candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue
      const clientRequestId = scopedKey(candidate.clientRequestId, MAX_REQUEST_ID_LENGTH)
      const message = typeof candidate.message === 'string' && candidate.message.length > 0 && candidate.message.length <= MAX_DRAFT_LENGTH
        ? candidate.message
        : undefined
      if (clientRequestId !== undefined && message !== undefined) record.pending[chatId] = { clientRequestId, message }
    }
  }
  return record
}

function writeRecord(setItem, key, record) {
  if (setItem === undefined || key === undefined) return false
  const serialized = JSON.stringify(record)
  if (byteLength(serialized) > MAX_STORAGE_BYTES) return false
  try {
    setItem(key, serialized)
    return true
  } catch {
    return false
  }
}

/**
 * Keep only client-side recovery hints. Conversations, messages, runs, and
 * artifacts always come from the independent MLCC server API.
 */
export function createChatHistory(storage) {
  const getItem = storageMethod(storage, 'getItem')
  const setItem = storageMethod(storage, 'setItem')
  const removeItem = storageMethod(storage, 'removeItem')

  function update(ownerId, update) {
    const key = ownerKey(ownerId)
    if (key === undefined || setItem === undefined) return false
    const record = readRecord(getItem, key)
    update(record)
    return writeRecord(setItem, key, record)
  }

  function loadDraft(ownerId, chatId) {
    const key = ownerKey(ownerId)
    const id = scopedKey(chatId, MAX_CHAT_ID_LENGTH)
    if (key === undefined || id === undefined) return ''
    return readRecord(getItem, key).drafts[id] ?? ''
  }

  function saveDraft(ownerId, chatId, draft) {
    const id = scopedKey(chatId, MAX_CHAT_ID_LENGTH)
    if (id === undefined || typeof draft !== 'string' || draft.length > MAX_DRAFT_LENGTH) return false
    return update(ownerId, (record) => {
      if (draft.length === 0) delete record.drafts[id]
      else record.drafts[id] = draft
    })
  }

  function loadPending(ownerId, chatId) {
    const key = ownerKey(ownerId)
    const id = scopedKey(chatId, MAX_CHAT_ID_LENGTH)
    if (key === undefined || id === undefined) return null
    const pending = readRecord(getItem, key).pending[id]
    return pending ? { ...pending } : null
  }

  function savePending(ownerId, chatId, value) {
    const id = scopedKey(chatId, MAX_CHAT_ID_LENGTH)
    const clientRequestId = scopedKey(value?.clientRequestId, MAX_REQUEST_ID_LENGTH)
    const message = value?.message
    if (id === undefined || clientRequestId === undefined || typeof message !== 'string' || message.length === 0 || message.length > MAX_DRAFT_LENGTH) return false
    return update(ownerId, (record) => {
      record.pending[id] = { clientRequestId, message }
    })
  }

  function clearDraft(ownerId, chatId) {
    const id = scopedKey(chatId, MAX_CHAT_ID_LENGTH)
    if (id === undefined) return false
    return update(ownerId, (record) => { delete record.drafts[id] })
  }

  function moveDraft(ownerId, fromChatId, toChatId) {
    const from = scopedKey(fromChatId, MAX_CHAT_ID_LENGTH)
    const to = scopedKey(toChatId, MAX_CHAT_ID_LENGTH)
    if (from === undefined || to === undefined) return false
    if (from === to) return true
    return update(ownerId, record => {
      if (typeof record.drafts[from] === 'string') record.drafts[to] = record.drafts[from]
      delete record.drafts[from]
    })
  }

  function clearPending(ownerId, chatId) {
    const id = scopedKey(chatId, MAX_CHAT_ID_LENGTH)
    if (id === undefined) return false
    return update(ownerId, (record) => { delete record.pending[id] })
  }

  function clear(ownerId) {
    const key = ownerKey(ownerId)
    if (key === undefined || removeItem === undefined) return false
    try {
      removeItem(key)
      return true
    } catch {
      return false
    }
  }

  return { loadDraft, saveDraft, moveDraft, loadPending, savePending, clearDraft, clearPending, clear }
}
