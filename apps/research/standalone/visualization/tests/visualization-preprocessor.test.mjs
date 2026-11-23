import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  SERVER_ARTIFACT_VISUALIZATION_SOURCE_MAX_BYTES,
                                           
} from '../scientific-visualization.mjs'

import {
  VisualizationMalformedError,
  VisualizationPreprocessor,
  VisualizationPreprocessorError,
  VisualizationTooLargeError,
  VisualizationUnsupportedError,
                            
                            
                           
                                   
} from '../visualization-preprocessor.mjs'
import { VisualizationCache } from '../visualization-cache.mjs'
import { TEXT_TRAJECTORY_VISUALIZATION_ADAPTERS } from '../trajectory-adapters.mjs'

const encoder = new TextEncoder()
const sourceBytes = encoder.encode('1 2 3\n')

function trajectoryManifest(source                             , id = 'coordinates')                                      {
  return {
    version: 1,
    source: {
      runId: source.runId,
      sequence: source.sequence,
      name: source.name,
      mimeType: source.mimeType,
    },
    resources: [{
      id,
      role: 'trajectory.coordinates',
      mimeType: 'application/vnd.zeus.f32',
      byteLength: 4,
    }],
    kind: 'trajectory',
    format: 'extxyz',
    atomCount: 1,
    frameCount: 1,
    elements: ['Si'],
    periodic: false,
    timeUnit: 'frame',
    timeStep: 1,
  }
}

function resource(id = 'coordinates')                       {
  return {
    descriptor: {
      id,
      role: 'trajectory.coordinates',
      mimeType: 'application/vnd.zeus.f32',
      byteLength: 4,
    },
    bytes: new Uint8Array([0, 1, 2, 3]),
  }
}

function source(overrides                               = {})                      {
  return {
    runId: 'run_1',
    sequence: 7,
    name: 'result.extxyz',
    mimeType: 'chemical/x-extxyz',
    contentLength: sourceBytes.byteLength,
    bytes: (async function* () { yield sourceBytes })(),
    ...overrides,
  }
}

function iterableWithReturn(chunks                       , onReturn            )                            {
  return {
    [Symbol.asyncIterator]() {
      let index = 0
      return {
        async next() {
          const value = chunks[index++]
          return value === undefined ? { done: true         , value: undefined } : { done: false         , value }
        },
        async return() {
          onReturn()
          return { done: true         , value: undefined }
        },
      }
    },
  }
}

function adapter(overrides                                = {})                       {
  return {
    id: 'extxyz',
    version: '1',
    match: () => true,
    async prepare(input, metadata) {
      assert.deepEqual(input, sourceBytes)
      return { manifest: trajectoryManifest(metadata ), resources: [resource()] }
    },
    ...overrides,
  }
}

test('selects exactly by adapter name and MIME and copies trusted source metadata', async () => {
  const seen                                                                               = []
  const selected = adapter({
    match: (input) => input.name === 'result.extxyz' && input.mimeType === 'chemical/x-extxyz',
    async prepare(bytes, metadata) {
      assert.deepEqual(bytes, sourceBytes)
      seen.push(metadata )
      return { manifest: trajectoryManifest(metadata ), resources: [resource()] }
    },
  })
  const preprocessor = new VisualizationPreprocessor({ adapters: [selected] })
  const result = await preprocessor.prepare(source())
  assert.equal(result.state, 'ready')
  assert.deepEqual(seen, [{ runId: 'run_1', sequence: 7, name: 'result.extxyz', mimeType: 'chemical/x-extxyz' }])
  assert.deepEqual(result.manifest.source, {
    runId: 'run_1', sequence: 7, name: 'result.extxyz', mimeType: 'chemical/x-extxyz',
  })
  assert.equal(result.manifest.resources[0]?.byteLength, 4)
})

