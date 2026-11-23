import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SERVER_ARTIFACT_VISUALIZATION_MAX_GRID_POINTS,
  SERVER_ARTIFACT_VISUALIZATION_MAX_RESOURCES,
                                           
} from '../scientific-visualization.mjs'

import {
  CHGCAR_VISUALIZATION_ADAPTER,
  CUBE_VISUALIZATION_ADAPTER,
  ELFCAR_VISUALIZATION_ADAPTER,
  SCALAR_VOLUME_VISUALIZATION_ADAPTERS,
  VisualizationMalformedError,
  VisualizationTooLargeError,
  VisualizationUnsupportedError,
  assertVolumeGridBudget,
} from '../volume-adapters.mjs'
                                                                               

const encoder = new TextEncoder()

function bytes(text        )             {
  return encoder.encode(text)
}

function floats(resource            )           {
  assert.equal(resource.byteLength % 4, 0)
  const view = new DataView(resource.buffer, resource.byteOffset, resource.byteLength)
  return Array.from({ length: resource.byteLength / 4 }, (_, index) => view.getFloat32(index * 4, true))
}

function metadata(name        , mimeType        )                              {
  return { runId: 'run_volume_1', sequence: 7, name, mimeType }
}

function volumeManifest(manifest                                     )                                                                   {
  assert.equal(manifest.kind, 'volume')
  if (manifest.kind !== 'volume') throw new Error('expected volume manifest')
  return manifest
}

const cubeBohr = `secret title /private/path must not escape
second comment with SECRET_TOKEN
2 1 2 3
2 0.5 0 0
2 0 0.5 0
2 0 0 0.5
14 0.0 0 0 0
8 0.0 1 1 1
0.0D+00 1.0D+00 2.0E+00 3.0e+00
4 5 6 7
`

const cubeAngstrom = `cube in angstrom
generated fixture
1 0 0 0
-2 1 0 0
-2 0 1 0
-2 0 0 1
6 0 0 0 0
1 2 3 4 5 6 7 8
`

const chgcarSingle = `CHGCAR fixture secret /tmp/private
2.0
2 0 0
0 3 0
0 0 4
Si O
1 1
Direct
0 0 0
0.5 0.5 0.5

2 2 1
1D+00 2 3 4
`

const chgcarTwoChannels = `CHGCAR two-channel fixture
1.0
2 0 0
0 2 0
0 0 2
Si O
1 1
Selective dynamics
Cartesian
0 0 0 T T T
1 1 1 F F F

2 2 1
1 2
3 4

augmentation occupancies 1 2
0.25D+00 0.5
augmentation occupancies 2 0

2 2 1
-1 -2
-3 -4

augmentation occupancies 1 1
9.0
`

const elfcarSingle = `ELFCAR fixture
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
`

const elfcarSpin = `${elfcarSingle}
augmentation occupancies 1 1
9.0

1 1 2
-0.125 -0.25

augmentation occupancies 2 0
`

test('exports strict frozen scalar-volume adapters with exact name and MIME matching', () => {
  assert.equal(Object.isFrozen(SCALAR_VOLUME_VISUALIZATION_ADAPTERS), true)
  assert.deepEqual(SCALAR_VOLUME_VISUALIZATION_ADAPTERS.map((adapter) => [adapter.id, adapter.version]), [
    ['cube-v1', '1'],
    ['chgcar-v1', '1'],
    ['elfcar-v1', '1'],
  ])
  assert.equal(CUBE_VISUALIZATION_ADAPTER.match({ name: 'density.cube', mimeType: 'chemical/x-cube' }), true)
  assert.equal(CUBE_VISUALIZATION_ADAPTER.match({ name: 'DENSITY.CUBE', mimeType: 'chemical/x-cube' }), true)
  for (const name of ['.cube', 'density.cube.exe', 'dir/density.cube', 'density.CUBE.txt']) {
    assert.equal(CUBE_VISUALIZATION_ADAPTER.match({ name, mimeType: 'chemical/x-cube' }), false)
  }
  assert.equal(CUBE_VISUALIZATION_ADAPTER.match({ name: 'density.cube', mimeType: 'text/plain' }), false)
  assert.equal(CHGCAR_VISUALIZATION_ADAPTER.match({ name: 'CHGCAR', mimeType: 'chemical/x-vasp-chgcar' }), true)
  assert.equal(CHGCAR_VISUALIZATION_ADAPTER.match({ name: 'chgcar', mimeType: 'chemical/x-vasp-chgcar' }), true)
  for (const name of ['.CHGCAR', 'CHGCAR.txt', 'dir/CHGCAR']) {
    assert.equal(CHGCAR_VISUALIZATION_ADAPTER.match({ name, mimeType: 'chemical/x-vasp-chgcar' }), false)
  }
  assert.equal(ELFCAR_VISUALIZATION_ADAPTER.match({ name: 'ELFCAR', mimeType: 'chemical/x-vasp-elfcar' }), true)
  assert.equal(ELFCAR_VISUALIZATION_ADAPTER.match({ name: 'ELFCAR', mimeType: 'chemical/x-cube' }), false)
})

