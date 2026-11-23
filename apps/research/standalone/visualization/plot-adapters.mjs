import {
  SERVER_ARTIFACT_VISUALIZATION_MAX_ATOMS,
  SERVER_ARTIFACT_VISUALIZATION_MAX_GRID_POINTS,
  SERVER_ARTIFACT_VISUALIZATION_MAX_RESOURCE_BYTES,
  SERVER_ARTIFACT_VISUALIZATION_SOURCE_MAX_BYTES,
                                           
} from './scientific-visualization.mjs'

import {
  VisualizationMalformedError,
  VisualizationTooLargeError,
                            
                            
                                   
} from './visualization-preprocessor.mjs'

const EIGENVAL_MIME = 'chemical/x-vasp-eigenval'
const DOSCAR_MIME = 'chemical/x-vasp-doscar'
const JSON_MIME = 'application/json'         
const PLOT_JSON_NUMERIC_MAX_BYTES = 32
// Reserve room for a delimiter and the brackets surrounding nested numeric arrays.
const PLOT_JSON_NUMERIC_SEPARATOR_BYTES = PLOT_JSON_NUMERIC_MAX_BYTES + 8
const PLOT_JSON_FIXED_OVERHEAD_BYTES = 4096

                                               
                            
                                               
                                            
  
                              

function malformed()        {
  throw new VisualizationMalformedError()
}

function tooLarge()        {
  throw new VisualizationTooLargeError()
}

function safeMetadata(metadata                                         )               {
  if (metadata === undefined || metadata === null || typeof metadata !== 'object') return malformed()
  if (
    typeof metadata.runId !== 'string' ||
    typeof metadata.sequence !== 'number' || !Number.isSafeInteger(metadata.sequence) || metadata.sequence < 1 ||
    typeof metadata.name !== 'string' || metadata.name.length === 0 || metadata.name.length > 500 ||
    metadata.name === '.' || metadata.name === '..' || metadata.name.startsWith('.') ||
    metadata.name.includes('/') || metadata.name.includes('\\') || /[\u0000-\u001f\u007f\r\n]/.test(metadata.name) ||
    typeof metadata.mimeType !== 'string' || metadata.mimeType.length === 0 || metadata.mimeType.length > 127
  ) return malformed()
  return {
    runId: metadata.runId,
    sequence: metadata.sequence,
    name: metadata.name,
    mimeType: metadata.mimeType,
  }
}

function decode(bytes            )         {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > SERVER_ARTIFACT_VISUALIZATION_SOURCE_MAX_BYTES) return tooLarge()
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) || /(^|[^\r])\r(?!\n)/.test(text)) return malformed()
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
const CANONICAL_NONNEGATIVE_INTEGER_PATTERN = /^(?:0|[1-9][0-9]*)$/
const CANONICAL_POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/

function realToken(value        )         {
  if (typeof value !== 'string' || !DECIMAL_REAL_PATTERN.test(value)) return malformed()
  const number = Number(value.replace(/[dD]/, 'e'))
  return Number.isFinite(number) ? number : malformed()
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

function discardedTitle(line         )       {
  if (typeof line !== 'string' || line.length > 1024 || /[\u0000-\u001f\u007f]/.test(line)) return malformed()
}

function skipBlankLines(lines                   , start        )         {
  let index = start
  while (index < lines.length && tokens(lines[index] ).length === 0) index += 1
  return index
}

function exactCar(line         )       {
  if (line !== 'CAR') return malformed()
}

/** @internal Pure prospective plot cardinality guard. */
export function assertPlotBudget(kind          , spinChannels        , points        , bands         )       {
  if ((kind !== 'band' && kind !== 'dos') || !Number.isSafeInteger(spinChannels) || (spinChannels !== 1 && spinChannels !== 2)) return tooLarge()
  if (!Number.isSafeInteger(points) || points < 1) return tooLarge()
  const boundedMultiply = (left        , right        )         => {
    if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left < 1 || right < 1) return tooLarge()
    if (left > Math.floor(SERVER_ARTIFACT_VISUALIZATION_MAX_GRID_POINTS / right)) return tooLarge()
    return left * right
  }
  const boundedAdd = (left        , right        )         => {
    if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left < 0 || right < 0) return tooLarge()
    if (left > SERVER_ARTIFACT_VISUALIZATION_MAX_GRID_POINTS - right) return tooLarge()
    return left + right
  }
  let numericValues        
  if (kind === 'band') {
    const bandCount = bands
    if (typeof bandCount !== 'number' || !Number.isSafeInteger(bandCount) || bandCount < 1) return tooLarge()
    const kpointCoordinatesAndWeight = boundedMultiply(points, 4)
    const spinPointBands = boundedMultiply(boundedMultiply(spinChannels, points), bandCount)
    numericValues = boundedAdd(kpointCoordinatesAndWeight, boundedMultiply(spinPointBands, 2))
  } else if (bands !== undefined) {
    return tooLarge()
  } else {
    const spinPointValues = boundedMultiply(boundedMultiply(spinChannels, points), 2)
    numericValues = boundedAdd(points, spinPointValues)
  }
  const maxJsonNumericValues = Math.floor(
    (SERVER_ARTIFACT_VISUALIZATION_MAX_RESOURCE_BYTES - PLOT_JSON_FIXED_OVERHEAD_BYTES) /
    PLOT_JSON_NUMERIC_SEPARATOR_BYTES,
  )
  if (numericValues > maxJsonNumericValues) return tooLarge()
}

