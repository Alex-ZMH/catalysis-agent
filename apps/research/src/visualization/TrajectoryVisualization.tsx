import * as React from 'react'
import type {
  ServerArtifactVisualizationManifest,
  ServerArtifactVisualizationResource,
} from './scientific-visualization'

// Keep a runtime binding for consumers that transpile shared TSX with classic JSX.
void React

type TrajectoryManifest = Extract<ServerArtifactVisualizationManifest, { kind: 'trajectory' }>

export type TrajectoryViewer = Readonly<{
  addModel(data: string, format: string, options?: Record<string, unknown>): unknown
  setStyle(selection: Record<string, never>, style: Record<string, unknown>): unknown
  render(): unknown
  zoomTo?(): unknown
  addLine?(spec: Record<string, unknown>): unknown
  removeAllModels?(): unknown
  addUnitCell?(model?: unknown, style?: Record<string, unknown>): unknown
  /** Optional embedder seam for preserving the exact frame cell vectors. */
  setUnitCell?(vectors: readonly number[]): unknown
  removeUnitCell?(model?: unknown): unknown
  removeAllShapes?(): unknown
  clear?(): unknown
  getView?(): readonly number[]
  setView?(view: readonly number[]): unknown
  setBackgroundColor?(color: string, alpha?: number): unknown
}>

export type TrajectoryViewerLoader = (
  container: HTMLElement,
) => TrajectoryViewer | Promise<TrajectoryViewer>

export type TrajectoryResourceLoader = (
  resource: ServerArtifactVisualizationResource,
  signal?: AbortSignal,
) => Promise<Blob>

export type TrajectoryIdentity = Readonly<{
  runId: string
  sequence: number
}>

export type TrajectoryVisualizationProps = Readonly<{
  manifest: TrajectoryManifest
  loadResource: TrajectoryResourceLoader
  /** Auth/project/thread freshness fence. */
  scopeKey?: string
  /** Optional host identity fence; manifest.source remains the data identity. */
  identity?: TrajectoryIdentity | string
  /** Retry or host generation fence. */
  generation?: number
  /** Injectable seam for tests and embedders; production uses a lazy 3Dmol import. */
  viewerLoader?: TrajectoryViewerLoader
  /** Render-safe fallback owned by the surrounding result panel. */
  fallback?: React.ReactNode | (() => React.ReactNode)
}>

const EMPTY_SELECTION: Record<string, never> = Object.freeze({})
const TRAJECTORY_STYLE: Record<string, unknown> = Object.freeze({
  stick: { radius: 0.12 },
  sphere: { scale: 0.3 },
})
const UNIT_CELL_STYLE: Record<string, unknown> = Object.freeze({
  box: { color: '#8a8a83', lineWidth: 1 },
  astyle: { hidden: true },
  bstyle: { hidden: true },
  cstyle: { hidden: true },
  alabel: '',
  blabel: '',
  clabel: '',
})
const SPEEDS = [0.25, 0.5, 1, 2] as const
const BASE_FRAME_INTERVAL_MS = 1000
/** Match the authenticated scientific-resource budget used by the original panel. */
export const TRAJECTORY_VISUALIZATION_MAX_RESOURCE_BYTES = 256 * 1024 * 1024
export const TRAJECTORY_VISUALIZATION_MAX_TOTAL_RESOURCE_BYTES = 256 * 1024 * 1024
export const TRAJECTORY_VISUALIZATION_MAX_GIF_BYTES = 8 * 1024 * 1024

function identityKey(identity: TrajectoryIdentity | string | undefined, manifest: TrajectoryManifest): string {
  if (typeof identity === 'string') return identity
  if (identity !== undefined) return `${identity.runId}\u0000${identity.sequence}`
  return `${manifest.source.runId}\u0000${manifest.source.sequence}`
}

function resourceFor(
  manifest: TrajectoryManifest,
  role: 'trajectory.coordinates' | 'trajectory.cells' | 'trajectory.preview',
): ServerArtifactVisualizationResource | undefined {
  const matches = manifest.resources.filter((resource) => resource.role === role)
  return matches.length === 1 ? matches[0] : undefined
}

