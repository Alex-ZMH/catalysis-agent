import {
  SERVER_ARTIFACT_VISUALIZATION_MAX_ATOMS,
  SERVER_ARTIFACT_VISUALIZATION_MAX_FRAMES,
  SERVER_ARTIFACT_VISUALIZATION_MAX_RESOURCE_BYTES,
  SERVER_ARTIFACT_VISUALIZATION_SOURCE_MAX_BYTES,
                                           
} from './scientific-visualization.mjs'

import {
  VisualizationMalformedError,
  VisualizationTooLargeError,
                            
                            
                                   
} from './visualization-preprocessor.mjs'
import { renderTrajectoryGif } from './trajectory-gif.mjs'

const F32_MIME = 'application/vnd.zeus.f32'         
const EXTXYZ_MIME = 'chemical/x-xyz'
const XDATCAR_MIME = 'chemical/x-vasp-xdatcar'
const LAMMPS_MIME = 'application/x-lammps-dump'

                                           
                                    
                                               

                                
                                              
                   
                    
                             
                   
                                
                           
                               
                   
                                
  

function malformed()        {
  throw new VisualizationMalformedError()
}

function tooLarge()        {
  throw new VisualizationTooLargeError()
}

function safeMetadata(metadata                                         )           {
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
    if (text.includes('\u0000') || /(^|[^\n])\r(?!\n)/.test(text)) return malformed()
    return text
  } catch {
    return malformed()
  }
}

function linesOf(text        )           {
  const lines = text.replaceAll('\r\n', '\n').split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function tokens(line         )           {
  if (typeof line !== 'string') return malformed()
  return line.trim().length === 0 ? [] : line.trim().split(/\s+/)
}

const DECIMAL_REAL_PATTERN = /^[+-]?(?:(?:[0-9]+(?:\.[0-9]*)?)|(?:\.[0-9]+))(?:[eE][+-]?[0-9]+)?$/
const CANONICAL_SIGNED_INTEGER_PATTERN = /^-?(?:0|[1-9][0-9]*)$/
const CANONICAL_POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/
const NONFINITE_NUMERIC_WORD_PATTERN = /^[+-]?(?:nan|inf(?:inity)?)$/i

function decimalRealToken(value        )         {
  if (typeof value !== 'string' || !DECIMAL_REAL_PATTERN.test(value)) return malformed()
  const number = Number(value)
  return Number.isFinite(number) ? number : malformed()
}

function integerToken(value        , minimum = Number.MIN_SAFE_INTEGER)         {
  if (typeof value !== 'string' || !CANONICAL_SIGNED_INTEGER_PATTERN.test(value)) return malformed()
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < minimum) return malformed()
  return number
}

function positiveIntegerToken(value        )         {
  if (typeof value !== 'string' || !CANONICAL_POSITIVE_INTEGER_PATTERN.test(value)) return malformed()
  const number = Number(value)
  if (!Number.isSafeInteger(number)) return malformed()
  return number > 0 ? number : malformed()
}

function f32(value        )         {
  if (!Number.isFinite(value)) return malformed()
  const rounded = Math.fround(value)
  if (!Number.isFinite(rounded)) return malformed()
  return rounded
}

/** @internal Pure prospective frame/resource budget guard for text adapters. */
export function assertTrajectoryFrameBudget(atomCount        , frameCount        , periodic         )       {
  if (atomCount < 1 || atomCount > SERVER_ARTIFACT_VISUALIZATION_MAX_ATOMS) return tooLarge()
  if (frameCount < 1 || frameCount > SERVER_ARTIFACT_VISUALIZATION_MAX_FRAMES) return tooLarge()
  const coordinateBytes = frameCount * atomCount * 3 * 4
  const cellBytes = periodic ? frameCount * 9 * 4 : 0
  if (!Number.isSafeInteger(coordinateBytes) || coordinateBytes > SERVER_ARTIFACT_VISUALIZATION_MAX_RESOURCE_BYTES) return tooLarge()
  if (!Number.isSafeInteger(cellBytes) || cellBytes > SERVER_ARTIFACT_VISUALIZATION_MAX_RESOURCE_BYTES) return tooLarge()
}

