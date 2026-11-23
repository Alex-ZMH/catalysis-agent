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

export type VolumeVisualizationManifest = Extract<
  ServerArtifactVisualizationManifest,
  { kind: 'volume' }
>

export type VolumeVisualizationVector = Readonly<{ x: number; y: number; z: number }>

export type VolumeVisualizationData = Readonly<{
  data: Float32Array
  size: VolumeVisualizationVector
  origin: VolumeVisualizationVector
  unit: VolumeVisualizationVector
  matrix: unknown
}>

export type VolumeVisualizationIsosurfaceSpec = Readonly<{
  isoval: number
  color: string
  opacity: number
}>

export type VolumeVisualizationViewer = Readonly<{
  addIsosurface(data: VolumeVisualizationData, spec: VolumeVisualizationIsosurfaceSpec): unknown
  addBox?(spec: {
    corner: VolumeVisualizationVector
    dimensions: { w: number; h: number; d: number }
    hidden?: boolean
  }): unknown
  removeShape?(shape: unknown): unknown
  removeAllShapes(): unknown
  render(): unknown
  zoomTo?(): unknown
  clear?(): unknown
  setBackgroundColor?(color: string, alpha: number): unknown
}>

export type VolumeVisualizationRuntime = Readonly<{
  viewer: VolumeVisualizationViewer
  createMatrix4(elements: readonly number[]): unknown
  createVolumeData(input: {
    data: Float32Array
    size: VolumeVisualizationVector
    origin: VolumeVisualizationVector
    unit: VolumeVisualizationVector
    matrix: unknown
  }): VolumeVisualizationData
}>

export type VolumeVisualizationLoader = (
  container: HTMLElement,
  options?: Readonly<{ minimumZoomToDistance: number }>,
) => VolumeVisualizationRuntime | Promise<VolumeVisualizationRuntime>

export type VolumeVisualizationIdentity = Readonly<{
  runId: string
  sequence: number
}>

export type VolumeVisualizationProps = Readonly<{
  manifest: VolumeVisualizationManifest
  /** Auth/project/thread freshness fence. */
  scopeKey?: string
  /** The exact descriptor selected by the parsed manifest is passed through unchanged. */
  loadResource(
    resource: ServerArtifactVisualizationResource,
    signal?: AbortSignal,
  ): Promise<Blob>
  /** Optional host generation guard for selection/scope transitions. */
  isCurrent?(): boolean
  /** Optional host identity fence; manifest.source remains the data identity. */
  identity?: VolumeVisualizationIdentity | string
  /** Retry or host generation fence. */
  generation?: number
  /** Optional identity override for hosts that key more than run + sequence. */
  identityKey?: string
  /** Injectable 3Dmol seam used by tests; production lazily imports 3Dmol. */
  viewerLoader?: VolumeVisualizationLoader
  /** Render-safe fallback owned by the surrounding result panel. */
  fallback?: React.ReactNode | (() => React.ReactNode)
}>

const DEFAULT_POSITIVE_COLOR = '#3f69b1'
const DEFAULT_NEGATIVE_COLOR = '#c33b3b'
const DEFAULT_OPACITY = 0.75
const GEOMETRY_EPSILON = 1e-10
/** Match the authenticated scientific-resource budget used by the original panel. */
export const VOLUME_VISUALIZATION_MAX_RESOURCE_BYTES = 256 * 1024 * 1024

type VolumeStatus = 'loading' | 'ready' | 'error'

type VolumeValueRange = Readonly<{ minimum: number; maximum: number }>

type ThresholdBounds = Readonly<{ lower: number; upper: number }>

type GridGeometry = Readonly<{
  dimensions: readonly [number, number, number]
  cardinality: number
  origin: VolumeVisualizationVector
  axes: readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
  ]
  matrixElements: readonly number[] | null
  unit: VolumeVisualizationVector
}>

type VolumeVisualizationWorldBounds = Readonly<{
  corner: VolumeVisualizationVector
  dimensions: Readonly<{ w: number; h: number; d: number }>
}>

function publicName(manifest: VolumeVisualizationManifest): string {
  const safe = manifest.source.name.replace(/[\\/\u0000-\u001f\u007f]/g, '_').trim()
  return safe || '体数据文件'
}

function fallbackContent(
  fallback: VolumeVisualizationProps['fallback'],
  message: string,
): React.ReactNode {
  if (typeof fallback === 'function') return fallback()
  return fallback ?? <p>{message}</p>
}

