import * as React from 'react'
import type {
  ServerArtifactVisualizationManifest,
  ServerArtifactVisualizationResource,
} from './scientific-visualization'
import {
  SERVER_ARTIFACT_VISUALIZATION_MAX_GRID_POINTS,
} from './scientific-visualization'

// Keep a runtime binding for consumers that transpile shared TSX with classic JSX.
void React

type PlotManifest = Extract<ServerArtifactVisualizationManifest, { kind: 'band' | 'dos' }>
type BandManifest = Extract<ServerArtifactVisualizationManifest, { kind: 'band' }>
type DosManifest = Extract<ServerArtifactVisualizationManifest, { kind: 'dos' }>

export type ScientificPlotResourceLoader = (
  resource: ServerArtifactVisualizationResource,
  signal?: AbortSignal,
) => Promise<Blob>

export type ScientificPlotIdentity = Readonly<{ runId: string; sequence: number }> | string

export type ScientificPlotVisualizationProps = Readonly<{
  manifest: PlotManifest
  /** The host receives this exact descriptor object; this component never creates a URL. */
  loadResource: ScientificPlotResourceLoader
  /** Auth/project/thread freshness fence. */
  scopeKey?: string
  /** Optional host identity fence; manifest.source remains the data identity. */
  identity?: ScientificPlotIdentity
  /** Retry or host generation fence. */
  generation?: number
  /** Render-safe fallback owned by the surrounding result panel. */
  fallback?: React.ReactNode | (() => React.ReactNode)
}>

export const SCIENTIFIC_PLOT_MAX_RENDERED_POINTS = 2_000
/** Match the authenticated scientific-resource budget used by the original panel. */
export const SCIENTIFIC_PLOT_MAX_RESOURCE_BYTES = 256 * 1024 * 1024
const SVG_WIDTH = 720
const SVG_HEIGHT = 360
const MARGIN = Object.freeze({ top: 28, right: 24, bottom: 46, left: 58 })
const PLOT_WIDTH = SVG_WIDTH - MARGIN.left - MARGIN.right
const PLOT_HEIGHT = SVG_HEIGHT - MARGIN.top - MARGIN.bottom
// Brighter, color-blind-conscious accents keep multiple series legible on the
// standalone dark surface while preserving stable series-to-color assignment.
const COLORS = ['#67e8f9', '#ff9b72', '#aab5ff', '#e7c974'] as const
const PLOT_MAX_SERIES = 1024

export type ScientificPlotPoint = Readonly<{ x: number; y: number; originalIndex?: number }>

type PlotSeries = Readonly<{
  id: string
  label: string
  color: string
  xValues: readonly number[]
  yValues: readonly number[]
  breakBefore: readonly boolean[]
}>

type PlotPayload = Readonly<{
  series: readonly PlotSeries[]
  xLabel: string
  yLabel: string
  xDomain: readonly [number, number]
  yDomain: readonly [number, number]
  reference: Readonly<{ value: number; label: string }>
  pathInfoLabel: string | null
}>

type Readout = Readonly<{ series: number; point: number }>

type PlainRecord = Record<string, unknown>

function fallbackContent(fallback: ScientificPlotVisualizationProps['fallback']): React.ReactNode {
  if (typeof fallback === 'function') return fallback()
  return fallback ?? <p role="alert">科学绘图不可用，仍可下载原始文件。</p>
}

function ownDataProperty(record: PlainRecord, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
    throw new Error('invalid scientific plot object')
  }
  return descriptor.value
}

function plainRecord(value: unknown): PlainRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid scientific plot object')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new Error('invalid scientific plot prototype')
  const record = value as PlainRecord
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== 'string') throw new Error('invalid scientific plot key')
    const descriptor = Object.getOwnPropertyDescriptor(record, key)
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error('invalid scientific plot descriptor')
    }
  }
  return record
}

function exactKeys(record: PlainRecord, keys: readonly string[]): void {
  const expected = new Set(keys)
  const ownKeys = Reflect.ownKeys(record)
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string' || !expected.has(key))) {
    throw new Error('invalid scientific plot keys')
  }
}

function denseArray(value: unknown, maximum = SERVER_ARTIFACT_VISUALIZATION_MAX_GRID_POINTS): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new Error('invalid scientific plot array')
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  if (
    lengthDescriptor === undefined
    || !Object.hasOwn(lengthDescriptor, 'value')
    || typeof lengthDescriptor.value !== 'number'
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || lengthDescriptor.value > maximum
  ) throw new Error('invalid scientific plot array length')
  const length = lengthDescriptor.value
  const keys = Reflect.ownKeys(value)
  if (keys.length !== length + 1) throw new Error('scientific plot array must be dense')
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error('scientific plot array must contain data indices')
    }
  }
  for (const key of keys) {
    if (key !== 'length' && (typeof key !== 'string' || !/^\d+$/.test(key))) {
      throw new Error('scientific plot array has extra properties')
    }
  }
  return value
}

function finiteNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('scientific plot value is not finite')
  return value
}

function safePositiveInteger(value: unknown, maximum = SERVER_ARTIFACT_VISUALIZATION_MAX_GRID_POINTS): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error('scientific plot count is invalid')
  }
  return value
}

function safeId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) throw new Error('scientific plot id is invalid')
  return value
}

function safeMime(value: unknown): string {
  if (typeof value !== 'string' || value !== 'application/json') throw new Error('scientific plot MIME is invalid')
  return value
}

function safeDescriptor(value: unknown): ServerArtifactVisualizationResource {
  const record = plainRecord(value)
  exactKeys(record, ['id', 'role', 'mimeType', 'byteLength'])
  const id = safeId(ownDataProperty(record, 'id'))
  if (ownDataProperty(record, 'role') !== 'plot.values') throw new Error('scientific plot role is invalid')
  const mimeType = safeMime(ownDataProperty(record, 'mimeType')) as 'application/json'
  const byteLength = ownDataProperty(record, 'byteLength')
  if (
    typeof byteLength !== 'number'
    || !Number.isSafeInteger(byteLength)
    || byteLength < 1
    || byteLength > SCIENTIFIC_PLOT_MAX_RESOURCE_BYTES
  ) throw new Error('scientific plot byte length is invalid')
  void id
  void mimeType
  // Preserve the descriptor object identity from the parsed manifest. The
  // authenticated host seam must never receive a reconstructed descriptor.
  return value as ServerArtifactVisualizationResource
}

function safeSource(value: unknown): void {
  const source = plainRecord(value)
  exactKeys(source, ['runId', 'sequence', 'name', 'mimeType'])
  safeId(ownDataProperty(source, 'runId'))
  const sequence = ownDataProperty(source, 'sequence')
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1) throw new Error('scientific plot source is invalid')
  const name = ownDataProperty(source, 'name')
  if (
    typeof name !== 'string'
    || name.length === 0
    || name.length > 500
    || name === '.'
    || name === '..'
    || name.startsWith('.')
    || name.includes('/')
    || name.includes('\\')
    || /[\u0000-\u001f\u007f\r\n]/.test(name)
  ) throw new Error('scientific plot source is invalid')
  const mime = ownDataProperty(source, 'mimeType')
  if (typeof mime !== 'string' || mime.length === 0 || mime.length > 127) throw new Error('scientific plot source is invalid')
}

function safeManifest(manifest: unknown): {
  manifest: PlotManifest
  resource: ServerArtifactVisualizationResource
} {
  const record = plainRecord(manifest)
  const kind = ownDataProperty(record, 'kind')
  if (kind !== 'band' && kind !== 'dos') throw new Error('unsupported scientific plot')
  const required = kind === 'band'
    ? ['version', 'source', 'resources', 'kind', 'format', 'spinChannels', 'bands', 'kpoints', 'fermiEnergy', 'resourceId']
    : ['version', 'source', 'resources', 'kind', 'format', 'spinChannels', 'points', 'fermiEnergy', 'resourceId']
  exactKeys(record, required)
  if (ownDataProperty(record, 'version') !== 1) throw new Error('scientific plot version is invalid')
  safeSource(ownDataProperty(record, 'source'))
  const resources = denseArray(ownDataProperty(record, 'resources'), 64)
  if (resources.length !== 1) throw new Error('scientific plot requires exactly one resource')
  const parsedResources = resources.map(safeDescriptor)
  const resourceId = safeId(ownDataProperty(record, 'resourceId'))
  const matches = parsedResources.filter((candidate) => candidate.id === resourceId)
  if (matches.length !== 1) throw new Error('scientific plot resource is missing')
  if (new Set(parsedResources.map((candidate) => candidate.id)).size !== parsedResources.length) throw new Error('scientific plot resources are duplicated')
  if (kind === 'band') {
    if (ownDataProperty(record, 'format') !== 'vasp-eigenval') throw new Error('unsupported scientific plot')
    const spinChannels = ownDataProperty(record, 'spinChannels')
    if (spinChannels !== 1 && spinChannels !== 2) throw new Error('scientific plot spin count is invalid')
    safePositiveInteger(ownDataProperty(record, 'bands'))
    safePositiveInteger(ownDataProperty(record, 'kpoints'))
    if (ownDataProperty(record, 'fermiEnergy') !== null) throw new Error('scientific plot Fermi energy is invalid')
    return {
      manifest: record as unknown as BandManifest,
      resource: matches[0]!,
    }
  }
  if (ownDataProperty(record, 'format') !== 'vasp-doscar') throw new Error('unsupported scientific plot')
  const spinChannels = ownDataProperty(record, 'spinChannels')
  if (spinChannels !== 1 && spinChannels !== 2) throw new Error('scientific plot spin count is invalid')
  safePositiveInteger(ownDataProperty(record, 'points'))
  finiteNumber(ownDataProperty(record, 'fermiEnergy'))
  return {
    manifest: record as unknown as DosManifest,
    resource: matches[0]!,
  }
}