function assertResourceBudget(data                )       {
  assertTrajectoryFrameBudget(data.atomCount, data.frameCount, data.periodic)
  if (data.coordinates.length * 4 > SERVER_ARTIFACT_VISUALIZATION_MAX_RESOURCE_BYTES) return tooLarge()
  if (data.cells !== undefined && data.cells.length * 4 > SERVER_ARTIFACT_VISUALIZATION_MAX_RESOURCE_BYTES) return tooLarge()
}

function encode(values                   )             {
  const output = new Uint8Array(values.length * 4)
  const view = new DataView(output.buffer)
  for (let index = 0; index < values.length; index += 1) view.setFloat32(index * 4, f32(values[index] ), true)
  return output
}

function output(data                , metadata                                         )   
                                               
                                            
  {
  const source = safeMetadata(metadata)
  assertResourceBudget(data)
  if (data.elements.length !== data.atomCount) return malformed()
  const coordinates = encode(data.coordinates)
  const resources                         = [{
    descriptor: {
      id: 'coordinates', role: 'trajectory.coordinates', mimeType: F32_MIME, byteLength: coordinates.byteLength,
    },
    bytes: coordinates,
  }]
  if (data.periodic) {
    if (data.cells === undefined) return malformed()
    const cells = encode(data.cells)
    resources.push({
      descriptor: { id: 'cells', role: 'trajectory.cells', mimeType: F32_MIME, byteLength: cells.byteLength },
      bytes: cells,
    })
  } else if (data.cells !== undefined) {
    return malformed()
  }
  const frameTimes = data.frameTimes
  if (frameTimes !== undefined) {
    if (
      frameTimes.length !== data.frameCount ||
      data.timeUnit === undefined ||
      data.timeUnit === 'frame' ||
      frameTimes.some((value) => !Number.isFinite(value))
    ) return malformed()
  }
  const timeUnit = data.timeUnit ?? 'frame'
  const timeStep = data.timeStep ?? (
    frameTimes === undefined ? 1 : frameTimes.length < 2 ? 0 : frameTimes[1]  - frameTimes[0] 
  )
  if (!Number.isFinite(timeStep) || timeStep < 0) return malformed()
  if (data.format === 'lammps-dump') {
    const preview = renderTrajectoryGif(data)
    resources.push({
      descriptor: {
        id: 'preview_gif', role: 'trajectory.preview', mimeType: 'image/gif', byteLength: preview.byteLength,
      },
      bytes: preview,
    })
  }
  const manifest                                      = {
    version: 1,
    source,
    resources: resources.map((resource) => resource.descriptor),
    kind: 'trajectory',
    format: data.format,
    atomCount: data.atomCount,
    frameCount: data.frameCount,
    elements: [...data.elements],
    periodic: data.periodic,
    timeUnit,
    timeStep,
    ...(frameTimes === undefined ? {} : { frameTimes: [...frameTimes] }),
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
    if (error instanceof VisualizationMalformedError || error instanceof VisualizationTooLargeError) throw error
    throw new VisualizationMalformedError()
  }
}

function safeLabel(value        )         {
  if (value.length === 0 || value.length > 16 || !/^[A-Za-z][A-Za-z0-9+_.-]*$/.test(value)) return malformed()
  return value
}

function safeName(name         )                 {
  return typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..' &&
    !name.startsWith('.') && !name.includes('/') && !name.includes('\\') &&
    !/[\u0000-\u001f\u007f\r\n]/.test(name)
}

function exactExtension(name         , extensions                   )          {
  if (!safeName(name)) return false
  const lower = name.toLowerCase()
  return extensions.some((extension) => lower.endsWith(extension) && lower.length > extension.length)
}

function exactMime(mimeType         , expected        )          {
  return mimeType === expected
}

