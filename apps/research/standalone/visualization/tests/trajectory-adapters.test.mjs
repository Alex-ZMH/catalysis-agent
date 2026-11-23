import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SERVER_ARTIFACT_VISUALIZATION_MAX_ATOMS,
  SERVER_ARTIFACT_VISUALIZATION_MAX_FRAMES,
  SERVER_ARTIFACT_VISUALIZATION_MAX_RESOURCE_BYTES,
                                           
                                                                    
} from '../scientific-visualization.mjs'

import {
  LAMMPS_DUMP_VISUALIZATION_ADAPTER,
  TEXT_TRAJECTORY_VISUALIZATION_ADAPTERS,
  XDATCAR_VISUALIZATION_ADAPTER,
  EXTXYZ_VISUALIZATION_ADAPTER,
  VisualizationMalformedError,
  VisualizationTooLargeError,
  parseExtxyzTrajectory,
  parseLammpsDumpTrajectory,
  parseXdatcarTrajectory,
  assertTrajectoryFrameBudget,
} from '../trajectory-adapters.mjs'
                                                                               

const metadata                              = {
  runId: 'run_text_1',
  sequence: 4,
  name: 'trajectory.extxyz',
  mimeType: 'chemical/x-xyz',
}

const encoder = new TextEncoder()

function bytes(text        )             {
  return encoder.encode(text)
}

function floats(resource            )           {
  assert.equal(resource.byteLength % 4, 0)
  const view = new DataView(resource.buffer, resource.byteOffset, resource.byteLength)
  return Array.from({ length: resource.byteLength / 4 }, (_, index) => view.getFloat32(index * 4, true))
}

async function prepare(adapter                                     , text        , sourceMetadata = metadata) {
  return adapter.prepare(bytes(text), sourceMetadata)
}

function trajectoryManifest(manifest                       )                                                         {
  assert.equal(manifest.kind, 'trajectory')
  if (manifest.kind !== 'trajectory') throw new Error('expected trajectory manifest')
  return manifest
}

const extxyz = `2\nProperties="species:S:1:pos:R:3" Lattice="3 0 0 0 3 0 0 0 3" pbc="T T T"\nSi 0 0 0\nO 1.5e0 -2 3\n2\nProperties="species:S:1:pos:R:3" Lattice="3 0 0 0 4 0 0 0 5" pbc="T T T"\nSi 0.5 0.5 0.5\nO 1 2 3\n`

test('exports a frozen canonical adapter registry', () => {
  assert.equal(Object.isFrozen(TEXT_TRAJECTORY_VISUALIZATION_ADAPTERS), true)
  assert.deepEqual(TEXT_TRAJECTORY_VISUALIZATION_ADAPTERS.map((adapter) => [adapter.id, adapter.version]), [
    ['extxyz-v1', '3'],
    ['xdatcar-v1', '1'],
    ['lammps-dump-v1', '2'],
  ])
  assert.equal(EXTXYZ_VISUALIZATION_ADAPTER.match({ name: 'a.extxyz', mimeType: 'chemical/x-xyz' }), true)
  assert.equal(EXTXYZ_VISUALIZATION_ADAPTER.match({ name: 'a.extxyz', mimeType: 'text/plain' }), false)
  assert.equal(EXTXYZ_VISUALIZATION_ADAPTER.match({ name: '.extxyz.exe', mimeType: 'chemical/x-xyz' }), false)
  assert.equal(EXTXYZ_VISUALIZATION_ADAPTER.match({ name: 'a.xyz', mimeType: 'chemical/x-xyz' }), false)
  assert.equal(XDATCAR_VISUALIZATION_ADAPTER.match({ name: 'xdatcar', mimeType: 'chemical/x-vasp-xdatcar' }), true)
  assert.equal(XDATCAR_VISUALIZATION_ADAPTER.match({ name: 'XDATCAR', mimeType: 'text/plain' }), false)
  assert.equal(XDATCAR_VISUALIZATION_ADAPTER.match({ name: 'XDATCAR', mimeType: 'chemical/x-vasp-xdatcar' }), true)
  assert.equal(XDATCAR_VISUALIZATION_ADAPTER.match({ name: 'XDATCAR.txt', mimeType: 'chemical/x-vasp-xdatcar' }), false)
  assert.equal(LAMMPS_DUMP_VISUALIZATION_ADAPTER.match({ name: 'a.lammpstrj', mimeType: 'application/x-lammps-dump' }), true)
  assert.equal(LAMMPS_DUMP_VISUALIZATION_ADAPTER.match({ name: 'a.lammpstrj', mimeType: 'text/plain' }), false)
  assert.equal(LAMMPS_DUMP_VISUALIZATION_ADAPTER.match({ name: 'a.dump.exe', mimeType: 'application/x-lammps-dump' }), false)
  assert.equal(LAMMPS_DUMP_VISUALIZATION_ADAPTER.match({ name: 'dir/a.dump', mimeType: 'application/x-lammps-dump' }), false)
})