/** @internal Exact derived JSON-resource byte guard used before returning bytes. */
export function assertPlotResourceBudget(byteLength        )       {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > SERVER_ARTIFACT_VISUALIZATION_MAX_RESOURCE_BYTES) return tooLarge()
}

function serialize(payload                                   )             {
  let text        
  try {
    text = JSON.stringify(payload)
  } catch {
    return malformed()
  }
  if (typeof text !== 'string') return malformed()
  const bytes = new TextEncoder().encode(text)
  assertPlotResourceBudget(bytes.byteLength)
  return bytes
}

                       
              
                  
                             
                         
                   
                     
                       
      
              
                 
                           
                         
                    
                         
      

function outputPlot(
  metadata                                         ,
  manifestData                  ,
  payload                                   ,
)             {
  const source = safeMetadata(metadata)
  const bytes = serialize(payload)
  const descriptor = {
    id: 'plot',
    role: 'plot.values'         ,
    mimeType: JSON_MIME,
    byteLength: bytes.byteLength,
  }
  const manifest = {
    version: 1         ,
    source,
    resources: [descriptor],
    ...manifestData,
    resourceId: 'plot',
  }                                       
  return { manifest, resources: [{ descriptor, bytes }] }
}

function safeName(value         )                  {
  return typeof value === 'string' && value.length > 0 && value.length <= 500 &&
    value !== '.' && value !== '..' && !value.startsWith('.') && !value.includes('/') && !value.includes('\\') &&
    !/[\u0000-\u001f\u007f\r\n]/.test(value)
}

function exactBasename(value         , basename        )          {
  return safeName(value) && value.toLowerCase() === basename
}

function exactMime(value         , expected        )          {
  return value === expected
}

