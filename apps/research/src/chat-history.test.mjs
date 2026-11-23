import assert from 'node:assert/strict'
import test from 'node:test'

import { createChatHistory } from './chat-history.js'

class MemoryStorage {
  constructor() {
    this.values = new Map()
    this.calls = []
    this.fail = new Set()
  }

  getItem(key) {
    this.calls.push(['getItem', key])
    if (this.fail.has('getItem')) throw new Error('read blocked')
    return this.values.get(key) ?? null
  }

  setItem(key, value) {
    this.calls.push(['setItem', key, value])
    if (this.fail.has('setItem')) throw new Error('quota exceeded')
    this.values.set(key, String(value))
  }

  removeItem(key) {
    this.calls.push(['removeItem', key])
    if (this.fail.has('removeItem')) throw new Error('write blocked')
    this.values.delete(key)
  }
}

test('creating a server chat moves its unsent draft so refresh does not resurrect a sent question', () => {
  const storage = new MemoryStorage()
  const history = createChatHistory(storage)
  history.saveDraft('user_a', 'new', '读取操作目录')
  history.saveDraft('user_b', 'new', '另一个账号的草稿')
  history.moveDraft('user_a', 'new', 'chat_created')
  assert.equal(history.loadDraft('user_a', 'new'), '')
  assert.equal(history.loadDraft('user_a', 'chat_created'), '读取操作目录')
  history.clearDraft('user_a', 'chat_created')
  const reloaded = createChatHistory(storage)
  assert.equal(reloaded.loadDraft('user_a', 'new'), '')
  assert.equal(reloaded.loadDraft('user_a', 'chat_created'), '')
  assert.equal(reloaded.loadDraft('user_b', 'new'), '另一个账号的草稿')
})

test('stores drafts and unconfirmed requests per independent owner and chat', () => {
  const storage = new MemoryStorage()
  const history = createChatHistory(storage)

  assert.equal(history.saveDraft('user_a', 'chat_01', '补充边界条件'), true)
  assert.equal(history.savePending('user_a', 'chat_01', {
    clientRequestId: 'request_01',
    message: '运行介电层研究',
  }), true)
  assert.equal(history.loadDraft('user_a', 'chat_01'), '补充边界条件')
  assert.deepEqual(history.loadPending('user_a', 'chat_01'), {
    clientRequestId: 'request_01',
    message: '运行介电层研究',
  })

  assert.equal(history.loadDraft('user_b', 'chat_01'), '')
  assert.equal(history.loadPending('user_b', 'chat_01'), null)
  assert.equal(history.loadDraft('user_a', 'chat_02'), '')
  assert.equal(history.loadPending('user_a', 'chat_02'), null)
})

test('does not expose a browser chat transcript API or persist server messages', () => {
  const storage = new MemoryStorage()
  const history = createChatHistory(storage)

  assert.equal('load' in history, false)
  assert.equal('save' in history, false)
  assert.equal(history.saveDraft('user_a', 'chat_01', '草稿'), true)

  const raw = [...storage.values.values()].join('\n')
  assert.match(raw, /草稿/)
  assert.doesNotMatch(raw, /assistant|serverMessage|accessToken|password|cookie/i)
})

test('sanitizes malformed pending data and bounds draft/request sizes', () => {
  const storage = new MemoryStorage()
  const history = createChatHistory(storage)

  assert.equal(history.saveDraft('', 'chat_01', 'x'), false)
  assert.equal(history.saveDraft('user_a', '', 'x'), false)
  assert.equal(history.saveDraft('user_a', 'chat_01', 'x'.repeat(19_001)), false)
  assert.equal(history.savePending('user_a', 'chat_01', { clientRequestId: 'bad id', message: 'x' }), false)
  assert.equal(history.savePending('user_a', 'chat_01', { clientRequestId: 'request_01', message: '' }), false)
  assert.equal(history.savePending('user_a', 'chat_01', {
    clientRequestId: 'request_01',
    message: 'x'.repeat(19_001),
  }), false)
  assert.equal(history.loadPending('user_a', 'chat_01'), null)
})

test('clear removes only local state for the selected user', () => {
  const storage = new MemoryStorage()
  const history = createChatHistory(storage)
  history.saveDraft('user_a', 'chat_01', 'a')
  history.savePending('user_a', 'chat_01', { clientRequestId: 'request_a', message: 'a' })
  history.saveDraft('user_b', 'chat_01', 'b')
  history.savePending('user_b', 'chat_01', { clientRequestId: 'request_b', message: 'b' })

  assert.equal(history.clear('user_a'), true)
  assert.equal(history.loadDraft('user_a', 'chat_01'), '')
  assert.equal(history.loadPending('user_a', 'chat_01'), null)
  assert.equal(history.loadDraft('user_b', 'chat_01'), 'b')
  assert.deepEqual(history.loadPending('user_b', 'chat_01'), {
    clientRequestId: 'request_b',
    message: 'b',
  })
})

test('storage failures never turn local drafts into a source of truth', () => {
  const storage = new MemoryStorage()
  const history = createChatHistory(storage)
  assert.equal(history.saveDraft('user_a', 'chat_01', 'before failure'), true)

  storage.fail.add('setItem')
  assert.equal(history.saveDraft('user_a', 'chat_01', 'after failure'), false)
  storage.fail.delete('setItem')
  storage.fail.add('getItem')
  assert.equal(history.loadDraft('user_a', 'chat_01'), '')
  assert.equal(history.loadPending('user_a', 'chat_01'), null)
  storage.fail.delete('getItem')
  storage.fail.add('removeItem')
  assert.equal(history.clear('user_a'), false)
})