test('parses positive-count Bohr CUBE with exact Å origin, axes, z-fastest order, and min/max', async () => {
  const output = await CUBE_VISUALIZATION_ADAPTER.prepare(bytes(cubeBohr), metadata('density.cube', 'chemical/x-cube'))
  const manifest = volumeManifest(output.manifest)
  const bohr = 0.529177210903
  assert.deepEqual(manifest.source, metadata('density.cube', 'chemical/x-cube'))
  assert.deepEqual(manifest.dimensions, [2, 2, 2])
  assert.deepEqual(manifest.origin, [1 * bohr, 2 * bohr, 3 * bohr])
  assert.deepEqual(manifest.axes, [[0.5 * bohr, 0, 0], [0, 0.5 * bohr, 0], [0, 0, 0.5 * bohr]])
  assert.deepEqual(manifest.channels, [{
    id: 'scalar', label: 'Scalar field', minimum: 0, maximum: 7, resourceId: 'scalar',
  }])
  assert.deepEqual(manifest.resources, [{
    id: 'scalar', role: 'volume.values', mimeType: 'application/vnd.zeus.f32', byteLength: 32,
  }])
  assert.deepEqual(floats(output.resources[0] .bytes), [0, 1, 2, 3, 4, 5, 6, 7])
})

test('parses negative-axis-count CUBE in Å without unit conversion', async () => {
  const output = await CUBE_VISUALIZATION_ADAPTER.prepare(bytes(cubeAngstrom), metadata('density.cube', 'chemical/x-cube'))
  const manifest = volumeManifest(output.manifest)
  assert.deepEqual(manifest.dimensions, [2, 2, 2])
  assert.deepEqual(manifest.origin, [0, 0, 0])
  assert.deepEqual(manifest.axes, [[1, 0, 0], [0, 1, 0], [0, 0, 1]])
  assert.deepEqual(floats(output.resources[0] .bytes), [1, 2, 3, 4, 5, 6, 7, 8])
})

test('rejects CUBE sign/zero dimensions, unsupported atom/orbital datasets, and bad atom rows', async () => {
  const cases                                               = [
    [cubeBohr.replace('2 0 0 0.5', '-2 0 0 0.5'), 'malformed'],
    [cubeBohr.replace('2 0.5 0 0', '0 0.5 0 0'), 'malformed'],
    [cubeBohr.replace('2 1 2 3', '-1 1 2 3'), 'unsupported'],
    [cubeBohr.replace('2 1 2 3', '-0 1 2 3'), 'malformed'],
    [cubeBohr.replace('2 1 2 3', '2 1 2 3 2'), 'unsupported'],
    [`${cubeBohr.split('4 5 6 7')[0]}1\n4 5 6 7\n`, 'malformed'],
    [cubeBohr.replace('8 0.0 1 1 1\n0.0D+00', '8 0.0 1 1 1\n2\n0.0D+00'), 'malformed'],
    [cubeBohr.replace('14 0.0 0 0 0', '14 0.0 0 0'), 'malformed'],
    [cubeBohr.replace('8 0.0 1 1 1', '8 NaN 1 1 1'), 'malformed'],
  ]
  for (const [text, kind] of cases) {
    try {
      await CUBE_VISUALIZATION_ADAPTER.prepare(bytes(text), metadata('density.cube', 'chemical/x-cube'))
      assert.fail('expected CUBE rejection')
    } catch (error) {
      assert.equal(error instanceof VisualizationUnsupportedError, kind === 'unsupported')
      assert.equal(error instanceof VisualizationMalformedError, kind === 'malformed')
    }
  }
})

