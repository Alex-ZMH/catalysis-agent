import * as React from 'react'
import {
  ArrowCounterClockwise,
  ArrowsOut,
  BoundingBox,
  Camera,
  Cube,
  SlidersHorizontal,
} from '@phosphor-icons/react'
import type { ServerAgentArtifactReference } from './types'
import { scientificStructureArtifactFormat } from '../../standalone/scientific-artifact.mjs'

// Keep a runtime binding for consumers that transpile shared TSX with classic JSX.
void React

export const SERVER_AGENT_RESULTS_MAX_STRUCTURE_BYTES = 10 * 1024 * 1024

export type AtomicStructureDownloadState = 'idle' | 'loading' | 'error'

export type AtomicStructureAtom = Readonly<{
  elem?: string
  serial?: number
  index?: number
  bonds?: readonly number[]
  chain?: string
  resi?: number
  x?: number
  y?: number
  z?: number
  [key: string]: unknown
}>

export type AtomicStructureModel = Readonly<{
  selectedAtoms?(selection: Record<string, never>): readonly AtomicStructureAtom[]
  removeAtoms?(atoms: readonly AtomicStructureAtom[]): unknown
}>

export type AtomicStructureModelOptions = Readonly<{
  doAssembly?: boolean
  duplicateAssemblyAtoms?: boolean
  wrapAtoms?: boolean
  keepH?: boolean
}>

export type AtomicStructureUnitCellStyle = Readonly<{
  box?: Record<string, unknown>
  astyle?: Record<string, unknown>
  bstyle?: Record<string, unknown>
  cstyle?: Record<string, unknown>
  alabel?: string
  blabel?: string
  clabel?: string
}>

/** The small part of the 3Dmol viewer API owned by this adapter. */
export type AtomicStructureViewer = Readonly<{
  addModel(data: string, format: string, options?: AtomicStructureModelOptions): unknown
  setStyle(selection: Record<string, never>, style: Record<string, unknown>): unknown
  zoomTo(): unknown
  render(): unknown
  clear(): unknown
  addUnitCell(model?: unknown, style?: AtomicStructureUnitCellStyle): unknown
  removeAllShapes(): unknown
  replicateUnitCell(a: number, b: number, c: number, model?: unknown, addBonds?: boolean): unknown
  getModel?(): AtomicStructureModel
  setClickable(
    selection: Record<string, never>,
    clickable: boolean,
    callback: (atom: AtomicStructureAtom, viewer?: AtomicStructureViewer) => void,
  ): unknown
  setBackgroundColor?(color: string, alpha: number): unknown
  getView?(): readonly number[]
  setViewChangeCallback?(callback: ((view: readonly number[]) => void) | null): unknown
  pngURI?(): string
  selectedAtoms?(selection: Record<string, never>): readonly AtomicStructureAtom[]
  /** Optional test/embedder override. Production uses 3Dmol's active element palette. */
  elementColor?(element: string): string
}>

export type AtomicStructureViewerLoader = (
  container: HTMLElement,
) => AtomicStructureViewer | Promise<AtomicStructureViewer>

export type AtomicStructurePreviewProps = Readonly<{
  reference: ServerAgentArtifactReference
  blob: Blob
  loadArtifact(reference: ServerAgentArtifactReference, signal?: AbortSignal): Promise<Blob>
  downloadState?: AtomicStructureDownloadState
  onDownloadState?(state: AtomicStructureDownloadState): void
  isCurrent?(): boolean
  /** The surrounding results panel owns the original-file download control. */
  showDownload?: boolean
  /** Same-origin authenticated artifact URL used by the standalone panel. */
  downloadHref?: string
  /** Injectable seam for tests and embedders; production uses a lazy 3Dmol import. */
  viewerLoader?: AtomicStructureViewerLoader
}>

export const ATOMIC_STRUCTURE_STICK_RADIUS_MIN = 0.06
export const ATOMIC_STRUCTURE_STICK_RADIUS_MAX = 0.30
export const ATOMIC_STRUCTURE_STICK_RADIUS_STEP = 0.01
export const ATOMIC_STRUCTURE_DEFAULT_STICK_RADIUS = 0.12

const SPACE_FILLING_STYLE: Record<string, unknown> = { sphere: {} }
const EMPTY_SELECTION: Record<string, never> = {}

type StructureStyleMode = 'ball-and-stick' | 'space-filling'

type ElementLegendItem = Readonly<{
  element: string
  color: string
  foreground: '#20201d' | '#ffffff'
}>

const viewerElementColors = new WeakMap<object, (element: string) => string>()
const MATTERAI_ELEMENT_COLOR_OVERRIDES: Readonly<Record<string, number>> = Object.freeze({
  // MP-style warm hydrogen remains visible against the white viewer canvas.
  H: 0xf4c2c2,
  // 3Dmol does not ship isotope palette entries; keep D/T scientifically named
  // while using the same visible color as hydrogen.
  D: 0xf4c2c2,
  T: 0xf4c2c2,
})

const CIF_ASSEMBLY_PARSER_OPTIONS: AtomicStructureModelOptions = Object.freeze({
  doAssembly: true,
  duplicateAssemblyAtoms: true,
  wrapAtoms: true,
})

