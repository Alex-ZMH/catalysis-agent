import assert from 'node:assert/strict'
import test from 'node:test'

import * as shared from '../scientific-visualization.mjs'

const parseResponse = (shared                
                                                                        
 ).parseServerArtifactVisualizationResponse

const parseResourceId = (shared                
                                                                          
 ).parseServerArtifactVisualizationResourceId

const coordinates = {
  id: 'coordinates_1',
  role: 'trajectory.coordinates',
  mimeType: 'application/vnd.zeus.f32',
  byteLength: 96,
}         

const cells = {
  id: 'cells_1',
  role: 'trajectory.cells',
  mimeType: 'application/vnd.zeus.f32',
  byteLength: 48,
}         

const trajectoryPreview = {
  id: 'preview_gif',
  role: 'trajectory.preview',
  mimeType: 'image/gif',
  byteLength: 4096,
}         

const volumeValues = {
  id: 'density_1',
  role: 'volume.values',
  mimeType: 'application/vnd.zeus.f64',
  byteLength: 512,
}         

const plotValues = {
  id: 'plot_1',
  role: 'plot.values',
  mimeType: 'application/json',
  byteLength: 256,
}         

const source = {
  runId: 'run_1',
  sequence: 7,
  name: 'results.extxyz',
  mimeType: 'chemical/x-extxyz',
}         

function trajectoryManifest() {
  return {
    version: 1,
    source,
    resources: [coordinates, cells],
    kind: 'trajectory',
    format: 'extxyz',
    atomCount: 2,
    frameCount: 3,
    elements: ['Si', 'O'],
    periodic: true,
    timeUnit: 'fs',
    timeStep: 0.5,
  }         
}

function volumeManifest() {
  return {
    version: 1,
    source: { ...source, name: 'density.cube', mimeType: 'chemical/x-cube' },
    resources: [volumeValues],
    kind: 'volume',
    format: 'cube',
    dimensions: [2, 2, 2]         ,
    origin: [0, 0.25, -1.5]         ,
    axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]]         ,
    channels: [{
      id: 'charge',
      label: 'Charge density',
      minimum: -1.25,
      maximum: 2.5,
      resourceId: volumeValues.id,
    }],
  }         
}

function bandManifest() {
  return {
    version: 1,
    source: { ...source, name: 'EIGENVAL', mimeType: 'text/plain' },
    resources: [plotValues],
    kind: 'band',
    format: 'vasp-eigenval',
    spinChannels: 2,
    bands: 4,
    kpoints: 5,
    fermiEnergy: null,
    resourceId: plotValues.id,
  }         
}

function dosManifest() {
  return {
    version: 1,
    source: { ...source, name: 'DOSCAR', mimeType: 'text/plain' },
    resources: [plotValues],
    kind: 'dos',
    format: 'vasp-doscar',
    spinChannels: 1,
    points: 128,
    fermiEnergy: 5.25,
    resourceId: plotValues.id,
  }         
}

test('exposes the visualization parsers', () => {
  assert.equal(typeof parseResponse, 'function')
  assert.equal(typeof parseResourceId, 'function')
})
test('accepts one valid manifest for every supported visualization kind', () => {
  for (const manifest of [trajectoryManifest(), volumeManifest(), bandManifest(), dosManifest()]) {
    const parsed = parseResponse?.({ state: 'ready', manifest })                           
    assert.equal(parsed.state, 'ready')
    assert.deepEqual(parsed.manifest, manifest)
    assert.equal(Object.isFrozen(parsed), true)
    assert.equal(Object.isFrozen(parsed.manifest), true)
  }
})

test('accepts one optional GIF preview for a trajectory manifest', () => {
  const manifest = {
    ...trajectoryManifest(),
    resources: [coordinates, cells, trajectoryPreview],
  }
  const parsed = parseResponse?.({ state: 'ready', manifest })                                                   
  assert.deepEqual(parsed.manifest.resources, manifest.resources)
})