function manifestIdentity(manifest: VolumeVisualizationManifest): string {
  return [
    manifest.source.runId,
    manifest.source.sequence,
    manifest.source.name,
    manifest.source.mimeType,
    manifest.format,
    manifest.dimensions.join(','),
    manifest.origin.join(','),
    manifest.axes.map((axis) => axis.join(',')).join(';'),
    manifest.resources.map((resource) => [
      resource.id,
      resource.role,
      resource.mimeType,
      resource.byteLength,
    ].join(',')).join(';'),
    manifest.channels.map((channel) => [
      channel.id,
      channel.resourceId,
      channel.minimum,
      channel.maximum,
    ].join(',')).join(';'),
  ].join('\u0000')
}

function resolveIdentityKey(
  identity: VolumeVisualizationIdentity | string | undefined,
  manifest: VolumeVisualizationManifest,
): string {
  if (typeof identity === 'string') return identity
  if (identity !== undefined) return `${identity.runId}\u0000${identity.sequence}`
  return `${manifest.source.runId}\u0000${manifest.source.sequence}`
}

function isFiniteVector(vector: readonly number[]): boolean {
  return vector.length === 3 && vector.every((value) => typeof value === 'number' && Number.isFinite(value))
}

function isFloat32Representable(value: number): boolean {
  return Number.isFinite(value) && Number.isFinite(Math.fround(value))
}

function vectorLength(vector: readonly number[]): number {
  return Math.hypot(vector[0] ?? 0, vector[1] ?? 0, vector[2] ?? 0)
}

function determinant(
  a: readonly number[],
  b: readonly number[],
  c: readonly number[],
): number {
  return (a[0] ?? 0) * ((b[1] ?? 0) * (c[2] ?? 0) - (b[2] ?? 0) * (c[1] ?? 0))
    - (a[1] ?? 0) * ((b[0] ?? 0) * (c[2] ?? 0) - (b[2] ?? 0) * (c[0] ?? 0))
    + (a[2] ?? 0) * ((b[0] ?? 0) * (c[1] ?? 0) - (b[1] ?? 0) * (c[0] ?? 0))
}

function axisAligned(axes: readonly (readonly number[])[]): boolean {
  return axes.every((axis, row) => axis.every((value, column) => (
    row === column ? Math.abs(value) > GEOMETRY_EPSILON : Math.abs(value) <= GEOMETRY_EPSILON
  )))
}

function validateGeometry(manifest: VolumeVisualizationManifest): GridGeometry {
  if (manifest.format !== 'cube' && manifest.format !== 'chgcar' && manifest.format !== 'elfcar') {
    throw new Error('unsupported format')
  }
  const dimensions = manifest.dimensions
  if (
    dimensions.length !== 3
    || dimensions.some((value) => !Number.isSafeInteger(value) || value < 1)
  ) throw new Error('invalid geometry')
  const cardinality = dimensions[0] * dimensions[1] * dimensions[2]
  if (!Number.isSafeInteger(cardinality) || cardinality < 1 || cardinality > SERVER_ARTIFACT_VISUALIZATION_MAX_GRID_POINTS) {
    throw new Error('invalid geometry')
  }
  if (!isFiniteVector(manifest.origin) || manifest.axes.length !== 3 || manifest.axes.some((axis) => !isFiniteVector(axis))) {
    throw new Error('invalid geometry')
  }
  if (
    !manifest.origin.every(isFloat32Representable)
    || !manifest.axes.every((axis) => axis.every(isFloat32Representable))
  ) throw new Error('invalid geometry')
  const axes = manifest.axes as GridGeometry['axes']
  const terminal = [dimensions[0] - 1, dimensions[1] - 1, dimensions[2] - 1]
  for (const xCorner of [0, 1]) {
    for (const yCorner of [0, 1]) {
      for (const zCorner of [0, 1]) {
        const world = [
          manifest.origin[0]
            + (xCorner * terminal[0]) * axes[0][0]
            + (yCorner * terminal[1]) * axes[1][0]
            + (zCorner * terminal[2]) * axes[2][0],
          manifest.origin[1]
            + (xCorner * terminal[0]) * axes[0][1]
            + (yCorner * terminal[1]) * axes[1][1]
            + (zCorner * terminal[2]) * axes[2][1],
          manifest.origin[2]
            + (xCorner * terminal[0]) * axes[0][2]
            + (yCorner * terminal[1]) * axes[1][2]
            + (zCorner * terminal[2]) * axes[2][2],
        ]
        if (!world.every(isFloat32Representable)) throw new Error('invalid geometry')
      }
    }
  }
  const lengths = axes.map(vectorLength)
  if (lengths.some((value) => !isFloat32Representable(value) || value <= GEOMETRY_EPSILON)) throw new Error('invalid geometry')
  const determinantValue = determinant(axes[0], axes[1], axes[2])
  const determinantScale = GEOMETRY_EPSILON * lengths[0] * lengths[1] * lengths[2]
  if (
    !isFloat32Representable(determinantValue)
    || !Number.isFinite(determinantScale)
    || Math.abs(determinantValue) <= determinantScale
  ) {
    throw new Error('invalid geometry')
  }
  const origin: VolumeVisualizationVector = {
    x: manifest.origin[0],
    y: manifest.origin[1],
    z: manifest.origin[2],
  }
  const unit: VolumeVisualizationVector = {
    x: axes[0][0],
    y: axes[1][1],
    z: axes[2][2],
  }
  if (![unit.x, unit.y, unit.z].every(isFloat32Representable)) throw new Error('invalid geometry')
  if (!axisAligned(axes)) {
    // Matrix4's array constructor accepts column-major elements. The first
    // three columns are grid axes; the fourth is the world-space origin.
    const matrixElements = [
      axes[0][0], axes[0][1], axes[0][2], 0,
      axes[1][0], axes[1][1], axes[1][2], 0,
      axes[2][0], axes[2][1], axes[2][2], 0,
      origin.x, origin.y, origin.z, 1,
    ]
    if (!matrixElements.every(isFloat32Representable)) throw new Error('invalid geometry')
    return { dimensions, cardinality, origin, axes, matrixElements, unit }
  }
  return { dimensions, cardinality, origin, axes, matrixElements: null, unit }
}