// The crystallographic axes live in the fixed orientation indicator below.
// Keep the optional 3Dmol cell box, but suppress its model-space arrows and
// labels so the same axes are never shown twice.
const UNIT_CELL_BOX_ONLY_STYLE: AtomicStructureUnitCellStyle = {
  astyle: { hidden: true },
  bstyle: { hidden: true },
  cstyle: { hidden: true },
  alabel: '',
  blabel: '',
  clabel: '',
}

const MATTERAI_ISOTOPE_BOND_RADIUS = 0.37
const PERIODIC_PROBE_DIMENSION = 3
const PERIODIC_PROBE_ATOM_CAP = 4096

const CIF_LEGACY_SYMMETRY_TAG = '_symmetry_equiv_pos_as_xyz'
const CIF_MODERN_SYMMETRY_TAG = '_space_group_symop_operation_xyz'

type SpaceGroupInfoLike = Readonly<{
  s?: readonly string[]
}>

function isPeriodicStructureFormat(format: string): boolean {
  return format === 'cif' || format === 'vasp'
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function cifDataItemValue(text: string, names: readonly string[]): string | null {
  const itemPattern = names.map(escapeRegExp).join('|')
  const item = new RegExp(`^\\s*(?:${itemPattern})(?:\\s+(.*)|\\s*)$`, 'i')
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const match = item.exec(lines[index] ?? '')
    if (match === null) continue
    let raw = (match[1] ?? '').trim()
    if (raw === '' && index + 1 < lines.length) raw = (lines[index + 1] ?? '').trim()
    if (raw === '' || raw === '.' || raw === '?') return null
    const quote = raw[0]
    if (quote === "'" || quote === '"') {
      const closingQuote = raw.indexOf(quote, 1)
      if (closingQuote > 0) return raw.slice(1, closingQuote).trim()
    }
    return raw.split(/\s+/)[0] ?? null
  }
  return null
}

function hasCifDataItem(text: string, name: string): boolean {
  return new RegExp(`^\\s*${escapeRegExp(name)}(?:\\s|$)`, 'im').test(text)
}

function atomLoopIndex(lines: readonly string[]): number {
  for (let index = 0; index < lines.length; index += 1) {
    if ((lines[index] ?? '').trim().toLowerCase() !== 'loop_') continue
    for (let field = index + 1; field < lines.length; field += 1) {
      const line = (lines[field] ?? '').trim().toLowerCase()
      if (line === '' || line.startsWith('#')) continue
      if (line.startsWith('_atom_site_')) return index
      if (!line.startsWith('_')) break
    }
  }
  return -1
}

function injectCifSymmetryOperations(text: string, operations: readonly string[]): string {
  const block = [
    'loop_',
    CIF_LEGACY_SYMMETRY_TAG,
    ...operations.map((operation) => `'${operation}'`),
  ]
  const lines = text.split(/\r?\n/)
  const insertionIndex = atomLoopIndex(lines)
  if (insertionIndex >= 0) lines.splice(insertionIndex, 0, ...block)
  else lines.push('', ...block)
  return lines.join('\n')
}

async function prepareCifText(text: string): Promise<string> {
  if (hasCifDataItem(text, CIF_LEGACY_SYMMETRY_TAG)) return text
  if (hasCifDataItem(text, CIF_MODERN_SYMMETRY_TAG)) {
    return text.replace(
      new RegExp(`(^[ \\t]*)${escapeRegExp(CIF_MODERN_SYMMETRY_TAG)}(?=\\s|$)`, 'im'),
      `$1${CIF_LEGACY_SYMMETRY_TAG}`,
    )
  }

  const hall = cifDataItemValue(text, ['_symmetry_space_group_name_Hall', '_space_group_name_Hall'])
  const hm = cifDataItemValue(text, ['_symmetry_space_group_name_H-M', '_space_group_name_H-M'])
  const number = cifDataItemValue(text, ['_symmetry_Int_Tables_number', '_space_group_IT_number'])
  if (hall === null && hm === null && number === null) return text
  const { SpaceGroup } = await import('@chemistry/space-groups')
  const group = (hall === null ? null : SpaceGroup.getByHallName(hall))
    ?? (hm === null ? null : SpaceGroup.getByHMName(hm))
    ?? (number === null ? null : SpaceGroup.getById(Number.parseInt(number, 10)))
  const operations = (group as SpaceGroupInfoLike | null)?.s
  if (operations === undefined || operations.length === 0) return text
  return injectCifSymmetryOperations(text, operations)
}

function colorSpecToCss(color: unknown): string {
  if (typeof color === 'number' && Number.isFinite(color)) {
    return `#${Math.max(0, Math.min(0xffffff, Math.round(color))).toString(16).padStart(6, '0')}`
  }
  if (typeof color === 'string' && color.trim() !== '') return color
  if (typeof color === 'object' && color !== null) {
    const candidate = color as { r?: unknown; g?: unknown; b?: unknown }
    if ([candidate.r, candidate.g, candidate.b].every((channel) => typeof channel === 'number')) {
      const channels = [candidate.r, candidate.g, candidate.b] as number[]
      const scale = channels.every((channel) => channel >= 0 && channel <= 1) ? 255 : 1
      return `rgb(${channels.map((channel) => Math.max(0, Math.min(255, Math.round(channel * scale)))).join(', ')})`
    }
  }
  return '#ff1493'
}