test('accepts and preserves an optional bounded physical frame-time sequence', () => {
  const timed = {
    ...trajectoryManifest(),
    timeUnit: 'ps'         ,
    frameTimes: [0.25, 1.75, 4.5]         ,
  }
  const parsed = parseResponse?.({ state: 'ready', manifest: timed })     
                                                
   
  assert.deepEqual(parsed.manifest.frameTimes, timed.frameTimes)
  assert.equal(Object.isFrozen(parsed.manifest.frameTimes), true)
})

test('rejects physical frame-time sequences with the wrong length or non-finite values', () => {
  for (const frameTimes of [
    [0.25, 1.75],
    [0.25, Number.NaN, 4.5],
    [0.25, Number.POSITIVE_INFINITY, 4.5],
    [0.25, 0.25, 4.5],
  ]) {
    assert.throws(() => parseResponse?.({
      state: 'ready',
      manifest: { ...trajectoryManifest(), timeUnit: 'ps', frameTimes },
    }), TypeError)
  }
})

test('rejects a non-GIF or duplicate trajectory preview resource', () => {
  for (const resources of [
    [coordinates, cells, { ...trajectoryPreview, mimeType: 'image/png' }],
    [coordinates, cells, trajectoryPreview, { ...trajectoryPreview, id: 'preview_gif_2' }],
  ]) {
    assert.throws(() => parseResponse?.({
      state: 'ready',
      manifest: { ...trajectoryManifest(), resources },
    }), TypeError)
  }
})

test('preserves exact numeric arrays while returning recursively frozen plain values', () => {
  const manifest = volumeManifest()
  const parsed = parseResponse?.({ state: 'ready', manifest })     
               
                                   
                               
                                          
     
   
  assert.deepEqual(parsed.manifest.dimensions, [2, 2, 2])
  assert.deepEqual(parsed.manifest.origin, [0, 0.25, -1.5])
  assert.deepEqual(parsed.manifest.axes, [[1, 0, 0], [0, 1, 0], [0, 0, 1]])
  assert.notEqual(parsed.manifest, manifest)
  assert.equal(Object.getPrototypeOf(parsed.manifest), Object.prototype)
  assert.equal(Object.isFrozen(parsed.manifest.dimensions), true)
  assert.equal(Object.isFrozen(parsed.manifest.origin), true)
  assert.equal(Object.isFrozen(parsed.manifest.axes), true)
  assert.equal(Object.isFrozen(parsed.manifest.axes[0]), true)
})

test('accepts unsupported responses only with the closed reason set', () => {
  for (const reason of ['unsupported_format', 'malformed', 'too_large']         ) {
    const parsed = parseResponse?.({ state: 'unsupported', reason })                           
    assert.deepEqual(parsed, { state: 'unsupported', reason })
    assert.equal(Object.isFrozen(parsed), true)
  }
  for (const value of [
    { state: 'unsupported', reason: 'unknown' },
    { state: 'ready' },
    { state: 'ready', manifest: trajectoryManifest(), extra: true },
    { state: 'unsupported', reason: 'too_large', manifest: trajectoryManifest() },
  ]) {
    assert.throws(() => parseResponse?.(value), TypeError)
  }
})

test('resource ids accept only bounded opaque safe identifiers', () => {
  assert.equal(parseResourceId?.('A_0-z'), 'A_0-z')
  assert.equal(parseResourceId?.('a'.repeat(80)), 'a'.repeat(80))
  for (const value of [
    '',
    'a'.repeat(81),
    'has.dot',
    'has/slash',
    'has\\backslash',
    'https://example.test/resource',
    '../outside',
    null,
    1,
  ]) {
    assert.throws(() => parseResourceId?.(value), TypeError)
  }
})