test('parses two-frame EXTXYZ with exact little-endian coordinates, CRLF, scientific values, and varying cells', async () => {
  const text = extxyz.replaceAll('\n', '\r\n')
  const output = await prepare(EXTXYZ_VISUALIZATION_ADAPTER, text)
  assert.deepEqual(output.manifest, {
    version: 1,
    source: metadata,
    resources: [
      { id: 'coordinates', role: 'trajectory.coordinates', mimeType: 'application/vnd.zeus.f32', byteLength: 48 },
      { id: 'cells', role: 'trajectory.cells', mimeType: 'application/vnd.zeus.f32', byteLength: 72 },
    ],
    kind: 'trajectory', format: 'extxyz', atomCount: 2, frameCount: 2,
    elements: ['Si', 'O'], periodic: true, timeUnit: 'frame', timeStep: 1,
  }                                              )
  assert.deepEqual(floats(output.resources[0] .bytes), [
    0, 0, 0, 1.5, -2, 3, 0.5, 0.5, 0.5, 1, 2, 3,
  ])
  assert.deepEqual(floats(output.resources[1] .bytes), [
    3, 0, 0, 0, 3, 0, 0, 0, 3,
    3, 0, 0, 0, 4, 0, 0, 0, 5,
  ])
})

test('parses non-periodic EXTXYZ and skips declared string/integer/logical/real fields', async () => {
  const text = `1\nProperties="species:S:1:pos:R:3:label:S:1:charge:R:1:index:I:1:fixed:L:1"\nC 1 2 3 atom 0.25 7 T\n`
  const output = await prepare(EXTXYZ_VISUALIZATION_ADAPTER, text)
  assert.equal(trajectoryManifest(output.manifest).periodic, false)
  assert.equal(output.resources.length, 1)
  assert.deepEqual(floats(output.resources[0] .bytes), [1, 2, 3])
})

test('parses standard unquoted EXTXYZ Properties declarations used by worker trajectories', async () => {
  const text = `1\nLattice="28 0 0 0 28 0 0 0 28" Properties=species:S:1:pos:R:3 pbc="T T T" Time=0\nC 1 2 3\n`
  const output = await prepare(EXTXYZ_VISUALIZATION_ADAPTER, text)
  const parsed = trajectoryManifest(output.manifest)
  assert.equal(parsed.atomCount, 1)
  assert.equal(parsed.frameCount, 1)
  assert.equal(parsed.periodic, true)
  assert.deepEqual(floats(output.resources[0] .bytes), [1, 2, 3])
})

test('preserves complete EXTXYZ physical times including nonzero starts and uneven intervals', async () => {
  const text = [
    '1',
    'Properties=species:S:1:pos:R:3 Time=0.25 time_unit=ps time_start_ps=0.0 time_end_ps=4.5 time_unit=ps',
    'C 0 0 0',
    '1',
    'Properties=species:S:1:pos:R:3 Time=1.75 time_unit=ps time_start_ps=0.0 time_end_ps=4.5 time_unit=ps',
    'C 1 0 0',
    '1',
    'Properties=species:S:1:pos:R:3 Time=4.5 time_unit=ps time_start_ps=0.0 time_end_ps=4.5 time_unit=ps',
    'C 2 0 0',
  ].join('\n')
  const output = await prepare(EXTXYZ_VISUALIZATION_ADAPTER, text)
  const parsed = trajectoryManifest(output.manifest)                                                              
                                  
   
  assert.equal(parsed.timeUnit, 'ps')
  assert.deepEqual(parsed.frameTimes, [0.25, 1.75, 4.5])
  assert.deepEqual(floats(output.resources[0] .bytes), [0, 0, 0, 1, 0, 0, 2, 0, 0])
})