function resourceWidth(resource: ServerArtifactVisualizationResource): number {
  if (resource.mimeType === 'application/vnd.zeus.f32') return 4
  if (resource.mimeType === 'application/vnd.zeus.f64') return 8
  return 0
}

function boundedResourceBytes(
  resource: ServerArtifactVisualizationResource,
  expectedCount: number,
): number | null {
  const width = resourceWidth(resource)
  if (width === 0 || !Number.isSafeInteger(expectedCount) || expectedCount < 1) return null
  const expectedBytes = expectedCount * width
  if (
    !Number.isSafeInteger(expectedBytes)
    || expectedBytes > TRAJECTORY_VISUALIZATION_MAX_RESOURCE_BYTES
    || !Number.isSafeInteger(resource.byteLength)
    || resource.byteLength !== expectedBytes
  ) return null
  return expectedBytes
}

async function decodeFloatResource(
  resource: ServerArtifactVisualizationResource,
  blob: Blob,
  expectedCount: number,
): Promise<number[]> {
  const width = resourceWidth(resource)
  if (width === 0 || !Number.isSafeInteger(expectedCount) || expectedCount < 1) {
    throw new Error('invalid trajectory resource')
  }
  const expectedBytes = boundedResourceBytes(resource, expectedCount)
  if (expectedBytes === null) {
    throw new Error('trajectory resource cardinality mismatch')
  }
  if (!Number.isSafeInteger(blob.size) || blob.size !== expectedBytes) {
    throw new Error('trajectory resource byte length mismatch')
  }
  const blobType = typeof blob.type === 'string' ? blob.type.toLowerCase() : ''
  if (blobType !== resource.mimeType) throw new Error('trajectory resource MIME mismatch')

  const buffer = await blob.arrayBuffer()
  if (buffer.byteLength !== expectedBytes) throw new Error('trajectory resource byte length mismatch')
  const view = new DataView(buffer)
  const values = new Array<number>(expectedCount)
  for (let index = 0; index < expectedCount; index += 1) {
    const offset = index * width
    const value = width === 4
      ? view.getFloat32(offset, true)
      : view.getFloat64(offset, true)
    if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value))) {
      throw new Error('trajectory resource is outside Float32 range')
    }
    values[index] = value
  }
  return values
}

function finite(value: number): boolean {
  return Number.isFinite(value)
}

function numberText(value: number): string {
  if (!finite(value)) throw new Error('non-finite trajectory coordinate')
  return String(value)
}

function xyzText(
  elements: readonly string[],
  coordinates: readonly number[],
  atomCount: number,
  frame: number,
): string {
  const lines = [String(atomCount), `frame ${frame + 1}`]
  for (let atom = 0; atom < atomCount; atom += 1) {
    const offset = atom * 3
    lines.push([
      elements[atom] ?? 'X',
      numberText(coordinates[offset] ?? Number.NaN),
      numberText(coordinates[offset + 1] ?? Number.NaN),
      numberText(coordinates[offset + 2] ?? Number.NaN),
    ].join(' '))
  }
  return lines.join('\n')
}

type CellPoint = Readonly<{ x: number; y: number; z: number }>

function cellPoint(x: number, y: number, z: number): CellPoint {
  return { x, y, z }
}

/**
 * Draw a cell directly from the parsed 3x3 vectors.  The 3Dmol XYZ parser
 * stores lattice values in Float32Array and PDB CRYST1 is fixed-width, so
 * neither is an authority for exact vectors. GLViewer.addLine is public and
 * accepts arbitrary numeric coordinates, preserving orientation and precision.
 */