function finiteProduct(...values: readonly number[]): number {
  let product = 1
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 1 || product > Math.floor(SERVER_ARTIFACT_VISUALIZATION_MAX_GRID_POINTS / value)) {
      throw new Error('scientific plot cardinality is too large')
    }
    product *= value
  }
  return product
}

function finiteArray(value: unknown, length: number): number[] {
  const array = denseArray(value, SERVER_ARTIFACT_VISUALIZATION_MAX_GRID_POINTS)
  if (array.length !== length) throw new Error('scientific plot cardinality mismatch')
  return array.map(finiteNumber)
}

function seriesPointCount(series: PlotSeries): number {
  if (series.xValues.length !== series.yValues.length || series.xValues.length < 1) {
    throw new Error('scientific plot series cardinality mismatch')
  }
  if (series.breakBefore.length !== series.xValues.length) throw new Error('scientific plot segment cardinality mismatch')
  return series.xValues.length
}

function pointAt(series: PlotSeries, index: number): ScientificPlotPoint {
  return { x: series.xValues[index]!, y: series.yValues[index]!, originalIndex: index }
}

function requiredIndices(series: PlotSeries): number[] {
  const count = seriesPointCount(series)
  const indices = new Set<number>([0, count - 1])
  for (let index = 1; index < count; index += 1) {
    if (series.breakBefore[index]) indices.add(index)
  }
  return [...indices].sort((left, right) => left - right)
}

function minimumDisplayPoints(series: PlotSeries): number {
  const count = seriesPointCount(series)
  if (count <= 4) return count
  return Math.max(4, requiredIndices(series).length)
}

function parseBandPayload(manifest: BandManifest, payload: unknown): PlotSeries[] {
  const record = plainRecord(payload)
  exactKeys(record, ['kpoints', 'weights', 'energies', 'occupations'])
  const kpoints = safePositiveInteger(manifest.kpoints)
  const bands = safePositiveInteger(manifest.bands)
  const spins = manifest.spinChannels
  finiteProduct(kpoints, bands, spins)
  const rawKpoints = denseArray(ownDataProperty(record, 'kpoints'))
  if (rawKpoints.length !== kpoints) throw new Error('scientific plot k-point cardinality mismatch')
  const kpointValues = rawKpoints.map((value) => finiteArray(value, 3))
  const weights = finiteArray(ownDataProperty(record, 'weights'), kpoints)
  const rawEnergies = denseArray(ownDataProperty(record, 'energies'), spins)
  const rawOccupations = denseArray(ownDataProperty(record, 'occupations'), spins)
  const energies: number[][][] = []
  const occupations: number[][][] = []
  for (let spin = 0; spin < spins; spin += 1) {
    const spinEnergies = denseArray(rawEnergies[spin], kpoints)
    const spinOccupations = denseArray(rawOccupations[spin], kpoints)
    energies.push(spinEnergies.map((value) => finiteArray(value, bands)))
    occupations.push(spinOccupations.map((value) => finiteArray(value, bands)))
  }
  void weights
  const distances: number[] = new Array(kpoints)
  const breakBefore: boolean[] = new Array(kpoints).fill(false)
  distances[0] = 0
  for (let point = 1; point < kpointValues.length; point += 1) {
    const previous = kpointValues[point - 1]!
    const current = kpointValues[point]!
    const step = Math.hypot(
      current[0]! - previous[0]!,
      current[1]! - previous[1]!,
      current[2]! - previous[2]!,
    )
    const distance = (distances[point - 1] ?? 0) + step
    if (!Number.isFinite(step) || !Number.isFinite(distance)) throw new Error('scientific plot k-path is not finite')
    distances[point] = distance
    breakBefore[point] = current[0] === previous[0] && current[1] === previous[1] && current[2] === previous[2]
  }
  const seriesCount = finiteProduct(spins, bands)
  if (seriesCount > PLOT_MAX_SERIES) throw new Error('scientific plot series count is invalid')
  const series: PlotSeries[] = []
  for (let spin = 0; spin < spins; spin += 1) {
    for (let band = 0; band < bands; band += 1) {
      const yValues = new Array<number>(kpoints)
      for (let point = 0; point < kpoints; point += 1) yValues[point] = energies[spin]![point]![band]!
      series.push({
        id: `${spin}-${band}`,
        label: spins === 1 ? `band ${band + 1}` : `${spin === 0 ? 'spin up' : 'spin down'} · band ${band + 1}`,
        color: COLORS[spin % COLORS.length]!,
        xValues: distances,
        yValues,
        breakBefore,
      })
    }
  }
  return series
}