function matterAiElementColor(element: string, fallbackColor: unknown): string {
  return colorSpecToCss(MATTERAI_ELEMENT_COLOR_OVERRIDES[element] ?? fallbackColor)
}

function normalizeElementSymbol(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!/^[A-Za-z]{1,3}$/.test(trimmed)) return null
  return `${trimmed[0]?.toUpperCase() ?? ''}${trimmed.slice(1).toLowerCase()}`
}

function legendForeground(color: string): '#20201d' | '#ffffff' {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(color)
  if (match === null) return '#20201d'
  const [r, g, b] = match.slice(1).map((channel) => Number.parseInt(channel ?? '0', 16))
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 150 ? '#20201d' : '#ffffff'
}

function structureElementLegend(viewer: AtomicStructureViewer): ElementLegendItem[] {
  try {
    const atoms = viewer.selectedAtoms?.(EMPTY_SELECTION) ?? []
    const elements: string[] = []
    const seen = new Set<string>()
    for (const atom of atoms) {
      const element = normalizeElementSymbol(atom.elem)
      if (element === null || seen.has(element)) continue
      seen.add(element)
      elements.push(element)
      if (elements.length >= 118) break
    }
    const colorFor = viewer.elementColor ?? viewerElementColors.get(viewer) ?? (() => '#ff1493')
    return elements.map((element) => {
      const color = matterAiElementColor(element, colorFor(element))
      return { element, color, foreground: legendForeground(color) }
    })
  } catch {
    return []
  }
}

function elementLegendLabel(element: string): string {
  if (element === 'D') return 'D（氘）'
  if (element === 'T') return 'T（氚）'
  return element
}

function structureStyle(mode: StructureStyleMode, stickRadius: number): Record<string, unknown> {
  return mode === 'space-filling'
    ? SPACE_FILLING_STYLE
    : { stick: { radius: stickRadius }, sphere: { scale: 0.3 } }
}

function completePeriodicBoundaryImages(viewer: AtomicStructureViewer): boolean {
  const model = viewer.getModel?.()
  if (model?.selectedAtoms === undefined || model.removeAtoms === undefined) return false

  // 3Dmol's normal bond assignment is non-periodic. Probe the centered
  // neighborhood, then keep only image atoms that complete source-cell bonds.
  const sourceAtoms = model.selectedAtoms(EMPTY_SELECTION)
  if (sourceAtoms.length === 0 || sourceAtoms.length * PERIODIC_PROBE_DIMENSION ** 3 > PERIODIC_PROBE_ATOM_CAP) return false

  const sourceObjects = new Set(sourceAtoms)
  const sourceIndices = new Set(
    sourceAtoms
      .map((atom) => atom.index)
      .filter((index): index is number => typeof index === 'number' && Number.isFinite(index)),
  )

  viewer.replicateUnitCell(
    PERIODIC_PROBE_DIMENSION,
    PERIODIC_PROBE_DIMENSION,
    PERIODIC_PROBE_DIMENSION,
    undefined,
    true,
  )

  const expandedAtoms = model.selectedAtoms(EMPTY_SELECTION)
  const isSourceAtom = (atom: AtomicStructureAtom): boolean => (
    sourceObjects.has(atom)
    || (typeof atom.index === 'number' && sourceIndices.has(atom.index))
  )
  const atomByIndex = new Map<number, AtomicStructureAtom>()
  for (const atom of expandedAtoms) {
    if (typeof atom.index === 'number' && Number.isFinite(atom.index)) atomByIndex.set(atom.index, atom)
  }

  const bondedImageIndices = new Set<number>()
  for (const atom of expandedAtoms) {
    if (!isSourceAtom(atom)) continue
    for (const bond of atom.bonds ?? []) {
      const neighbor = atomByIndex.get(bond)
      if (neighbor !== undefined && !isSourceAtom(neighbor) && typeof neighbor.index === 'number') {
        bondedImageIndices.add(neighbor.index)
      }
    }
  }

  const removableImages = expandedAtoms.filter((atom) => (
    !isSourceAtom(atom)
    && (typeof atom.index !== 'number' || !bondedImageIndices.has(atom.index))
  ))
  if (removableImages.length > 0) model.removeAtoms(removableImages)
  return true
}

