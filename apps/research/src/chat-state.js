export function restorePromptAfterAuth({ sendAfterLogin, prompt = '', savedDraft = '' }) {
  return sendAfterLogin && prompt.length > 0 ? prompt : savedDraft
}

export function cursorFromRun(run) {
  const values = [run?.after, run?.lastSequence, run?.sequence]
  const cursor = values.find(value => Number.isSafeInteger(value) && value >= 0)
  return cursor ?? 0
}

export function recoverableRun({ chatId, serverRun, pending }) {
  if (serverRun?.id) {
    return {
      chatId,
      id: String(serverRun.id),
      status: String(serverRun.status || '进行中'),
      clientRequestId: pending?.clientRequestId,
      message: pending?.message,
      after: cursorFromRun(serverRun),
      inFlight: false,
    }
  }
  if (pending?.clientRequestId && pending.message) {
    return {
      chatId,
      id: null,
      status: 'pending',
      clientRequestId: pending.clientRequestId,
      message: pending.message,
      after: 0,
      inFlight: false,
    }
  }
  return null
}

export function hasSubmittedPair(messages, message) {
  const assistant = messages?.at(-1)
  const user = messages?.at(-2)
  return Boolean(user?.role === 'user' && user.text === message && assistant?.role === 'assistant')
}

export function canStartSubmission({ activeRun, submitInFlight }) {
  return !activeRun && !submitInFlight
}
