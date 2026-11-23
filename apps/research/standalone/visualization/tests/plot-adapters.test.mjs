import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SERVER_ARTIFACT_VISUALIZATION_MAX_ATOMS,
  SERVER_ARTIFACT_VISUALIZATION_MAX_GRID_POINTS,
  SERVER_ARTIFACT_VISUALIZATION_MAX_RESOURCE_BYTES,
                                           
} from '../scientific-visualization.mjs'

import {
  DOSCAR_VISUALIZATION_ADAPTER,
  EIGENVAL_VISUALIZATION_ADAPTER,
  VASP_PLOT_VISUALIZATION_ADAPTERS,
  VisualizationMalformedError,
  VisualizationTooLargeError,
  assertPlotBudget,
} from '../plot-adapters.mjs'
import * as plotAdapterModule from '../plot-adapters.mjs'
                                                                               

const assertPlotResourceBudget = (plotAdapterModule                
                                                        
 ).assertPlotResourceBudget

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function bytes(text        )             {
  return encoder.encode(text)
}

function metadata(name        , mimeType        )                              {
  return { runId: 'run_plot_1', sequence: 12, name, mimeType }
}

function bandManifest(manifest                                     )                                                                 {
  assert.equal(manifest.kind, 'band')
  if (manifest.kind !== 'band') throw new Error('expected band manifest')
  return manifest
}

function dosManifest(manifest                                     )                                                                {
  assert.equal(manifest.kind, 'dos')
  if (manifest.kind !== 'dos') throw new Error('expected DOS manifest')
  return manifest
}

function jsonResource(output                                                 )          {
  assert.equal(output.resources.length, 1)
  return JSON.parse(decoder.decode(output.resources[0] .bytes))           
}

const eigenvalNonSpin = `1 1 1 1
0 1 2 3 4
5.0
CAR
SECRET system title /private/source/path
8.0 2 2

0.0 0.0 0.0 0.25
1 -1.0 0.1
2 0.5 0.9

0.5 0.0 0.0 0.75
1 -0.25 0.2
2 0.75 0.8
`

const eigenvalSpin = `1 1 1 2
0 1D+00 2 3 4
5D+00
CAR
spin title SECRET_TOKEN
8 1 2

0.0 0.0 0.5 1.0
1 -1.0 -0.5 0.1 0.2
2 0.5 0.75 0.9 0.8
`

const doscarNonSpin = `2 2 0 0
0 1 2 3 4
5.0
CAR
DOS title /tmp/private
10.0 -2.0 3 1.5 1.0
-2.0 0.1 0.01
0.0 0.2 0.03
2.0 0.3 0.06
`

const doscarSpin = `2 2 0 0
0 1 2 3 4
5.0
CAR
spin DOS title
10D+00 -2D+00 2 1.5D+00 1.0
-2D+00 0.1D+00 0.2D+00 0.01D+00 0.02D+00
2D+00 0.3D+00 0.4D+00 0.03D+00 0.04D+00
`

const doscarProjected = `2 2 1 0
10  -2  0  0  1
5
CAR
projected DOS title
10 -2 2 1.5 1.0
-2 0.1 0.01
2 0.2 0.02
10 -2 2 1.5 1.0
-2.0 1.0 2.0
2.0 1.5 2.5
10 -2 2 1.5 1.0
-2.0 3.0 4.0
2.0 3.5 4.5
`

test('exports frozen plot adapters with exact case-insensitive basename and MIME routing', () => {
  assert.equal(Object.isFrozen(VASP_PLOT_VISUALIZATION_ADAPTERS), true)
  assert.deepEqual(VASP_PLOT_VISUALIZATION_ADAPTERS.map((adapter) => [adapter.id, adapter.version]), [
    ['vasp-eigenval-v1', '1'],
    ['vasp-doscar-v1', '1'],
  ])
  assert.equal(EIGENVAL_VISUALIZATION_ADAPTER.match({ name: 'EIGENVAL', mimeType: 'chemical/x-vasp-eigenval' }), true)
  assert.equal(EIGENVAL_VISUALIZATION_ADAPTER.match({ name: 'eigenval', mimeType: 'chemical/x-vasp-eigenval' }), true)
  assert.equal(DOSCAR_VISUALIZATION_ADAPTER.match({ name: 'DOSCAR', mimeType: 'chemical/x-vasp-doscar' }), true)
  assert.equal(DOSCAR_VISUALIZATION_ADAPTER.match({ name: 'doscar', mimeType: 'chemical/x-vasp-doscar' }), true)
  for (const name of ['.EIGENVAL', 'EIGENVAL.txt', 'dir/EIGENVAL', 'EIGENVAL.bak']) {
    assert.equal(EIGENVAL_VISUALIZATION_ADAPTER.match({ name, mimeType: 'chemical/x-vasp-eigenval' }), false)
  }
  for (const name of ['.DOSCAR', 'DOSCAR.txt', 'dir/DOSCAR', 'DOSCAR.bak']) {
    assert.equal(DOSCAR_VISUALIZATION_ADAPTER.match({ name, mimeType: 'chemical/x-vasp-doscar' }), false)
  }
  assert.equal(EIGENVAL_VISUALIZATION_ADAPTER.match({ name: 'EIGENVAL', mimeType: 'text/plain' }), false)
  assert.equal(DOSCAR_VISUALIZATION_ADAPTER.match({ name: 'DOSCAR', mimeType: 'text/plain' }), false)
})