function configureStructureModel(
  viewer: AtomicStructureViewer,
  text: string,
  format: string,
  styleMode: StructureStyleMode,
  stickRadius: number,
  unitCellVisible: boolean,
  onAtomClick: (atom: AtomicStructureAtom) => void,
  completePeriodicImages = false,
): boolean | null {
  // This order is supported by 3Dmol 2.5.5. The caller clears an existing
  // viewer before invoking it when rebuilding the original 1×1×1 model.
  if (format === 'cif') viewer.addModel(text, format, { ...CIF_ASSEMBLY_PARSER_OPTIONS })
  else if (format === 'sdf') viewer.addModel(text, format, { keepH: true })
  else viewer.addModel(text, format)
  const periodicCompletion = completePeriodicImages && isPeriodicStructureFormat(format)
    ? completePeriodicBoundaryImages(viewer)
    : null
  viewer.setClickable(EMPTY_SELECTION, true, (atom) => onAtomClick(atom))
  viewer.setStyle(EMPTY_SELECTION, structureStyle(styleMode, stickRadius))
  if (unitCellVisible) viewer.addUnitCell(undefined, UNIT_CELL_BOX_ONLY_STYLE)
  viewer.zoomTo()
  viewer.render()
  return periodicCompletion
}

async function defaultViewerLoader(container: HTMLElement): Promise<AtomicStructureViewer> {
  const module = await import('3dmol')
  module.setBondLength('D', MATTERAI_ISOTOPE_BOND_RADIUS)
  module.setBondLength('T', MATTERAI_ISOTOPE_BOND_RADIUS)
  const elementColors = {
    ...module.elementColors.defaultColors,
    ...MATTERAI_ELEMENT_COLOR_OVERRIDES,
  }
  const viewer = module.createViewer(container, {
    backgroundColor: 'white',
    backgroundAlpha: 0,
    defaultcolors: elementColors,
  })
  if (viewer === null || viewer === undefined) throw new Error('3D viewer unavailable')
  const adaptedViewer = viewer as unknown as AtomicStructureViewer
  viewerElementColors.set(adaptedViewer, (element) => colorSpecToCss(
    elementColors[element]
      ?? elementColors[element.toUpperCase()]
      ?? module.elementColors.defaultColor,
  ))
  return adaptedViewer
}

function publicName(reference: ServerAgentArtifactReference): string {
  const safeName = reference.name.replace(/[\\/\u0000-\u001f\u007f]/g, '_').trim()
  return safeName || '结构文件'
}

function formatAtomInfo(atom: AtomicStructureAtom): string {
  const element = atom.elem ?? atom.atom ?? '未知元素'
  const identifier = typeof atom.serial === 'number' && Number.isSafeInteger(atom.serial) && atom.serial >= 1
    ? atom.serial
    : typeof atom.index === 'number' && Number.isSafeInteger(atom.index) && atom.index >= 0
      ? atom.index + 1
      : undefined
  const location = [
    atom.chain === undefined ? null : `链 ${atom.chain}`,
    atom.resi === undefined ? null : `残基 ${atom.resi}`,
  ].filter((value): value is string => value !== null)
  const coordinates = [atom.x, atom.y, atom.z].every((value) => typeof value === 'number')
    ? ` · x ${atom.x} · y ${atom.y} · z ${atom.z}`
    : ''
  return `${element}${identifier === undefined ? '' : ` #${identifier}`}${location.length === 0 ? '' : ` · ${location.join(' · ')}`}${coordinates}`
}

const DEFAULT_VIEW: readonly number[] = Object.freeze([0, 0, 0, 0, 0, 0, 0, 1])

type OrientationVector = Readonly<{ x: number; y: number; z: number }>
type OrientationAxis = Readonly<{
  id: 'a' | 'b' | 'c'
  color: string
  vector: OrientationVector
}>

const CRYSTALLOGRAPHIC_AXES: readonly OrientationAxis[] = Object.freeze([
  { id: 'a', color: '#c33b3b', vector: { x: 1, y: 0, z: 0 } },
  { id: 'b', color: '#27834a', vector: { x: 0, y: 1, z: 0 } },
  { id: 'c', color: '#3f69b1', vector: { x: 0, y: 0, z: 1 } },
])

function normalizedView(view: readonly number[] | undefined): readonly number[] {
  if (view === undefined || view.length < 8) return DEFAULT_VIEW
  const quaternion = view.slice(4, 8)
  if (quaternion.length !== 4 || quaternion.some((value) => !Number.isFinite(value))) return DEFAULT_VIEW
  const magnitude = Math.hypot(...quaternion)
  if (magnitude < Number.EPSILON) return DEFAULT_VIEW
  return view.slice(0, 8)
}

function rotateOrientationVector(vector: OrientationVector, view: readonly number[]): OrientationVector {
  const [rawX, rawY, rawZ, rawW] = view.slice(4, 8)
  const magnitude = Math.hypot(rawX ?? 0, rawY ?? 0, rawZ ?? 0, rawW ?? 1)
  const x = (rawX ?? 0) / magnitude
  const y = (rawY ?? 0) / magnitude
  const z = (rawZ ?? 0) / magnitude
  const w = (rawW ?? 1) / magnitude
  const tx = 2 * (y * vector.z - z * vector.y)
  const ty = 2 * (z * vector.x - x * vector.z)
  const tz = 2 * (x * vector.y - y * vector.x)
  return {
    x: vector.x + w * tx + (y * tz - z * ty),
    y: vector.y + w * ty + (z * tx - x * tz),
    z: vector.z + w * tz + (x * ty - y * tx),
  }
}

