import {
  SERVER_ARTIFACT_VISUALIZATION_MAX_ATOMS,
  SERVER_ARTIFACT_VISUALIZATION_MAX_GRID_POINTS,
  SERVER_ARTIFACT_VISUALIZATION_MAX_RESOURCE_BYTES,
  SERVER_ARTIFACT_VISUALIZATION_MAX_RESOURCES,
  SERVER_ARTIFACT_VISUALIZATION_SOURCE_MAX_BYTES,
                                           
} from './scientific-visualization.mjs'

import {
  VisualizationMalformedError,
  VisualizationTooLargeError,
  VisualizationUnsupportedError,
                            
                            
                                   
} from './visualization-preprocessor.mjs'

const F32_MIME = 'application/vnd.zeus.f32'         
const CUBE_MIME = 'chemical/x-cube'
const CHGCAR_MIME = 'chemical/x-vasp-chgcar'
const ELFCAR_MIME = 'chemical/x-vasp-elfcar'
const BOHR_TO_ANGSTROM = 0.529177210903

                                    
                                                       
                                                 

                               
                   
                 
                 
  

function malformed()        {
  throw new VisualizationMalformedError()
}

function tooLarge()        {
  throw new VisualizationTooLargeError()
}

function unsupported()        {
  throw new VisualizationUnsupportedError()
}

function safeMetadata(metadata                                         )                 {
  if (metadata === undefined || metadata === null || typeof metadata !== 'object') return malformed()
  if (
    typeof metadata.runId !== 'string' ||
    typeof metadata.sequence !== 'number' || !Number.isSafeInteger(metadata.sequence) || metadata.sequence < 1 ||
    typeof metadata.name !== 'string' || typeof metadata.mimeType !== 'string'
  ) return malformed()
  return {
    runId: metadata.runId,
    sequence: metadata.sequence,
    name: metadata.name,
    mimeType: metadata.mimeType,
  }
}

function decode(bytes            )         {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > SERVER_ARTIFACT_VISUALIZATION_SOURCE_MAX_BYTES) {
    return tooLarge()
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    // Tabs and line endings are the only control characters accepted by the
    // text formats. Comments are discarded, but control bytes in them still
    // indicate an unsafe or ambiguous source.
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) || /(^|[^\r])\r(?!\n)/.test(text)) {
      return malformed()
    }
    return text
  } catch {
    return malformed()
  }
}

function linesOf(text        )           {
  const lines = text.replaceAll('\r\n', '\n').split('\n')
  while (lines.at(-1) === '') lines.pop()
  return lines
}

function tokens(line         )           {
  if (typeof line !== 'string') return malformed()
  return line.trim().length === 0 ? [] : line.trim().split(/\s+/)
}

const DECIMAL_REAL_PATTERN = /^[+-]?(?:(?:[0-9]+(?:\.[0-9]*)?)|(?:\.[0-9]+))(?:[eEdD][+-]?[0-9]+)?$/
const CANONICAL_SIGNED_INTEGER_PATTERN = /^-?(?:0|[1-9][0-9]*)$/
const CANONICAL_NONNEGATIVE_INTEGER_PATTERN = /^(?:0|[1-9][0-9]*)$/
const CANONICAL_POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/

function realToken(value        )         {
  if (typeof value !== 'string' || !DECIMAL_REAL_PATTERN.test(value)) return malformed()
  const number = Number(value.replace(/[dD]/, 'e'))
  return Number.isFinite(number) ? number : malformed()
}

function signedIntegerToken(value        )         {
  if (typeof value !== 'string' || value === '-0' || !CANONICAL_SIGNED_INTEGER_PATTERN.test(value)) return malformed()
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : malformed()
}

function nonnegativeIntegerToken(value        )         {
  if (typeof value !== 'string' || !CANONICAL_NONNEGATIVE_INTEGER_PATTERN.test(value)) return malformed()
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : malformed()
}

function positiveIntegerToken(value        )         {
  if (typeof value !== 'string' || !CANONICAL_POSITIVE_INTEGER_PATTERN.test(value)) return malformed()
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : malformed()
}