test('falls back to frame time when EXTXYZ time metadata is incomplete or inconsistent', async () => {
  const text = [
    '1',
    'Properties=species:S:1:pos:R:3 Time=0.25 time_unit=ps',
    'C 0 0 0',
    '1',
    'Properties=species:S:1:pos:R:3 Time=1.75',
    'C 1 0 0',
  ].join('\n')
  const output = await prepare(EXTXYZ_VISUALIZATION_ADAPTER, text)
  const parsed = trajectoryManifest(output.manifest)
  assert.equal(parsed.timeUnit, 'frame')
  assert.equal(parsed.timeStep, 1)
  assert.equal('frameTimes' in parsed, false)
})

test('falls back to frame time when repeated EXTXYZ time metadata conflicts', async () => {
  const text = [
    '1',
    'Properties=species:S:1:pos:R:3 Time=0 time_unit=ps time_unit=fs',
    'C 0 0 0',
    '1',
    'Properties=species:S:1:pos:R:3 Time=1 time_unit=ps time_unit=fs',
    'C 1 0 0',
  ].join('\n')
  const output = await prepare(EXTXYZ_VISUALIZATION_ADAPTER, text)
  const parsed = trajectoryManifest(output.manifest)
  assert.equal(parsed.timeUnit, 'frame')
  assert.equal(parsed.timeStep, 1)
  assert.equal('frameTimes' in parsed, false)
})

test('rejects EXTXYZ atom identity changes, malformed UTF-8/NUL, non-finite values, and undeclared columns', async () => {
  const cases = [
    extxyz.replace('O 1.5e0', 'C 1.5e0'),
    `1\nProperties="species:S:1:pos:R:3"\nC NaN 0 0\n`,
    `1\nProperties="species:S:1:pos:R:3"\nC Infinity 0 0\n`,
    `1\nProperties="species:S:1:pos:R:3"\nC 0 0 0 extra\n`,
    `1\nProperties="species:S:1:pos:R:3"\nC 0 0 0\u0000\n`,
  ]
  for (const text of cases) await assert.rejects(() => prepare(EXTXYZ_VISUALIZATION_ADAPTER, text), VisualizationMalformedError)
  await assert.rejects(
    () => EXTXYZ_VISUALIZATION_ADAPTER.prepare(new Uint8Array([0xff]), metadata),
    VisualizationMalformedError,
  )
})

test('uses canonical integer syntax while retaining decimal scientific real syntax', async () => {
  const extxyzInvalidCounts = [
    `0x2\nProperties="species:S:1:pos:R:3"\nC 0 0 0\n`,
    `2.0\nProperties="species:S:1:pos:R:3"\nC 0 0 0\nC 1e0 2.0 3.0\n`,
  ]
  for (const text of extxyzInvalidCounts) await assert.rejects(
    () => prepare(EXTXYZ_VISUALIZATION_ADAPTER, text), VisualizationMalformedError,
  )
  const lammpsBadIntegers = lammpsOrthogonal
    .replace('2 1 8 9 10', '1e0 +2 8 9 10')
  await assert.rejects(() => prepare(LAMMPS_DUMP_VISUALIZATION_ADAPTER, lammpsBadIntegers, {
    ...metadata, name: 'run.dump', mimeType: 'application/x-lammps-dump',
  }), VisualizationMalformedError)
  const xdatcarBadCounts = xdatcarDirect.replace('1 1\nDirect', '2.0 1\nDirect')
  await assert.rejects(() => prepare(XDATCAR_VISUALIZATION_ADAPTER, xdatcarBadCounts, {
    ...metadata, name: 'XDATCAR', mimeType: 'chemical/x-vasp-xdatcar',
  }), VisualizationMalformedError)
  const scientific = await prepare(EXTXYZ_VISUALIZATION_ADAPTER, `1\nProperties="species:S:1:pos:R:3"\nC +1.25e-2 -.5E+1 2.0\n`)
  assert.deepEqual(floats(scientific.resources[0] .bytes), [Math.fround(0.0125), -5, 2])
})