function parseDosPayload(manifest: DosManifest, payload: unknown): PlotSeries[] {
  const record = plainRecord(payload)
  exactKeys(record, ['energy', 'density', 'integrated'])
  const points = safePositiveInteger(manifest.points)
  const spins = manifest.spinChannels
  finiteProduct(points, spins)
  const energy = finiteArray(ownDataProperty(record, 'energy'), points)
  for (let index = 1; index < energy.length; index += 1) {
    if (!(energy[index]! > energy[index - 1]!)) throw new Error('scientific plot energy order is invalid')
  }
  const density = denseArray(ownDataProperty(record, 'density'), spins)
  const integrated = denseArray(ownDataProperty(record, 'integrated'), spins)
  const series: PlotSeries[] = []
  for (let spin = 0; spin < spins; spin += 1) {
    const densityValues = finiteArray(density[spin], points)
    // Integrated DOS is part of the authenticated payload contract and is
    // revalidated even though the SVG only displays density.
    finiteArray(integrated[spin], points)
    const yValues = new Array<number>(points)
    for (let index = 0; index < points; index += 1) {
      const shifted = energy[index]! - manifest.fermiEnergy
      if (!Number.isFinite(shifted)) throw new Error('scientific plot shifted energy is not finite')
      yValues[index] = shifted
    }
    series.push({
      id: `${spin}`,
      label: spins === 1 ? 'density' : (spin === 0 ? 'spin up density' : 'spin down density'),
      color: COLORS[spin % COLORS.length]!,
      xValues: densityValues,
      yValues,
      breakBefore: new Array(points).fill(false),
    })
  }
  return series
}

function paddedDomain(minimum: number, maximum: number): [number, number] {
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) throw new Error('scientific plot domain is invalid')
  if (minimum === maximum) {
    const padding = Math.max(1, Math.abs(minimum) * 0.1)
    if (!Number.isFinite(padding)) throw new Error('scientific plot domain is invalid')
    minimum -= padding
    maximum += padding
  } else {
    const span = maximum - minimum
    if (!Number.isFinite(span)) throw new Error('scientific plot domain is invalid')
    const padding = span * 0.05
    if (!Number.isFinite(padding) || !Number.isFinite(minimum - padding) || !Number.isFinite(maximum + padding)) {
      throw new Error('scientific plot domain is invalid')
    }
    minimum -= padding
    maximum += padding
  }
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || !(maximum > minimum)) throw new Error('scientific plot domain is invalid')
  return [minimum, maximum]
}

function domain(series: readonly PlotSeries[], axis: 'x' | 'y', includeZero: boolean): [number, number] {
  let minimum = Number.POSITIVE_INFINITY
  let maximum = Number.NEGATIVE_INFINITY
  for (const entry of series) {
    seriesPointCount(entry)
    const values = axis === 'x' ? entry.xValues : entry.yValues
    for (const value of values) {
      if (!Number.isFinite(value)) throw new Error('scientific plot value is not finite')
      minimum = Math.min(minimum, value)
      maximum = Math.max(maximum, value)
    }
  }
  if (includeZero) {
    minimum = Math.min(minimum, 0)
    maximum = Math.max(maximum, 0)
  }
  return paddedDomain(minimum, maximum)
}

function parsePayload(manifest: PlotManifest, payload: unknown): PlotPayload {
  const series = manifest.kind === 'band' ? parseBandPayload(manifest, payload) : parseDosPayload(manifest, payload)
  if (series.length === 0 || series.length > PLOT_MAX_SERIES) throw new Error('scientific plot series count is invalid')
  let minimumDisplayTotal = 0
  for (const entry of series) minimumDisplayTotal += minimumDisplayPoints(entry)
  if (minimumDisplayTotal > SCIENTIFIC_PLOT_MAX_RENDERED_POINTS) throw new Error('scientific plot display budget is too small')
  const yDomain = domain(series, 'y', true)
  const reference = manifest.kind === 'dos'
    ? { value: 0, label: `E_F = ${formatNumber(manifest.fermiEnergy)} eV` }
    : { value: 0, label: 'energy zero (E_F unavailable / 费米能级不可用)' }
  const hasBreaks = series.some((entry) => entry.breakBefore.some(Boolean))
  return {
    series,
    xLabel: manifest.kind === 'dos' ? 'Density' : 'k-path distance',
    yLabel: manifest.kind === 'dos' ? 'Energy − E_F (eV)' : 'Energy (eV)',
    xDomain: domain(series, 'x', false),
    yDomain,
    reference,
    pathInfoLabel: manifest.kind === 'band' && !hasBreaks ? '源文件未提供路径分段信息' : null,
  }
}