function orientationAxisEndpoint(axis: OrientationAxis, view: readonly number[]) {
  const rotated = rotateOrientationVector(axis.vector, view)
  // 3Dmol's camera looks down the depth axis. A restrained oblique projection
  // keeps a depth-only c axis legible while still following the viewer's
  // quaternion as the model rotates.
  const projectedX = rotated.x - rotated.z * 0.58
  const projectedY = -(rotated.y + rotated.z * 0.58)
  const length = Math.hypot(projectedX, projectedY)
  const safeLength = length < 0.08 ? 1 : length
  const scale = 27
  const origin = { x: 42, y: 58 }
  return {
    x: origin.x + (projectedX / safeLength) * scale,
    y: origin.y + (projectedY / safeLength) * scale,
    origin,
  }
}

function CrystallographicAxisIndicator({ view }: { view: readonly number[] }) {
  const markerPrefix = `atomic-structure-axis-${React.useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  return (
    <div
      className="zeus-atomic-structure-axis-indicator"
      data-placement="bottom-left"
      role="img"
      aria-label="晶体学方向 a、b、c"
    >
      <svg viewBox="0 0 96 82" aria-hidden="true" focusable="false">
        <defs>
          {CRYSTALLOGRAPHIC_AXES.map(({ id, color }) => (
            <marker
              key={id}
              id={`${markerPrefix}-${id}`}
              markerHeight="4"
              markerWidth="4"
              orient="auto"
              refX="8"
              refY="5"
              viewBox="0 0 10 10"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
            </marker>
          ))}
        </defs>
        {CRYSTALLOGRAPHIC_AXES.map((axis) => {
          const endpoint = orientationAxisEndpoint(axis, view)
          const textAnchor = endpoint.x < endpoint.origin.x ? 'end' : 'start'
          return (
            <g key={axis.id} data-axis={axis.id} aria-label={`${axis.id} 轴`}>
              <line
                x1={endpoint.origin.x}
                y1={endpoint.origin.y}
                x2={endpoint.x}
                y2={endpoint.y}
                stroke={axis.color}
                strokeLinecap="round"
                strokeWidth="2.5"
                markerEnd={`url(#${markerPrefix}-${axis.id})`}
              />
              <text
                x={endpoint.x + (textAnchor === 'end' ? -4 : 4)}
                y={endpoint.y + (endpoint.y < endpoint.origin.y ? -3 : 4)}
                fill={axis.color}
                fontSize="12"
                fontWeight="700"
                textAnchor={textAnchor}
              >
                {axis.id}
              </text>
            </g>
          )
        })}
        <circle cx="42" cy="58" r="2.6" fill="var(--zeus-server-results-text, #20201d)" />
      </svg>
    </div>
  )
}

function OriginalDownloadButton({
  reference,
  downloadHref,
}: {
  reference: ServerAgentArtifactReference
  downloadHref?: string
}) {
  return (
    <a
      href={downloadHref ?? `/api/artifacts/${encodeURIComponent(reference.runId)}`}
      download={publicName(reference)}
      rel="noopener"
      aria-label="下载原始文件"
    >
      下载原始文件
    </a>
  )
}

function viewerCanBeUsed(viewer: AtomicStructureViewer): boolean {
  return typeof viewer.addModel === 'function'
    && typeof viewer.setStyle === 'function'
    && typeof viewer.zoomTo === 'function'
    && typeof viewer.render === 'function'
    && typeof viewer.clear === 'function'
    && typeof viewer.addUnitCell === 'function'
    && typeof viewer.removeAllShapes === 'function'
    && typeof viewer.replicateUnitCell === 'function'
    && typeof viewer.setClickable === 'function'
}

function clearViewer(viewer: AtomicStructureViewer | null): void {
  if (viewer === null) return
  try {
    viewer.setViewChangeCallback?.(null)
  } catch {
    // An embedder may not accept callback detachment after its context is lost.
  }
  try {
    viewer.clear()
  } catch {
    // A WebGL context may already be lost during unmount. Cleanup is best effort.
  }
}

