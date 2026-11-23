import assert from 'node:assert/strict'
import test from 'node:test'

import { canStartSubmission, cursorFromRun, hasSubmittedPair, recoverableRun, restorePromptAfterAuth } from './chat-state.js'

test('keeps the typed prompt when authentication completes', () => {
  assert.equal(restorePromptAfterAuth({ sendAfterLogin: true, prompt: '分析氧空位', savedDraft: '' }), '分析氧空位')
  assert.equal(restorePromptAfterAuth({ sendAfterLogin: false, prompt: '旧输入', savedDraft: '服务器草稿' }), '服务器草稿')
})

test('resumes an active server run from its persisted event cursor', () => {
  const run = recoverableRun({
    chatId: 'chat_01',
    serverRun: { id: 'run_01', status: 'running', after: 17 },
    pending: { clientRequestId: 'request_01', message: '继续分析' },
  })
  assert.equal(run.id, 'run_01')
  assert.equal(run.after, 17)
  assert.equal(cursorFromRun({ lastSequence: 9 }), 9)
})

test('turns an unconfirmed local request into a recoverable run', () => {
  const run = recoverableRun({
    chatId: 'chat_01',
    serverRun: null,
    pending: { clientRequestId: 'request_01', message: '恢复提交' },
  })
  assert.deepEqual(run, {
    chatId: 'chat_01', id: null, status: 'pending', clientRequestId: 'request_01',
    message: '恢复提交', after: 0, inFlight: false,
  })
})

test('does not append a second message pair when reconciling a submitted request', () => {
  assert.equal(hasSubmittedPair([
    { role: 'user', text: '分析介质层' },
    { role: 'assistant', text: '已开始', status: '正在回答' },
  ], '分析介质层'), true)
  assert.equal(hasSubmittedPair([{ role: 'user', text: '分析介质层' }], '分析介质层'), false)
})

test('blocks a second submission while chat creation or run submission is awaiting a response', () => {
  assert.equal(canStartSubmission({ activeRun: null, submitInFlight: false }), true)
  assert.equal(canStartSubmission({ activeRun: null, submitInFlight: true }), false)
  assert.equal(canStartSubmission({ activeRun: { id: null }, submitInFlight: false }), false)
})