function parseEigenvalUnsafe(bytes            , metadata                              )             {
  const lines = linesOf(decode(bytes))
  if (lines.length < 6) return malformed()
  const first = tokens(lines[0])
  if (first.length !== 4) return malformed()
  const ionCount = positiveIntegerToken(first[0] )
  if (positiveIntegerToken(first[1] ) !== ionCount) return malformed()
  if (ionCount > SERVER_ARTIFACT_VISUALIZATION_MAX_ATOMS) return tooLarge()
  nonnegativeIntegerToken(first[2] )
  const spinChannels = nonnegativeIntegerToken(first[3] )
  if (spinChannels !== 1 && spinChannels !== 2) return malformed()
  const second = tokens(lines[1])
  if (second.length !== 5) return malformed()
  second.forEach(realToken)
  const third = tokens(lines[2])
  if (third.length !== 1) return malformed()
  realToken(third[0] )
  exactCar(lines[3])
  discardedTitle(lines[4])
  const counts = tokens(lines[5])
  if (counts.length !== 3) return malformed()
  const electrons = realToken(counts[0] )
  if (electrons < 0) return malformed()
  const kpointsCount = positiveIntegerToken(counts[1] )
  const bands = positiveIntegerToken(counts[2] )
  assertPlotBudget('band', spinChannels, kpointsCount, bands)

  const kpoints             = new Array(kpointsCount)
  const weights           = new Array(kpointsCount)
  const energies               = Array.from({ length: spinChannels }, () => new Array(kpointsCount))
  const occupations               = Array.from({ length: spinChannels }, () => new Array(kpointsCount))
  let index = 6
  for (let point = 0; point < kpointsCount; point += 1) {
    index = skipBlankLines(lines, index)
    const header = tokens(lines[index++] ?? '')
    if (header.length !== 4) return malformed()
    const coordinates = [realToken(header[0] ), realToken(header[1] ), realToken(header[2] )]
    const weight = realToken(header[3] )
    kpoints[point] = coordinates
    weights[point] = weight
    const pointEnergies             = Array.from({ length: spinChannels }, () => new Array(bands))
    const pointOccupations             = Array.from({ length: spinChannels }, () => new Array(bands))
    for (let band = 0; band < bands; band += 1) {
      const row = tokens(lines[index++] ?? '')
      if (row.length !== 1 + spinChannels * 2) return malformed()
      const bandIndex = positiveIntegerToken(row[0] )
      if (bandIndex !== band + 1) return malformed()
      if (spinChannels === 1) {
        pointEnergies[0] [band] = realToken(row[1] )
        pointOccupations[0] [band] = realToken(row[2] )
      } else {
        pointEnergies[0] [band] = realToken(row[1] )
        pointEnergies[1] [band] = realToken(row[2] )
        pointOccupations[0] [band] = realToken(row[3] )
        pointOccupations[1] [band] = realToken(row[4] )
      }
    }
    for (let spin = 0; spin < spinChannels; spin += 1) {
      energies[spin] [point] = pointEnergies[spin] 
      occupations[spin] [point] = pointOccupations[spin] 
    }
  }
  if (skipBlankLines(lines, index) !== lines.length) return malformed()
  return outputPlot(metadata, {
    kind: 'band',
    format: 'vasp-eigenval',
    spinChannels: spinChannels         ,
    bands,
    kpoints: kpointsCount,
    fermiEnergy: null,
  }, { kpoints, weights, energies, occupations })
}

                                                                                              

function parseDosHeader(line         , expectedPoints         )            {
  const values = tokens(line)
  if (values.length !== 5) return malformed()
  const emax = realToken(values[0] )
  const emin = realToken(values[1] )
  const points = positiveIntegerToken(values[2] )
  const fermiEnergy = realToken(values[3] )
  if (realToken(values[4] ) !== 1) return malformed()
  if (expectedPoints !== undefined && points !== expectedPoints) return malformed()
  return { emax, emin, points, fermiEnergy }
}

function projectedBlock(
  lines                   ,
  start        ,
  totalHeader           ,
  totalEnergy                   ,
  expectedWidth                    ,
)                                       {
  let index = skipBlankLines(lines, start)
  const header = parseDosHeader(lines[index++], totalHeader.points)
  if (
    header.emax !== totalHeader.emax ||
    header.emin !== totalHeader.emin ||
    header.points !== totalHeader.points ||
    header.fermiEnergy !== totalHeader.fermiEnergy
  ) return malformed()
  let width = expectedWidth
  for (let row = 0; row < totalHeader.points; row += 1) {
    const values = tokens(lines[index++] ?? '')
    if (values.length < 2 || (width !== undefined && values.length !== width)) return malformed()
    width ??= values.length
    values.forEach(realToken)
    if (realToken(values[0] ) !== totalEnergy[row]) return malformed()
  }
  if (width === undefined) return malformed()
  return { nextIndex: index, width }
}