function decodeJson(bytes: ArrayBuffer, resource: ServerArtifactVisualizationResource): unknown {
  if (bytes.byteLength !== resource.byteLength) throw new Error('scientific plot byte length mismatch')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const text = decoder.decode(bytes)
  if (text.length === 0) throw new Error('scientific plot JSON is empty')
  return JSON.parse(text) as unknown
}

async function loadAndParse(
  manifest: PlotManifest,
  resource: ServerArtifactVisualizationResource,
  loadResource: ScientificPlotResourceLoader,
  signal: AbortSignal,
): Promise<PlotPayload> {
  const blob = await loadResource(resource, signal)
  if (signal.aborted || blob === null || typeof blob !== 'object') throw new Error('scientific plot aborted')
  if (
    blob.type !== resource.mimeType
    || blob.size !== resource.byteLength
    || blob.size > SCIENTIFIC_PLOT_MAX_RESOURCE_BYTES
  ) throw new Error('scientific plot blob mismatch')
  const buffer = await blob.arrayBuffer()
  if (signal.aborted) throw new Error('scientific plot aborted')
  return parsePayload(manifest, decodeJson(buffer, resource))
}

/**
 * Deterministic first/last plus per-bucket min/max envelope decimation.
 * The helper is exported so embedders can test the display cap without a DOM.
 */
export function decimateScientificPlotSeries(
  points: readonly ScientificPlotPoint[],
  cap = SCIENTIFIC_PLOT_MAX_RENDERED_POINTS,
): ScientificPlotPoint[] {
  if (!Number.isSafeInteger(cap) || cap < 2) throw new Error('scientific plot display budget is invalid')
  if (points.length > cap && cap < 4) throw new Error('scientific plot display budget is too small')
  if (points.length <= cap) return [...points]
  const bucketCount = Math.max(1, Math.floor((cap - 2) / 2))
  const interiorCount = points.length - 2
  const output: ScientificPlotPoint[] = [points[0]!]
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = 1 + Math.floor((bucket * interiorCount) / bucketCount)
    const end = 1 + Math.floor(((bucket + 1) * interiorCount) / bucketCount)
    if (start >= end) continue
    let minimum = start
    let maximum = start
    for (let index = start + 1; index < end; index += 1) {
      if (points[index]!.y < points[minimum]!.y) minimum = index
      if (points[index]!.y > points[maximum]!.y) maximum = index
    }
    const ordered = minimum <= maximum ? [minimum, maximum] : [maximum, minimum]
    for (const index of ordered) {
      if (output.at(-1) !== points[index]!) output.push(points[index]!)
    }
  }
  const last = points.at(-1)!
  if (output.at(-1) !== last) output.push(last)
  return output.length > cap ? output.slice(0, cap - 1).concat(last) : output
}

function decimateIndices(
  series: PlotSeries,
  cap: number,
): number[] {
  const count = seriesPointCount(series)
  if (!Number.isSafeInteger(cap) || cap < 2) return count <= 2 ? Array.from({ length: count }, (_, index) => index) : [0, count - 1]
  if (count <= cap) return Array.from({ length: count }, (_, index) => index)
  const required = requiredIndices(series)
  if (required.length > cap) throw new Error('scientific plot display budget is too small')
  const requiredSet = new Set(required)
  const bucketCount = Math.max(1, Math.floor((cap - required.length) / 2))
  const interiorStart = 1
  const interiorCount = count - 2
  const selected = new Set<number>(required)
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = interiorStart + Math.floor((bucket * interiorCount) / bucketCount)
    const end = interiorStart + Math.floor(((bucket + 1) * interiorCount) / bucketCount)
    if (start >= end) continue
    let minimum = -1
    let maximum = -1
    for (let index = start; index < end; index += 1) {
      if (requiredSet.has(index)) continue
      if (minimum < 0) {
        minimum = index
        maximum = index
        continue
      }
      if (series.yValues[index]! < series.yValues[minimum]!) minimum = index
      if (series.yValues[index]! > series.yValues[maximum!]!) maximum = index
    }
    if (minimum >= 0) {
      selected.add(minimum)
      selected.add(maximum!)
    }
  }
  const indices = [...selected].sort((left, right) => left - right)
  if (indices.length > cap) {
    // Required first/last/break points are never sacrificed. This branch is
    // only possible when bucket extrema overlap in a pathological layout;
    // keep deterministic required points and let the caller render fallback
    // if they alone exceed the global budget.
    const trimmed = indices.filter((index) => requiredSet.has(index))
    if (trimmed.length > cap) throw new Error('scientific plot display budget is too small')
    return trimmed
  }
  return indices
}