function volumeWorldBounds(geometry: GridGeometry): VolumeVisualizationWorldBounds {
  const terminal = [
    geometry.dimensions[0] - 1,
    geometry.dimensions[1] - 1,
    geometry.dimensions[2] - 1,
  ]
  const minimum = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]
  const maximum = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY]
  for (const xCorner of [0, 1]) {
    for (const yCorner of [0, 1]) {
      for (const zCorner of [0, 1]) {
        const world = [
          geometry.origin.x
            + (xCorner * terminal[0]) * geometry.axes[0][0]
            + (yCorner * terminal[1]) * geometry.axes[1][0]
            + (zCorner * terminal[2]) * geometry.axes[2][0],
          geometry.origin.y
            + (xCorner * terminal[0]) * geometry.axes[0][1]
            + (yCorner * terminal[1]) * geometry.axes[1][1]
            + (zCorner * terminal[2]) * geometry.axes[2][1],
          geometry.origin.z
            + (xCorner * terminal[0]) * geometry.axes[0][2]
            + (yCorner * terminal[1]) * geometry.axes[1][2]
            + (zCorner * terminal[2]) * geometry.axes[2][2],
        ]
        if (!world.every(isFloat32Representable)) throw new Error('invalid geometry bounds')
        for (let index = 0; index < 3; index += 1) {
          minimum[index] = Math.min(minimum[index] ?? Number.POSITIVE_INFINITY, world[index] ?? Number.NaN)
          maximum[index] = Math.max(maximum[index] ?? Number.NEGATIVE_INFINITY, world[index] ?? Number.NaN)
        }
      }
    }
  }
  const dimensions = {
    w: (maximum[0] ?? Number.NaN) - (minimum[0] ?? Number.NaN),
    h: (maximum[1] ?? Number.NaN) - (minimum[1] ?? Number.NaN),
    d: (maximum[2] ?? Number.NaN) - (minimum[2] ?? Number.NaN),
  }
  if (!Object.values(dimensions).every((value) => value >= 0 && isFloat32Representable(value))) {
    throw new Error('invalid geometry bounds')
  }
  return {
    corner: {
      x: minimum[0] ?? Number.NaN,
      y: minimum[1] ?? Number.NaN,
      z: minimum[2] ?? Number.NaN,
    },
    dimensions,
  }
}

function minimumZoomToDistance(bounds: VolumeVisualizationWorldBounds): number {
  const diagonal = Math.hypot(
    bounds.dimensions.w,
    bounds.dimensions.h,
    bounds.dimensions.d,
  )
  if (!Number.isFinite(diagonal) || diagonal <= 0) throw new Error('invalid geometry bounds')
  const distance = Math.min(5, diagonal / 2)
  if (!Number.isFinite(distance) || distance <= 0) throw new Error('invalid geometry bounds')
  return distance
}