function quotedField(comment        , field        )                     {
  const expression = new RegExp(`(?:^|\\s)${field}\\s*=\\s*"([^"]*)"`)
  const match = expression.exec(comment)
  if (match === null) return undefined
  const prefix = comment.slice(0, match.index)
  const after = comment.slice(match.index + match[0].length)
  if (after.length > 0 && !/^\s/.test(after)) return malformed()
  if (new RegExp(`(?:^|\\s)${field}\\s*=`).test(after) || new RegExp(`(?:^|\\s)${field}\\s*=`).test(prefix)) return malformed()
  return match[1]
}

/**
 * EXTXYZ writers commonly emit the schema as a single unquoted token:
 * `Properties=species:S:1:pos:R:3`.  Accept that form in addition to the
 * quoted form while keeping duplicate keys and empty values malformed.
 */
function propertiesField(comment        )                     {
  const occurrences = [...comment.matchAll(/(?:^|\s)Properties\s*=/g)]
  if (occurrences.length > 1) return malformed()
  const match = /(?:^|\s)Properties\s*=\s*(?:"([^"]*)"|([^\s]+))/.exec(comment)
  if (match === null) return undefined
  const after = comment.slice(match.index + match[0].length)
  if (after.length > 0 && !/^\s/.test(after)) return malformed()
  const value = match[1] ?? match[2]
  return value === undefined || value.length === 0 ? malformed() : value
}

function parseExtxyzProperties(comment        )   
                         
                       
                        
                                                                                                      
  {
  const schema = propertiesField(comment)
  if (schema === undefined) return malformed()
  const parts = schema.split(':')
  if (parts.length === 0 || parts.length % 3 !== 0) return malformed()
  const columns                                                                                      = []
  const names = new Set        ()
  let offset = 0
  for (let index = 0; index < parts.length; index += 3) {
    const name = parts[index] 
    const typeToken = parts[index + 1]
    const count = positiveIntegerToken(parts[index + 2] )
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name) || names.has(name) || !/^[SRIL]$/.test(typeToken ?? '')) return malformed()
    const type = typeToken                         
    if (!Number.isSafeInteger(offset + count)) return tooLarge()
    names.add(name)
    columns.push({ name, type, count, offset })
    offset += count
  }
  const species = columns.filter((column) => column.name === 'species' && column.type === 'S' && column.count === 1)
  const positions = columns.filter((column) => column.name === 'pos' && column.type === 'R' && column.count === 3)
  if (species.length !== 1 || positions.length !== 1) return malformed()
  return { declaredColumns: offset, speciesOffset: species[0] .offset, positionOffset: positions[0] .offset, columns }
}

function parseLattice(comment        )                     {
  const value = quotedField(comment, 'Lattice')
  const hasLattice = /(?:^|\s)Lattice\s*=/.test(comment)
  if (value === undefined && hasLattice) return malformed()
  if (value === undefined) return undefined
  const values = tokens(value).map(decimalRealToken)
  if (values.length !== 9) return malformed()
  return [values.slice(0, 3)        , values.slice(3, 6)        , values.slice(6, 9)        ]
}

function parsePbc(comment        )                      {
  const value = quotedField(comment, 'pbc')
  const hasPbc = /(?:^|\s)pbc\s*=/.test(comment)
  if (value === undefined && hasPbc) return malformed()
  if (value === undefined) return undefined
  const flags = tokens(value).map((flag) => {
    if (/^(?:T|TRUE|1)$/i.test(flag)) return true
    if (/^(?:F|FALSE|0)$/i.test(flag)) return false
    return malformed()
  })
  if (flags.length !== 3 || flags.some((flag) => flag !== flags[0])) return malformed()
  return flags[0]
}

/**
 * Read an optional EXTXYZ scalar without making presentation metadata capable
 * of rejecting an otherwise valid trajectory. A missing or malformed value is
 * represented by null and makes the complete time sequence untrusted.
 */