function safeLabel(value        )         {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64 || !/^[A-Za-z][A-Za-z0-9+_.-]*$/.test(value)) {
    return malformed()
  }
  return value
}

function safeName(value         )                  {
  return typeof value === 'string' && value.length > 0 && value.length <= 500 &&
    value !== '.' && value !== '..' && !value.startsWith('.') && !value.includes('/') && !value.includes('\\') &&
    !/[\u0000-\u001f\u007f\r\n]/.test(value)
}

function exactExtension(value         , extension        )          {
  return safeName(value) && value.toLowerCase().endsWith(extension) && value.length > extension.length
}

function exactBasename(value         , basename        )          {
  return safeName(value) && value.toLowerCase() === basename
}

function exactMime(value         , expected        )          {
  return value === expected
}

/** @internal Pure prospective scalar-grid/channel/resource budget guard. */
export function assertVolumeGridBudget(dimensions                   , channels        )       {
  if (!Array.isArray(dimensions) || dimensions.length !== 3) return tooLarge()
  if (!Number.isSafeInteger(channels) || channels < 1 || channels > SERVER_ARTIFACT_VISUALIZATION_MAX_RESOURCES) return tooLarge()
  for (const dimension of dimensions) {
    if (!Number.isSafeInteger(dimension) || dimension < 1 || dimension > SERVER_ARTIFACT_VISUALIZATION_MAX_GRID_POINTS) return tooLarge()
  }
  const [nx, ny, nz] = dimensions
  if (nx  > Math.floor(SERVER_ARTIFACT_VISUALIZATION_MAX_GRID_POINTS / ny )) return tooLarge()
  const xy = nx  * ny 
  if (xy > Math.floor(SERVER_ARTIFACT_VISUALIZATION_MAX_GRID_POINTS / nz )) return tooLarge()
  const points = xy * nz 
  if (points > Math.floor(SERVER_ARTIFACT_VISUALIZATION_MAX_RESOURCE_BYTES / 4)) return tooLarge()
}

function vector(line        )       {
  const values = tokens(line)
  if (values.length !== 3) return malformed()
  return values.map(realToken)        
}

function dimensionsLine(line        )                 {
  const values = tokens(line)
  if (values.length !== 3) return malformed()
  return [positiveIntegerToken(values[0] ), positiveIntegerToken(values[1] ), positiveIntegerToken(values[2] )]
}

function sameDimensions(left                , right                )          {
  return left[0] === right[0] && left[1] === right[1] && left[2] === right[2]
}

function pointCount(dimensions                )         {
  // The budget guard performs overflow-safe multiplication before this helper
  // is called.
  return dimensions[0] * dimensions[1] * dimensions[2]
}

function encodeValues(values                   )                {
  const bytes = new Uint8Array(values.length * 4)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let minimum = Number.POSITIVE_INFINITY
  let maximum = Number.NEGATIVE_INFINITY
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] 
    if (!Number.isFinite(value)) return malformed()
    const emitted = Math.fround(value)
    if (!Number.isFinite(emitted)) return malformed()
    view.setFloat32(index * 4, emitted, true)
    minimum = Math.min(minimum, emitted)
    maximum = Math.max(maximum, emitted)
  }
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return malformed()
  return { bytes, minimum, maximum }
}

function volumeOutput(
  format                              ,
  metadata                                         ,
  dimensions                ,
  origin      ,
  axes                             ,
  channels                                                                     ,
)                                                                                                {
  const source = safeMetadata(metadata)
  assertVolumeGridBudget(dimensions, channels.length)
  if (
    origin.some((value) => !Number.isFinite(value)) ||
    axes.some((axis) => axis.some((value) => !Number.isFinite(value)))
  ) return malformed()
  const expectedPoints = pointCount(dimensions)
  if (channels.length === 0 || channels.length > SERVER_ARTIFACT_VISUALIZATION_MAX_RESOURCES) return tooLarge()
  const resources                         = []
  const manifestChannels                                                                                             = []
  for (const channel of channels) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(channel.id) || channel.values.length !== expectedPoints) return malformed()
    const encoded = encodeValues(channel.values)
    resources.push({
      descriptor: { id: channel.id, role: 'volume.values', mimeType: F32_MIME, byteLength: encoded.bytes.byteLength },
      bytes: encoded.bytes,
    })
    manifestChannels.push({
      id: channel.id,
      label: channel.label,
      minimum: encoded.minimum,
      maximum: encoded.maximum,
      resourceId: channel.id,
    })
  }
  const manifest                                      = {
    version: 1,
    source,
    resources: resources.map((resource) => resource.descriptor),
    kind: 'volume',
    format,
    dimensions: [...dimensions]                            ,
    origin: [...origin]                            ,
    axes: axes.map((axis) => [...axis]                            )                                                                                  ,
    channels: manifestChannels,
  }
  return { manifest, resources }
}