test('rejects unknown keys, non-plain prototypes, external URLs, and filesystem-looking fields', () => {
  const valid = { state: 'ready', manifest: trajectoryManifest() }
  for (const value of [
    { ...valid, provider: 'codex' },
    { state: 'ready', manifest: { ...trajectoryManifest(), path: '/tmp/secret' } },
    { state: 'ready', manifest: { ...trajectoryManifest(), url: 'https://example.test' } },
    { state: 'ready', manifest: { ...trajectoryManifest(), source: { ...source, path: '/workspace/out' } } },
    { state: 'ready', manifest: { ...trajectoryManifest(), source: { ...source, name: 'https://example.test/out' } } },
    Object.assign(Object.create({ inherited: true }), valid),
    { state: 'ready', manifest: Object.assign(Object.create({ inherited: true }), trajectoryManifest()) },
    { state: 'ready', manifest: { ...trajectoryManifest(), source: Object.assign(Object.create({ inherited: true }), source) } },
  ]) {
    assert.throws(() => parseResponse?.(value), TypeError)
  }
})

test('rejects unsafe resources and duplicate resource ids', () => {
  const manifest = trajectoryManifest()
  const badResources = [
    [{ ...coordinates, id: 'bad.id' }, cells],
    [{ ...coordinates, id: '../outside' }, cells],
    [{ ...coordinates, mimeType: 'text/plain' }, cells],
    [{ ...coordinates, role: 'volume.values' }, cells],
    [{ ...coordinates, byteLength: -1 }, cells],
    [{ ...coordinates, byteLength: Number.MAX_SAFE_INTEGER + 1 }, cells],
    [{ ...coordinates, byteLength: Number.POSITIVE_INFINITY }, cells],
    [{ ...coordinates, byteLength: Number.NaN }, cells],
    [{ ...coordinates, byteLength: 1.5 }, cells],
    [{ ...coordinates }, { ...cells, id: coordinates.id }],
  ]
  for (const resources of badResources) {
    assert.throws(() => parseResponse?.({ state: 'ready', manifest: { ...manifest, resources } }), TypeError)
  }
})

test('rejects role references that do not belong to the selected manifest kind', () => {
  assert.throws(() => parseResponse?.({
    state: 'ready',
    manifest: { ...volumeManifest(), resources: [coordinates] },
  }), TypeError)
  assert.throws(() => parseResponse?.({
    state: 'ready',
    manifest: { ...bandManifest(), resources: [volumeValues] },
  }), TypeError)
  assert.throws(() => parseResponse?.({
    state: 'ready',
    manifest: { ...dosManifest(), resources: [coordinates] },
  }), TypeError)
})

test('rejects negative, non-finite, fractional, and excessive counts', () => {
  const cases = [
    { ...trajectoryManifest(), atomCount: -1 },
    { ...trajectoryManifest(), atomCount: 100_001 },
    { ...trajectoryManifest(), frameCount: -1 },
    { ...trajectoryManifest(), frameCount: 10_001 },
    { ...trajectoryManifest(), atomCount: Number.NaN },
    { ...trajectoryManifest(), frameCount: Number.POSITIVE_INFINITY },
    { ...volumeManifest(), dimensions: [-1, 2, 2] },
    { ...volumeManifest(), dimensions: [16_777_217, 1, 1] },
    { ...volumeManifest(), dimensions: [257, 257, 257] },
    { ...bandManifest(), bands: 0 },
    { ...bandManifest(), bands: 16_777_217 },
    { ...bandManifest(), kpoints: Number.POSITIVE_INFINITY },
    { ...dosManifest(), points: 16_777_217 },
    { ...dosManifest(), points: 1.5 },
  ]
  for (const manifest of cases) {
    assert.throws(() => parseResponse?.({ state: 'ready', manifest }), TypeError)
  }
})