function optionalScalarField(comment        , field        )                            {
  const key = new RegExp(`(?:^|\\s)${field}\\s*=`, 'g')
  const occurrences = [...comment.matchAll(key)]
  if (occurrences.length === 0) return undefined
  const expression = new RegExp(`(?:^|\\s)${field}\\s*=\\s*(?:"([^"]*)"|([^\\s]+))`, 'g')
  const values           = []
  for (const match of comment.matchAll(expression)) {
    const index = match.index
    if (index === undefined) return null
    const after = comment.slice(index + match[0].length)
    if (after.length > 0 && !/^\s/.test(after)) return null
    const value = match[1] ?? match[2]
    if (value === undefined) return null
    values.push(value)
  }
  // Some writers repeat metadata in a later provenance block. Repeated exact
  // values are equivalent; conflicting or malformed occurrences are not.
  if (values.length !== occurrences.length || values.some((value) => value !== values[0])) return null
  return values[0] ?? null
}

                                                                                              

function parseExtxyzFrameTime(comment        )                         {
  const rawTime = optionalScalarField(comment, 'Time')
  const rawUnit = optionalScalarField(comment, 'time_unit')
  if (rawTime === undefined && rawUnit === undefined) return null
  if (rawTime === null || rawUnit === null || rawTime === undefined || rawUnit === undefined) return null
  if (!DECIMAL_REAL_PATTERN.test(rawTime) || (rawUnit !== 'fs' && rawUnit !== 'ps')) return null
  const value = Number(rawTime)
  if (!Number.isFinite(value)) return null
  return { value, unit: rawUnit }
}

function parseExtxyzUnsafe(bytes            , metadata                              )   
                                               
                                            
  {
  const source = decode(bytes)
  const lines = linesOf(source)
  const coordinates           = []
  const cells           = []
  const elements           = []
  let atomCount                    
  let periodic                     
  let frameCount = 0
  let index = 0
  let trustedTimes = true
  let timeUnit                                                  
  const frameTimes           = []
  while (index < lines.length) {
    const countLine = lines[index++] 
    const countTokens = tokens(countLine)
    if (countTokens.length !== 1) return malformed()
    const frameAtoms = positiveIntegerToken(countTokens[0] )
    if (frameAtoms > SERVER_ARTIFACT_VISUALIZATION_MAX_ATOMS) return tooLarge()
    if (atomCount !== undefined && atomCount !== frameAtoms) return malformed()
    atomCount ??= frameAtoms
    const comment = lines[index++]
    if (comment === undefined || comment.trim().length === 0) return malformed()
    const schema = parseExtxyzProperties(comment)
    const lattice = parseLattice(comment)
    const pbc = parsePbc(comment)
    const frameTime = parseExtxyzFrameTime(comment)
    if (frameTime === null) {
      trustedTimes = false
    } else if (
      trustedTimes &&
      (timeUnit !== undefined && timeUnit !== frameTime.unit ||
        frameTimes.length > 0 && frameTime.value <= frameTimes.at(-1) )
    ) {
      trustedTimes = false
    } else if (trustedTimes) {
      timeUnit = frameTime.unit
      frameTimes.push(frameTime.value)
    }
    const framePeriodic = lattice !== undefined
    if (pbc !== undefined && pbc !== framePeriodic) return malformed()
    if (periodic !== undefined && periodic !== framePeriodic) return malformed()
    periodic ??= framePeriodic
    frameCount += 1
    if (frameCount > SERVER_ARTIFACT_VISUALIZATION_MAX_FRAMES) return tooLarge()
    assertTrajectoryFrameBudget(atomCount, frameCount, periodic)
    if (framePeriodic && lattice === undefined) return malformed()
    for (let atom = 0; atom < frameAtoms; atom += 1) {
      const row = lines[index++]
      if (row === undefined) return malformed()
      const values = tokens(row)
      if (values.length !== schema.declaredColumns) return malformed()
      const species = safeLabel(values[schema.speciesOffset] )
      const position = [
        decimalRealToken(values[schema.positionOffset] ),
        decimalRealToken(values[schema.positionOffset + 1] ),
        decimalRealToken(values[schema.positionOffset + 2] ),
      ]        
      for (const column of schema.columns) {
        for (let component = 0; component < column.count; component += 1) {
          const token = values[column.offset + component] 
          if (column.type === 'R') decimalRealToken(token)
          else if (column.type === 'I') integerToken(token)
          else if (column.type === 'L' && !/^(?:T|F|TRUE|FALSE|0|1)$/i.test(token)) return malformed()
        }
      }
      if (frameCount === 1) elements.push(species)
      else if (elements[atom] !== species) return malformed()
      coordinates.push(...position)
    }
    if (framePeriodic) cells.push(...lattice .flat())
  }
  if (atomCount === undefined || frameCount === 0 || periodic === undefined) return malformed()
  // The first frame's labels are added in the loop; the first atom enters the
  // array before the second atom, so append remaining labels as they arrive.
  if (elements.length !== atomCount) return malformed()
  return output({
    format: 'extxyz', atomCount, frameCount, elements, periodic,
    coordinates, ...(periodic ? { cells } : {}),
    ...(trustedTimes && timeUnit !== undefined && frameTimes.length === frameCount
      ? { timeUnit, frameTimes }
      : {}),
  }, metadata)
}

