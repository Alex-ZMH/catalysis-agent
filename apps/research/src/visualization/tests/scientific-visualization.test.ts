import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseServerArtifactVisualizationResponse,
} from '../scientific-visualization'
import { decimateScientificPlotSeries } from '../ScientificPlotVisualization'
import { derivedVisualizationKind } from '../DerivedVisualizationPreview'

function reference(name: string, mimeType: string) {
  return { runId: 'run-test', sequence: 1, name, mimeType, at: '2026-11-15T00:00:00.000Z' }
}

test('parses and freezes a server visualization manifest with exact resource metadata', () => {
  const response = parseServerArtifactVisualizationResponse({
    state: 'ready',
    manifest: {
      version: 1,
      source: { runId: 'run-test', sequence: 1, name: 'EIGENVAL', mimeType: 'chemical/x-vasp-eigenval' },
      resources: [{ id: 'plot', role: 'plot.values', mimeType: 'application/json', byteLength: 128 }],
      kind: 'band',
      format: 'vasp-eigenval',
      spinChannels: 1,
      bands: 2,
      kpoints: 4,
      fermiEnergy: null,
      resourceId: 'plot',
    },
  })

  assert.equal(response.state, 'ready')
  assert.equal(response.manifest.kind, 'band')
  assert.equal(response.manifest.resources[0]?.byteLength, 128)
  assert.ok(Object.isFrozen(response))
  assert.ok(Object.isFrozen(response.manifest))
  assert.ok(Object.isFrozen(response.manifest.resources[0]))
})

test('rejects unsafe visualization metadata instead of interpreting it as a path', () => {
  assert.throws(() => parseServerArtifactVisualizationResponse({
    state: 'ready',
    manifest: {
      version: 1,
      source: { runId: 'run-test', sequence: 1, name: '../EIGENVAL', mimeType: 'chemical/x-vasp-eigenval' },
      resources: [{ id: '../plot', role: 'plot.values', mimeType: 'application/json', byteLength: 1 }],
      kind: 'band', format: 'vasp-eigenval', spinChannels: 1, bands: 1, kpoints: 1,
      fermiEnergy: null, resourceId: '../plot',
    },
  }), /safe file name|safe 1-80 character id/)
})

test('routes derived artifact names only when the MIME contract is exact', () => {
  assert.equal(derivedVisualizationKind(reference('movie.extxyz', 'chemical/x-xyz')), 'trajectory')
  assert.equal(derivedVisualizationKind(reference('XDATCAR', 'chemical/x-vasp-xdatcar')), 'trajectory')
  assert.equal(derivedVisualizationKind(reference('density.cube', 'chemical/x-cube')), 'volume')
  assert.equal(derivedVisualizationKind(reference('CHGCAR', 'chemical/x-vasp-chgcar')), 'volume')
  assert.equal(derivedVisualizationKind(reference('EIGENVAL', 'chemical/x-vasp-eigenval')), 'band')
  assert.equal(derivedVisualizationKind(reference('DOSCAR', 'chemical/x-vasp-doscar')), 'dos')
  assert.equal(derivedVisualizationKind(reference('EIGENVAL', 'application/octet-stream')), null)
  assert.equal(derivedVisualizationKind(reference('.extxyz', 'chemical/x-xyz')), null)
})

test('scientific plot decimation keeps extrema, order, and display cap', () => {
  const input = Array.from({ length: 101 }, (_, index) => ({
    x: index,
    y: index === 50 ? 100 : index === 75 ? -50 : index,
    originalIndex: index,
  }))
  const output = decimateScientificPlotSeries(input, 20)
  assert.ok(output.length <= 20)
  assert.deepEqual(output[0], input[0])
  assert.deepEqual(output.at(-1), input.at(-1))
  assert.ok(output.some((point) => point.y === 100))
  assert.ok(output.some((point) => point.y === -50))
  assert.ok(output.every((point, index) => index === 0 || point.x > output[index - 1]!.x))
})