test('parses non-spin EIGENVAL with exact [spin][kpoint][band] order and null Fermi energy', async () => {
  const output = await EIGENVAL_VISUALIZATION_ADAPTER.prepare(
    bytes(eigenvalNonSpin.replaceAll('\n', '\r\n')),
    metadata('EIGENVAL', 'chemical/x-vasp-eigenval'),
  )
  assert.deepEqual(output.manifest, {
    version: 1,
    source: metadata('EIGENVAL', 'chemical/x-vasp-eigenval'),
    resources: [{ id: 'plot', role: 'plot.values', mimeType: 'application/json', byteLength: output.resources[0] .bytes.byteLength }],
    kind: 'band', format: 'vasp-eigenval', spinChannels: 1, bands: 2, kpoints: 2, fermiEnergy: null, resourceId: 'plot',
  }                                              )
  assert.deepEqual(jsonResource(output), {
    kpoints: [[0, 0, 0], [0.5, 0, 0]],
    weights: [0.25, 0.75],
    energies: [[[-1, 0.5], [-0.25, 0.75]]],
    occupations: [[[0.1, 0.9], [0.2, 0.8]]],
  })
  const encoded = bytes(JSON.stringify(jsonResource(output)))
  assert.equal(output.resources[0] .bytes.byteLength, encoded.byteLength)
  assert.equal(output.manifest.resources[0] .byteLength, encoded.byteLength)
  assert.ok(encoded.byteLength <= SERVER_ARTIFACT_VISUALIZATION_MAX_RESOURCE_BYTES)
})

test('parses spin-polarized EIGENVAL and retains up/down columns in source order', async () => {
  const output = await EIGENVAL_VISUALIZATION_ADAPTER.prepare(
    bytes(eigenvalSpin), metadata('EIGENVAL', 'chemical/x-vasp-eigenval'),
  )
  assert.deepEqual(bandManifest(output.manifest), {
    ...bandManifest(output.manifest),
    spinChannels: 2,
    bands: 2,
    kpoints: 1,
    fermiEnergy: null,
  })
  assert.deepEqual(jsonResource(output), {
    kpoints: [[0, 0, 0.5]],
    weights: [1],
    energies: [[[-1, 0.5]], [[-0.5, 0.75]]],
    occupations: [[[0.1, 0.9]], [[0.2, 0.8]]],
  })
})

test('parses non-spin and spin DOSCAR rows with strict energy order and Fermi energy', async () => {
  const nonSpin = await DOSCAR_VISUALIZATION_ADAPTER.prepare(
    bytes(doscarNonSpin), metadata('DOSCAR', 'chemical/x-vasp-doscar'),
  )
  assert.deepEqual(dosManifest(nonSpin.manifest), {
    ...dosManifest(nonSpin.manifest),
    spinChannels: 1,
    points: 3,
    fermiEnergy: 1.5,
  })
  assert.deepEqual(jsonResource(nonSpin), {
    energy: [-2, 0, 2],
    density: [[0.1, 0.2, 0.3]],
    integrated: [[0.01, 0.03, 0.06]],
  })
  const spin = await DOSCAR_VISUALIZATION_ADAPTER.prepare(
    bytes(doscarSpin), metadata('DOSCAR', 'chemical/x-vasp-doscar'),
  )
  assert.equal(dosManifest(spin.manifest).spinChannels, 2)
  assert.deepEqual(jsonResource(spin), {
    energy: [-2, 2],
    density: [[0.1, 0.3], [0.2, 0.4]],
    integrated: [[0.01, 0.03], [0.02, 0.04]],
  })
})