test('rejects invalid dimensions, ranges, and non-finite scalar values', () => {
  for (const manifest of [
    { ...volumeManifest(), dimensions: [2, 2] },
    { ...volumeManifest(), dimensions: [2, 2, 2, 2] },
    { ...volumeManifest(), origin: [0, Number.NaN, 0] },
    { ...volumeManifest(), axes: [[1, 0], [0, 1, 0], [0, 0, 1]] },
    { ...volumeManifest(), channels: [{ ...volumeManifest().channels[0], minimum: Number.POSITIVE_INFINITY }] },
    { ...volumeManifest(), channels: [{ ...volumeManifest().channels[0], minimum: 5, maximum: 1 }] },
    { ...bandManifest(), fermiEnergy: Number.NaN },
    { ...dosManifest(), fermiEnergy: Number.NEGATIVE_INFINITY },
    { ...trajectoryManifest(), timeStep: Number.NaN },
  ]) {
    assert.throws(() => parseResponse?.({ state: 'ready', manifest }), TypeError)
  }
})

test('rejects too many resources and unresolvable manifest references', () => {
  const resources = Array.from({ length: 65 }, (_, index) => ({
    id: `resource_${index}`,
    role: 'trajectory.coordinates'         ,
    mimeType: 'application/vnd.zeus.f32'         ,
    byteLength: 1,
  }))
  assert.throws(() => parseResponse?.({
    state: 'ready',
    manifest: { ...trajectoryManifest(), resources },
  }), TypeError)
  assert.throws(() => parseResponse?.({
    state: 'ready',
    manifest: { ...volumeManifest(), channels: [{
      ...volumeManifest().channels[0], resourceId: 'missing',
    }] },
  }), TypeError)
  assert.throws(() => parseResponse?.({
    state: 'ready',
    manifest: { ...bandManifest(), resourceId: 'missing' },
  }), TypeError)
  assert.throws(() => parseResponse?.({
    state: 'ready',
    manifest: { ...dosManifest(), resourceId: 'missing' },
  }), TypeError)
})

function coerciveString(value        )                         {
  return { toString: () => value }
}

test('rejects objects that only coerce to closed-union strings', () => {
  const role = coerciveString('trajectory.coordinates')
  const resourceMimeType = coerciveString('application/vnd.zeus.f32')
  const trajectoryFormat = coerciveString('extxyz')
  const timeUnit = coerciveString('fs')
  const volumeFormat = coerciveString('cube')
  const unsupportedReason = coerciveString('too_large')
  const cases                           = [
    [{ state: 'ready', manifest: {
      ...trajectoryManifest(),
      resources: [{ ...coordinates, role }, cells],
    } }, role],
    [{ state: 'ready', manifest: {
      ...trajectoryManifest(),
      resources: [{ ...coordinates, mimeType: resourceMimeType }, cells],
    } }, resourceMimeType],
    [{ state: 'ready', manifest: { ...trajectoryManifest(), format: trajectoryFormat } }, trajectoryFormat],
    [{ state: 'ready', manifest: { ...trajectoryManifest(), timeUnit } }, timeUnit],
    [{ state: 'ready', manifest: { ...volumeManifest(), format: volumeFormat } }, volumeFormat],
    [{ state: 'unsupported', reason: unsupportedReason }, unsupportedReason],
  ]

  for (const [value, malicious] of cases) {
    assert.throws(() => parseResponse?.(value), TypeError)
    assert.equal(Object.isFrozen(malicious), false)
  }
})

test('returns detached frozen values without freezing input objects', () => {
  const input = { state: 'ready', manifest: trajectoryManifest() }
  const parsed = parseResponse?.(input)     
               
                    
                                  
                                 
     
   

  assert.equal(Object.isFrozen(input), false)
  assert.equal(Object.isFrozen(input.manifest), false)
  assert.equal(Object.isFrozen(input.manifest.source), false)
  assert.equal(Object.isFrozen(input.manifest.resources), false)
  assert.equal(Object.isFrozen(input.manifest.elements), false)
  assert.equal(Object.isFrozen(parsed), true)
  assert.equal(Object.isFrozen(parsed.manifest), true)
  assert.equal(Object.isFrozen(parsed.manifest.source), true)
  assert.equal(Object.isFrozen(parsed.manifest.resources), true)
  assert.equal(Object.isFrozen(parsed.manifest.resources[0]), true)
  assert.equal(Object.isFrozen(parsed.manifest.elements), true)
  assert.notEqual(parsed.manifest, input.manifest)
  assert.notEqual(parsed.manifest.source, input.manifest.source)
  assert.notEqual(parsed.manifest.resources, input.manifest.resources)
  assert.notEqual(parsed.manifest.elements, input.manifest.elements)
  assert.equal(typeof (parsed.manifest.resources[0]                     ).role, 'string')
})