function prepareSafely(
  parser                                                                  
                                                 
                                              
   ,
  bytes            ,
  metadata                              ,
) {
  try {
    return parser(bytes, metadata)
  } catch (error) {
    if (
      error instanceof VisualizationMalformedError ||
      error instanceof VisualizationTooLargeError ||
      error instanceof VisualizationUnsupportedError
    ) throw error
    throw new VisualizationMalformedError()
  }
}

function parseCubeUnsafe(bytes            , metadata                              )   
                                               
                                            
  {
  const source = decode(bytes)
  const lines = linesOf(source)
  if (lines.length < 6) return malformed()
  let index = 2 // Exactly two comment lines are discarded and never propagated.
  const atomLine = tokens(lines[index++] ?? '')
  if (atomLine.length !== 4 && atomLine.length !== 5) return malformed()
  const signedAtomCount = signedIntegerToken(atomLine[0] )
  if (signedAtomCount < 0) return unsupported()
  if (signedAtomCount > SERVER_ARTIFACT_VISUALIZATION_MAX_ATOMS) return tooLarge()
  if (atomLine.length === 5 && positiveIntegerToken(atomLine[4] ) !== 1) return unsupported()
  const origin = atomLine.slice(1, 4).map(realToken)        
  const signedDimensions           = []
  const rawAxes         = []
  for (let axis = 0; axis < 3; axis += 1) {
    const values = tokens(lines[index++] ?? '')
    if (values.length !== 4) return malformed()
    const count = signedIntegerToken(values[0] )
    if (count === 0) return malformed()
    signedDimensions.push(count)
    rawAxes.push(values.slice(1).map(realToken)        )
  }
  const sign = Math.sign(signedDimensions[0] )
  if (signedDimensions.some((count) => Math.sign(count) !== sign)) return malformed()
  const dimensions = signedDimensions.map((count) => Math.abs(count))                            
  assertVolumeGridBudget(dimensions, 1)
  const conversion = sign > 0 ? BOHR_TO_ANGSTROM : 1
  const convertedOrigin = origin.map((value) => value * conversion)        
  const axes = rawAxes.map((axis) => axis.map((value) => value * conversion)        )                      
  for (let atom = 0; atom < signedAtomCount; atom += 1) {
    const values = tokens(lines[index++] ?? '')
    if (values.length !== 5) return malformed()
    nonnegativeIntegerToken(values[0] )
    realToken(values[1] )
    realToken(values[2] )
    realToken(values[3] )
    realToken(values[4] )
  }

  const remainingLines             = []
  for (; index < lines.length; index += 1) {
    const lineTokens = tokens(lines[index] )
    if (lineTokens.length > 0) remainingLines.push(lineTokens)
  }
  const expectedPoints = pointCount(dimensions)
  const flattened = remainingLines.flat()
  if (flattened.length === 0) return malformed()
  if (flattened.length !== expectedPoints) return malformed()
  const values = new Array        (expectedPoints)
  for (let valueIndex = 0; valueIndex < expectedPoints; valueIndex += 1) {
    values[valueIndex] = realToken(flattened[valueIndex] )
  }
  return volumeOutput('cube', metadata, dimensions, convertedOrigin, axes, [{ id: 'scalar', label: 'Scalar field', values }])
}

                               
                             
                   
                   
  