test('validates and discards exactly all projected-DOS sections', async () => {
  const output = await DOSCAR_VISUALIZATION_ADAPTER.prepare(
    bytes(doscarProjected), metadata('DOSCAR', 'chemical/x-vasp-doscar'),
  )
  assert.equal(dosManifest(output.manifest).points, 2)
  assert.deepEqual(output.manifest.resources, [{
    id: 'plot', role: 'plot.values', mimeType: 'application/json', byteLength: output.resources[0] .bytes.byteLength,
  }])
  for (const text of [
    doscarProjected.replace('2.0 3.5 4.5\n', ''),
    doscarProjected.replace('10 -2 2 1.5 1.0\n-2.0 3.0', '10 -2 3 1.5 1.0\n-2.0 3.0'),
    `${doscarProjected}10 -2 2 1.5 1.0\n0 1\n0.5 1\n`,
  ]) {
    await assert.rejects(
      () => DOSCAR_VISUALIZATION_ADAPTER.prepare(bytes(text), metadata('DOSCAR', 'chemical/x-vasp-doscar')),
      VisualizationMalformedError,
    )
  }
})

test('requires projected-DOS ion blocks to share width, energy grid, and scientific header values', async () => {
  const widthMismatch = doscarProjected.replace('-2.0 3.0 4.0\n', '-2.0 3.0 4.0 5.0\n')
  const energyMismatch = doscarProjected.replace('2.0 3.5 4.5\n', '0.0 3.5 4.5\n')
  const headerMismatch = doscarProjected.replace('10 -2 2 1.5 1.0\n-2.0 3.0', '10 -2 2 1.6 1.0\n-2.0 3.0')
  for (const text of [widthMismatch, energyMismatch, headerMismatch]) {
    await assert.rejects(
      () => DOSCAR_VISUALIZATION_ADAPTER.prepare(bytes(text), metadata('DOSCAR', 'chemical/x-vasp-doscar')),
      VisualizationMalformedError,
    )
  }
})

test('rejects strict EIGENVAL header, band-index, count, and trailing-data violations', async () => {
  const cases = [
    eigenvalNonSpin.replace('CAR\n', 'CAR extra\n'),
    eigenvalNonSpin.replace('1 -1.0 0.1', '2 -1.0 0.1'),
    eigenvalNonSpin.replace('8.0 2 2', '8.0 2 3'),
    eigenvalNonSpin.replace('2 0.5 0.9', '2 0.5 0.9 99'),
    `${eigenvalNonSpin}extra trailing text\n`,
  ]
  for (const text of cases) {
    await assert.rejects(
      () => EIGENVAL_VISUALIZATION_ADAPTER.prepare(bytes(text), metadata('EIGENVAL', 'chemical/x-vasp-eigenval')),
      VisualizationMalformedError,
    )
  }
})

test('rejects strict DOSCAR headers, widths, energy order, count mismatches, and trailing data', async () => {
  const cases = [
    doscarNonSpin.replace('CAR\n', 'CAR extra\n'),
    doscarNonSpin.replace('0.0 0.2 0.03', '-2.0 0.2 0.03'),
    doscarNonSpin.replace('10.0 -2.0 3 1.5 1.0', '10.0 -2.0 4 1.5 1.0'),
    doscarNonSpin.replace('0.0 0.2 0.03', '0.0 0.2 0.03 0.04'),
    `${doscarNonSpin}extra trailing text\n`,
  ]
  for (const text of cases) {
    await assert.rejects(
      () => DOSCAR_VISUALIZATION_ADAPTER.prepare(bytes(text), metadata('DOSCAR', 'chemical/x-vasp-doscar')),
      VisualizationMalformedError,
    )
  }
})

test('rejects malformed UTF-8, NUL/control, hex, NaN, Infinity, and sanitized source text', async () => {
  const secret = 'SECRET_UNSAFE_TOKEN /absolute/private/path'
  for (const text of [
    eigenvalNonSpin.replace('5.0', '0x1'),
    eigenvalNonSpin.replace('5.0', 'NaN'),
    eigenvalNonSpin.replace('5.0', 'Infinity'),
    eigenvalNonSpin.replace('5.0', `5.0\u0001`),
  ]) {
    try {
      await EIGENVAL_VISUALIZATION_ADAPTER.prepare(bytes(text), metadata('EIGENVAL', 'chemical/x-vasp-eigenval'))
      assert.fail('expected malformed EIGENVAL')
    } catch (error) {
      assert.equal(error instanceof VisualizationMalformedError, true)
      assert.equal((error         ).message.includes(secret), false)
      assert.equal((error         ).message.includes('/absolute/private/path'), false)
    }
  }
  await assert.rejects(
    () => EIGENVAL_VISUALIZATION_ADAPTER.prepare(new Uint8Array([0xff]), metadata('EIGENVAL', 'chemical/x-vasp-eigenval')),
    VisualizationMalformedError,
  )
  await assert.rejects(
    () => DOSCAR_VISUALIZATION_ADAPTER.prepare(bytes(doscarNonSpin.replace('DOS title /tmp/private', 'DOS\u0000title')), metadata('DOSCAR', 'chemical/x-vasp-doscar')),
    VisualizationMalformedError,
  )
  const malformedSecret = eigenvalNonSpin
    .replace('5.0', 'NaN')
    .replace('SECRET system title /private/source/path', secret)
  await assert.rejects(
    () => EIGENVAL_VISUALIZATION_ADAPTER.prepare(bytes(malformedSecret), metadata('EIGENVAL', 'chemical/x-vasp-eigenval')),
    (error         ) => error instanceof VisualizationMalformedError &&
      (error         ).message === 'Visualization input is malformed.' &&
      !(error         ).message.includes(secret) &&
      !(error         ).message.includes('/absolute/private/path'),
  )
  const sanitized = await EIGENVAL_VISUALIZATION_ADAPTER.prepare(
    bytes(eigenvalNonSpin.replace('SECRET system title /private/source/path', secret)),
    metadata('EIGENVAL', 'chemical/x-vasp-eigenval'),
  )
  assert.equal(decoder.decode(sanitized.resources[0] .bytes).includes(secret), false)
})

