import assert from 'node:assert/strict'
import test from 'node:test'

import {
  TRAJECTORY_GIF_HEIGHT,
  TRAJECTORY_GIF_MAX_ATOMS,
  TRAJECTORY_GIF_MAX_FRAMES,
  TRAJECTORY_GIF_WIDTH,
  renderTrajectoryGif,
  selectEvenlySpacedIndices,
} from '../trajectory-gif.mjs'

function gifFrameCount(bytes            )         {
  let frames = 0
  for (let index = 0; index + 2 < bytes.length; index += 1) {
    if (bytes[index] === 0x21 && bytes[index + 1] === 0xf9 && bytes[index + 2] === 0x04) frames += 1
  }
  return frames
}

test('selects deterministic evenly spaced indices while preserving both endpoints', () => {
  assert.deepEqual(selectEvenlySpacedIndices(1, 8), [0])
  assert.deepEqual(selectEvenlySpacedIndices(5, 8), [0, 1, 2, 3, 4])
  assert.deepEqual(selectEvenlySpacedIndices(10, 4), [0, 3, 6, 9])
  assert.deepEqual(selectEvenlySpacedIndices(100, 3), [0, 50, 99])
  assert.throws(() => selectEvenlySpacedIndices(0, 4), RangeError)
})

test('renders a bounded animated GIF from evenly sampled trajectory frames and atoms', () => {
  const frameCount = TRAJECTORY_GIF_MAX_FRAMES + 7
  const atomCount = TRAJECTORY_GIF_MAX_ATOMS + 13
  const coordinates = new Float32Array(frameCount * atomCount * 3)
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let atom = 0; atom < atomCount; atom += 1) {
      const offset = (frame * atomCount + atom) * 3
      coordinates[offset] = atom % 23 + frame * 0.02
      coordinates[offset + 1] = Math.floor(atom / 23) % 19
      coordinates[offset + 2] = (atom % 11) + frame * 0.01
    }
  }
  const gif = renderTrajectoryGif({
    atomCount,
    frameCount,
    elements: Array.from({ length: atomCount }, (_, index) => `T${index % 4 + 1}`),
    coordinates,
  })

  assert.equal(new TextDecoder().decode(gif.subarray(0, 6)), 'GIF89a')
  assert.equal(gif[gif.length - 1], 0x3b)
  assert.equal(gif[6] | gif[7]  << 8, TRAJECTORY_GIF_WIDTH)
  assert.equal(gif[8] | gif[9]  << 8, TRAJECTORY_GIF_HEIGHT)
  assert.equal(gifFrameCount(gif), TRAJECTORY_GIF_MAX_FRAMES)
})

test('rejects inconsistent or non-finite coordinate buffers', () => {
  assert.throws(() => renderTrajectoryGif({
    atomCount: 2,
    frameCount: 2,
    elements: ['C', 'H'],
    coordinates: new Float32Array(3),
  }), RangeError)
  assert.throws(() => renderTrajectoryGif({
    atomCount: 1,
    frameCount: 1,
    elements: ['C'],
    coordinates: new Float32Array([0, Number.NaN, 0]),
  }), RangeError)
})