function colorIsSafe(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  if (/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/.test(normalized)) return true
  if (/^(?:rgb|rgba)\(\s*[0-9]{1,3}\s*,\s*[0-9]{1,3}\s*,\s*[0-9]{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/.test(normalized)) return true
  return new Set([
    'black', 'blue', 'cyan', 'green', 'magenta', 'orange', 'purple', 'red', 'white', 'yellow',
  ]).has(normalized)
}

function sanitizeColor(value: string, fallback: string): string {
  const normalized = value.trim()
  return colorIsSafe(normalized) ? normalized : fallback
}

const POSITIVE_THRESHOLD_EPSILON = Number.MIN_VALUE

function thresholdBounds(
  channel: VolumeVisualizationManifest['channels'][number] | undefined,
): ThresholdBounds {
  if (channel === undefined) return { lower: POSITIVE_THRESHOLD_EPSILON, upper: POSITIVE_THRESHOLD_EPSILON }
  const positive = Number.isFinite(channel.maximum) && channel.maximum > 0
  const negative = Number.isFinite(channel.minimum) && channel.minimum < 0
  if (positive && negative) {
    return {
      lower: POSITIVE_THRESHOLD_EPSILON,
      upper: Math.max(channel.maximum, Math.abs(channel.minimum)),
    }
  }
  if (positive) {
    const lower = Math.max(channel.minimum, POSITIVE_THRESHOLD_EPSILON)
    return { lower, upper: Math.max(lower, channel.maximum) }
  }
  if (negative) {
    const lower = Math.max(Math.abs(channel.maximum), POSITIVE_THRESHOLD_EPSILON)
    return { lower, upper: Math.max(lower, Math.abs(channel.minimum)) }
  }
  return { lower: POSITIVE_THRESHOLD_EPSILON, upper: POSITIVE_THRESHOLD_EPSILON }
}

function boundedThreshold(value: number, bounds: ThresholdBounds): number {
  const lower = Math.max(POSITIVE_THRESHOLD_EPSILON, bounds.lower)
  const upper = Math.max(lower, bounds.upper)
  if (!Number.isFinite(value) || value <= lower) return lower
  return Math.min(upper, value)
}

function defaultThreshold(
  channel: VolumeVisualizationManifest['channels'][number] | undefined,
): number {
  if (channel === undefined) return POSITIVE_THRESHOLD_EPSILON
  const bounds = thresholdBounds(channel)
  if (channel.minimum < 0 && channel.maximum > 0) {
    const signedReference = Math.min(Math.abs(channel.minimum), channel.maximum)
    return boundedThreshold(signedReference * 0.25, bounds)
  }
  const span = bounds.upper - bounds.lower
  return boundedThreshold(bounds.lower + Math.max(0, span) * 0.25, bounds)
}

function defaultThresholdForRange(
  channel: VolumeVisualizationManifest['channels'][number],
  range: VolumeValueRange,
): number {
  const bounds = thresholdBounds(channel)
  const descriptorDefault = defaultThreshold(channel)
  const positiveLower = Math.max(range.minimum > 0 ? range.minimum : POSITIVE_THRESHOLD_EPSILON, POSITIVE_THRESHOLD_EPSILON)
  const negativeLower = Math.max(range.maximum < 0 ? Math.abs(range.maximum) : POSITIVE_THRESHOLD_EPSILON, POSITIVE_THRESHOLD_EPSILON)
  const fitsPositive = range.maximum > 0
    && channel.maximum > 0
    && descriptorDefault >= positiveLower
    && descriptorDefault <= range.maximum
  const fitsNegative = range.minimum < 0
    && channel.minimum < 0
    && descriptorDefault >= negativeLower
    && descriptorDefault <= Math.abs(range.minimum)
  if (fitsPositive || fitsNegative) return descriptorDefault
  if (range.maximum > 0 && channel.maximum > 0) {
    return boundedThreshold(positiveLower + Math.max(0, range.maximum - positiveLower) * 0.25, bounds)
  }
  if (range.minimum < 0 && channel.minimum < 0) {
    return boundedThreshold(negativeLower + Math.max(0, Math.abs(range.minimum) - negativeLower) * 0.25, bounds)
  }
  return descriptorDefault
}

function resourceForChannel(
  manifest: VolumeVisualizationManifest,
  channel: VolumeVisualizationManifest['channels'][number],
  cardinality: number,
): ServerArtifactVisualizationResource {
  if (
    typeof channel.id !== 'string'
    || channel.id.length === 0
    || typeof channel.resourceId !== 'string'
    || !Number.isFinite(channel.minimum)
    || !Number.isFinite(channel.maximum)
    || channel.minimum > channel.maximum
  ) throw new Error('invalid channel')
  const matches = manifest.resources.filter((candidate) => candidate.id === channel.resourceId)
  if (matches.length !== 1) throw new Error('invalid resource')
  const resource = matches[0]
  if (resource === undefined || resource.role !== 'volume.values') throw new Error('invalid resource')
  if (resource.mimeType !== 'application/vnd.zeus.f32' && resource.mimeType !== 'application/vnd.zeus.f64') {
    throw new Error('invalid resource')
  }
  if (
    !Number.isSafeInteger(resource.byteLength)
    || resource.byteLength < 0
    || resource.byteLength > VOLUME_VISUALIZATION_MAX_RESOURCE_BYTES
  ) throw new Error('invalid resource')
  const bytesPerValue = resource.mimeType === 'application/vnd.zeus.f64' ? 8 : 4
  if (
    !Number.isSafeInteger(cardinality)
    || cardinality < 1
    || cardinality > Math.floor(VOLUME_VISUALIZATION_MAX_RESOURCE_BYTES / bytesPerValue)
  ) throw new Error('invalid resource')
  const expectedBytes = cardinality * bytesPerValue
  if (
    !Number.isSafeInteger(expectedBytes)
    || expectedBytes < 1
    || expectedBytes > VOLUME_VISUALIZATION_MAX_RESOURCE_BYTES
    || resource.byteLength !== expectedBytes
  ) throw new Error('invalid resource')
  return resource
}

async function decodeValues(
  resource: ServerArtifactVisualizationResource,
  blob: Blob,
  cardinality: number,
): Promise<Float32Array> {
  const bytesPerValue = resource.mimeType === 'application/vnd.zeus.f64' ? 8 : 4
  if (
    !Number.isSafeInteger(cardinality)
    || cardinality < 1
    || cardinality > Math.floor(VOLUME_VISUALIZATION_MAX_RESOURCE_BYTES / bytesPerValue)
  ) throw new Error('invalid resource bytes')
  const expectedBytes = cardinality * bytesPerValue
  if (
    !Number.isSafeInteger(expectedBytes)
    || expectedBytes > VOLUME_VISUALIZATION_MAX_RESOURCE_BYTES
    || resource.byteLength !== expectedBytes
    || blob.size !== expectedBytes
    || blob.type !== resource.mimeType
  ) throw new Error('invalid resource bytes')
  const bytes = await blob.arrayBuffer()
  if (bytes.byteLength !== expectedBytes) throw new Error('invalid resource bytes')
  const view = new DataView(bytes)
  const values = new Float32Array(cardinality)
  for (let index = 0; index < cardinality; index += 1) {
    const offset = index * bytesPerValue
    const value = bytesPerValue === 8
      ? view.getFloat64(offset, true)
      : view.getFloat32(offset, true)
    const converted = value
    if (!Number.isFinite(value) || !Number.isFinite(converted)) throw new Error('invalid resource values')
    values[index] = converted
    if (!Number.isFinite(values[index] ?? Number.NaN)) throw new Error('invalid resource values')
  }
  return values
}

function viewerValues(
  values: Float32Array,
  dimensions: readonly [number, number, number],
  format: VolumeVisualizationManifest['format'],
): Float32Array {
  if (format === 'cube') return values
  const [nx, ny, nz] = dimensions
  const reordered = new Float32Array(values.length)
  // The server's VASP adapters serialize x fastest (z -> y -> x), while
  // 3Dmol's VolumeData indexes x*ny*nz + y*nz + z (z fastest).
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        const serverIndex = (z * ny + y) * nx + x
        const viewerIndex = (x * ny + y) * nz + z
        reordered[viewerIndex] = values[serverIndex] ?? Number.NaN
      }
    }
  }
  return reordered
}