function parseVector(line        )       {
  const values = tokens(line)
  if (values.length !== 3) return malformed()
  return values.map(decimalRealToken)        
}

function parseXdatcarUnsafe(bytes            , metadata                              )   
                                               
                                            
  {
  const source = decode(bytes)
  const lines = linesOf(source)
  if (lines.length < 8) return malformed()
  let index = 0
  index += 1 // VASP comment
  const scale = decimalRealToken(tokens(lines[index++] ?? '')[0] ?? '')
  if (tokens(lines[index - 1] ?? '').length !== 1 || scale <= 0) return malformed()
  const lattice = [parseVector(lines[index++] ), parseVector(lines[index++] ), parseVector(lines[index++] )]
    .map((vector) => vector.map((value) => value * scale)        )
  const symbols = tokens(lines[index++] ?? '')
  if (symbols.length === 0 || symbols.some((symbol) => !/^[A-Za-z][A-Za-z0-9+_.-]*$/.test(symbol))) return malformed()
  const counts = tokens(lines[index++] ?? '')
  if (counts.length !== symbols.length || counts.length === 0) return malformed()
  const expanded           = []
  for (let symbolIndex = 0; symbolIndex < symbols.length; symbolIndex += 1) {
    const count = positiveIntegerToken(counts[symbolIndex] )
    if (count > SERVER_ARTIFACT_VISUALIZATION_MAX_ATOMS || expanded.length + count > SERVER_ARTIFACT_VISUALIZATION_MAX_ATOMS) return tooLarge()
    const label = safeLabel(symbols[symbolIndex] )
    for (let atom = 0; atom < count; atom += 1) expanded.push(label)
  }
  const atomCount = expanded.length
  const coordinates           = []
  const cells           = []
  let frameCount = 0
  let mode                                    
  let expectedConfiguration = 1
  while (index < lines.length) {
    const marker = lines[index++] 
    const match = /^(Direct|Cartesian)\s+configuration\s*=\s*(\d+)$/.exec(marker.trim())
    if (match === null) return malformed()
    const frameMode = (match[1] [0] .toUpperCase() + match[1] .slice(1).toLowerCase())                          
    const configuration = positiveIntegerToken(match[2] )
    if (configuration !== expectedConfiguration) return malformed()
    expectedConfiguration += 1
    if (mode !== undefined && mode !== frameMode) return malformed()
    mode ??= frameMode
    frameCount += 1
    if (frameCount > SERVER_ARTIFACT_VISUALIZATION_MAX_FRAMES) return tooLarge()
    assertTrajectoryFrameBudget(atomCount, frameCount, true)
    for (let atom = 0; atom < atomCount; atom += 1) {
      const row = lines[index++]
      if (row === undefined) return malformed()
      const values = tokens(row)
      if (values.length !== 3) return malformed()
      const position = values.map(decimalRealToken)        
      if (frameMode === 'Direct') {
        coordinates.push(
          position[0]  * lattice[0] [0]  + position[1]  * lattice[1] [0]  + position[2]  * lattice[2] [0] ,
          position[0]  * lattice[0] [1]  + position[1]  * lattice[1] [1]  + position[2]  * lattice[2] [1] ,
          position[0]  * lattice[0] [2]  + position[1]  * lattice[1] [2]  + position[2]  * lattice[2] [2] ,
        )
      } else {
        coordinates.push(position[0]  * scale, position[1]  * scale, position[2]  * scale)
      }
    }
    cells.push(...lattice.flat())
  }
  if (mode === undefined || frameCount === 0) return malformed()
  return output({ format: 'xdatcar', atomCount, frameCount, elements: expanded, periodic: true, coordinates, cells }, metadata)
}

                                                                                            