function drawUnitCell(viewer: TrajectoryViewer, model: unknown, cell: readonly number[]): void {
  if (cell.length !== 9 || cell.some((value) => !finite(value))) return
  const [ax, ay, az, bx, by, bz, cx, cy, cz] = cell
  const p0 = cellPoint(0, 0, 0)
  const p1 = cellPoint(ax!, ay!, az!)
  const p2 = cellPoint(bx!, by!, bz!)
  const p3 = cellPoint(cx!, cy!, cz!)
  const p4 = cellPoint(ax! + bx!, ay! + by!, az! + bz!)
  const p5 = cellPoint(bx! + cx!, by! + cy!, bz! + cz!)
  const p6 = cellPoint(ax! + cx!, ay! + cy!, az! + cz!)
  const p7 = cellPoint(ax! + bx! + cx!, ay! + by! + cy!, az! + bz! + cz!)
  const edges: readonly Readonly<{ start: CellPoint; end: CellPoint }>[] = [
    { start: p0, end: p1 }, { start: p0, end: p2 }, { start: p1, end: p4 }, { start: p2, end: p4 },
    { start: p0, end: p3 }, { start: p3, end: p5 }, { start: p2, end: p5 }, { start: p1, end: p6 },
    { start: p4, end: p7 }, { start: p6, end: p7 }, { start: p3, end: p6 }, { start: p5, end: p7 },
  ]
  if (typeof viewer.addLine === 'function') {
    for (const edge of edges) {
      viewer.addLine({ start: edge.start, end: edge.end, color: '#8a8a83', lineWidth: 1 })
    }
    return
  }
  // Keep the injectable seam useful for embedders that own an exact cell API.
  viewer.setUnitCell?.(cell)
  viewer.addUnitCell?.(model, UNIT_CELL_STYLE)
}

function clearViewer(viewer: TrajectoryViewer | null): void {
  if (viewer === null) return
  try {
    viewer.removeAllShapes?.()
  } catch {
    // WebGL context loss is already a terminal state; cleanup is best effort.
  }
  try {
    viewer.clear?.()
  } catch {
    // WebGL context loss is already a terminal state; cleanup is best effort.
  }
  if (typeof viewer.clear !== 'function') {
    try {
      viewer.removeAllModels?.()
    } catch {
      // Cleanup is best effort for a partial test/embedder adapter.
    }
  }
}

function removePreviousModel(viewer: TrajectoryViewer, model: unknown): void {
  if (model !== null && model !== undefined) {
    try {
      viewer.removeUnitCell?.(model)
    } catch {
      // The model may have been removed by a host viewer during context loss.
    }
  }
  try {
    viewer.removeAllShapes?.()
  } catch {
    // The model may have been removed by a host viewer during context loss.
  }
  if (typeof viewer.removeAllModels === 'function') viewer.removeAllModels()
  else viewer.clear?.()
}

function applyFrame(
  viewer: TrajectoryViewer,
  elements: readonly string[],
  coordinates: readonly number[],
  cells: readonly number[] | null,
  frame: number,
  atomCount: number,
  previousModel: unknown,
  firstFrame: boolean,
): unknown {
  const view = viewer.getView?.()
  if (!firstFrame) removePreviousModel(viewer, previousModel)
  const cellOffset = cells === null ? 0 : frame * 9
  const cell = cells === null ? null : cells.slice(cellOffset, cellOffset + 9)
  const coordinateOffset = frame * atomCount * 3
  const frameCoordinates = coordinates.slice(coordinateOffset, coordinateOffset + atomCount * 3)
  const model = viewer.addModel(xyzText(elements, frameCoordinates, atomCount, frame), 'xyz')
  viewer.setStyle(EMPTY_SELECTION, TRAJECTORY_STYLE)
  if (cell !== null) drawUnitCell(viewer, model, cell)
  if (firstFrame) viewer.zoomTo?.()
  else if (view !== undefined && viewer.setView !== undefined) viewer.setView(view)
  viewer.render()
  return model
}

async function defaultViewerLoader(container: HTMLElement): Promise<TrajectoryViewer> {
  const module = await import('3dmol')
  const viewer = module.createViewer(container, {
    backgroundColor: 'white',
    backgroundAlpha: 0,
  })
  if (viewer === null || viewer === undefined) throw new Error('3D viewer unavailable')
  return viewer as unknown as TrajectoryViewer
}

function fallbackContent(fallback: TrajectoryVisualizationProps['fallback']): React.ReactNode {
  if (typeof fallback === 'function') return fallback()
  return fallback ?? <p role="alert">轨迹预览不可用，仍可下载原始文件。</p>
}

function formatTime(frame: number, manifest: TrajectoryManifest): string {
  const value = manifest.frameTimes?.[frame] ?? frame * manifest.timeStep
  if (!finite(value)) return '时间不可用'
  const rounded = Number(value.toFixed(6))
  return `${rounded} ${manifest.timeUnit}`
}