function renderedPoints(series: PlotSeries, cap: number): ScientificPlotPoint[] {
  return decimateIndices(series, cap).map((index) => pointAt(series, index))
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const absolute = Math.abs(value)
  if (absolute !== 0 && (absolute >= 1e4 || absolute < 1e-3)) return value.toExponential(3)
  return Number(value.toFixed(4)).toString()
}

function ticks(minimum: number, maximum: number, count = 5): number[] {
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || !(maximum > minimum)) return [minimum]
  const values = Array.from({ length: count }, (_, index) => minimum + (maximum - minimum) * index / (count - 1))
  if (values.some((value) => !Number.isFinite(value))) throw new Error('scientific plot ticks are invalid')
  return values
}

function mappedX(value: number, range: readonly [number, number]): number {
  const span = range[1]! - range[0]!
  const mapped = MARGIN.left + ((value - range[0]!) / span) * PLOT_WIDTH
  if (!Number.isFinite(mapped)) throw new Error('scientific plot x mapping is invalid')
  return mapped
}

function mappedY(value: number, range: readonly [number, number]): number {
  const span = range[1]! - range[0]!
  const mapped = MARGIN.top + (1 - (value - range[0]!) / span) * PLOT_HEIGHT
  if (!Number.isFinite(mapped)) throw new Error('scientific plot y mapping is invalid')
  return mapped
}

function pointPath(
  points: readonly ScientificPlotPoint[],
  series: PlotSeries,
  xRange: readonly [number, number],
  yRange: readonly [number, number],
): string {
  return points.map((point, index) => {
    const originalIndex = point.originalIndex ?? index
    const isBreak = index === 0 || Boolean(series.breakBefore[originalIndex])
    return `${isBreak ? 'M' : 'L'}${mappedX(point.x, xRange).toFixed(3)},${mappedY(point.y, yRange).toFixed(3)}`
  }).join(' ')
}

function nearestPointIndex(
  event: React.PointerEvent<SVGPathElement>,
  points: readonly ScientificPlotPoint[],
  xRange: readonly [number, number],
): number {
  if (points.length <= 1) return 0
  const svg = event.currentTarget.ownerSVGElement
  const rect = svg?.getBoundingClientRect()
  const viewBoxX = rect !== undefined && rect.width > 0 && Number.isFinite(event.clientX)
    ? (event.clientX - rect.left) * (SVG_WIDTH / rect.width)
    : Number((event.nativeEvent as PointerEvent).offsetX)
  const ratio = Number.isFinite(viewBoxX)
    ? Math.max(0, Math.min(1, (viewBoxX - MARGIN.left) / PLOT_WIDTH))
    : 0
  const value = xRange[0]! + ratio * (xRange[1]! - xRange[0]!)
  let nearest = 0
  let distance = Number.POSITIVE_INFINITY
  points.forEach((point, index) => {
    const current = Math.abs(point.x - value)
    if (current < distance) {
      distance = current
      nearest = index
    }
  })
  return points[nearest]?.originalIndex ?? nearest
}

function scientificReadout(readout: Readout | null, payload: PlotPayload): string {
  if (readout === null) return '选择曲线以查看最近点。'
  const series = payload.series[readout.series]
  if (series === undefined || readout.point < 0 || readout.point >= series.xValues.length) return '选择曲线以查看最近点。'
  return `${series.label}: x: ${formatNumber(series.xValues[readout.point]!)} , y: ${formatNumber(series.yValues[readout.point]!)}`
}

function renderFallback(fallback: ScientificPlotVisualizationProps['fallback']): React.ReactNode {
  try {
    return fallbackContent(fallback)
  } catch {
    return <p role="alert">科学绘图不可用，仍可下载原始文件。</p>
  }
}

function identityTokenFor(
  manifest: unknown,
  identity: ScientificPlotIdentity | undefined,
): string {
  try {
    if (typeof identity === 'string') return identity
    if (identity !== undefined) {
      const record = plainRecord(identity)
      const runId = ownDataProperty(record, 'runId')
      const sequence = ownDataProperty(record, 'sequence')
      return `${String(runId)}\u0000${String(sequence)}`
    }
    const record = plainRecord(manifest)
    const source = plainRecord(ownDataProperty(record, 'source'))
    return `${String(ownDataProperty(source, 'runId'))}\u0000${String(ownDataProperty(source, 'sequence'))}`
  } catch {
    // Keep malformed authority objects out of the DOM and let the effect's
    // strict manifest validation render the safe fallback.
    return 'invalid-scientific-plot-identity'
  }
}