function parseLammpsBox(header        , lines          , index        )                                        {
  const headerTokens = tokens(header)
  if (headerTokens.length < 3 || headerTokens[0] !== 'ITEM:' || headerTokens[1] !== 'BOX' || headerTokens[2] !== 'BOUNDS') return malformed()
  const suffix = headerTokens.slice(3)
  if (suffix.length !== 3 && suffix.length !== 6) return malformed()
  const periodicFlags = suffix.slice(-3)
  if (!periodicFlags.every((flag) => flag === 'pp')) return malformed()
  const triclinic = suffix.length === 6 && suffix.slice(0, 3).join(' ') === 'xy xz yz'
  if (suffix.length === 6 && !triclinic) return malformed()
  const bounds             = []
  for (let axis = 0; axis < 3; axis += 1) {
    const values = tokens(lines[index + axis] ?? '')
    if (values.length !== (triclinic ? 3 : 2)) return malformed()
    bounds.push(values.map(decimalRealToken))
  }
  let xlo = bounds[0] [0] 
  let xhi = bounds[0] [1] 
  let ylo = bounds[1] [0] 
  let yhi = bounds[1] [1] 
  const zlo = bounds[2] [0] 
  const zhi = bounds[2] [1] 
  let xy = 0
  let xz = 0
  let yz = 0
  if (triclinic) {
    xy = bounds[0] [2] 
    xz = bounds[1] [2] 
    yz = bounds[2] [2] 
    xlo -= Math.min(0, xy, xz, xy + xz)
    xhi -= Math.max(0, xy, xz, xy + xz)
    ylo -= Math.min(0, yz)
    yhi -= Math.max(0, yz)
  }
  const lx = xhi - xlo
  const ly = yhi - ylo
  const lz = zhi - zlo
  if (!(lx > 0 && ly > 0 && lz > 0)) return malformed()
  return {
    box: {
      origin: [xlo, ylo, zlo],
      vectors: [[lx, 0, 0], [xy, ly, 0], [xz, yz, lz]],
      triclinic,
    },
    nextIndex: index + 3,
  }
}