test('guards prospective band and DOS cardinality before allocation', () => {
  const maximum = SERVER_ARTIFACT_VISUALIZATION_MAX_GRID_POINTS
  assert.doesNotThrow(() => assertPlotBudget('band', 1, 2, 2))
  assert.doesNotThrow(() => assertPlotBudget('dos', 2, 2))
  assert.throws(
    () => assertPlotBudget('band', 1, Math.floor(maximum / 6) + 1, 1),
    VisualizationTooLargeError,
  )
  assert.throws(
    () => assertPlotBudget('dos', 1, Math.floor(maximum / 3) + 1),
    VisualizationTooLargeError,
  )
  assert.throws(
    () => assertPlotBudget('band', 2, SERVER_ARTIFACT_VISUALIZATION_MAX_GRID_POINTS, 2),
    VisualizationTooLargeError,
  )
  assert.throws(
    () => assertPlotBudget('dos', 1, SERVER_ARTIFACT_VISUALIZATION_MAX_GRID_POINTS + 1),
    VisualizationTooLargeError,
  )
  assert.throws(() => assertPlotBudget('band', 0, 1, 1), VisualizationTooLargeError)
  assert.doesNotThrow(() => assertPlotResourceBudget(SERVER_ARTIFACT_VISUALIZATION_MAX_RESOURCE_BYTES))
  assert.throws(
    () => assertPlotResourceBudget(SERVER_ARTIFACT_VISUALIZATION_MAX_RESOURCE_BYTES + 1),
    (error         ) => error instanceof VisualizationTooLargeError && (error         ).message === 'Visualization input is too large.',
  )
})

test('enforces positive matching ion counts and the atom cap in both formats', async () => {
  await assert.rejects(
    () => EIGENVAL_VISUALIZATION_ADAPTER.prepare(bytes(eigenvalNonSpin.replace('1 1 1 1', '1 2 1 1')), metadata('EIGENVAL', 'chemical/x-vasp-eigenval')),
    VisualizationMalformedError,
  )
  await assert.rejects(
    () => DOSCAR_VISUALIZATION_ADAPTER.prepare(bytes(doscarNonSpin.replace('2 2 0 0', '2 3 0 0')), metadata('DOSCAR', 'chemical/x-vasp-doscar')),
    VisualizationMalformedError,
  )
  const eigenvalOverCap = `101 101 1 1\n0 1 2 3 4\n5\nCAR\ntitle\n8 1 1\n`
    .replaceAll('101', String(SERVER_ARTIFACT_VISUALIZATION_MAX_ATOMS + 1))
  const doscarOverCap = `${SERVER_ARTIFACT_VISUALIZATION_MAX_ATOMS + 1} ${SERVER_ARTIFACT_VISUALIZATION_MAX_ATOMS + 1} 0 0\n0 1 2 3 4\n5\nCAR\ntitle\n10 -2 1 1.5 1.0\n-2 0.1 0.01\n`
  await assert.rejects(
    () => EIGENVAL_VISUALIZATION_ADAPTER.prepare(bytes(eigenvalOverCap), metadata('EIGENVAL', 'chemical/x-vasp-eigenval')),
    VisualizationTooLargeError,
  )
  await assert.rejects(
    () => DOSCAR_VISUALIZATION_ADAPTER.prepare(bytes(doscarOverCap), metadata('DOSCAR', 'chemical/x-vasp-doscar')),
    VisualizationTooLargeError,
  )
})