test('accepts an explicit CUBE NVAL of one and rejects invented standalone counts', async () => {
  const explicit = cubeBohr.replace('2 1 2 3\n', '2 1 2 3 1\n')
  const output = await CUBE_VISUALIZATION_ADAPTER.prepare(bytes(explicit), metadata('density.cube', 'chemical/x-cube'))
  const manifest = volumeManifest(output.manifest)
  const bohr = 0.529177210903
  assert.deepEqual(manifest.dimensions, [2, 2, 2])
  assert.deepEqual(manifest.origin, [1 * bohr, 2 * bohr, 3 * bohr])
  assert.deepEqual(manifest.axes, [[0.5 * bohr, 0, 0], [0, 0.5 * bohr, 0], [0, 0, 0.5 * bohr]])
  assert.deepEqual(floats(output.resources[0] .bytes), [0, 1, 2, 3, 4, 5, 6, 7])
  await assert.rejects(
    () => CUBE_VISUALIZATION_ADAPTER.prepare(bytes(cubeBohr.replace('0.0D+00 1.0D+00', '1\n0.0D+00 1.0D+00')), metadata('density.cube', 'chemical/x-cube')),
    VisualizationMalformedError,
  )
})

test('rejects CUBE under/overflow value counts, non-finite/hex tokens, malformed UTF-8, and NUL/control data', async () => {
  const under = cubeBohr.replace('4 5 6 7', '4 5 6')
  const over = cubeBohr.replace('4 5 6 7', '4 5 6 7 8')
  for (const text of [
    under,
    over,
    cubeBohr.replace('1.0D+00', '0x1'),
    cubeBohr.replace('1.0D+00', 'NaN'),
    cubeBohr.replace('1.0D+00', 'Infinity'),
    cubeBohr.replace('1.0D+00', '1\u0001'),
  ]) {
    await assert.rejects(
      () => CUBE_VISUALIZATION_ADAPTER.prepare(bytes(text), metadata('density.cube', 'chemical/x-cube')),
      VisualizationMalformedError,
    )
  }
  await assert.rejects(
    () => CUBE_VISUALIZATION_ADAPTER.prepare(new Uint8Array([0xff]), metadata('density.cube', 'chemical/x-cube')),
    VisualizationMalformedError,
  )
})

test('parses CHGCAR charge grid with scaled lattice axes and preserves VASP x-fastest source order', async () => {
  const text = chgcarSingle.replaceAll('\n', '\r\n')
  const output = await CHGCAR_VISUALIZATION_ADAPTER.prepare(bytes(text), metadata('CHGCAR', 'chemical/x-vasp-chgcar'))
  const manifest = volumeManifest(output.manifest)
  assert.deepEqual(manifest.dimensions, [2, 2, 1])
  assert.deepEqual(manifest.origin, [0, 0, 0])
  assert.deepEqual(manifest.axes, [[2, 0, 0], [0, 3, 0], [0, 0, 8]])
  assert.deepEqual(manifest.channels, [{
    id: 'charge', label: 'Charge density', minimum: 1, maximum: 4, resourceId: 'charge',
  }])
  assert.deepEqual(floats(output.resources[0] .bytes), [1, 2, 3, 4])
})

test('parses CHGCAR charge and magnetization grids around exact augmentation blocks', async () => {
  const output = await CHGCAR_VISUALIZATION_ADAPTER.prepare(bytes(chgcarTwoChannels), metadata('CHGCAR', 'chemical/x-vasp-chgcar'))
  const manifest = volumeManifest(output.manifest)
  assert.deepEqual(manifest.channels, [
    { id: 'charge', label: 'Charge density', minimum: 1, maximum: 4, resourceId: 'charge' },
    { id: 'magnetization', label: 'Magnetization density', minimum: -4, maximum: -1, resourceId: 'magnetization' },
  ])
  assert.deepEqual(manifest.resources.map((resource) => resource.id), ['charge', 'magnetization'])
  assert.deepEqual(floats(output.resources[0] .bytes), [1, 2, 3, 4])
  assert.deepEqual(floats(output.resources[1] .bytes), [-1, -2, -3, -4])
})

test('validates Selective dynamics Cartesian rows and rejects malformed flags/positions', async () => {
  const malformedFlags = chgcarTwoChannels.replace('0 0 0 T T T', '0 0 0 T X T')
  const malformedPosition = chgcarTwoChannels.replace('1 1 1 F F F', '1 1 1 F F F extra')
  for (const text of [malformedFlags, malformedPosition]) {
    await assert.rejects(
      () => CHGCAR_VISUALIZATION_ADAPTER.prepare(bytes(text), metadata('CHGCAR', 'chemical/x-vasp-chgcar')),
      VisualizationMalformedError,
    )
  }
})

