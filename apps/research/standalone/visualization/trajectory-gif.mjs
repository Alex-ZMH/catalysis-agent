import { createRequire } from 'node:module'

export const TRAJECTORY_GIF_WIDTH = 400
export const TRAJECTORY_GIF_HEIGHT = 300
export const TRAJECTORY_GIF_MAX_FRAMES = 32
export const TRAJECTORY_GIF_MAX_ATOMS = 2_000
export const TRAJECTORY_GIF_MAX_BYTES = 8 * 1024 * 1024

                            
             
                       
                  
                   
                       
                                              
                    
                     
       
         
                
                     
  

                                                                                         

const require = createRequire(import.meta.url)
const { GIFEncoder } = require('./vendor/gifenc.cjs')                                               

const PALETTE = Object.freeze([
  [248, 250, 252],
  [51, 65, 85],
  [37, 99, 235],
  [220, 38, 38],
  [5, 150, 105],
  [217, 119, 6],
  [124, 58, 237],
  [219, 39, 119],
  [8, 145, 178],
  [101, 116, 139],
  [22, 163, 74],
  [234, 88, 12],
  [79, 70, 229],
  [190, 24, 93],
  [148, 163, 184],
  [15, 23, 42],
].map((color) => Object.freeze(color)))

                                           
                   
                    
                             
                                
  

export function selectEvenlySpacedIndices(count        , maximum        )           {
  if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(maximum) || maximum < 1) {
    throw new RangeError('Invalid trajectory sampling bounds')
  }
  if (count <= maximum) return Array.from({ length: count }, (_, index) => index)
  if (maximum === 1) return [0]
  return Array.from({ length: maximum }, (_, index) => Math.round(index * (count - 1) / (maximum - 1)))
}

function elementColor(label        )         {
  let hash = 2166136261
  for (let index = 0; index < label.length; index += 1) {
    hash ^= label.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return 2 + (hash >>> 0) % 12
}

function drawDisk(pixels            , centerX        , centerY        , radius        , color        )       {
  const minimumX = Math.max(0, centerX - radius)
  const maximumX = Math.min(TRAJECTORY_GIF_WIDTH - 1, centerX + radius)
  const minimumY = Math.max(0, centerY - radius)
  const maximumY = Math.min(TRAJECTORY_GIF_HEIGHT - 1, centerY + radius)
  const radiusSquared = radius * radius
  for (let y = minimumY; y <= maximumY; y += 1) {
    for (let x = minimumX; x <= maximumX; x += 1) {
      const dx = x - centerX
      const dy = y - centerY
      if (dx * dx + dy * dy <= radiusSquared) pixels[y * TRAJECTORY_GIF_WIDTH + x] = color
    }
  }
}

function coordinate(input                    , frame        , atom        , axis        )         {
  const value = input.coordinates[(frame * input.atomCount + atom) * 3 + axis]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new RangeError('Invalid trajectory coordinates')
  return value
}

function project(x        , y        , z        )                            {
  return [x - y * 0.55, z + (x + y) * 0.28]
}

export function renderTrajectoryGif(input                    )             {
  if (
    !Number.isSafeInteger(input.atomCount) || input.atomCount < 1 ||
    !Number.isSafeInteger(input.frameCount) || input.frameCount < 1 ||
    input.elements.length !== input.atomCount ||
    input.coordinates.length !== input.atomCount * input.frameCount * 3
  ) throw new RangeError('Invalid trajectory GIF input')

  const frames = selectEvenlySpacedIndices(input.frameCount, TRAJECTORY_GIF_MAX_FRAMES)
  const atoms = selectEvenlySpacedIndices(input.atomCount, TRAJECTORY_GIF_MAX_ATOMS)
  let minimumU = Number.POSITIVE_INFINITY
  let maximumU = Number.NEGATIVE_INFINITY
  let minimumV = Number.POSITIVE_INFINITY
  let maximumV = Number.NEGATIVE_INFINITY
  for (const frame of frames) {
    for (const atom of atoms) {
      const [u, v] = project(
        coordinate(input, frame, atom, 0),
        coordinate(input, frame, atom, 1),
        coordinate(input, frame, atom, 2),
      )
      minimumU = Math.min(minimumU, u)
      maximumU = Math.max(maximumU, u)
      minimumV = Math.min(minimumV, v)
      maximumV = Math.max(maximumV, v)
    }
  }

  const padding = 20
  const footer = 16
  const availableWidth = TRAJECTORY_GIF_WIDTH - padding * 2
  const availableHeight = TRAJECTORY_GIF_HEIGHT - padding * 2 - footer
  const spanU = Math.max(maximumU - minimumU, 1e-9)
  const spanV = Math.max(maximumV - minimumV, 1e-9)
  const scale = Math.min(availableWidth / spanU, availableHeight / spanV)
  const offsetX = padding + (availableWidth - spanU * scale) / 2
  const offsetY = padding + (availableHeight - spanV * scale) / 2
  const gif = GIFEncoder({ initialCapacity: 64 * 1024 })

  for (let sampledFrame = 0; sampledFrame < frames.length; sampledFrame += 1) {
    const frame = frames[sampledFrame] 
    const pixels = new Uint8Array(TRAJECTORY_GIF_WIDTH * TRAJECTORY_GIF_HEIGHT)
    for (const atom of atoms) {
      const [u, v] = project(
        coordinate(input, frame, atom, 0),
        coordinate(input, frame, atom, 1),
        coordinate(input, frame, atom, 2),
      )
      const x = Math.round(offsetX + (u - minimumU) * scale)
      const y = Math.round(offsetY + (maximumV - v) * scale)
      drawDisk(pixels, x, y, 3, 1)
      drawDisk(pixels, x, y, 2, elementColor(input.elements[atom] ))
    }

    const timelineY = TRAJECTORY_GIF_HEIGHT - 9
    const timelineStart = padding
    const timelineEnd = TRAJECTORY_GIF_WIDTH - padding
    pixels.fill(14, timelineY * TRAJECTORY_GIF_WIDTH + timelineStart, timelineY * TRAJECTORY_GIF_WIDTH + timelineEnd + 1)
    const progress = frames.length === 1 ? 0 : sampledFrame / (frames.length - 1)
    drawDisk(pixels, Math.round(timelineStart + progress * (timelineEnd - timelineStart)), timelineY, 3, 15)
    gif.writeFrame(pixels, TRAJECTORY_GIF_WIDTH, TRAJECTORY_GIF_HEIGHT, {
      ...(sampledFrame === 0 ? { palette: PALETTE, repeat: 0 } : {}),
      delay: frames.length === 1 ? 1_000 : 125,
    })
  }
  gif.finish()
  const output = gif.bytes()
  if (output.byteLength > TRAJECTORY_GIF_MAX_BYTES) throw new RangeError('Trajectory GIF exceeds preview budget')
  return output
}