function parseVaspStructure(lines                   )                {
  if (lines.length < 8) return malformed()
  let index = 1 // VASP comment/title is trusted input but is never emitted.
  const scaleTokens = tokens(lines[index++] ?? '')
  if (scaleTokens.length !== 1) return malformed()
  const scale = realToken(scaleTokens[0] )
  if (!(scale > 0)) return malformed()
  const lattice = [vector(lines[index++] ?? ''), vector(lines[index++] ?? ''), vector(lines[index++] ?? '')]
    .map((row) => row.map((value) => value * scale)        )                      
  const symbols = tokens(lines[index++] ?? '')
  if (symbols.length === 0) return malformed()
  const labels = symbols.map(safeLabel)
  const counts = tokens(lines[index++] ?? '')
  if (counts.length !== labels.length || counts.length === 0) return malformed()
  const atomCounts = counts.map(positiveIntegerToken)
  const atomCount = atomCounts.reduce((sum, count) => {
    if (sum > SERVER_ARTIFACT_VISUALIZATION_MAX_ATOMS - count) return tooLarge()
    return sum + count
  }, 0)
  const selective = (lines[index] ?? '').trim().toLowerCase() === 'selective dynamics'
  if (selective) index += 1
  const modeTokens = tokens(lines[index++] ?? '')
  if (modeTokens.length !== 1 || !/^(?:direct|cartesian)$/i.test(modeTokens[0] )) return malformed()
  const mode = modeTokens[0] .toLowerCase()
  for (let atom = 0; atom < atomCount; atom += 1) {
    const position = tokens(lines[index++] ?? '')
    if (position.length !== (selective ? 6 : 3)) return malformed()
    realToken(position[0] )
    realToken(position[1] )
    realToken(position[2] )
    if (selective && position.slice(3).some((flag) => !/^(?:t|f)$/i.test(flag))) return malformed()
    // Coordinates are validated in their declared mode. Neither mode is
    // emitted in this phase, but retaining this branch keeps the parser's
    // scientific-unit boundary explicit.
    if (mode !== 'direct' && mode !== 'cartesian') return malformed()
  }
  return { lattice, atomCount, nextIndex: index }
}

function skipBlankLines(lines                   , index        )         {
  let next = index
  while (next < lines.length && tokens(lines[next] ).length === 0) next += 1
  return next
}

function parseGridValues(lines                   , start        , dimensions                )                                          {
  const count = pointCount(dimensions)
  const values = new Array        (count)
  let index = start
  let valueIndex = 0
  while (valueIndex < count) {
    if (index >= lines.length) return malformed()
    const lineValues = tokens(lines[index++] )
    if (lineValues.length === 0) continue
    if (lineValues.length > count - valueIndex) return malformed()
    for (const token of lineValues) values[valueIndex++] = realToken(token)
  }
  return { values, nextIndex: index }
}

function consumeAugmentationBlocks(lines                   , start        )         {
  let index = skipBlankLines(lines, start)
  while (index < lines.length) {
    const header = tokens(lines[index] )
    if (header[0] !== 'augmentation') break
    if (header.length !== 4 || header[1] !== 'occupancies') return malformed()
    positiveIntegerToken(header[2] )
    const count = nonnegativeIntegerToken(header[3] )
    if (count > SERVER_ARTIFACT_VISUALIZATION_MAX_GRID_POINTS) return tooLarge()
    index += 1
    let consumed = 0
    while (consumed < count) {
      if (index >= lines.length) return malformed()
      const values = tokens(lines[index++] )
      if (values.length === 0) continue
      if (values.length > count - consumed) return malformed()
      for (const token of values) realToken(token)
      consumed += values.length
    }
    index = skipBlankLines(lines, index)
  }
  return index
}