test('rejects EXTXYZ truncated/extra frames and inconsistent lattice/pbc syntax', async () => {
  const cases = [
    extxyz.replace('O 1 2 3\n', ''),
    `${extxyz}\n2\nProperties="species:S:1:pos:R:3"\nSi 0 0 0\nO 1 1 1\n`,
    `1\nProperties="species:S:1:pos:R:3" Lattice="1 0 0 0 1 0 0 0"\nC 0 0 0\n`,
    `1\nProperties="species:S:1:pos:R:3" pbc="T F T"\nC 0 0 0\n`,
  ]
  for (const text of cases) await assert.rejects(() => prepare(EXTXYZ_VISUALIZATION_ADAPTER, text), VisualizationMalformedError)
})

const xdatcarDirect = `VASP test\n2.0\n1 0 0\n0 1 0\n0 0 1\nSi O\n1 1\nDirect configuration=     1\n0 0 0\n0.5 0.5 0.5\nDirect configuration=     2\n0.25 0 0\n0 0.25 0\n`
const xdatcarCartesian = `VASP test\n2.0\n1 0 0\n0 1 0\n0 0 1\nSi O\n1 1\nCartesian configuration= 1\n1 2 3\n-1 0 0\nCartesian configuration= 2\n0 0 0\n1 1 1\n`

test('parses XDATCAR Direct and Cartesian frames with scaled cells and exact Float32 order', async () => {
  const direct = await prepare(XDATCAR_VISUALIZATION_ADAPTER, xdatcarDirect, {
    ...metadata, name: 'XDATCAR', mimeType: 'chemical/x-vasp-xdatcar',
  })
  assert.equal(trajectoryManifest(direct.manifest).frameCount, 2)
  assert.deepEqual(trajectoryManifest(direct.manifest).elements, ['Si', 'O'])
  assert.deepEqual(floats(direct.resources[0] .bytes), [
    0, 0, 0, 1, 1, 1, 0.5, 0, 0, 0, 0.5, 0,
  ])
  assert.deepEqual(floats(direct.resources[1] .bytes), [
    2, 0, 0, 0, 2, 0, 0, 0, 2,
    2, 0, 0, 0, 2, 0, 0, 0, 2,
  ])
  const cartesian = await prepare(XDATCAR_VISUALIZATION_ADAPTER, xdatcarCartesian, {
    ...metadata, name: 'xdatcar', mimeType: 'chemical/x-vasp-xdatcar',
  })
  assert.deepEqual(floats(cartesian.resources[0] .bytes), [2, 4, 6, -2, 0, 0, 0, 0, 0, 2, 2, 2])
})

test('rejects XDATCAR VASP4/selective dynamics/mixed modes/duplicate or missing frames and extra columns', async () => {
  const cases = [
    xdatcarDirect.replace('Si O\n1 1', '1 1\nSi O'),
    xdatcarDirect.replace('0.5 0.5 0.5', '0.5 0.5 0.5 T'),
    xdatcarDirect.replace('Direct configuration=     2', 'Cartesian configuration=     2'),
    xdatcarDirect.replace('Direct configuration=     2', 'Direct configuration=     1'),
    xdatcarDirect.replace('Direct configuration=     2', 'Direct configuration=     3'),
    xdatcarDirect.replace('Direct configuration=     2\n0.25', 'Direct configuration=     2\n0.25 0 0\nextra'),
  ]
  for (const text of cases) {
    await assert.rejects(() => prepare(XDATCAR_VISUALIZATION_ADAPTER, text, {
      ...metadata, name: 'XDATCAR', mimeType: 'chemical/x-vasp-xdatcar',
    }), VisualizationMalformedError)
  }
})

const lammpsOrthogonal = `ITEM: TIMESTEP\n0\nITEM: NUMBER OF ATOMS\n2\nITEM: BOX BOUNDS pp pp pp\n-1 9\n0 10\n1 11\nITEM: ATOMS id type x y z\n2 1 8 9 10\n1 2 -1 0 1\nITEM: TIMESTEP\n1\nITEM: NUMBER OF ATOMS\n2\nITEM: BOX BOUNDS pp pp pp\n-1 9\n0 10\n1 11\nITEM: ATOMS id type xs ys zs\n1 2 0 0 0\n2 1 1 1 1\n`
const lammpsTriclinic = `ITEM: TIMESTEP\n0\nITEM: NUMBER OF ATOMS\n1\nITEM: BOX BOUNDS xy xz yz pp pp pp\n0 10 1\n0 10 2\n0 10 3\nITEM: ATOMS id type xs ys zs\n1 4 0.5 0.25 0.75\n`
const lammpsElement = `ITEM: TIMESTEP\n0\nITEM: NUMBER OF ATOMS\n2\nITEM: BOX BOUNDS pp pp pp\n0 10\n0 10\n0 10\nITEM: ATOMS id type x y z element\n2 1 1 1 1 O\n1 1 2 2 2 C\nITEM: TIMESTEP\n1\nITEM: NUMBER OF ATOMS\n2\nITEM: BOX BOUNDS pp pp pp\n0 10\n0 10\n0 10\nITEM: ATOMS id type x y z element\n1 1 3 3 3 C\n2 1 4 4 4 O\n`