function parseDoscarUnsafe(bytes            , metadata                              )             {
  const lines = linesOf(decode(bytes))
  if (lines.length < 6) return malformed()
  const first = tokens(lines[0])
  if (first.length !== 4) return malformed()
  const ionCount = positiveIntegerToken(first[0] )
  if (positiveIntegerToken(first[1] ) !== ionCount) return malformed()
  const partial = nonnegativeIntegerToken(first[2] )
  if (partial !== 0 && partial !== 1) return malformed()
  nonnegativeIntegerToken(first[3] )
  if (ionCount > SERVER_ARTIFACT_VISUALIZATION_MAX_ATOMS) return tooLarge()
  const second = tokens(lines[1])
  if (second.length !== 5) return malformed()
  second.forEach(realToken)
  const third = tokens(lines[2])
  if (third.length !== 1) return malformed()
  realToken(third[0] )
  exactCar(lines[3])
  discardedTitle(lines[4])
  const totalHeader = parseDosHeader(lines[5])
  let index = 6
  const firstRow = tokens(lines[index++] ?? '')
  if (firstRow.length !== 3 && firstRow.length !== 5) return malformed()
  const spinChannels = firstRow.length === 3 ? 1 : 2
  assertPlotBudget('dos', spinChannels, totalHeader.points)
  const energy           = new Array(totalHeader.points)
  const density             = Array.from({ length: spinChannels }, () => new Array(totalHeader.points))
  const integrated             = Array.from({ length: spinChannels }, () => new Array(totalHeader.points))
  let previousEnergy                    
  for (let point = 0; point < totalHeader.points; point += 1) {
    const row = point === 0 ? firstRow : tokens(lines[index++] ?? '')
    if (row.length !== (spinChannels === 1 ? 3 : 5)) return malformed()
    const currentEnergy = realToken(row[0] )
    if (previousEnergy !== undefined && !(currentEnergy > previousEnergy)) return malformed()
    previousEnergy = currentEnergy
    energy[point] = currentEnergy
    if (spinChannels === 1) {
      density[0] [point] = realToken(row[1] )
      integrated[0] [point] = realToken(row[2] )
    } else {
      density[0] [point] = realToken(row[1] )
      density[1] [point] = realToken(row[2] )
      integrated[0] [point] = realToken(row[3] )
      integrated[1] [point] = realToken(row[4] )
    }
  }
  if (partial === 1) {
    let projectedWidth                    
    for (let ion = 0; ion < ionCount; ion += 1) {
      const block = projectedBlock(lines, index, totalHeader, energy, projectedWidth)
      index = block.nextIndex
      projectedWidth = block.width
    }
  }
  if (skipBlankLines(lines, index) !== lines.length) return malformed()
  return outputPlot(metadata, {
    kind: 'dos',
    format: 'vasp-doscar',
    spinChannels: spinChannels         ,
    points: totalHeader.points,
    fermiEnergy: totalHeader.fermiEnergy,
  }, { energy, density, integrated })
}

function prepareSafely(parser                                                                           , bytes            , metadata                              )             {
  try {
    return parser(bytes, metadata)
  } catch (error) {
    if (error instanceof VisualizationMalformedError || error instanceof VisualizationTooLargeError) throw error
    throw new VisualizationMalformedError()
  }
}

export const EIGENVAL_VISUALIZATION_ADAPTER                       = Object.freeze({
  id: 'vasp-eigenval-v1',
  version: '1',
  match(source                                                        )          {
    return exactBasename(source?.name, 'eigenval') && exactMime(source?.mimeType, EIGENVAL_MIME)
  },
  async prepare(bytes            , metadata                              ) {
    return prepareSafely(parseEigenvalUnsafe, bytes, metadata)
  },
})

export const DOSCAR_VISUALIZATION_ADAPTER                       = Object.freeze({
  id: 'vasp-doscar-v1',
  version: '1',
  match(source                                                        )          {
    return exactBasename(source?.name, 'doscar') && exactMime(source?.mimeType, DOSCAR_MIME)
  },
  async prepare(bytes            , metadata                              ) {
    return prepareSafely(parseDoscarUnsafe, bytes, metadata)
  },
})

export const VASP_PLOT_VISUALIZATION_ADAPTERS                                  = Object.freeze([
  EIGENVAL_VISUALIZATION_ADAPTER,
  DOSCAR_VISUALIZATION_ADAPTER,
])

export const parseEigenval = (bytes            , metadata                              ) => (
  prepareSafely(parseEigenvalUnsafe, bytes, metadata)
)

export const parseDoscar = (bytes            , metadata                              ) => (
  prepareSafely(parseDoscarUnsafe, bytes, metadata)
)

export { VisualizationMalformedError, VisualizationTooLargeError }