function rawRange(values: Float32Array): VolumeValueRange {
  let minimum = Number.POSITIVE_INFINITY
  let maximum = Number.NEGATIVE_INFINITY
  for (const value of values) {
    minimum = Math.min(minimum, value)
    maximum = Math.max(maximum, value)
  }
  return { minimum, maximum }
}

function clearViewer(viewer: VolumeVisualizationViewer | null): void {
  if (viewer === null) return
  try { viewer.removeAllShapes() } catch { /* best effort */ }
  try { viewer.clear?.() } catch { /* best effort */ }
}

function fitVolumeViewer(
  viewer: VolumeVisualizationViewer,
  bounds: VolumeVisualizationWorldBounds,
): void {
  if (typeof viewer.addBox !== 'function' || typeof viewer.removeShape !== 'function') {
    viewer.zoomTo?.()
    return
  }
  const helper = viewer.addBox({
    corner: bounds.corner,
    dimensions: bounds.dimensions,
    hidden: true,
  })
  if (helper === null || helper === undefined) throw new Error('viewer bounds unavailable')
  try {
    viewer.zoomTo?.()
  } finally {
    viewer.removeShape(helper)
  }
}

function viewerIsUsable(runtime: VolumeVisualizationRuntime | null | undefined): boolean {
  return runtime !== null
    && runtime !== undefined
    && runtime.viewer !== null
    && runtime.viewer !== undefined
    && typeof runtime.viewer.addIsosurface === 'function'
    && typeof runtime.viewer.removeAllShapes === 'function'
    && typeof runtime.viewer.render === 'function'
    && typeof runtime.createMatrix4 === 'function'
    && typeof runtime.createVolumeData === 'function'
}