function parseVaspVolumeUnsafe(
  bytes            ,
  metadata                                         ,
  format                     ,
)                                                                                                {
  const source = decode(bytes)
  const lines = linesOf(source)
  const structure = parseVaspStructure(lines)
  let index = skipBlankLines(lines, structure.nextIndex)
  if (index >= lines.length) return malformed()
  const dimensions = dimensionsLine(lines[index++] )
  assertVolumeGridBudget(dimensions, 1)
  const first = parseGridValues(lines, index, dimensions)
  index = consumeAugmentationBlocks(lines, first.nextIndex)
  const channels                                                                            = [{
    id: format === 'chgcar' ? 'charge' : 'elf',
    label: format === 'chgcar' ? 'Charge density' : 'Electron localization function',
    values: first.values,
  }]
  if (index < lines.length) {
    const secondDimensions = dimensionsLine(lines[index++] )
    if (!sameDimensions(dimensions, secondDimensions)) return malformed()
    assertVolumeGridBudget(dimensions, 2)
    const second = parseGridValues(lines, index, dimensions)
    index = consumeAugmentationBlocks(lines, second.nextIndex)
    if (format === 'chgcar') {
      channels.push({ id: 'magnetization', label: 'Magnetization density', values: second.values })
    } else {
      channels[0] = { id: 'elf-up', label: 'ELF spin up', values: first.values }
      channels.push({ id: 'elf-down', label: 'ELF spin down', values: second.values })
    }
  }
  if (index < lines.length) return malformed()
  const axes                     = [
    structure.lattice[0].map((value) => value / dimensions[0])        ,
    structure.lattice[1].map((value) => value / dimensions[1])        ,
    structure.lattice[2].map((value) => value / dimensions[2])        ,
  ]
  return volumeOutput(format, metadata, dimensions, [0, 0, 0], axes, channels)
}

export const CUBE_VISUALIZATION_ADAPTER                       = Object.freeze({
  id: 'cube-v1',
  version: '1',
  match(source                                                        )          {
    return exactExtension(source?.name, '.cube') && exactMime(source?.mimeType, CUBE_MIME)
  },
  async prepare(bytes            , metadata                              ) {
    return prepareSafely(parseCubeUnsafe, bytes, metadata)
  },
})

export const CHGCAR_VISUALIZATION_ADAPTER                       = Object.freeze({
  id: 'chgcar-v1',
  version: '1',
  match(source                                                        )          {
    return exactBasename(source?.name, 'chgcar') && exactMime(source?.mimeType, CHGCAR_MIME)
  },
  async prepare(bytes            , metadata                              ) {
    return prepareSafely((input, sourceMetadata) => parseVaspVolumeUnsafe(input, sourceMetadata, 'chgcar'), bytes, metadata)
  },
})

export const ELFCAR_VISUALIZATION_ADAPTER                       = Object.freeze({
  id: 'elfcar-v1',
  version: '1',
  match(source                                                        )          {
    return exactBasename(source?.name, 'elfcar') && exactMime(source?.mimeType, ELFCAR_MIME)
  },
  async prepare(bytes            , metadata                              ) {
    return prepareSafely((input, sourceMetadata) => parseVaspVolumeUnsafe(input, sourceMetadata, 'elfcar'), bytes, metadata)
  },
})

export const SCALAR_VOLUME_VISUALIZATION_ADAPTERS                                  = Object.freeze([
  CUBE_VISUALIZATION_ADAPTER,
  CHGCAR_VISUALIZATION_ADAPTER,
  ELFCAR_VISUALIZATION_ADAPTER,
])

export const CUBE_VOLUME_ADAPTER = CUBE_VISUALIZATION_ADAPTER
export const CHGCAR_VOLUME_ADAPTER = CHGCAR_VISUALIZATION_ADAPTER
export const ELFCAR_VOLUME_ADAPTER = ELFCAR_VISUALIZATION_ADAPTER

export const parseCube = (bytes            , metadata                              ) => (
  prepareSafely(parseCubeUnsafe, bytes, metadata)
)

export const parseChgcar = (bytes            , metadata                              ) => (
  prepareSafely((input, sourceMetadata) => parseVaspVolumeUnsafe(input, sourceMetadata, 'chgcar'), bytes, metadata)
)

export const parseElfcar = (bytes            , metadata                              ) => (
  prepareSafely((input, sourceMetadata) => parseVaspVolumeUnsafe(input, sourceMetadata, 'elfcar'), bytes, metadata)
)

export const parseCubeVolume = parseCube
export const parseChgcarVolume = parseChgcar
export const parseElfcarVolume = parseElfcar

export { VisualizationMalformedError, VisualizationTooLargeError, VisualizationUnsupportedError }