test('parses one or two ELFCAR spin channels and rejects mismatched/third grids', async () => {
  const output = await ELFCAR_VISUALIZATION_ADAPTER.prepare(bytes(elfcarSingle), metadata('ELFCAR', 'chemical/x-vasp-elfcar'))
  const manifest = volumeManifest(output.manifest)
  assert.deepEqual(manifest.channels, [{
    id: 'elf', label: 'Electron localization function', minimum: 0.125, maximum: 0.25, resourceId: 'elf',
  }])
  assert.deepEqual(manifest.resources, [{
    id: 'elf', role: 'volume.values', mimeType: 'application/vnd.zeus.f32', byteLength: 8,
  }])
  assert.deepEqual(floats(output.resources[0] .bytes), [0.125, 0.25])
  const spin = await ELFCAR_VISUALIZATION_ADAPTER.prepare(bytes(elfcarSpin), metadata('ELFCAR', 'chemical/x-vasp-elfcar'))
  assert.deepEqual(volumeManifest(spin.manifest).channels, [
    { id: 'elf-up', label: 'ELF spin up', minimum: 0.125, maximum: 0.25, resourceId: 'elf-up' },
    { id: 'elf-down', label: 'ELF spin down', minimum: -0.25, maximum: -0.125, resourceId: 'elf-down' },
  ])
  assert.deepEqual(volumeManifest(spin.manifest).resources.map((resource) => resource.id), ['elf-up', 'elf-down'])
  assert.deepEqual(floats(spin.resources[0] .bytes), [0.125, 0.25])
  assert.deepEqual(floats(spin.resources[1] .bytes), [-0.125, -0.25])
  await assert.rejects(
    () => ELFCAR_VISUALIZATION_ADAPTER.prepare(bytes(`${elfcarSpin}\n1 1 2\n0 1\n`), metadata('ELFCAR', 'chemical/x-vasp-elfcar')),
    VisualizationMalformedError,
  )
  await assert.rejects(
    () => ELFCAR_VISUALIZATION_ADAPTER.prepare(bytes(`${elfcarSingle}\n1 2 2\n0 1 2 3\n`), metadata('ELFCAR', 'chemical/x-vasp-elfcar')),
    VisualizationMalformedError,
  )
})

test('rejects mismatched/third grids, truncated augmentation, unexpected trailing text, and non-finite VASP values', async () => {
  const mismatched = chgcarTwoChannels.replace('2 2 1\n-1 -2', '3 2 1\n-1 -2')
  const third = `${chgcarTwoChannels}\n2 2 1\n1 2\n3 4\n`
  const truncatedAugmentation = chgcarTwoChannels.replace('0.25D+00 0.5', '0.25D+00')
  const trailing = `${chgcarSingle}\ntrailing secret comment\n`
  const nonFinite = chgcarSingle.replace('1D+00', 'Infinity')
  for (const text of [mismatched, third, truncatedAugmentation, trailing, nonFinite]) {
    await assert.rejects(
      () => CHGCAR_VISUALIZATION_ADAPTER.prepare(bytes(text), metadata('CHGCAR', 'chemical/x-vasp-chgcar')),
      VisualizationMalformedError,
    )
  }
  await assert.rejects(
    () => CHGCAR_VISUALIZATION_ADAPTER.prepare(bytes(chgcarTwoChannels.replace('augmentation occupancies 1 2', 'augmentation occupancies atom 1 2')), metadata('CHGCAR', 'chemical/x-vasp-chgcar')),
    VisualizationMalformedError,
  )
})

test('enforces pure grid, channel, and byte budgets before value allocation', () => {
  assert.doesNotThrow(() => assertVolumeGridBudget([2, 2, 2], 1))
  assert.throws(
    () => assertVolumeGridBudget([SERVER_ARTIFACT_VISUALIZATION_MAX_GRID_POINTS, 2, 1], 1),
    VisualizationTooLargeError,
  )
  assert.throws(
    () => assertVolumeGridBudget([1, 1, 1], SERVER_ARTIFACT_VISUALIZATION_MAX_RESOURCES + 1),
    VisualizationTooLargeError,
  )
})

test('sanitizes generic malformed errors without source comments, paths, or tokens', async () => {
  const secret = 'SECRET_TOKEN /private/path'
  try {
    await CHGCAR_VISUALIZATION_ADAPTER.prepare(
      bytes(`${chgcarSingle}\n${secret}\n`),
      metadata('CHGCAR', 'chemical/x-vasp-chgcar'),
    )
    assert.fail('expected malformed input')
  } catch (error) {
    assert.ok(error instanceof VisualizationMalformedError)
    assert.equal(error.message, 'Visualization input is malformed.')
    assert.equal(error.message.includes(secret), false)
  }
})