async function defaultViewerLoader(
  container: HTMLElement,
  options: Readonly<{ minimumZoomToDistance: number }> = { minimumZoomToDistance: 5 },
): Promise<VolumeVisualizationRuntime> {
  const module = await import('3dmol')
  if (typeof module.createViewer !== 'function' || typeof module.VolumeData !== 'function' || typeof module.Matrix4 !== 'function') {
    throw new Error('3D viewer unavailable')
  }
  const viewer = module.createViewer(container, {
    backgroundColor: 'white',
    backgroundAlpha: 0,
    minimumZoomToDistance: options.minimumZoomToDistance,
  })
  if (viewer === null || viewer === undefined) throw new Error('3D viewer unavailable')
  return {
    viewer: viewer as unknown as VolumeVisualizationViewer,
    createMatrix4: (elements) => new module.Matrix4([...elements]),
    createVolumeData: (input) => {
      // Construct an empty VolumeData instance and replace only its bounded
      // typed grid. No source text is parsed or executed in this component.
      const data = new module.VolumeData('', 'cube') as unknown as Record<string, unknown>
      data.data = input.data
      data.size = input.size
      data.origin = input.origin
      data.unit = input.unit
      data.matrix = input.matrix
      data.inversematrix = null
      return data as unknown as VolumeVisualizationData
    },
  }
}