test('serializes source preparation and removes an aborted queued request', async () => {
  let active = 0
  let maximum = 0
  let firstStartedResolve
  const firstStarted = new Promise((resolve) => { firstStartedResolve = resolve })
  let releaseFirst
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  const preprocessor = new VisualizationPreprocessor({ adapters: [adapter({
    async prepare(input, metadata) {
      active += 1
      maximum = Math.max(maximum, active)
      if (metadata.runId === 'first') {
        firstStartedResolve()
        await firstGate
      }
      active -= 1
      return { manifest: trajectoryManifest(metadata), resources: [resource()] }
    },
  })] })

  const first = preprocessor.prepare(source({ runId: 'first' }))
  await firstStarted
  const controller = new AbortController()
  const queued = preprocessor.prepare(source({ runId: 'second', signal: controller.signal }))
  controller.abort()
  assert.deepEqual(await queued, { state: 'unsupported', reason: 'malformed' })
  releaseFirst()
  assert.equal((await first).state, 'ready')
  assert.equal(maximum, 1)
})

test('rejects extension spoofing and reports unsupported format without invoking adapter', async () => {
  let invoked = false
  const preprocessor = new VisualizationPreprocessor({ adapters: [adapter({
    match: (input) => input.name.endsWith('.extxyz') && input.mimeType === 'chemical/x-extxyz',
    async prepare() { invoked = true; return { manifest: trajectoryManifest(source()), resources: [resource()] } },
  })] })
  const result = await preprocessor.prepare(source({ name: 'result.xyz', mimeType: 'application/octet-stream' }))
  assert.deepEqual(result, { state: 'unsupported', reason: 'unsupported_format' })
  assert.equal(invoked, false)
})

test('rejects zero and multiple adapter matches deterministically', async () => {
  const none = new VisualizationPreprocessor({ adapters: [adapter({ match: () => false })] })
  assert.deepEqual(await none.prepare(source()), { state: 'unsupported', reason: 'unsupported_format' })
  const many = new VisualizationPreprocessor({ adapters: [adapter(), adapter({ id: 'second' })] })
  await assert.rejects(() => many.prepare(source()), /multiple visualization adapters/i)
})

test('rejects declared oversize before obtaining the byte iterator', async () => {
  let iterated = false
  const bytes = {
    async *[Symbol.asyncIterator]() { iterated = true; yield sourceBytes },
  }
  const preprocessor = new VisualizationPreprocessor({ adapters: [adapter()] })
  const result = await preprocessor.prepare(source({
    contentLength: SERVER_ARTIFACT_VISUALIZATION_SOURCE_MAX_BYTES + 1,
    bytes,
  }))
  assert.deepEqual(result, { state: 'unsupported', reason: 'too_large' })
  assert.equal(iterated, false)
})

test('enforces streamed cap plus one and calls iterator return on overflow', async () => {
  let returned = false
  const bytes = iterableWithReturn([
    new Uint8Array(SERVER_ARTIFACT_VISUALIZATION_SOURCE_MAX_BYTES),
    new Uint8Array([1]),
  ], () => { returned = true })
  const preprocessor = new VisualizationPreprocessor({ adapters: [adapter()] })
  const result = await preprocessor.prepare(source({
    contentLength: SERVER_ARTIFACT_VISUALIZATION_SOURCE_MAX_BYTES,
    bytes,
  }))
  assert.deepEqual(result, { state: 'unsupported', reason: 'too_large' })
  assert.equal(returned, true)
})

test('rejects declared and actual length mismatch and closes the iterator', async () => {
  let returned = false
  const bytes = iterableWithReturn([sourceBytes], () => { returned = true })
  const preprocessor = new VisualizationPreprocessor({ adapters: [adapter()] })
  const result = await preprocessor.prepare(source({ contentLength: sourceBytes.byteLength + 1, bytes }))
  assert.deepEqual(result, { state: 'unsupported', reason: 'malformed' })
  assert.equal(returned, true)
})

test('closes the source iterator when an adapter throws an explicit error', async () => {
  let returned = false
  const bytes = iterableWithReturn([sourceBytes], () => { returned = true })
  const preprocessor = new VisualizationPreprocessor({ adapters: [adapter({
    async prepare() { throw new VisualizationMalformedError() },
  })] })
  const result = await preprocessor.prepare(source({ bytes }))
  assert.deepEqual(result, { state: 'unsupported', reason: 'malformed' })
  assert.equal(returned, true)
})

