/** Maximum source and derived payload bounds for server-derived visualization. */
export const SERVER_ARTIFACT_VISUALIZATION_SOURCE_MAX_BYTES = 268_435_456
export const SERVER_ARTIFACT_VISUALIZATION_MAX_ATOMS = 100_000
export const SERVER_ARTIFACT_VISUALIZATION_MAX_FRAMES = 10_000
export const SERVER_ARTIFACT_VISUALIZATION_MAX_GRID_POINTS = 16_777_216
export const SERVER_ARTIFACT_VISUALIZATION_MAX_RESOURCES = 64
export const SERVER_ARTIFACT_VISUALIZATION_MAX_RESOURCE_BYTES = 268_435_456

// Descriptive aliases keep the limit names readable to adapters without
// creating a second, independently configurable set of limits.
export const SERVER_ARTIFACT_VISUALIZATION_MAX_SCALAR_GRID_POINTS_PER_CHANNEL =
  SERVER_ARTIFACT_VISUALIZATION_MAX_GRID_POINTS
export const SERVER_ARTIFACT_VISUALIZATION_MAX_DERIVED_RESOURCES =
  SERVER_ARTIFACT_VISUALIZATION_MAX_RESOURCES
export const SERVER_ARTIFACT_VISUALIZATION_MAX_SINGLE_RESOURCE_BYTES =
  SERVER_ARTIFACT_VISUALIZATION_MAX_RESOURCE_BYTES

const RESOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER

const RESOURCE_ROLES = [
  'trajectory.coordinates',
  'trajectory.cells',
  'trajectory.preview',
  'volume.values',
  'plot.values',
] as const

const RESOURCE_MIME_TYPES = [
  'application/vnd.zeus.f32',
  'application/vnd.zeus.f64',
  'application/json',
  'image/gif',
] as const

const FLOAT_RESOURCE_MIME_TYPES = [
  'application/vnd.zeus.f32',
  'application/vnd.zeus.f64',
] as const

type ServerArtifactVisualizationResourceRole = typeof RESOURCE_ROLES[number]
type ServerArtifactVisualizationResourceMimeType = typeof RESOURCE_MIME_TYPES[number]

export type ServerArtifactVisualizationResource = Readonly<{
  id: string
  role: 'trajectory.coordinates' | 'trajectory.cells' | 'trajectory.preview' | 'volume.values' | 'plot.values'
  mimeType: 'application/vnd.zeus.f32' | 'application/vnd.zeus.f64' | 'application/json' | 'image/gif'
  byteLength: number
}>

export type ServerArtifactVisualizationManifest = Readonly<{
  version: 1
  source: Readonly<{ runId: string; sequence: number; name: string; mimeType: string }>
  resources: readonly ServerArtifactVisualizationResource[]
} & (
  | {
      kind: 'trajectory'
      format: 'extxyz' | 'xdatcar' | 'lammps-dump'
      atomCount: number
      frameCount: number
      elements: readonly string[]
      periodic: boolean
      timeUnit: 'frame' | 'fs' | 'ps'
      timeStep: number
      frameTimes?: readonly number[]
    }
  | {
      kind: 'volume'
      format: 'cube' | 'chgcar' | 'elfcar'
      dimensions: readonly [number, number, number]
      origin: readonly [number, number, number]
      axes: readonly [
        readonly [number, number, number],
        readonly [number, number, number],
        readonly [number, number, number],
      ]
      channels: readonly {
        id: string
        label: string
        minimum: number
        maximum: number
        resourceId: string
      }[]
    }
  | {
      kind: 'band'
      format: 'vasp-eigenval'
      spinChannels: 1 | 2
      bands: number
      kpoints: number
      fermiEnergy: number | null
      resourceId: string
    }
  | {
      kind: 'dos'
      format: 'vasp-doscar'
      spinChannels: 1 | 2
      points: number
      fermiEnergy: number
      resourceId: string
    }
)>

export type ServerArtifactVisualizationResponse =
  | Readonly<{ state: 'ready'; manifest: ServerArtifactVisualizationManifest }>
  | Readonly<{ state: 'unsupported'; reason: 'unsupported_format' | 'malformed' | 'too_large' }>