export function VolumeVisualization({
  manifest,
  scopeKey = '',
  loadResource,
  isCurrent = () => true,
  identity,
  generation = 0,
  identityKey,
  viewerLoader,
  fallback,
}: VolumeVisualizationProps) {
  const surfaceRef = React.useRef<HTMLDivElement | null>(null)
  const mountedRef = React.useRef(false)
  const generationRef = React.useRef(0)
  const viewerRef = React.useRef<VolumeVisualizationViewer | null>(null)
  const runtimeRef = React.useRef<VolumeVisualizationRuntime | null>(null)
  const dataRef = React.useRef<VolumeVisualizationData | null>(null)
  const geometryRef = React.useRef<GridGeometry | null>(null)
  const boundsRef = React.useRef<VolumeVisualizationWorldBounds | null>(null)
  const channelRef = React.useRef<VolumeVisualizationManifest['channels'][number] | null>(null)
  const valueRangeRef = React.useRef<VolumeValueRange | null>(null)
  const thresholdRef = React.useRef(defaultThreshold(manifest.channels[0]))
  const positiveColorRef = React.useRef(DEFAULT_POSITIVE_COLOR)
  const negativeColorRef = React.useRef(DEFAULT_NEGATIVE_COLOR)
  const opacityRef = React.useRef(DEFAULT_OPACITY)
  const currentGuardRef = React.useRef(isCurrent)
  const loadResourceRef = React.useRef(loadResource)
  const viewerLoaderRef = React.useRef(viewerLoader)
  const [selectedChannelId, setSelectedChannelId] = React.useState(manifest.channels[0]?.id ?? '')
  const [status, setStatus] = React.useState<VolumeStatus>('loading')
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null)
  const [threshold, setThreshold] = React.useState(() => defaultThreshold(manifest.channels[0]))
  const [positiveColor, setPositiveColor] = React.useState(DEFAULT_POSITIVE_COLOR)
  const [negativeColor, setNegativeColor] = React.useState(DEFAULT_NEGATIVE_COLOR)
  const [opacity, setOpacity] = React.useState(DEFAULT_OPACITY)

  const dataIdentity = identityKey ?? resolveIdentityKey(identity, manifest)
  const manifestKey = manifestIdentity(manifest)
  const selectedChannel = manifest.channels.find((channel) => channel.id === selectedChannelId)
    ?? manifest.channels[0]
  const currentGuard = () => mountedRef.current && currentGuardRef.current()

  currentGuardRef.current = isCurrent
  loadResourceRef.current = loadResource
  viewerLoaderRef.current = viewerLoader
  thresholdRef.current = threshold
  positiveColorRef.current = positiveColor
  negativeColorRef.current = negativeColor
  opacityRef.current = opacity

  React.useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      generationRef.current += 1
      clearViewer(viewerRef.current)
      viewerRef.current = null
      runtimeRef.current = null
      dataRef.current = null
      geometryRef.current = null
      boundsRef.current = null
      channelRef.current = null
      valueRangeRef.current = null
    }
  }, [])

  React.useEffect(() => {
    setSelectedChannelId((current) => manifest.channels.some((channel) => channel.id === current)
      ? current
      : manifest.channels[0]?.id ?? '')
  }, [manifestKey])

  const rebuild = React.useCallback(() => {
    const viewer = viewerRef.current
    const data = dataRef.current
    const channel = channelRef.current
    const bounds = boundsRef.current
    if (viewer === null || data === null || channel === null || bounds === null || !currentGuard()) return
    try {
      const thresholdRange = thresholdBounds(channel)
      const value = boundedThreshold(thresholdRef.current, thresholdRange)
      thresholdRef.current = value
      const range = valueRangeRef.current
      viewer.removeAllShapes()
      const hasPositive = range !== null
        && range.maximum > 0
        && channel.maximum > 0
        && value >= Math.max(range.minimum > 0 ? range.minimum : POSITIVE_THRESHOLD_EPSILON, POSITIVE_THRESHOLD_EPSILON)
        && value <= range.maximum
      const hasNegative = range !== null
        && range.minimum < 0
        && channel.minimum < 0
        && value >= Math.max(range.maximum < 0 ? Math.abs(range.maximum) : POSITIVE_THRESHOLD_EPSILON, POSITIVE_THRESHOLD_EPSILON)
        && value <= Math.abs(range.minimum)
      if (hasPositive) {
        viewer.addIsosurface(data, {
          isoval: value,
          color: positiveColorRef.current,
          opacity: opacityRef.current,
        })
      }
      if (hasNegative) {
        viewer.addIsosurface(data, {
          isoval: -value,
          color: negativeColorRef.current,
          opacity: opacityRef.current,
        })
      }
      fitVolumeViewer(viewer, bounds)
      viewer.render()
    } catch {
      if (!currentGuard()) return
      clearViewer(viewer)
      if (viewerRef.current === viewer) viewerRef.current = null
      runtimeRef.current = null
      dataRef.current = null
      geometryRef.current = null
      boundsRef.current = null
      channelRef.current = null
      valueRangeRef.current = null
      setStatus('error')
      setErrorMessage('3D 体数据预览不可用。')
    }
  }, [])

  React.useEffect(() => {
    const next = defaultThreshold(selectedChannel)
    thresholdRef.current = next
    setThreshold(next)
  }, [manifestKey, selectedChannel?.id])

  React.useEffect(() => {
    if (status === 'ready') rebuild()
  }, [negativeColor, opacity, positiveColor, rebuild, status, threshold])

  React.useEffect(() => {
    const channel = selectedChannel
    const generation = ++generationRef.current
    const controller = typeof AbortController === 'undefined' ? null : new AbortController()
    let cancelled = false
    const active = () => !cancelled
      && generationRef.current === generation
      && !controller?.signal.aborted
      && currentGuard()

    clearViewer(viewerRef.current)
    viewerRef.current = null
    runtimeRef.current = null
    dataRef.current = null
    geometryRef.current = null
    boundsRef.current = null
    channelRef.current = null
    valueRangeRef.current = null
    setStatus('loading')
    setErrorMessage(null)

    if (channel === undefined) {
      setStatus('error')
      setErrorMessage('体数据无法安全预览。')
      return () => {
        cancelled = true
        controller?.abort()
      }
    }

    let viewerAttempted = false
    let ownedViewer: VolumeVisualizationViewer | null = null
    const run = async () => {
      try {
        const geometry = validateGeometry(manifest)
        const bounds = volumeWorldBounds(geometry)
        const resource = resourceForChannel(manifest, channel, geometry.cardinality)
        const blob = await loadResourceRef.current(resource, controller?.signal)
        if (!active()) return
        const decodedValues = await decodeValues(resource, blob, geometry.cardinality)
        if (!active()) return
        const values = viewerValues(decodedValues, geometry.dimensions, manifest.format)
        const range = rawRange(values)
        if (!Number.isFinite(range.minimum) || !Number.isFinite(range.maximum)) throw new Error('invalid values')
        if (range.minimum < channel.minimum || range.maximum > channel.maximum) throw new Error('range mismatch')
        if (range.minimum === range.maximum) {
          setStatus('error')
          setErrorMessage('体数据为常数，无法生成等值面。')
          return
        }
        const container = surfaceRef.current
        if (container === null) throw new Error('viewer unavailable')
        const loader = viewerLoaderRef.current ?? defaultViewerLoader
        viewerAttempted = true
        const runtime = await loader(container, {
          minimumZoomToDistance: minimumZoomToDistance(bounds),
        })
        ownedViewer = runtime?.viewer ?? null
        if (!active()) {
          clearViewer(ownedViewer)
          ownedViewer = null
          return
        }
        if (!viewerIsUsable(runtime)) throw new Error('viewer unavailable')
        const matrix = geometry.matrixElements === null ? null : runtime.createMatrix4(geometry.matrixElements)
        const data = runtime.createVolumeData({
          data: values,
          size: { x: geometry.dimensions[0], y: geometry.dimensions[1], z: geometry.dimensions[2] },
          origin: matrix === null ? geometry.origin : { x: 0, y: 0, z: 0 },
          unit: matrix === null ? geometry.unit : { x: 1, y: 1, z: 1 },
          matrix,
        })
        if (data === null || data === undefined) throw new Error('volume unavailable')
        const initialThreshold = defaultThresholdForRange(channel, range)
        thresholdRef.current = initialThreshold
        setThreshold(initialThreshold)
        viewerRef.current = runtime.viewer
        runtimeRef.current = runtime
        dataRef.current = data
        geometryRef.current = geometry
        boundsRef.current = bounds
        channelRef.current = channel
        valueRangeRef.current = range
        runtime.viewer.setBackgroundColor?.('white', 0)
        ownedViewer = null
        if (!active()) {
          clearViewer(viewerRef.current)
          viewerRef.current = null
          runtimeRef.current = null
          dataRef.current = null
          geometryRef.current = null
          boundsRef.current = null
          channelRef.current = null
          valueRangeRef.current = null
          return
        }
        setStatus('ready')
      } catch {
        if (!active()) {
          clearViewer(viewerRef.current ?? ownedViewer)
          ownedViewer = null
          return
        }
        clearViewer(viewerRef.current ?? ownedViewer)
        ownedViewer = null
        viewerRef.current = null
        runtimeRef.current = null
        dataRef.current = null
        geometryRef.current = null
        boundsRef.current = null
        channelRef.current = null
        valueRangeRef.current = null
        setStatus('error')
        setErrorMessage(viewerAttempted ? '3D 体数据预览不可用。' : '体数据无法安全预览。')
      }
    }
    void run()

    return () => {
      cancelled = true
      controller?.abort()
      clearViewer(viewerRef.current)
      viewerRef.current = null
      runtimeRef.current = null
      dataRef.current = null
      geometryRef.current = null
      boundsRef.current = null
      channelRef.current = null
      valueRangeRef.current = null
    }
  }, [dataIdentity, generation, loadResource, manifestKey, rebuild, scopeKey, selectedChannel?.id, viewerLoader])

  const bounds = thresholdBounds(selectedChannel)
  const label = publicName(manifest)

  return (
    <section className="zeus-volume-visualization" aria-label={`${label} 体数据可视化`}>
      <div ref={surfaceRef} className="zeus-volume-visualization-surface" data-testid="volume-visualization-surface" />
      {status === 'loading' ? <p role="status" aria-label="正在加载体数据…">正在加载体数据…</p> : null}
      {status === 'error' ? (
        <div
          role="alert"
          aria-label={fallback === undefined ? (errorMessage ?? '体数据无法安全预览。') : undefined}
        >
          {fallbackContent(fallback, errorMessage ?? '体数据无法安全预览。')}
        </div>
      ) : null}
      {status !== 'error' && selectedChannel !== undefined ? (
        <div role="toolbar" aria-label="体数据控件">
          <label>
            通道
            <select
              aria-label="体数据通道"
              value={selectedChannel.id}
              onChange={(event) => setSelectedChannelId(event.currentTarget.value)}
            >
              {manifest.channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.label}</option>)}
            </select>
          </label>
          {status === 'ready' ? <>
            <label>
              阈值
              <input
                aria-label="等值面阈值"
                type="number"
                min={bounds.lower}
                max={bounds.upper}
                step="any"
                value={threshold}
                onChange={(event) => {
                  const next = Number(event.currentTarget.value)
                  const bounded = boundedThreshold(next, bounds)
                  setThreshold(bounded)
                }}
              />
            </label>
            <label>
              正值颜色
              <input
                aria-label="正值颜色"
                type="text"
                value={positiveColor}
                onChange={(event) => setPositiveColor(sanitizeColor(event.currentTarget.value, DEFAULT_POSITIVE_COLOR))}
              />
            </label>
            <label>
              负值颜色
              <input
                aria-label="负值颜色"
                type="text"
                value={negativeColor}
                onChange={(event) => setNegativeColor(sanitizeColor(event.currentTarget.value, DEFAULT_NEGATIVE_COLOR))}
              />
            </label>
            <label>
              透明度
              <input
                aria-label="等值面透明度"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={opacity}
                onChange={(event) => {
                  const next = Number(event.currentTarget.value)
                  setOpacity(Number.isFinite(next) ? Math.max(0, Math.min(1, next)) : DEFAULT_OPACITY)
                }}
              />
            </label>
          </> : null}
        </div>
      ) : null}
    </section>
  )
}