test('parses orthogonal and scaled LAMMPS frames, sorting ids and emitting deterministic type labels', async () => {
  const output = await prepare(LAMMPS_DUMP_VISUALIZATION_ADAPTER, lammpsOrthogonal, {
    ...metadata, name: 'run.dump', mimeType: 'application/x-lammps-dump',
  })
  assert.deepEqual(trajectoryManifest(output.manifest).elements, ['T2', 'T1'])
  const preview = output.resources.find((resource) => resource.descriptor.role === 'trajectory.preview')
  assert.deepEqual(preview?.descriptor, {
    id: 'preview_gif', role: 'trajectory.preview', mimeType: 'image/gif', byteLength: preview?.bytes.byteLength,
  })
  assert.equal(new TextDecoder().decode(preview?.bytes.subarray(0, 6)), 'GIF89a')
  assert.deepEqual(floats(output.resources[0] .bytes), [0, 0, 0, 9, 9, 9, 0, 0, 0, 10, 10, 10])
  assert.deepEqual(floats(output.resources[1] .bytes), [10, 0, 0, 0, 10, 0, 0, 0, 10, 10, 0, 0, 0, 10, 0, 0, 0, 10])
})

test('parses restricted triclinic LAMMPS bounds and scaled-to-Cartesian coordinates', async () => {
  const output = await prepare(LAMMPS_DUMP_VISUALIZATION_ADAPTER, lammpsTriclinic, {
    ...metadata, name: 'run.lammpstrj', mimeType: 'application/x-lammps-dump',
  })
  assert.deepEqual(floats(output.resources[0] .bytes), [5.25, 4, 7.5])
  assert.deepEqual(floats(output.resources[1] .bytes), [7, 0, 0, 1, 7, 0, 2, 3, 10])
})

test('rejects LAMMPS unstable identities, duplicate ids, mixed boundaries, partial coordinates, and row columns', async () => {
  const cases = [
    lammpsOrthogonal.replace('2 1 8 9 10', '1 1 8 9 10'),
    lammpsOrthogonal.replace('ITEM: ATOMS id type x y z', 'ITEM: ATOMS id type x y z element').replace('2 1 8 9 10', '2 1 8 9 10 Si'),
    lammpsOrthogonal.replace('ITEM: BOX BOUNDS pp pp pp', 'ITEM: BOX BOUNDS pp ff pp'),
    lammpsOrthogonal.replace('ITEM: ATOMS id type x y z', 'ITEM: ATOMS id type x y'),
    lammpsOrthogonal.replace('2 1 8 9 10', '2 1 8 9 10 11'),
  ]
  for (const text of cases) await assert.rejects(() => prepare(LAMMPS_DUMP_VISUALIZATION_ADAPTER, text, {
    ...metadata, name: 'run.dump', mimeType: 'application/x-lammps-dump',
  }), VisualizationMalformedError)
})

test('rejects cross-frame LAMMPS id-set, type, and element changes', async () => {
  const idSetChanged = lammpsOrthogonal.replace('2 1 1 1 1', '3 1 1 1 1')
  const typeChanged = lammpsOrthogonal.replace('2 1 1 1 1', '2 9 1 1 1')
  const elementChanged = lammpsElement.replace('2 1 4 4 4 O', '2 1 4 4 4 N')
  for (const text of [idSetChanged, typeChanged, elementChanged]) await assert.rejects(
    () => prepare(LAMMPS_DUMP_VISUALIZATION_ADAPTER, text, {
      ...metadata, name: 'run.dump', mimeType: 'application/x-lammps-dump',
    }), VisualizationMalformedError,
  )
})