type PlainObject = Record<string, unknown>

function isAllowedString<const T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return typeof value === 'string' && allowed.includes(value as T)
}

function invalid(message = 'Invalid server-artifact visualization response'): never {
  throw new TypeError(message)
}

function parsePlainObject(value: unknown, label: string): PlainObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return invalid(`${label} must be a plain object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    return invalid(`${label} must be a plain object`)
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      return invalid(`${label} must contain enumerable data properties`)
    }
  }
  return value as PlainObject
}

function parseArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return invalid(`${label} must be an array`)
  }
  const ownKeys = Reflect.ownKeys(value)
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  if (
    lengthDescriptor === undefined ||
    lengthDescriptor.enumerable ||
    !Object.hasOwn(lengthDescriptor, 'value') ||
    typeof lengthDescriptor.value !== 'number' ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > SERVER_ARTIFACT_VISUALIZATION_MAX_GRID_POINTS
  ) {
    return invalid(`${label} must have a bounded array length`)
  }
  const length = lengthDescriptor.value
  if (ownKeys.length !== length + 1) {
    return invalid(`${label} must be dense with no extra properties`)
  }
  for (let index = 0; index < length; index += 1) {
    const key = String(index)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      return invalid(`${label} must contain enumerable data indices`)
    }
  }
  for (const key of ownKeys) {
    if (key !== 'length' && (typeof key !== 'string' || !/^\d+$/.test(key))) {
      return invalid(`${label} must not contain extra properties`)
    }
  }
  return value
}

function hasExactKeys(
  value: PlainObject,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const expected = new Set([...required, ...optional])
  const ownKeys = Reflect.ownKeys(value)
  return required.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined &&
      descriptor.enumerable &&
      Object.hasOwn(descriptor, 'value')
  }) && ownKeys.every((key) => typeof key === 'string' && expected.has(key))
}

function parseSafeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !RESOURCE_ID_PATTERN.test(value)) {
    return invalid(`${label} must be a safe 1-80 character id`)
  }
  return value
}

/** Parse an opaque derived-resource identifier without interpreting it as a path. */
export function parseServerArtifactVisualizationResourceId(value: unknown): string {
  return parseSafeId(value, 'resourceId')
}

function parseBoundedText(value: unknown, label: string, maximum: number, nonEmpty = true): string {
  if (
    typeof value !== 'string' ||
    value.length > maximum ||
    (nonEmpty && value.length === 0) ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return invalid(`${label} must be bounded text`)
  }
  return value
}

function parseArtifactName(value: unknown): string {
  const name = parseBoundedText(value, 'source.name', 500)
  if (
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    /[\r\n\"]/.test(name)
  ) {
    return invalid('source.name must be a safe file name')
  }
  return name
}

function parseMimeType(value: unknown, label: string): string {
  const mimeType = parseBoundedText(value, label, 127)
  if (!/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+\/-]{0,126}$/.test(mimeType)) {
    return invalid(`${label} must be a safe MIME type`)
  }
  return mimeType
}

function parseSafeInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    return invalid(`${label} must be a bounded safe integer`)
  }
  return value
}

function parseFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return invalid(`${label} must be a finite number`)
  }
  return value
}

function parseSource(value: unknown): ServerArtifactVisualizationManifest['source'] {
  const source = parsePlainObject(value, 'manifest.source')
  if (!hasExactKeys(source, ['runId', 'sequence', 'name', 'mimeType'])) {
    return invalid('Invalid visualization source')
  }
  return {
    runId: parseSafeId(source.runId, 'source.runId'),
    sequence: parseSafeInteger(source.sequence, 'source.sequence', 1, MAX_SAFE_INTEGER),
    name: parseArtifactName(source.name),
    mimeType: parseMimeType(source.mimeType, 'source.mimeType'),
  }
}

function parseResource(value: unknown): ServerArtifactVisualizationResource {
  const resource = parsePlainObject(value, 'manifest resource')
  if (!hasExactKeys(resource, ['id', 'role', 'mimeType', 'byteLength'])) {
    return invalid('Invalid visualization resource')
  }
  if (!isAllowedString(resource.role, RESOURCE_ROLES)) {
    return invalid('Invalid visualization resource role')
  }
  if (!isAllowedString(resource.mimeType, RESOURCE_MIME_TYPES)) {
    return invalid('Invalid visualization resource MIME type')
  }
  return {
    id: parseSafeId(resource.id, 'resource.id'),
    role: resource.role as ServerArtifactVisualizationResourceRole,
    mimeType: resource.mimeType as ServerArtifactVisualizationResourceMimeType,
    byteLength: parseSafeInteger(
      resource.byteLength,
      'resource.byteLength',
      0,
      SERVER_ARTIFACT_VISUALIZATION_MAX_RESOURCE_BYTES,
    ),
  }
}

function parseResources(value: unknown): ServerArtifactVisualizationResource[] {
  const resources = parseArray(value, 'manifest.resources')
  if (
    resources.length === 0 ||
    resources.length > SERVER_ARTIFACT_VISUALIZATION_MAX_RESOURCES
  ) {
    return invalid('manifest.resources count is out of bounds')
  }
  const parsed = resources.map(parseResource)
  const ids = new Set<string>()
  for (const resource of parsed) {
    if (ids.has(resource.id)) return invalid('manifest.resources contains duplicate ids')
    ids.add(resource.id)
  }
  return parsed
}

function parseElements(value: unknown): string[] {
  const elements = parseArray(value, 'trajectory.elements')
  if (elements.length === 0 || elements.length > SERVER_ARTIFACT_VISUALIZATION_MAX_ATOMS) {
    return invalid('trajectory.elements count is out of bounds')
  }
  return elements.map((element, index) => {
    const parsed = parseBoundedText(element, `trajectory.elements[${index}]`, 16)
    if (!/^[A-Za-z][A-Za-z0-9+_.-]*$/.test(parsed)) {
      return invalid(`trajectory.elements[${index}] must be a safe element label`)
    }
    return parsed
  })
}

function parseFrameTimes(value: unknown, frameCount: number): number[] {
  const frameTimes = parseArray(value, 'trajectory.frameTimes')
  if (frameTimes.length !== frameCount || frameTimes.length > SERVER_ARTIFACT_VISUALIZATION_MAX_FRAMES) {
    return invalid('trajectory.frameTimes count must equal frame count')
  }
  const parsed = frameTimes.map((time, index) => parseFiniteNumber(time, `trajectory.frameTimes[${index}]`))
  for (let index = 1; index < parsed.length; index += 1) {
    if (parsed[index]! <= parsed[index - 1]!) return invalid('trajectory.frameTimes must be strictly increasing')
  }
  return parsed
}

function parseTuple3(value: unknown, label: string): [number, number, number] {
  const tuple = parseArray(value, label)
  if (tuple.length !== 3) return invalid(`${label} must contain exactly three values`)
  return [
    parseFiniteNumber(tuple[0], `${label}[0]`),
    parseFiniteNumber(tuple[1], `${label}[1]`),
    parseFiniteNumber(tuple[2], `${label}[2]`),
  ]
}

function parseDimensions(value: unknown): [number, number, number] {
  const dimensions = parseArray(value, 'volume.dimensions')
  if (dimensions.length !== 3) return invalid('volume.dimensions must contain exactly three values')
  const parsed = [
    parseSafeInteger(dimensions[0], 'volume.dimensions[0]', 1, SERVER_ARTIFACT_VISUALIZATION_MAX_GRID_POINTS),
    parseSafeInteger(dimensions[1], 'volume.dimensions[1]', 1, SERVER_ARTIFACT_VISUALIZATION_MAX_GRID_POINTS),
    parseSafeInteger(dimensions[2], 'volume.dimensions[2]', 1, SERVER_ARTIFACT_VISUALIZATION_MAX_GRID_POINTS),
  ] as [number, number, number]
  if (parsed[0] * parsed[1] * parsed[2] > SERVER_ARTIFACT_VISUALIZATION_MAX_GRID_POINTS) {
    return invalid('volume scalar grid exceeds the supported point limit')
  }
  return parsed
}

function parseAxes(value: unknown): [
  readonly [number, number, number],
  readonly [number, number, number],
  readonly [number, number, number],
] {
  const axes = parseArray(value, 'volume.axes')
  if (axes.length !== 3) return invalid('volume.axes must contain exactly three vectors')
  return [
    parseTuple3(axes[0], 'volume.axes[0]'),
    parseTuple3(axes[1], 'volume.axes[1]'),
    parseTuple3(axes[2], 'volume.axes[2]'),
  ]
}

function parseChannels(value: unknown): Array<{
  id: string
  label: string
  minimum: number
  maximum: number
  resourceId: string
}> {
  const channels = parseArray(value, 'volume.channels')
  if (channels.length === 0 || channels.length > SERVER_ARTIFACT_VISUALIZATION_MAX_RESOURCES) {
    return invalid('volume.channels count is out of bounds')
  }
  const ids = new Set<string>()
  return channels.map((value, index) => {
    const channel = parsePlainObject(value, `volume.channels[${index}]`)
    if (!hasExactKeys(channel, ['id', 'label', 'minimum', 'maximum', 'resourceId'])) {
      return invalid('Invalid volume channel')
    }
    const id = parseSafeId(channel.id, `volume.channels[${index}].id`)
    if (ids.has(id)) return invalid('volume.channels contains duplicate ids')
    ids.add(id)
    const minimum = parseFiniteNumber(channel.minimum, `volume.channels[${index}].minimum`)
    const maximum = parseFiniteNumber(channel.maximum, `volume.channels[${index}].maximum`)
    if (minimum > maximum) return invalid('volume channel minimum exceeds maximum')
    return {
      id,
      label: parseBoundedText(channel.label, `volume.channels[${index}].label`, 200),
      minimum,
      maximum,
      resourceId: parseSafeId(channel.resourceId, `volume.channels[${index}].resourceId`),
    }
  })
}

function assertResourceRole(
  resources: readonly ServerArtifactVisualizationResource[],
  resourceId: string,
  role: ServerArtifactVisualizationResourceRole,
): void {
  const resource = resources.find((candidate) => candidate.id === resourceId)
  if (resource === undefined || resource.role !== role) {
    invalid('Visualization resource reference does not match its manifest kind')
  }
}

function isFloatResource(resource: ServerArtifactVisualizationResource): boolean {
  return isAllowedString(resource.mimeType, FLOAT_RESOURCE_MIME_TYPES)
}

function validateTrajectoryResources(
  resources: readonly ServerArtifactVisualizationResource[],
  periodic: boolean,
): void {
  const coordinates = resources.filter((resource) => resource.role === 'trajectory.coordinates')
  const cells = resources.filter((resource) => resource.role === 'trajectory.cells')
  const previews = resources.filter((resource) => resource.role === 'trajectory.preview')
  if (resources.some((resource) => (
    resource.role !== 'trajectory.coordinates' &&
    resource.role !== 'trajectory.cells' &&
    resource.role !== 'trajectory.preview'
  ))) {
    invalid('Visualization resource role does not belong to its manifest kind')
  }
  if (coordinates.length !== 1 || !isFloatResource(coordinates[0]!)) {
    invalid('Trajectory manifest requires exactly one floating-point coordinate resource')
  }
  if (cells.length > 1 || cells.some((resource) => !isFloatResource(resource))) {
    invalid('Trajectory manifest permits at most one floating-point cell resource')
  }
  if (periodic && cells.length !== 1) {
    invalid('Periodic trajectories require exactly one cell resource')
  }
  if (!periodic && cells.length !== 0) {
    invalid('Non-periodic trajectories must not include cell resources')
  }
  if (previews.length > 1 || previews.some((resource) => resource.mimeType !== 'image/gif')) {
    invalid('Trajectory manifests permit at most one GIF preview resource')
  }
}

function validateVolumeResources(
  resources: readonly ServerArtifactVisualizationResource[],
  channels: readonly { resourceId: string }[],
): void {
  const values = resources.filter((resource) => resource.role === 'volume.values')
  if (
    resources.some((resource) => resource.role !== 'volume.values') ||
    values.length !== channels.length ||
    values.some((resource) => !isFloatResource(resource))
  ) {
    invalid('Volume manifest resources must match its channels exactly')
  }
  const referenced = new Set(channels.map((channel) => channel.resourceId))
  if (referenced.size !== channels.length || referenced.size !== values.length ||
      values.some((resource) => !referenced.has(resource.id))) {
    invalid('Volume channels must reference each value resource exactly once')
  }
}

function validatePlotResources(
  resources: readonly ServerArtifactVisualizationResource[],
  resourceId: string,
): void {
  if (
    resources.length !== 1 ||
    resources[0]?.role !== 'plot.values' ||
    resources[0]?.mimeType !== 'application/json' ||
    resources[0]?.id !== resourceId
  ) {
    invalid('Plot manifests require exactly one referenced JSON resource')
  }
}

function parseManifest(value: unknown): ServerArtifactVisualizationManifest {
  const manifest = parsePlainObject(value, 'manifest')
  if (manifest.version !== 1 || typeof manifest.kind !== 'string') {
    return invalid('Invalid visualization manifest version or kind')
  }
  const source = parseSource(manifest.source)
  const resources = parseResources(manifest.resources)

  switch (manifest.kind) {
    case 'trajectory': {
      if (!hasExactKeys(manifest, [
        'version', 'source', 'resources', 'kind', 'format', 'atomCount', 'frameCount',
        'elements', 'periodic', 'timeUnit', 'timeStep',
      ], ['frameTimes'])) return invalid('Invalid trajectory visualization manifest')
      if (!isAllowedString(manifest.format, ['extxyz', 'xdatcar', 'lammps-dump'])) {
        return invalid('Invalid trajectory visualization format')
      }
      if (typeof manifest.periodic !== 'boolean') return invalid('trajectory.periodic must be boolean')
      if (!isAllowedString(manifest.timeUnit, ['frame', 'fs', 'ps'])) {
        return invalid('Invalid trajectory time unit')
      }
      const atomCount = parseSafeInteger(
        manifest.atomCount,
        'trajectory.atomCount',
        1,
        SERVER_ARTIFACT_VISUALIZATION_MAX_ATOMS,
      )
      const frameCount = parseSafeInteger(
        manifest.frameCount,
        'trajectory.frameCount',
        1,
        SERVER_ARTIFACT_VISUALIZATION_MAX_FRAMES,
      )
      const elements = parseElements(manifest.elements)
      if (elements.length !== atomCount) return invalid('trajectory.elements count must equal atom count')
      const timeStep = parseFiniteNumber(manifest.timeStep, 'trajectory.timeStep')
      if (timeStep < 0) return invalid('trajectory.timeStep must not be negative')
      const frameTimes = manifest.frameTimes === undefined
        ? undefined
        : parseFrameTimes(manifest.frameTimes, frameCount)
      if (frameTimes !== undefined && manifest.timeUnit === 'frame') {
        return invalid('trajectory.frameTimes requires a physical time unit')
      }
      validateTrajectoryResources(resources, manifest.periodic)
      return {
        version: 1,
        source,
        resources,
        kind: 'trajectory',
        format: manifest.format as 'extxyz' | 'xdatcar' | 'lammps-dump',
        atomCount,
        frameCount,
        elements,
        periodic: manifest.periodic,
        timeUnit: manifest.timeUnit as 'frame' | 'fs' | 'ps',
        timeStep,
        ...(frameTimes === undefined ? {} : { frameTimes }),
      }
    }
    case 'volume': {
      if (!hasExactKeys(manifest, [
        'version', 'source', 'resources', 'kind', 'format', 'dimensions', 'origin', 'axes', 'channels',
      ])) return invalid('Invalid volume visualization manifest')
      if (!isAllowedString(manifest.format, ['cube', 'chgcar', 'elfcar'])) {
        return invalid('Invalid volume visualization format')
      }
      const dimensions = parseDimensions(manifest.dimensions)
      const origin = parseTuple3(manifest.origin, 'volume.origin')
      const axes = parseAxes(manifest.axes)
      const channels = parseChannels(manifest.channels)
      validateVolumeResources(resources, channels)
      for (const channel of channels) assertResourceRole(resources, channel.resourceId, 'volume.values')
      return {
        version: 1,
        source,
        resources,
        kind: 'volume',
        format: manifest.format as 'cube' | 'chgcar' | 'elfcar',
        dimensions,
        origin,
        axes,
        channels,
      }
    }
    case 'band': {
      if (!hasExactKeys(manifest, [
        'version', 'source', 'resources', 'kind', 'format', 'spinChannels', 'bands', 'kpoints',
        'fermiEnergy', 'resourceId',
      ])) return invalid('Invalid band visualization manifest')
      if (manifest.format !== 'vasp-eigenval') return invalid('Invalid band visualization format')
      if (manifest.spinChannels !== 1 && manifest.spinChannels !== 2) {
        return invalid('band.spinChannels must be one or two')
      }
      const bands = parseSafeInteger(manifest.bands, 'band.bands', 1, SERVER_ARTIFACT_VISUALIZATION_MAX_GRID_POINTS)
      const kpoints = parseSafeInteger(manifest.kpoints, 'band.kpoints', 1, SERVER_ARTIFACT_VISUALIZATION_MAX_GRID_POINTS)
      if (bands * kpoints * manifest.spinChannels > SERVER_ARTIFACT_VISUALIZATION_MAX_GRID_POINTS) {
        return invalid('band point count exceeds the supported limit')
      }
      const fermiEnergy = manifest.fermiEnergy === null
        ? null
        : parseFiniteNumber(manifest.fermiEnergy, 'band.fermiEnergy')
      const resourceId = parseSafeId(manifest.resourceId, 'band.resourceId')
      validatePlotResources(resources, resourceId)
      return {
        version: 1,
        source,
        resources,
        kind: 'band',
        format: 'vasp-eigenval',
        spinChannels: manifest.spinChannels,
        bands,
        kpoints,
        fermiEnergy,
        resourceId,
      }
    }
    case 'dos': {
      if (!hasExactKeys(manifest, [
        'version', 'source', 'resources', 'kind', 'format', 'spinChannels', 'points', 'fermiEnergy',
        'resourceId',
      ])) return invalid('Invalid DOS visualization manifest')
      if (manifest.format !== 'vasp-doscar') return invalid('Invalid DOS visualization format')
      if (manifest.spinChannels !== 1 && manifest.spinChannels !== 2) {
        return invalid('dos.spinChannels must be one or two')
      }
      const points = parseSafeInteger(manifest.points, 'dos.points', 1, SERVER_ARTIFACT_VISUALIZATION_MAX_GRID_POINTS)
      const fermiEnergy = parseFiniteNumber(manifest.fermiEnergy, 'dos.fermiEnergy')
      const resourceId = parseSafeId(manifest.resourceId, 'dos.resourceId')
      validatePlotResources(resources, resourceId)
      return {
        version: 1,
        source,
        resources,
        kind: 'dos',
        format: 'vasp-doscar',
        spinChannels: manifest.spinChannels,
        points,
        fermiEnergy,
        resourceId,
      }
    }
    default:
      return invalid('Unsupported visualization manifest kind')
  }
}

function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const key of Reflect.ownKeys(value as object)) {
    freezeDeep((value as Record<PropertyKey, unknown>)[key])
  }
  return Object.freeze(value)
}

/** Parse a server-derived visualization response into a frozen, detached DTO. */
export function parseServerArtifactVisualizationResponse(
  value: unknown,
): ServerArtifactVisualizationResponse {
  const response = parsePlainObject(value, 'visualization response')
  if (response.state === 'ready') {
    if (!hasExactKeys(response, ['state', 'manifest'])) return invalid('Invalid ready visualization response')
    return freezeDeep({ state: 'ready', manifest: parseManifest(response.manifest) })
  }
  if (response.state === 'unsupported') {
    if (!hasExactKeys(response, ['state', 'reason'])) return invalid('Invalid unsupported visualization response')
    if (!isAllowedString(response.reason, ['unsupported_format', 'malformed', 'too_large'])) {
      return invalid('Invalid unsupported visualization reason')
    }
    return freezeDeep({
      state: 'unsupported',
      reason: response.reason as 'unsupported_format' | 'malformed' | 'too_large',
    })
  }
  return invalid('Invalid visualization response state')
}