test('rejects accessor and non-enumerable required object properties', () => {
  const sourceGetter = { ...source }
  Object.defineProperty(sourceGetter, 'runId', {
    get: () => source.runId,
    enumerable: true,
  })
  assert.throws(() => parseResponse?.({
    state: 'ready',
    manifest: { ...trajectoryManifest(), source: sourceGetter },
  }), TypeError)

  const sourceNonEnumerable = { ...source }
  Object.defineProperty(sourceNonEnumerable, 'sequence', {
    value: source.sequence,
    enumerable: false,
  })
  assert.throws(() => parseResponse?.({
    state: 'ready',
    manifest: { ...trajectoryManifest(), source: sourceNonEnumerable },
  }), TypeError)

  const resourceGetter = { ...coordinates }
  Object.defineProperty(resourceGetter, 'id', {
    get: () => coordinates.id,
    enumerable: true,
  })
  assert.throws(() => parseResponse?.({
    state: 'ready',
    manifest: { ...trajectoryManifest(), resources: [resourceGetter, cells] },
  }), TypeError)

  const channelGetter = { ...volumeManifest().channels[0] }
  Object.defineProperty(channelGetter, 'minimum', {
    get: () => -1.25,
    enumerable: true,
  })
  assert.throws(() => parseResponse?.({
    state: 'ready',
    manifest: { ...volumeManifest(), channels: [channelGetter] },
  }), TypeError)
})

test('rejects sparse arrays, accessor indices, and extra array properties', () => {
  const sparseElements = ['Si', 'O']
  delete sparseElements[1]
  assert.throws(() => parseResponse?.({
    state: 'ready',
    manifest: {
      ...trajectoryManifest(),
      periodic: false,
      resources: [coordinates],
      elements: sparseElements,
    },
  }), TypeError)

  const accessorElements = ['Si', 'O']
  Object.defineProperty(accessorElements, '0', {
    get: () => 'Si',
    enumerable: true,
  })
  assert.throws(() => parseResponse?.({
    state: 'ready',
    manifest: {
      ...trajectoryManifest(),
      periodic: false,
      resources: [coordinates],
      elements: accessorElements,
    },
  }), TypeError)

  const nonEnumerableIndex = ['Si', 'O']
  Object.defineProperty(nonEnumerableIndex, '0', {
    value: 'Si',
    enumerable: false,
  })
  assert.throws(() => parseResponse?.({
    state: 'ready',
    manifest: {
      ...trajectoryManifest(),
      periodic: false,
      resources: [coordinates],
      elements: nonEnumerableIndex,
    },
  }), TypeError)

  const enumerableExtra = ['Si', 'O']                                 
  enumerableExtra.extra = 'unexpected'
  assert.throws(() => parseResponse?.({
    state: 'ready',
    manifest: {
      ...trajectoryManifest(),
      periodic: false,
      resources: [coordinates],
      elements: enumerableExtra,
    },
  }), TypeError)

  const nonEnumerableExtra = ['Si', 'O']
  Object.defineProperty(nonEnumerableExtra, 'extra', {
    value: 'unexpected',
    enumerable: false,
  })
  assert.throws(() => parseResponse?.({
    state: 'ready',
    manifest: {
      ...trajectoryManifest(),
      periodic: false,
      resources: [coordinates],
      elements: nonEnumerableExtra,
    },
  }), TypeError)

  const symbolExtra = ['Si', 'O']
  Object.defineProperty(symbolExtra, Symbol('unexpected'), {
    value: 'unexpected',
    enumerable: true,
  })
  assert.throws(() => parseResponse?.({
    state: 'ready',
    manifest: {
      ...trajectoryManifest(),
      periodic: false,
      resources: [coordinates],
      elements: symbolExtra,
    },
  }), TypeError)
})