test('allows unknown LAMMPS extra columns as exact-width opaque strings', async () => {
  const text = lammpsElement.replaceAll('ITEM: ATOMS id type x y z element', 'ITEM: ATOMS id type x y z element label')
    .replace('2 1 1 1 1 O', '2 1 1 1 1 O secret_fixture')
    .replace('1 1 2 2 2 C', '1 1 2 2 2 C arbitrary_text')
    .replace('1 1 3 3 3 C', '1 1 3 3 3 C another_opaque')
    .replace('2 1 4 4 4 O', '2 1 4 4 4 O final_opaque')
  const output = await prepare(LAMMPS_DUMP_VISUALIZATION_ADAPTER, text, {
    ...metadata, name: 'run.dump', mimeType: 'application/x-lammps-dump',
  })
  assert.equal(trajectoryManifest(output.manifest).frameCount, 2)
})

test('rejects exact non-finite numeric words in unknown LAMMPS columns', async () => {
  const base = lammpsElement.replaceAll('ITEM: ATOMS id type x y z element', 'ITEM: ATOMS id type x y z element label')
    .replace('2 1 1 1 1 O', '2 1 1 1 1 O opaque')
    .replace('1 1 2 2 2 C', '1 1 2 2 2 C opaque')
    .replace('1 1 3 3 3 C', '1 1 3 3 3 C opaque')
    .replace('2 1 4 4 4 O', '2 1 4 4 4 O opaque')
  for (const token of ['NaN', '+Infinity', '-inf', 'nan', '-Infinity', '+nan']) {
    const text = base.replace('O opaque', `O ${token}`)
    await assert.rejects(() => prepare(LAMMPS_DUMP_VISUALIZATION_ADAPTER, text, {
      ...metadata, name: 'run.dump', mimeType: 'application/x-lammps-dump',
    }), VisualizationMalformedError)
  }
})

test('enforces atom/frame/resource caps before encoding and keeps errors generic', async () => {
  const hugeAtoms = `${SERVER_ARTIFACT_VISUALIZATION_MAX_ATOMS + 1}\nProperties="species:S:1:pos:R:3"\n`
  await assert.rejects(() => prepare(EXTXYZ_VISUALIZATION_ADAPTER, hugeAtoms), VisualizationTooLargeError)
  const hugeFrames = Array.from({ length: SERVER_ARTIFACT_VISUALIZATION_MAX_FRAMES + 1 }, () => '1\nProperties="species:S:1:pos:R:3"\nC 0 0 0').join('\n')
  await assert.rejects(() => prepare(EXTXYZ_VISUALIZATION_ADAPTER, hugeFrames), VisualizationTooLargeError)
  const resourceLimit = Math.floor(SERVER_ARTIFACT_VISUALIZATION_MAX_RESOURCE_BYTES / 4) + 1
  assert.ok(resourceLimit > 0)
  assert.equal(SERVER_ARTIFACT_VISUALIZATION_MAX_RESOURCE_BYTES > 0, true)
})

test('exposes pure prospective trajectory budget checks before parser allocations', () => {
  assert.doesNotThrow(() => assertTrajectoryFrameBudget(1, 1, false))
  assert.throws(() => assertTrajectoryFrameBudget(1, SERVER_ARTIFACT_VISUALIZATION_MAX_FRAMES + 1, false), (error         ) => (
    error instanceof VisualizationTooLargeError && error.message === 'Visualization input is too large.'
  ))
  assert.throws(() => assertTrajectoryFrameBudget(SERVER_ARTIFACT_VISUALIZATION_MAX_ATOMS, SERVER_ARTIFACT_VISUALIZATION_MAX_FRAMES, true), (error         ) => (
    error instanceof VisualizationTooLargeError && error.message === 'Visualization input is too large.'
  ))
})

test('sanitizes malformed errors to the exact generic message', async () => {
  const secret = 'secret fixture /private/path'
  try {
    await prepare(EXTXYZ_VISUALIZATION_ADAPTER, `1\nProperties="species:S:1:pos:R:3"\nC NaN 0 0 ${secret}\n`)
    assert.fail('expected malformed input')
  } catch (error) {
    assert.ok(error instanceof VisualizationMalformedError)
    assert.equal(error.message, 'Visualization input is malformed.')
    assert.equal(error.message.includes(secret), false)
  }
})