function parseLammpsUnsafe(bytes            , metadata                              )   
                                               
                                            
  {
  const source = decode(bytes)
  const lines = linesOf(source)
  const coordinates           = []
  const cells           = []
  const elements           = []
  const ids           = []
  const types = new Map                ()
  let atomCount                    
  let frameCount = 0
  let index = 0
  while (index < lines.length) {
    if (lines[index++]?.trim() !== 'ITEM: TIMESTEP') return malformed()
    const timestep = tokens(lines[index++] ?? '')
    if (timestep.length !== 1) return malformed()
    integerToken(timestep[0] )
    if (lines[index++]?.trim() !== 'ITEM: NUMBER OF ATOMS') return malformed()
    const countTokens = tokens(lines[index++] ?? '')
    if (countTokens.length !== 1) return malformed()
    const frameAtoms = positiveIntegerToken(countTokens[0] )
    if (frameAtoms > SERVER_ARTIFACT_VISUALIZATION_MAX_ATOMS) return tooLarge()
    if (atomCount !== undefined && atomCount !== frameAtoms) return malformed()
    atomCount ??= frameAtoms
    // Check the prospective frame before reading/allocating any box, atom map,
    // or coordinate rows for it.
    assertTrajectoryFrameBudget(atomCount, frameCount + 1, true)
    const boxHeader = lines[index++]
    if (boxHeader === undefined) return malformed()
    const parsedBox = parseLammpsBox(boxHeader, lines, index)
    index = parsedBox.nextIndex
    const atomsHeader = lines[index++]
    if (atomsHeader === undefined) return malformed()
    const atomHeader = tokens(atomsHeader)
    if (atomHeader.length < 3 || atomHeader[0] !== 'ITEM:' || atomHeader[1] !== 'ATOMS') return malformed()
    const columns = atomHeader.slice(2)
    if (columns.length === 0 || new Set(columns).size !== columns.length) return malformed()
    const idColumn = columns.indexOf('id')
    const typeColumn = columns.indexOf('type')
    if (idColumn < 0 || typeColumn < 0) return malformed()
    const cartColumns = ['x', 'y', 'z'].map((name) => columns.indexOf(name))
    const scaledColumns = ['xs', 'ys', 'zs'].map((name) => columns.indexOf(name))
    const allCartesian = cartColumns.every((column) => column >= 0)
    const allScaled = scaledColumns.every((column) => column >= 0)
    if (
      allCartesian === allScaled ||
      (allCartesian && scaledColumns.some((column) => column >= 0)) ||
      (allScaled && cartColumns.some((column) => column >= 0)) ||
      (!allCartesian && !allScaled)
    ) return malformed()
    const elementColumn = columns.indexOf('element')
    const frameAtomsById = new Map                                                           ()
    for (let atom = 0; atom < frameAtoms; atom += 1) {
      const row = tokens(lines[index++] ?? '')
      if (row.length !== columns.length) return malformed()
      const id = positiveIntegerToken(row[idColumn] )
      if (frameAtomsById.has(id)) return malformed()
      const type = positiveIntegerToken(row[typeColumn] )
      let position      
      if (allScaled) {
        const scaled = scaledColumns.map((column) => decimalRealToken(row[column] ))        
        const vectors = parsedBox.box.vectors
        position = [
          scaled[0]  * vectors[0] [0]  + scaled[1]  * vectors[1] [0]  + scaled[2]  * vectors[2] [0] ,
          scaled[0]  * vectors[0] [1]  + scaled[1]  * vectors[1] [1]  + scaled[2]  * vectors[2] [1] ,
          scaled[0]  * vectors[0] [2]  + scaled[1]  * vectors[1] [2]  + scaled[2]  * vectors[2] [2] ,
        ]
      } else {
        position = cartColumns.map((column) => decimalRealToken(row[column] ))        
        position = [position[0]  - parsedBox.box.origin[0] , position[1]  - parsedBox.box.origin[1] , position[2]  - parsedBox.box.origin[2] ]
      }
      // LAMMPS positions are normalized to the true lower corner; scaled
      // positions are already relative to that origin.
      const element = elementColumn >= 0 ? safeLabel(row[elementColumn] ) : `T${type}`
      for (let column = 0; column < columns.length; column += 1) {
        if (column === idColumn || column === typeColumn || column === elementColumn ||
          cartColumns.includes(column) || scaledColumns.includes(column)) continue
        // Unknown declared columns remain opaque strings, but exact non-finite
        // numeric words are scientific inconsistencies rather than text.
        if (NONFINITE_NUMERIC_WORD_PATTERN.test(row[column] )) return malformed()
      }
      frameAtomsById.set(id, { type, element, position })
    }
    const frameIds = [...frameAtomsById.keys()].sort((left, right) => left - right)
    if (frameCount === 0) {
      ids.push(...frameIds)
      for (const id of frameIds) {
        const atom = frameAtomsById.get(id) 
        types.set(id, atom.type)
        elements.push(atom.element)
      }
    } else {
      if (frameIds.length !== ids.length || frameIds.some((id, atom) => id !== ids[atom])) return malformed()
      for (let atom = 0; atom < ids.length; atom += 1) {
        const id = ids[atom] 
        const current = frameAtomsById.get(id) 
        if (types.get(id) !== current.type || elements[atom] !== current.element) return malformed()
      }
    }
    frameCount += 1
    for (const id of ids) coordinates.push(...frameAtomsById.get(id) .position)
    cells.push(...parsedBox.box.vectors.flat())
  }
  if (atomCount === undefined || frameCount === 0 || elements.length !== atomCount) return malformed()
  return output({ format: 'lammps-dump', atomCount, frameCount, elements, periodic: true, coordinates, cells }, metadata)
}

