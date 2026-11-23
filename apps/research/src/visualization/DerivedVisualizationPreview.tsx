import * as React from 'react'
import type {
  ServerArtifactVisualizationManifest,
  ServerArtifactVisualizationResource,
  ServerArtifactVisualizationResponse,
} from './scientific-visualization'
import type { ServerAgentArtifactReference } from './types'
import { parseServerArtifactVisualizationResponse } from './scientific-visualization'
import {
  ScientificPlotVisualization,
  type ScientificPlotVisualizationProps,
} from './ScientificPlotVisualization'
import {
  TrajectoryVisualization,
  type TrajectoryViewerLoader,
} from './TrajectoryVisualization'
import {
  VolumeVisualization,
  type VolumeVisualizationLoader,
} from './VolumeVisualization'

// Keep a runtime binding for consumers that transpile shared TSX with classic JSX.
void React

export type DerivedVisualizationKind = 'trajectory' | 'volume' | 'band' | 'dos'

const MIME_BY_KIND: Readonly<Record<DerivedVisualizationKind, string>> = Object.freeze({
  trajectory: 'chemical/x-xyz',
  volume: 'chemical/x-cube',
  band: 'chemical/x-vasp-eigenval',
  dos: 'chemical/x-vasp-doscar',
})

function safeCandidateName(reference: ServerAgentArtifactReference): string | null {
  const name = reference.name
  if (
    name.length === 0 ||
    name.trim() !== name ||
    name.startsWith('.') ||
    /[\\/\u0000-\u001f\u007f]/.test(name)
  ) return null
  return name
}

function extension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** Return the exact derived kind for a public artifact name/MIME pair. */
export function derivedVisualizationKind(reference: ServerAgentArtifactReference): DerivedVisualizationKind | null {
  const name = safeCandidateName(reference)
  if (name === null) return null
  // Manifest routing is an exact public contract: MIME case and surrounding
  // bytes are significant. Do not normalize or trim before dispatch.
  const mimeType = reference.mimeType
  const suffix = extension(name)
  if (suffix === 'extxyz' && mimeType === MIME_BY_KIND.trajectory) return 'trajectory'
  if (name.toUpperCase() === 'XDATCAR' && mimeType === 'chemical/x-vasp-xdatcar') return 'trajectory'
  if ((suffix === 'lammpstrj' || suffix === 'dump') && mimeType === 'application/x-lammps-dump') return 'trajectory'
  if (suffix === 'cube' && mimeType === MIME_BY_KIND.volume) return 'volume'
  if (name.toUpperCase() === 'CHGCAR' && mimeType === 'chemical/x-vasp-chgcar') return 'volume'
  if (name.toUpperCase() === 'ELFCAR' && mimeType === 'chemical/x-vasp-elfcar') return 'volume'
  if (name.toUpperCase() === 'EIGENVAL' && mimeType === MIME_BY_KIND.band) return 'band'
  if (name.toUpperCase() === 'DOSCAR' && mimeType === MIME_BY_KIND.dos) return 'dos'
  return null
}

export function isDerivedVisualizationCandidate(reference: ServerAgentArtifactReference): boolean {
  return derivedVisualizationKind(reference) !== null
}

type DerivedManifest = Extract<ServerArtifactVisualizationManifest, { kind: DerivedVisualizationKind }>

export type DerivedVisualizationPreviewProps = Readonly<{
  scopeKey: string
  reference: ServerAgentArtifactReference
  loadManifest(reference: ServerAgentArtifactReference, signal?: AbortSignal): Promise<ServerArtifactVisualizationResponse>
  loadResource(
    reference: ServerAgentArtifactReference,
    resource: ServerArtifactVisualizationResource,
    signal?: AbortSignal,
  ): Promise<Blob>
  retryGeneration?: number
  fallback?: React.ReactNode | (() => React.ReactNode)
  /** Optional 3Dmol seam forwarded only to the selected standalone. */
  viewerLoader?: TrajectoryViewerLoader | VolumeVisualizationLoader
}>

type PreviewState = Readonly<
  | { key: string; status: 'loading' }
  | { key: string; status: 'ready'; manifest: DerivedManifest }
  | { key: string; status: 'error' }
>

function fallbackContent(fallback: DerivedVisualizationPreviewProps['fallback']): React.ReactNode {
  if (typeof fallback === 'function') return fallback()
  return fallback ?? <p role="alert">科学可视化暂不可用，仍可下载原始文件。</p>
}

function artifactIdentity(reference: ServerAgentArtifactReference): string {
  return `${reference.runId}\u0000${reference.sequence}\u0000${reference.name}\u0000${reference.mimeType}`
}

const identityTokens = new WeakMap<object, number>()
let nextIdentityToken = 1