test('re-parses and rejects malformed/coercive adapter manifests', async () => {
  for (const manifest of [
    { ...trajectoryManifest(source()), resources: [] },
    Object.assign(Object.create({ inherited: true }), trajectoryManifest(source())),
    { ...trajectoryManifest(source()), resources: [{ ...resource().descriptor, byteLength: '4' }] },
  ]) {
    const preprocessor = new VisualizationPreprocessor({ adapters: [adapter({
      async prepare() { return { manifest: manifest                                       , resources: [resource()] } },
    })] })
    const result = await preprocessor.prepare(source())
    assert.deepEqual(result, { state: 'unsupported', reason: 'malformed' })
  }
})

test('rejects duplicate, missing, extra, and descriptor-mismatched resources', async () => {
  const cases                                                                       = [
    { resources: [resource(), resource()] },
    { resources: [] },
    { resources: [resource(), resource('extra')] },
    { resources: [{ ...resource(), descriptor: { ...resource().descriptor, byteLength: 3 } }] },
    { resources: [{ ...resource(), descriptor: { ...resource().descriptor, mimeType: 'application/json' } }] },
  ]
  for (const patch of cases) {
    const preprocessor = new VisualizationPreprocessor({ adapters: [adapter({
      async prepare() { return { manifest: trajectoryManifest(source()), resources: patch.resources ?? [] } },
    })] })
    const result = await preprocessor.prepare(source())
    assert.deepEqual(result, { state: 'unsupported', reason: 'malformed' })
  }
})

test('classifies only explicit too-large adapter errors', async () => {
  const preprocessor = new VisualizationPreprocessor({ adapters: [adapter({
    async prepare() { throw new VisualizationTooLargeError() },
  })] })
  assert.deepEqual(await preprocessor.prepare(source()), { state: 'unsupported', reason: 'too_large' })
})