export const EXTXYZ_VISUALIZATION_ADAPTER                       = Object.freeze({
  id: 'extxyz-v1',
  version: '3',
  match(source                                                               )          {
    return exactExtension(source.name, ['.extxyz']) && exactMime(source.mimeType, EXTXYZ_MIME)
  },
  async prepare(bytes            , metadata                              ) {
    return prepareSafely(parseExtxyzUnsafe, bytes, metadata)
  },
})

export const XDATCAR_VISUALIZATION_ADAPTER                       = Object.freeze({
  id: 'xdatcar-v1',
  version: '1',
  match(source                                                               )          {
    return safeName(source.name) && source.name.toLowerCase() === 'xdatcar' && exactMime(source.mimeType, XDATCAR_MIME)
  },
  async prepare(bytes            , metadata                              ) {
    return prepareSafely(parseXdatcarUnsafe, bytes, metadata)
  },
})

export const LAMMPS_DUMP_VISUALIZATION_ADAPTER                       = Object.freeze({
  id: 'lammps-dump-v1',
  version: '2',
  match(source                                                               )          {
    return exactExtension(source.name, ['.lammpstrj', '.dump']) && exactMime(source.mimeType, LAMMPS_MIME)
  },
  async prepare(bytes            , metadata                              ) {
    return prepareSafely(parseLammpsUnsafe, bytes, metadata)
  },
})

export const TEXT_TRAJECTORY_VISUALIZATION_ADAPTERS                                  = Object.freeze([
  EXTXYZ_VISUALIZATION_ADAPTER,
  XDATCAR_VISUALIZATION_ADAPTER,
  LAMMPS_DUMP_VISUALIZATION_ADAPTER,
])

// Explicit parser exports make the strict syntax boundaries directly testable
// without weakening the VisualizationAdapter seam used by the preprocessor.
export const EXTXYZ_TRAJECTORY_ADAPTER = EXTXYZ_VISUALIZATION_ADAPTER
export const XDATCAR_TRAJECTORY_ADAPTER = XDATCAR_VISUALIZATION_ADAPTER
export const LAMMPS_DUMP_TRAJECTORY_ADAPTER = LAMMPS_DUMP_VISUALIZATION_ADAPTER

export const parseExtxyz = (bytes            , metadata                              ) => (
  prepareSafely(parseExtxyzUnsafe, bytes, metadata)
)
export const parseXdatcar = (bytes            , metadata                              ) => (
  prepareSafely(parseXdatcarUnsafe, bytes, metadata)
)
export const parseLammps = (bytes            , metadata                              ) => (
  prepareSafely(parseLammpsUnsafe, bytes, metadata)
)

export const parseExtxyzTrajectory = parseExtxyz
export const parseXdatcarTrajectory = parseXdatcar
export const parseLammpsDumpTrajectory = parseLammps

export { VisualizationMalformedError, VisualizationTooLargeError }