function viewerIsUsable(viewer: TrajectoryViewer): boolean {
  return typeof viewer.addModel === 'function'
    && typeof viewer.setStyle === 'function'
    && typeof viewer.render === 'function'
}

export function TrajectoryVisualization({
  manifest,
  loadResource,
  scopeKey = '',
  identity,
  generation = 0,
  viewerLoader,
  fallback,
}: TrajectoryVisualizationProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const viewerRef = React.useRef<TrajectoryViewer | null>(null)
  const modelRef = React.useRef<unknown>(null)
  const coordinatesRef = React.useRef<readonly number[] | null>(null)
  const cellsRef = React.useRef<readonly number[] | null>(null)
  const frameRef = React.useRef(0)
  const timerRef = React.useRef<ReturnType<typeof setInterval> | null>(null)
  const playingRef = React.useRef(false)
  const generationRef = React.useRef(0)
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>('loading')
  const [frame, setFrameState] = React.useState(0)
  const [speed, setSpeed] = React.useState<number>(1)
  const [previewState, setPreviewState] = React.useState<Readonly<{ key: string; url: string }> | null>(null)
  const [, forcePlayingRender] = React.useReducer((value: number) => value + 1, 0)
  const renderedFrameRef = React.useRef<number | null>(null)

  const key = `${scopeKey}\u0000${identityKey(identity, manifest)}\u0000${generation}\u0000${manifest.source.runId}\u0000${manifest.source.sequence}`
  const coordinateResource = resourceFor(manifest, 'trajectory.coordinates')
  const cellResource = resourceFor(manifest, 'trajectory.cells')
  const previewResource = resourceFor(manifest, 'trajectory.preview')
  const previewKey = previewResource === undefined
    ? ''
    : `${key}\u0000${previewResource.id}\u0000${previewResource.byteLength}`
  const expectedCoordinates = manifest.frameCount * manifest.atomCount * 3
  const expectedCells = manifest.frameCount * 9

  frameRef.current = frame

  const clearTimer = React.useCallback(() => {
    const timer = timerRef.current
    if (timer !== null) {
      clearInterval(timer)
      timerRef.current = null
    }
  }, [])

  const stopPlayback = React.useCallback(() => {
    playingRef.current = false
    forcePlayingRender()
    clearTimer()
  }, [clearTimer])

  const armTimer = React.useCallback((selectedSpeed: number) => {
    clearTimer()
    if (!playingRef.current || manifest.frameCount < 2) return
    const delay = BASE_FRAME_INTERVAL_MS / selectedSpeed
    timerRef.current = setInterval(() => {
      const next = frameRef.current + 1
      if (next >= manifest.frameCount - 1) {
        frameRef.current = manifest.frameCount - 1
        setFrameState(manifest.frameCount - 1)
        stopPlayback()
        return
      }
      frameRef.current = next
      setFrameState(next)
    }, delay)
  }, [clearTimer, manifest.frameCount, stopPlayback])

  React.useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') stopPlayback()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      stopPlayback()
    }
  }, [stopPlayback])

  React.useEffect(() => {
    if (
      previewResource === undefined ||
      previewResource.mimeType !== 'image/gif' ||
      !Number.isSafeInteger(previewResource.byteLength) ||
      previewResource.byteLength < 6 ||
      previewResource.byteLength > TRAJECTORY_VISUALIZATION_MAX_GIF_BYTES ||
      typeof URL.createObjectURL !== 'function' ||
      typeof URL.revokeObjectURL !== 'function'
    ) {
      setPreviewState(null)
      return
    }
    const controller = typeof AbortController === 'undefined' ? null : new AbortController()
    let disposed = false
    let ownedUrl: string | null = null
    setPreviewState(null)
    const loadPreview = async () => {
      try {
        const blob = await loadResource(previewResource, controller?.signal)
        if (
          disposed ||
          blob.type.toLowerCase() !== 'image/gif' ||
          blob.size !== previewResource.byteLength
        ) return
        const header = new TextDecoder().decode(await blob.slice(0, 6).arrayBuffer())
        if (disposed || (header !== 'GIF87a' && header !== 'GIF89a')) return
        ownedUrl = URL.createObjectURL(blob)
        if (disposed) {
          URL.revokeObjectURL(ownedUrl)
          ownedUrl = null
          return
        }
        setPreviewState({ key: previewKey, url: ownedUrl })
      } catch {
        if (!disposed) setPreviewState(null)
      }
    }
    void loadPreview()
    return () => {
      disposed = true
      controller?.abort()
      if (ownedUrl !== null) URL.revokeObjectURL(ownedUrl)
    }
  }, [loadResource, previewKey, previewResource])

  React.useEffect(() => {
    let disposed = false
    let failed = false
    const runGeneration = ++generationRef.current
    let ownedViewer: TrajectoryViewer | null = null
    const controller = typeof AbortController === 'undefined' ? null : new AbortController()
    const active = () => !disposed && !failed && generationRef.current === runGeneration
    const container = containerRef.current
    const loader = viewerLoader ?? defaultViewerLoader
    const previousViewer = viewerRef.current
    viewerRef.current = null
    modelRef.current = null
    coordinatesRef.current = null
    cellsRef.current = null
    renderedFrameRef.current = null
    stopPlayback()
    setFrameState(0)
    frameRef.current = 0
    setStatus('loading')
    clearViewer(previousViewer)

    if (
      manifest.format !== 'extxyz' && manifest.format !== 'xdatcar' && manifest.format !== 'lammps-dump'
      || coordinateResource === undefined
      || cellResource !== undefined && !manifest.periodic
      || manifest.periodic && cellResource === undefined
      || container === null
    ) {
      setStatus('error')
      return () => {
        disposed = true
        generationRef.current += 1
        controller?.abort()
        stopPlayback()
      }
    }

    const coordinateBytes = boundedResourceBytes(coordinateResource, expectedCoordinates)
    const cellBytes = cellResource === undefined ? 0 : boundedResourceBytes(cellResource, expectedCells)
    if (
      coordinateBytes === null
      || cellBytes === null
      || coordinateBytes + cellBytes > TRAJECTORY_VISUALIZATION_MAX_TOTAL_RESOURCE_BYTES
    ) {
      setStatus('error')
      return () => {
        disposed = true
        generationRef.current += 1
        controller?.abort()
        stopPlayback()
      }
    }

    const loadedViewer = Promise.resolve().then(() => loader(container)).then((viewer) => {
      if (!active()) {
        clearViewer(viewer)
        return viewer
      }
      ownedViewer = viewer
      return viewer
    })
    const loadedCoordinates = Promise.resolve().then(() => loadResource(coordinateResource, controller?.signal))
      .then((blob) => decodeFloatResource(coordinateResource, blob, expectedCoordinates))
    const loadedCells = cellResource === undefined
      ? Promise.resolve<readonly number[] | null>(null)
      : Promise.resolve().then(() => loadResource(cellResource, controller?.signal))
        .then((blob) => decodeFloatResource(cellResource, blob, expectedCells))

    const load = async () => {
      try {
        const [viewer, coordinates, cells] = await Promise.all([loadedViewer, loadedCoordinates, loadedCells])
        if (!active()) return
        if (!viewerIsUsable(viewer)) throw new Error('Viewer adapter is incomplete')
        if (coordinates.length !== expectedCoordinates || cells !== null && cells.length !== expectedCells) {
          throw new Error('trajectory cardinality mismatch')
        }
        viewer.setBackgroundColor?.('white', 0)
        coordinatesRef.current = coordinates
        cellsRef.current = cells
        modelRef.current = applyFrame(viewer, manifest.elements, coordinates, cells, 0, manifest.atomCount, null, true)
        renderedFrameRef.current = 0
        viewerRef.current = viewer
        setStatus('ready')
      } catch {
        const wasActive = active()
        failed = true
        controller?.abort()
        if (ownedViewer !== null) {
          clearViewer(ownedViewer)
          ownedViewer = null
        }
        if (wasActive) setStatus('error')
      }
    }
    void load()

    return () => {
      disposed = true
      generationRef.current += 1
      controller?.abort()
      stopPlayback()
      const viewer = viewerRef.current
      viewerRef.current = null
      modelRef.current = null
      coordinatesRef.current = null
      cellsRef.current = null
      clearViewer(viewer)
      if (ownedViewer !== null && ownedViewer !== viewer) clearViewer(ownedViewer)
    }
  }, [key, loadResource, manifest, coordinateResource, cellResource, expectedCells, expectedCoordinates, stopPlayback, viewerLoader])

  React.useEffect(() => {
    if (status !== 'ready' || renderedFrameRef.current === frame) return
    const viewer = viewerRef.current
    const coordinates = coordinatesRef.current
    if (viewer === null || coordinates === null) return
    try {
      modelRef.current = applyFrame(
        viewer,
        manifest.elements,
        coordinates,
        cellsRef.current,
        frame,
        manifest.atomCount,
        modelRef.current,
        false,
      )
      renderedFrameRef.current = frame
    } catch {
      stopPlayback()
      setStatus('error')
      clearViewer(viewer)
      viewerRef.current = null
    }
  }, [frame, manifest, status, stopPlayback])

  const changeFrame = (next: number) => {
    stopPlayback()
    const bounded = Math.max(0, Math.min(manifest.frameCount - 1, Math.trunc(next)))
    frameRef.current = bounded
    setFrameState(bounded)
  }

  const togglePlayback = () => {
    if (playingRef.current && frameRef.current < manifest.frameCount - 1) {
      stopPlayback()
      return
    }
    if (manifest.frameCount < 2 || status !== 'ready') return
    if (frameRef.current >= manifest.frameCount - 1) {
      frameRef.current = 0
      setFrameState(0)
    }
    playingRef.current = true
    forcePlayingRender()
    armTimer(speed)
  }

  const changeSpeed = (value: string) => {
    const next = SPEEDS.find((candidate) => String(candidate) === value)
    if (next === undefined) return
    setSpeed(next)
    if (playingRef.current) armTimer(next)
  }

  const isPlaying = playingRef.current && frame < manifest.frameCount - 1

  return (
    <section className="zeus-trajectory-visualization" data-testid="trajectory-visualization" aria-label="轨迹可视化">
      {status === 'loading' ? <div role="status" aria-label="正在加载轨迹">正在加载轨迹…</div> : null}
      {status === 'error' ? <div role="alert">{fallbackContent(fallback)}</div> : null}
      {previewState?.key === previewKey ? (
        <figure className="zeus-trajectory-gif-preview">
          <img src={previewState.url} alt="抽帧轨迹动画" />
          <figcaption>抽帧动画预览</figcaption>
        </figure>
      ) : null}
      <div
        ref={containerRef}
        className="zeus-trajectory-surface"
        data-testid="trajectory-surface"
        role="img"
        aria-label="轨迹三维视图"
        style={{ minHeight: 240, width: '100%', background: 'transparent' }}
      />
      <div className="zeus-trajectory-controls" role="toolbar" aria-label="轨迹播放控制">
        <button type="button" aria-label={isPlaying ? '暂停' : '播放'} onClick={togglePlayback} disabled={status !== 'ready' || manifest.frameCount < 2}>
          {isPlaying ? '暂停' : '播放'}
        </button>
        <button type="button" aria-label="上一帧" onClick={() => changeFrame(frame - 1)} disabled={status !== 'ready' || frame <= 0}>上一帧</button>
        <button type="button" aria-label="下一帧" onClick={() => changeFrame(frame + 1)} disabled={status !== 'ready' || frame >= manifest.frameCount - 1}>下一帧</button>
        <label>
          <span>帧</span>
          <input
            type="range"
            aria-label="轨迹帧"
            min={0}
            max={Math.max(0, manifest.frameCount - 1)}
            step={1}
            value={frame}
            onChange={(event) => changeFrame(Number(event.currentTarget.value))}
            disabled={status !== 'ready'}
          />
        </label>
        <span aria-label="当前帧 / 总帧数">{frame + 1} / {manifest.frameCount}</span>
        <label>
          <span>速度</span>
          <select aria-label="播放速度" value={String(speed)} onChange={(event) => changeSpeed(event.currentTarget.value)}>
            {SPEEDS.map((value) => <option key={value} value={value}>{value}×</option>)}
          </select>
        </label>
        <span aria-label="当前时间">{formatTime(frame, manifest)}</span>
      </div>
    </section>
  )
}