test('preserves closed adapter errors when preprocessing through the cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeus-visualization-preprocessor-cache-'))
  try {
    const preprocessor = new VisualizationPreprocessor({
      adapters: [adapter({ async prepare() { throw new VisualizationMalformedError() } })],
      cache: new VisualizationCache({ stateRoot: root }),
    })
    assert.deepEqual(await preprocessor.prepare(source()), { state: 'unsupported', reason: 'malformed' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('preserves EXTXYZ physical frame times through canonical preprocessing and cache hits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeus-visualization-physical-time-cache-'))
  const text = [
    '1',
    'Properties=species:S:1:pos:R:3 Time=0 time_unit=ps time_start_ps=0.0 time_end_ps=1.0 time_unit=ps',
    'C 0 0 0',
    '1',
    'Properties=species:S:1:pos:R:3 Time=1 time_unit=ps time_start_ps=0.0 time_end_ps=1.0 time_unit=ps',
    'C 1 0 0',
  ].join('\n')
  const bytes = encoder.encode(text)
  const makeSource = ()                      => source({
    name: 'exported_preview0.extxyz',
    mimeType: 'chemical/x-xyz',
    contentLength: bytes.byteLength,
    bytes: (async function* () { yield bytes })(),
  })
  try {
    const preprocessor = new VisualizationPreprocessor({
      adapters: TEXT_TRAJECTORY_VISUALIZATION_ADAPTERS,
      cache: new VisualizationCache({ stateRoot: root }),
    })
    const first = await preprocessor.prepare(makeSource())
    const second = await preprocessor.prepare(makeSource())
    for (const result of [first, second]) {
      assert.equal(result.state, 'ready')
      if (result.state === 'ready' && result.manifest.kind === 'trajectory') {
        assert.equal(result.manifest.timeUnit, 'ps')
        assert.deepEqual(result.manifest.frameTimes, [0, 1])
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('classifies explicit unsupported adapter errors without exposing adapter text', async () => {
  const preprocessor = new VisualizationPreprocessor({ adapters: [adapter({
    async prepare() { throw new VisualizationUnsupportedError() },
  })] })
  assert.deepEqual(await preprocessor.prepare(source()), { state: 'unsupported', reason: 'unsupported_format' })
})

test('snapshots and freezes adapter identity/methods and prevents cache-key mutation', async () => {
  let prepares = 0
  const mutable = {
    id: 'extxyz',
    version: '1',
    match: () => true,
    async prepare(input            , metadata                              ) {
      prepares += 1
      return { manifest: trajectoryManifest(metadata ), resources: [resource()] }
    },
  }
  const preprocessor = new VisualizationPreprocessor({ adapters: [mutable] })
  const before = await preprocessor.prepare(source())
  assert.equal(before.state, 'ready')
  const internal = preprocessor                                              
  assert.equal(Object.isFrozen(internal.adapters), true)
  assert.equal(Object.isFrozen(internal.adapters[0]), true)
  mutable.id = 'changed'
  mutable.version = '2'
  mutable.match = () => false
  mutable.prepare = async () => { throw new Error('mutated prepare should not run') }
  const after = await preprocessor.prepare(source())
  assert.equal(after.state, 'ready')
  assert.equal(prepares, 2)
  if (before.state === 'ready' && after.state === 'ready') assert.equal(before.cacheKey, after.cacheKey)
})

test('adapter match receives only a frozen name/MIME view', async () => {
  let received                                     
  const preprocessor = new VisualizationPreprocessor({ adapters: [adapter({
    match(input) {
      received = input                           
      return true
    },
  })] })
  const result = await preprocessor.prepare(source())
  assert.equal(result.state, 'ready')
  assert.deepEqual(Object.keys(received ?? {}).sort(), ['mimeType', 'name'])
  assert.equal(Object.isFrozen(received), true)
})

test('unknown source iterator errors are sanitized internal errors, not malformed responses', async () => {
  const preprocessor = new VisualizationPreprocessor({ adapters: [adapter()] })
  const secret = 'source bytes /private/secret/path'
  const bytes = {
    [Symbol.asyncIterator]() {
      return {
        async next() { throw new Error(secret) },
        async return() { return { done: true         , value: undefined } },
      }
    },
  }
  await assert.rejects(
    () => preprocessor.prepare(source({ bytes })),
    (error         ) => error instanceof VisualizationPreprocessorError &&
      error.message !== secret && !error.message.includes('/private/secret/path'),
  )
})

test('abort waits for the unique deferred iterator return promise before resolving', async () => {
  const controller = new AbortController()
  let release             
  let returnStarted = false
  let returnCalls = 0
  let nextCalls = 0
  const returnGate = new Promise      ((resolve) => { release = resolve })
  const bytes = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          nextCalls += 1
          if (nextCalls === 1) return { done: false         , value: sourceBytes }
          return new Promise                            (() => {})
        },
        async return() {
          returnCalls += 1
          returnStarted = true
          await returnGate
          return { done: true         , value: undefined }
        },
      }
    },
  }
  const preprocessor = new VisualizationPreprocessor({ adapters: [adapter()] })
  let settled = false
  const pending = preprocessor.prepare(source({ bytes, signal: controller.signal })).then(() => { settled = true })
  await new Promise((resolve) => setTimeout(resolve, 5))
  controller.abort()
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(returnStarted, true)
  assert.equal(returnCalls, 1)
  assert.equal(settled, false)
  release()
  await pending
})

test('opens only an exact ready resource and clones no-cache bytes', async () => {
  const preprocessor = new VisualizationPreprocessor({ adapters: [adapter()] })
  const prepared = await preprocessor.prepare(source())
  assert.equal(prepared.state, 'ready')
  const seam = preprocessor                
                                                                           
                                                                      
                                      
      
   
  const opened = await seam.openPreparedResource(prepared, 'coordinates')
  assert.equal(opened.descriptor.id, 'coordinates')
  assert.equal(opened.descriptor.byteLength, 4)
  const first = (await opened.bytes[Symbol.asyncIterator]().next()).value
  assert.deepEqual(first, new Uint8Array([0, 1, 2, 3]))
  await assert.rejects(
    () => seam.openPreparedResource(prepared, 'missing'),
    /visualization/i,
  )
  await assert.rejects(
    () => seam.openPreparedResource({
      state: 'ready',
      manifest: prepared.manifest,
      cacheKey: prepared.cacheKey,
      resources: [{ descriptor: resource('coordinates').descriptor, bytes: new Uint8Array([1, 2, 3, 4]) }],
    }, 'coordinates'),
    /visualization/i,
  )
})
