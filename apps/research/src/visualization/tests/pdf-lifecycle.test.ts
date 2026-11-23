import assert from 'node:assert/strict'
import test from 'node:test'

import { destroyPdfLoadingTask } from '../preview-utils.mjs'

test('tears down the PDF.js loading task and tolerates a document proxy without destroy', async () => {
  let destroyCalls = 0
  const task = {
    destroy() {
      destroyCalls += 1
      return Promise.resolve()
    },
  }
  // PDFDocumentProxy in pdfjs-dist 6.5.438 exposes no destroy method.
  const documentProxy = { numPages: 1 }

  destroyPdfLoadingTask(task)
  destroyPdfLoadingTask(documentProxy)
  destroyPdfLoadingTask(null)
  await new Promise<void>((resolve) => setTimeout(resolve, 0))

  assert.equal(destroyCalls, 1)
  assert.equal('destroy' in documentProxy, false)
})

test('swallows loading-task cleanup failures during pane close', () => {
  assert.doesNotThrow(() => destroyPdfLoadingTask({
    destroy() {
      throw new Error('worker already closed')
    },
  }))
  assert.doesNotThrow(() => destroyPdfLoadingTask({
    destroy() {
      return Promise.reject(new Error('worker already closed'))
    },
  }))
})