function allocateSeriesBudgets(series: readonly PlotSeries[]): number[] {
  const required = series.map((entry) => minimumDisplayPoints(entry))
  const requiredTotal = required.reduce((total, value) => total + value, 0)
  if (requiredTotal > SCIENTIFIC_PLOT_MAX_RENDERED_POINTS) throw new Error('scientific plot display budget is too small')
  const budgets = [...required]
  let remaining = SCIENTIFIC_PLOT_MAX_RENDERED_POINTS - requiredTotal
  const capacities = series.map((entry, index) => Math.max(0, seriesPointCount(entry) - required[index]!))
  const base = series.length === 0 ? 0 : Math.floor(remaining / series.length)
  for (let index = 0; index < budgets.length; index += 1) {
    const add = Math.min(capacities[index]!, base)
    budgets[index] = budgets[index]! + add
    remaining -= add
  }
  while (remaining > 0) {
    let progressed = false
    for (let index = 0; index < budgets.length && remaining > 0; index += 1) {
      if (capacities[index]! > budgets[index]! - required[index]!) {
        budgets[index] = budgets[index]! + 1
        remaining -= 1
        progressed = true
      }
    }
    if (!progressed) break
  }
  return budgets
}

export function ScientificPlotVisualization({
  manifest,
  loadResource,
  scopeKey = '',
  identity,
  generation = 0,
  fallback,
}: ScientificPlotVisualizationProps) {
  const [state, setState] = React.useState<Readonly<{ status: 'loading'; token: string } | { status: 'ready'; token: string; payload: PlotPayload } | { status: 'error'; token: string }>>({ status: 'loading', token: '' })
  const [readout, setReadout] = React.useState<Readout | null>(null)
  const svgRef = React.useRef<SVGSVGElement | null>(null)
  const loaderTokenRef = React.useRef<{ value: ScientificPlotResourceLoader; token: number } | null>(null)
  const manifestTokenRef = React.useRef<{ value: PlotManifest; token: number } | null>(null)
  if (loaderTokenRef.current === null || loaderTokenRef.current.value !== loadResource) {
    loaderTokenRef.current = { value: loadResource, token: (loaderTokenRef.current?.token ?? 0) + 1 }
  }
  if (manifestTokenRef.current === null || manifestTokenRef.current.value !== manifest) {
    manifestTokenRef.current = { value: manifest, token: (manifestTokenRef.current?.token ?? 0) + 1 }
  }
  const identityToken = identityTokenFor(manifest, identity)
  const activeToken = `${scopeKey}\u0000${identityToken}\u0000${generation}\u0000${loaderTokenRef.current.token}\u0000${manifestTokenRef.current.token}`

  React.useEffect(() => {
    const controller = new AbortController()
    let current = true
    setState({ status: 'loading', token: activeToken })
    setReadout(null)
    const run = async () => {
      try {
        const validated = safeManifest(manifest)
        const payload = await loadAndParse(validated.manifest, validated.resource, loadResource, controller.signal)
        if (!current || controller.signal.aborted) return
        setState({ status: 'ready', token: activeToken, payload })
      } catch {
        if (!current || controller.signal.aborted) return
        setState({ status: 'error', token: activeToken })
      }
    }
    void run()
    return () => {
      current = false
      controller.abort()
    }
  }, [activeToken, loadResource, manifest])

  if (state.status !== 'ready' || state.token !== activeToken) {
    return state.status === 'error' && state.token === activeToken
      ? renderFallback(fallback)
      : <p role="status">正在加载科学绘图…</p>
  }

  const payload = state.payload
  const xTicks = ticks(payload.xDomain[0]!, payload.xDomain[1]!)
  const yTicks = ticks(payload.yDomain[0]!, payload.yDomain[1]!)
  const seriesBudgets = allocateSeriesBudgets(payload.series)
  const renderedSeries = payload.series.map((series, seriesIndex) => {
    const points = renderedPoints(series, seriesBudgets[seriesIndex]!)
    return { series, points }
  })
  const decimated = renderedSeries.some(({ series, points }) => points.length < series.xValues.length)
  const referenceY = mappedY(payload.reference.value, payload.yDomain)

  const setSeriesReadout = (seriesIndex: number, pointIndex: number) => {
    const series = payload.series[seriesIndex]
    if (series === undefined || series.xValues.length === 0) return
    const bounded = Math.max(0, Math.min(series.xValues.length - 1, pointIndex))
    setReadout({ series: seriesIndex, point: bounded })
  }

  return (
    <figure className="scientific-plot-visualization" aria-labelledby="scientific-plot-title">
      <figcaption id="scientific-plot-title">{manifest.kind === 'band' ? '能带图' : '态密度图'}</figcaption>
      <div className="scientific-plot-toolbar">
        <span data-testid="scientific-plot-x-label">{payload.xLabel}</span>
        <span data-testid="scientific-plot-y-label">{payload.yLabel}</span>
        {decimated ? <span role="status">显示已抽稀</span> : null}
        {payload.pathInfoLabel !== null ? <span data-testid="scientific-plot-path-info">{payload.pathInfoLabel}</span> : null}
      </div>
      <svg
        ref={svgRef}
        data-testid="scientific-plot-svg"
        viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
        aria-labelledby="scientific-plot-title"
        width="100%"
      >
        <g data-testid="scientific-plot-axes" stroke="#7d817d" strokeWidth="1">
          <line x1={MARGIN.left} y1={MARGIN.top} x2={MARGIN.left} y2={SVG_HEIGHT - MARGIN.bottom} />
          <line x1={MARGIN.left} y1={SVG_HEIGHT - MARGIN.bottom} x2={SVG_WIDTH - MARGIN.right} y2={SVG_HEIGHT - MARGIN.bottom} />
        </g>
        {xTicks.map((value, index) => {
          const x = mappedX(value, payload.xDomain)
          return <g key={`x-${index}`} data-testid="scientific-plot-x-tick"><line x1={x} y1={SVG_HEIGHT - MARGIN.bottom} x2={x} y2={SVG_HEIGHT - MARGIN.bottom + 4} stroke="#7d817d" /><text x={x} y={SVG_HEIGHT - MARGIN.bottom + 18} textAnchor="middle" fontSize="10">{formatNumber(value)}</text></g>
        })}
        {yTicks.map((value, index) => {
          const y = mappedY(value, payload.yDomain)
          return <g key={`y-${index}`} data-testid="scientific-plot-y-tick"><line x1={MARGIN.left - 4} y1={y} x2={MARGIN.left} y2={y} stroke="#7d817d" /><text x={MARGIN.left - 8} y={y + 3} textAnchor="end" fontSize="10">{formatNumber(value)}</text></g>
        })}
        <line data-testid="scientific-plot-reference-line" x1={MARGIN.left} y1={referenceY} x2={SVG_WIDTH - MARGIN.right} y2={referenceY} stroke="#999b96" strokeDasharray="4 3" />
        <text x={SVG_WIDTH - MARGIN.right} y={Math.max(MARGIN.top + 10, referenceY - 4)} textAnchor="end" fontSize="10">{payload.reference.label}</text>
        <text x={(MARGIN.left + SVG_WIDTH - MARGIN.right) / 2} y={SVG_HEIGHT - 4} textAnchor="middle" fontSize="11">{payload.xLabel}</text>
        <text x="13" y={(MARGIN.top + SVG_HEIGHT - MARGIN.bottom) / 2} textAnchor="middle" fontSize="11" transform={`rotate(-90 13 ${(MARGIN.top + SVG_HEIGHT - MARGIN.bottom) / 2})`}>{payload.yLabel}</text>
        <g data-testid="scientific-plot-series-group">
          {renderedSeries.map(({ series, points }, seriesIndex) => (
            <path
              key={series.id}
              data-testid={`scientific-plot-series-${seriesIndex}-${series.id.split('-').at(-1) ?? seriesIndex}`}
              d={pointPath(points, series, payload.xDomain, payload.yDomain)}
              fill="none"
              stroke={series.color}
              strokeWidth="1.5"
              tabIndex={0}
              role="button"
              aria-label={series.label}
              onFocus={() => setSeriesReadout(seriesIndex, 0)}
              onPointerMove={(event) => setSeriesReadout(seriesIndex, nearestPointIndex(event, points, payload.xDomain))}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                event.preventDefault()
                const current = readout?.series === seriesIndex ? readout.point : 0
                setSeriesReadout(seriesIndex, current + (event.key === 'ArrowRight' ? 1 : -1))
              }}
            />
          ))}
        </g>
        <g data-testid="scientific-plot-legend">
          {payload.series
            .filter((series, index, all) => all.findIndex((candidate) => (
              candidate.label.startsWith('spin up')
                ? series.label.startsWith('spin up')
                : candidate.label.startsWith('spin down')
                  ? series.label.startsWith('spin down')
                  : candidate.label === series.label
            )) === index)
            .slice(0, 2)
            .map((series, index) => <text key={`legend-${series.id}`} x={MARGIN.left + index * 130} y={MARGIN.top - 8} fill={series.color} fontSize="10">{series.label.replace(/ · band \d+$/, '')}</text>)}
        </g>
      </svg>
      <p data-testid="scientific-plot-readout" role="status" aria-live="polite">{scientificReadout(readout, payload)}</p>
    </figure>
  )
}