export function AtomicStructurePreview({
  reference,
  blob,
  isCurrent = () => true,
  showDownload = true,
  downloadHref,
  viewerLoader,
}: AtomicStructurePreviewProps) {
  const surfaceRef = React.useRef<HTMLDivElement | null>(null)
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const viewerRef = React.useRef<AtomicStructureViewer | null>(null)
  const loaderRef = React.useRef(viewerLoader)
  const currentGuardRef = React.useRef(isCurrent)
  const generationRef = React.useRef(0)
  const structureTextRef = React.useRef<string | null>(null)
  const structureFormatRef = React.useRef<string | null>(null)
  const periodicBoundaryCompletionRef = React.useRef<boolean | null>(null)
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>(() => (
    blob.size > SERVER_AGENT_RESULTS_MAX_STRUCTURE_BYTES || scientificStructureArtifactFormat(reference.name) === null
      ? 'error'
      : 'loading'
  ))
  const [errorMessage, setErrorMessage] = React.useState<string | null>(() => (
    blob.size > SERVER_AGENT_RESULTS_MAX_STRUCTURE_BYTES
      ? '结构文件超过 10 MiB，无法预览。'
      : scientificStructureArtifactFormat(reference.name) === null
        ? '该文件格式不支持结构预览。'
        : null
  ))
  const [styleMode, setStyleMode] = React.useState<StructureStyleMode>('ball-and-stick')
  const [stickRadius, setStickRadius] = React.useState(ATOMIC_STRUCTURE_DEFAULT_STICK_RADIUS)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [unitCellVisible, setUnitCellVisible] = React.useState(false)
  const [replicationMode, setReplicationMode] = React.useState<'original' | 'supercell'>('original')
  const [atomInfo, setAtomInfo] = React.useState<string | null>(null)
  const [screenshotHref, setScreenshotHref] = React.useState('data:,')
  const [isFullscreen, setIsFullscreen] = React.useState(false)
  const [elementLegend, setElementLegend] = React.useState<ElementLegendItem[]>([])
  const [orientationView, setOrientationView] = React.useState<readonly number[]>(DEFAULT_VIEW)
  const key = `${reference.runId}\u0000${reference.sequence}\u0000${reference.name}\u0000${reference.mimeType}`
  const styleModeRef = React.useRef(styleMode)
  const stickRadiusRef = React.useRef(stickRadius)
  const unitCellVisibleRef = React.useRef(unitCellVisible)

  loaderRef.current = viewerLoader
  currentGuardRef.current = isCurrent
  styleModeRef.current = styleMode
  stickRadiusRef.current = stickRadius
  unitCellVisibleRef.current = unitCellVisible

  React.useEffect(() => {
    let disposed = false
    const generation = ++generationRef.current
    let ownedViewer: AtomicStructureViewer | null = null
    const active = () => !disposed && generationRef.current === generation && currentGuardRef.current()
    const format = scientificStructureArtifactFormat(reference.name)

    setAtomInfo(null)
    setUnitCellVisible(false)
    setReplicationMode('original')
    setScreenshotHref('data:,')
    setElementLegend([])
    setOrientationView(DEFAULT_VIEW)
    periodicBoundaryCompletionRef.current = null
    if (blob.size > SERVER_AGENT_RESULTS_MAX_STRUCTURE_BYTES) {
      setStatus('error')
      setErrorMessage('结构文件超过 10 MiB，无法预览。')
      return () => {
        disposed = true
        generationRef.current += 1
        clearViewer(ownedViewer)
      }
    }
    if (format === null) {
      setStatus('error')
      setErrorMessage('该文件格式不支持结构预览。')
      return () => {
        disposed = true
        generationRef.current += 1
        clearViewer(ownedViewer)
      }
    }

    setStatus('loading')
    setErrorMessage(null)
    const load = async () => {
      try {
        const text = await blob.text()
        if (!active()) return
        const preparedText = format === 'cif' ? await prepareCifText(text) : text
        if (!active()) return
        const container = containerRef.current
        if (container === null) throw new Error('Viewer container unavailable')
        const loader = loaderRef.current ?? defaultViewerLoader
        const viewer = await loader(container)
        ownedViewer = viewer
        if (!active()) {
          clearViewer(viewer)
          ownedViewer = null
          return
        }
        if (!viewerCanBeUsed(viewer)) throw new Error('Viewer adapter is incomplete')
        viewer.setBackgroundColor?.('white', 0)
        periodicBoundaryCompletionRef.current = configureStructureModel(viewer, preparedText, format, styleModeRef.current, stickRadiusRef.current, unitCellVisibleRef.current, (atom) => {
          if (active()) setAtomInfo(formatAtomInfo(atom))
        }, isPeriodicStructureFormat(format))
        viewer.setViewChangeCallback?.((view) => {
          if (active()) setOrientationView(normalizedView(view))
        })
        if (active()) setOrientationView(normalizedView(viewer.getView?.()))
        if (active()) setElementLegend(structureElementLegend(viewer))
        structureTextRef.current = preparedText
        structureFormatRef.current = format
        viewerRef.current = viewer
        setStatus('ready')
      } catch {
        if (ownedViewer !== null) {
          clearViewer(ownedViewer)
          ownedViewer = null
        }
        if (active()) {
          setStatus('error')
          setErrorMessage('结构无法解析，仍可下载原始文件。')
        }
      }
    }
    void load()

    return () => {
      disposed = true
      generationRef.current += 1
      const viewer = viewerRef.current
      viewerRef.current = null
      structureTextRef.current = null
      structureFormatRef.current = null
      clearViewer(viewer)
      if (ownedViewer !== null && ownedViewer !== viewer) clearViewer(ownedViewer)
    }
  }, [blob, key, viewerLoader])

  React.useEffect(() => {
    const syncFullscreen = () => setIsFullscreen(document.fullscreenElement === surfaceRef.current)
    document.addEventListener?.('fullscreenchange', syncFullscreen)
    return () => document.removeEventListener?.('fullscreenchange', syncFullscreen)
  }, [])

  React.useEffect(() => {
    if (!settingsOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSettingsOpen(false)
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [settingsOpen])

  const viewer = viewerRef.current
  const resetView = () => {
    if (!isCurrent() || viewerRef.current === null) return
    viewerRef.current.zoomTo()
    viewerRef.current.render()
  }
  const toggleUnitCell = () => {
    if (!isCurrent() || viewerRef.current === null) return
    if (unitCellVisible) {
      viewerRef.current.removeAllShapes()
      setUnitCellVisible(false)
    } else {
      viewerRef.current.addUnitCell(undefined, UNIT_CELL_BOX_ONLY_STYLE)
      setUnitCellVisible(true)
    }
    viewerRef.current.render()
  }
  const replicate = () => {
    const currentViewer = viewerRef.current
    const text = structureTextRef.current
    const format = structureFormatRef.current
    if (!isCurrent() || currentViewer === null || text === null || format === null) return
    if (replicationMode === 'supercell' || periodicBoundaryCompletionRef.current !== null) return
    try {
      // Ask 3Dmol to infer bonds after replication so periodic neighbors that
      // meet across a unit-cell boundary are not left visually isolated.
      currentViewer.replicateUnitCell(2, 2, 2, undefined, true)
      if (unitCellVisibleRef.current) currentViewer.addUnitCell(undefined, UNIT_CELL_BOX_ONLY_STYLE)
      setElementLegend(structureElementLegend(currentViewer))
      currentViewer.render()
      setReplicationMode('supercell')
    } catch {
      viewerRef.current = null
      clearViewer(currentViewer)
      setStatus('error')
      setErrorMessage('结构无法解析，仍可下载原始文件。')
    }
  }
  const restoreOriginal = () => {
    const currentViewer = viewerRef.current
    const text = structureTextRef.current
    const format = structureFormatRef.current
    if (!isCurrent() || currentViewer === null || text === null || format === null || replicationMode === 'original') return
    try {
      currentViewer.clear()
      periodicBoundaryCompletionRef.current = configureStructureModel(currentViewer, text, format, styleModeRef.current, stickRadiusRef.current, unitCellVisibleRef.current, (atom) => {
        if (currentGuardRef.current()) setAtomInfo(formatAtomInfo(atom))
      }, isPeriodicStructureFormat(format))
      setElementLegend(structureElementLegend(currentViewer))
      setReplicationMode('original')
    } catch {
      viewerRef.current = null
      clearViewer(currentViewer)
      setStatus('error')
      setErrorMessage('结构无法解析，仍可下载原始文件。')
    }
  }
  const applyStyle = (nextMode: StructureStyleMode, nextRadius = stickRadiusRef.current) => {
    if (!isCurrent() || viewerRef.current === null) return
    viewerRef.current.setStyle(EMPTY_SELECTION, structureStyle(nextMode, nextRadius))
    viewerRef.current.render()
  }
  const selectStyleMode = (next: StructureStyleMode) => {
    if (!isCurrent() || viewerRef.current === null) return
    styleModeRef.current = next
    setStyleMode(next)
    applyStyle(next)
  }
  const updateStickRadius = (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = Number(event.currentTarget.value)
    if (!Number.isFinite(next)) return
    stickRadiusRef.current = next
    setStickRadius(next)
    applyStyle(styleModeRef.current, next)
  }
  const toggleFullscreen = async () => {
    if (!isCurrent()) return
    const surface = surfaceRef.current
    if (surface === null) return
    try {
      if (document.fullscreenElement === surface) {
        await document.exitFullscreen?.()
        setIsFullscreen(false)
      } else {
        await surface.requestFullscreen?.()
        setIsFullscreen(true)
      }
    } catch {
      // Fullscreen can be rejected by browser policy; leave the viewer usable.
    }
  }
  const screenshot = (event: React.MouseEvent<HTMLAnchorElement>) => {
    const currentViewer = viewerRef.current
    if (!isCurrent() || currentViewer?.pngURI === undefined) {
      event.preventDefault()
      return
    }
    try {
      const uri = currentViewer.pngURI()
      event.currentTarget.href = uri
      setScreenshotHref(uri)
    } catch {
      event.preventDefault()
    }
  }

  const currentError = errorMessage ?? '结构无法解析，仍可下载原始文件。'
  const periodicBoundaryCompletion = periodicBoundaryCompletionRef.current
  const periodicSupercellUnsafe = periodicBoundaryCompletion !== null
  const replicationLabel = replicationMode === 'original' ? '复制为 2×2×2 超胞' : '恢复为 1×1×1 原胞'
  const replicationTitle = replicationMode === 'original' && periodicSupercellUnsafe
    ? periodicBoundaryCompletion === false
      ? '2×2×2 超胞暂不可用：无法安全完成周期边界邻居'
      : '2×2×2 超胞暂不可用：避免产生不完整的边界键'
    : replicationLabel
  const showAxisIndicator = status === 'ready'
    && viewer !== null
    && isPeriodicStructureFormat(structureFormatRef.current ?? '')
  return (
    <section className="zeus-atomic-structure-preview" aria-label={`${publicName(reference)} 结构预览`}>
        <div
        ref={surfaceRef}
        className="zeus-atomic-structure-surface"
        data-testid="atomic-structure-surface"
      >
        <div ref={containerRef} className="zeus-atomic-structure-viewer" data-testid="atomic-structure-viewer" />
        {showAxisIndicator ? <CrystallographicAxisIndicator view={orientationView} /> : null}
        {status === 'loading' ? <p className="zeus-atomic-structure-status" role="status">正在加载结构预览…</p> : null}
        {status === 'error' ? <p className="zeus-atomic-structure-status zeus-atomic-structure-status-error" role="alert">{currentError}</p> : null}
        {status === 'ready' && viewer !== null ? (
          <div
            role="toolbar"
            aria-label="结构查看工具"
            className="zeus-atomic-structure-toolbar"
          >
            <button type="button" aria-label={isFullscreen ? '退出全屏' : '进入全屏'} title={isFullscreen ? '退出全屏' : '进入全屏'} onClick={() => void toggleFullscreen()}><ArrowsOut aria-hidden="true" /></button>
            <button
              type="button"
              aria-label="结构显示设置"
              aria-expanded={settingsOpen}
              aria-controls="atomic-structure-display-settings"
              title="结构显示设置"
              onClick={() => setSettingsOpen((open) => !open)}
            >
              <SlidersHorizontal aria-hidden="true" />
            </button>
            <button type="button" aria-label="重置视角" title="重置视角" onClick={resetView}><ArrowCounterClockwise aria-hidden="true" /></button>
            <a
              href={screenshotHref}
              download={`${publicName(reference)}.png`}
              aria-label="下载结构截图"
              title="下载结构截图"
              onClick={screenshot}
            >
              <Camera aria-hidden="true" />
            </a>
            <button
              type="button"
              aria-label={unitCellVisible ? '隐藏晶胞' : '显示晶胞'}
              title={unitCellVisible ? '隐藏晶胞' : '显示晶胞'}
              onClick={toggleUnitCell}
            >
              <BoundingBox aria-hidden="true" weight={unitCellVisible ? 'fill' : 'regular'} />
            </button>
            <button
              type="button"
              aria-label={replicationLabel}
              title={replicationTitle}
              disabled={periodicSupercellUnsafe}
              onClick={replicationMode === 'original' ? replicate : restoreOriginal}
            >
              <Cube aria-hidden="true" weight={replicationMode === 'supercell' ? 'fill' : 'regular'} />
            </button>
          </div>
        ) : null}
        {status === 'ready' && viewer !== null && settingsOpen ? (
          <div
            id="atomic-structure-display-settings"
            className="zeus-atomic-structure-settings"
            role="dialog"
            aria-label="结构显示设置"
            aria-modal="false"
          >
            <div className="zeus-atomic-structure-settings-heading">显示设置</div>
            <label className="zeus-atomic-structure-settings-label" htmlFor="atomic-structure-stick-radius">
              <span>棍半径</span>
              <output htmlFor="atomic-structure-stick-radius">{stickRadius.toFixed(2)}</output>
            </label>
            <input
              id="atomic-structure-stick-radius"
              type="range"
              min={ATOMIC_STRUCTURE_STICK_RADIUS_MIN}
              max={ATOMIC_STRUCTURE_STICK_RADIUS_MAX}
              step={ATOMIC_STRUCTURE_STICK_RADIUS_STEP}
              value={stickRadius}
              aria-label="棍半径"
              onChange={updateStickRadius}
            />
            <div className="zeus-atomic-structure-settings-range" aria-hidden="true">
              <span>{ATOMIC_STRUCTURE_STICK_RADIUS_MIN.toFixed(2)}</span>
              <span>{ATOMIC_STRUCTURE_STICK_RADIUS_MAX.toFixed(2)}</span>
            </div>
            <fieldset className="zeus-atomic-structure-settings-modes">
              <legend>表示模式</legend>
              <button
                type="button"
                aria-pressed={styleMode === 'ball-and-stick'}
                onClick={() => selectStyleMode('ball-and-stick')}
              >
                球棍表示
              </button>
              <button
                type="button"
                aria-pressed={styleMode === 'space-filling'}
                onClick={() => selectStyleMode('space-filling')}
              >
                空间填充表示
              </button>
            </fieldset>
          </div>
        ) : null}
        {status === 'ready' && elementLegend.length > 0 ? (
          <ul className="zeus-atomic-structure-legend" aria-label="元素颜色图例">
            {elementLegend.map(({ element, color, foreground }) => (
              <li key={element} aria-label={elementLegendLabel(element)} title={elementLegendLabel(element)}>
                <span
                  data-element={element}
                  style={{ backgroundColor: color, color: foreground }}
                  aria-hidden="true"
                >
                  {element}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {atomInfo !== null ? <p className="zeus-atomic-structure-atom-info" role="status">{atomInfo}</p> : null}
      </div>
      {status === 'ready' ? (
        <p className="zeus-atomic-structure-instruction">
          点击原子查看序号，然后在对话中引用该序号让智能体修改结构。
        </p>
      ) : null}
      {showDownload ? (
        <OriginalDownloadButton
          reference={reference}
          downloadHref={downloadHref}
        />
      ) : null}
    </section>
  )
}