test('requires trajectory element count to equal atom count', () => {
  assert.throws(() => parseResponse?.({
    state: 'ready',
    manifest: {
      ...trajectoryManifest(),
      elements: ['Si'],
    },
  }), TypeError)
})

test('accepts f32 and f64 coordinate, cell, and volume resources', () => {
  assert.doesNotThrow(() => parseResponse?.({
    state: 'ready',
    manifest: {
      ...trajectoryManifest(),
      resources: [
        { ...coordinates, mimeType: 'application/vnd.zeus.f64' },
        { ...cells, mimeType: 'application/vnd.zeus.f64' },
      ],
    },
  }))
  assert.doesNotThrow(() => parseResponse?.({
    state: 'ready',
    manifest: {
      ...volumeManifest(),
      resources: [{ ...volumeValues, mimeType: 'application/vnd.zeus.f32' }],
    },
  }))
})

test('enforces trajectory resource cardinality, MIME, and periodic-cell semantics', () => {
  const cases = [
    {
      ...trajectoryManifest(),
      resources: [coordinates, { ...coordinates, id: 'coordinates_2' }, cells],
    },
    {
      ...trajectoryManifest(),
      resources: [coordinates, cells, { ...cells, id: 'cells_2' }],
    },
    {
      ...trajectoryManifest(),
      resources: [{ ...coordinates, mimeType: 'application/json' }, cells],
    },
    {
      ...trajectoryManifest(),
      resources: [coordinates],
    },
    {
      ...trajectoryManifest(),
      periodic: false,
      resources: [coordinates, cells],
    },
  ]
  for (const manifest of cases) {
    assert.throws(() => parseResponse?.({ state: 'ready', manifest }), TypeError)
  }
})

test('requires one distinct volume value resource per channel with no unused resources', () => {
  const channel = volumeManifest().channels[0]
  const secondChannel = {
    id: 'spin',
    label: 'Spin density',
    minimum: -2,
    maximum: 3,
    resourceId: volumeValues.id,
  }
  const secondResource = { ...volumeValues, id: 'density_2' }

  for (const manifest of [
    {
      ...volumeManifest(),
      resources: [volumeValues, secondResource],
      channels: [channel],
    },
    {
      ...volumeManifest(),
      resources: [volumeValues, secondResource],
      channels: [channel, secondChannel],
    },
    {
      ...volumeManifest(),
      resources: [{ ...volumeValues, mimeType: 'application/json' }],
    },
  ]) {
    assert.throws(() => parseResponse?.({ state: 'ready', manifest }), TypeError)
  }

  assert.doesNotThrow(() => parseResponse?.({
    state: 'ready',
    manifest: {
      ...volumeManifest(),
      resources: [volumeValues, secondResource],
      channels: [channel, { ...secondChannel, resourceId: secondResource.id }],
    },
  }))
})

test('requires exactly one JSON plot resource for band and DOS manifests', () => {
  const secondResource = { ...plotValues, id: 'plot_2' }
  for (const manifest of [
    {
      ...bandManifest(),
      resources: [plotValues, secondResource],
    },
    {
      ...bandManifest(),
      resources: [{ ...plotValues, mimeType: 'application/vnd.zeus.f64' }],
    },
    {
      ...dosManifest(),
      resources: [plotValues, secondResource],
    },
    {
      ...dosManifest(),
      resources: [{ ...plotValues, mimeType: 'application/vnd.zeus.f32' }],
    },
  ]) {
    assert.throws(() => parseResponse?.({ state: 'ready', manifest }), TypeError)
  }
})