function identityToken(value: unknown): string {
  if ((typeof value === 'function' || typeof value === 'object') && value !== null) {
    const object = value as object
    const existing = identityTokens.get(object)
    if (existing !== undefined) return String(existing)
    const token = nextIdentityToken++
    identityTokens.set(object, token)
    return String(token)
  }
  return `${typeof value}:${String(value)}`
}

function exactManifest(
  value: unknown,
  expectedKind: DerivedVisualizationKind,
  reference: ServerAgentArtifactReference,
): DerivedManifest {
  const parsed = parseServerArtifactVisualizationResponse(value)
  if (parsed.state !== 'ready' || parsed.manifest.kind !== expectedKind) throw new Error('Unsupported visualization manifest')
  const source = parsed.manifest.source
  if (
    source.runId !== reference.runId ||
    source.sequence !== reference.sequence ||
    source.name !== reference.name ||
    source.mimeType !== reference.mimeType
  ) throw new Error('Visualization identity mismatch')
  return parsed.manifest as DerivedManifest
}

export function DerivedVisualizationPreview({
  scopeKey,
  reference,
  loadManifest,
  loadResource,
  retryGeneration = 0,
  fallback,
  viewerLoader,
}: DerivedVisualizationPreviewProps) {
  const [state, setState] = React.useState<PreviewState>({ key: '', status: 'loading' })
  const requestRef = React.useRef(0)
  const mountedRef = React.useRef(false)
  const expectedKind = derivedVisualizationKind(reference)
  const identity = artifactIdentity(reference)
  // `at` is event metadata, not artifact identity. Keep the loader snapshot
  // stable when a parent recreates an equivalent reference object so a ready
  // child is not aborted/reloaded between commits.
  const stableReference = React.useMemo(() => reference, [identity])
  // Loader seams are part of freshness. A new loader must synchronously fence
  // an already-ready child, even when scope and artifact coordinates are equal.
  const requestKey = [
    scopeKey,
    identity,
    retryGeneration,
    identityToken(loadManifest),
    identityToken(loadResource),
    identityToken(viewerLoader),
  ].join('\u0000')

  React.useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  React.useEffect(() => {
    const request = ++requestRef.current
    const controller = typeof AbortController === 'undefined' ? null : new AbortController()
    let disposed = false
    const active = () => mountedRef.current && !disposed && requestRef.current === request
    setState({ key: requestKey, status: 'loading' })
    if (expectedKind === null) {
      setState({ key: requestKey, status: 'error' })
      return () => {
        disposed = true
        controller?.abort()
      }
    }
    const load = async () => {
      try {
        const response = await loadManifest(stableReference, controller?.signal)
        if (!active()) return
        const manifest = exactManifest(response, expectedKind, stableReference)
        if (active()) setState({ key: requestKey, status: 'ready', manifest })
      } catch {
        if (active()) setState({ key: requestKey, status: 'error' })
      }
    }
    void load()
    return () => {
      disposed = true
      requestRef.current += 1
      controller?.abort()
    }
  }, [expectedKind, loadManifest, loadResource, requestKey, stableReference, viewerLoader])

  const resourceLoader = React.useCallback(
    (resource: ServerArtifactVisualizationResource, signal?: AbortSignal) => (
      loadResource(stableReference, resource, signal)
    ),
    [loadResource, stableReference],
  )

  if (state.status === 'loading' || state.key !== requestKey) {
    return <div className="zeus-derived-visualization-state zeus-derived-visualization-loading" data-testid="derived-visualization-loading" role="status">正在准备科学可视化…</div>
  }
  if (state.status === 'error') {
    return <div className="zeus-derived-visualization-state zeus-derived-visualization-error" data-testid="derived-visualization-error" role="alert">{fallbackContent(fallback)}</div>
  }

  const manifest = state.manifest
  const identityValue = { runId: reference.runId, sequence: reference.sequence }
  if (manifest.kind === 'trajectory') {
    return (
      <TrajectoryVisualization
        key={`${requestKey}\u0000trajectory`}
        manifest={manifest}
        scopeKey={scopeKey}
        identity={identityValue}
        generation={retryGeneration}
        loadResource={resourceLoader}
        viewerLoader={viewerLoader as TrajectoryViewerLoader | undefined}
        fallback={fallback}
      />
    )
  }
  if (manifest.kind === 'volume') {
    return (
      <VolumeVisualization
        key={`${requestKey}\u0000volume`}
        manifest={manifest}
        scopeKey={scopeKey}
        identity={identityValue}
        generation={retryGeneration}
        loadResource={resourceLoader}
        viewerLoader={viewerLoader as VolumeVisualizationLoader | undefined}
        fallback={fallback}
      />
    )
  }
  const plotProps: ScientificPlotVisualizationProps = {
    manifest,
    scopeKey,
    identity: identityValue,
    generation: retryGeneration,
    loadResource: resourceLoader,
    fallback,
  }
  return <ScientificPlotVisualization key={`${requestKey}\u0000${manifest.kind}`} {...plotProps} />
}
