import { lstat, readdir, realpath } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { scientificResultArtifactMimeType } from './scientific-artifact.mjs'

// Keep filesystem harvesting bounded independently of the upload byte limit.
// A run may create many small reports, but the worker must never walk an
// unbounded or attacker-controlled tree.
export const MAX_HARVESTED_ARTIFACTS = 24
export const MAX_ASSISTANT_REFERENCE_TEXT_CHARS = 128 * 1024
export const MAX_RESULT_ARTIFACT_BYTES = 1024 * 1024 * 1024

const MAX_VISITED_ENTRIES = 10_000
const MAX_RESULT_PATH_DEPTH = 16
const OUTPUT_PREFIXES = [
  ['.agents', 'outputs'],
  ['.agents', '.matterai-agent-kit', 'modeling', 'outputs'],
]
const EXCLUDED_ROOT_SEGMENTS = new Set([
  'uploads', 'feature-pipelines', 'node_modules',
  'inputs', 'input', 'configs', 'config', 'secrets', 'secret',
  'credentials', 'credential', 'requests', 'request',
])
const INTERNAL_TASK_ROOTS = new Set(['calculations', 'md_tasks'])
const INTERNAL_TASK_ID_PATTERN = /^(?:calc-[a-hj-km-np-z2-9]{12}|md-(?:[0-9]{4,12}-[a-hj-km-np-z2-9]{8}|[1-9][0-9]{0,11}))$/iu
const INTERNAL_JOURNAL_FILE_PATTERN = /^record-[0-9]{6}\.json$/iu
const INTERNAL_TASK_CONTROL_FILE_PATTERN = /^(?:request|receipt|progress|reaction-details)\.json$/iu
const INTERNAL_REACTION_OPTIMIZATION_FILE_PATTERN = /^(?:reactant_minimum|product_minimum|transition_state)_optim\.xyz$/iu
const INTERNAL_JOB_DIRECTORY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const INTERNAL_CED_RERUN_TASK_PATTERN = /^analysis-[A-Za-z0-9_-]{1,120}$/iu
const INTERNAL_CED_RERUN_FILE_PATTERN = /^(?:bulk|isolated)\.(?:data|dump|in|log)$/iu
// MLCC creates one control record plus an execution payload for every
// staged task.  These are provenance/transport inputs, not user-facing
// results.  Keep the surrounding task tree eligible so a real report,
// structure, trajectory, or volume written there can still be harvested.
const INTERNAL_MLCC_TASK_CONTROL_FILE_PATTERN = /^(?:task|operation-request|operation-output|operation-result|scale-request|scale-response|host-deployment)\.json$/iu
const INTERNAL_ARTIFACT_CATEGORIES = new Set([
  'chemical_system_manifest', 'conformer_ensemble', 'compute_job_receipt',
  'coverage_ledger', 'initial_model_ensemble', 'md_handoff', 'md_workflow',
  'parameterized_model_ensemble', 'registered_trajectory_collection',
  'registered_trajectory_ensemble',
])
const MD_PACKING_DIRECTORY_PATTERN = /^md-packing-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu
const GENERATED_VISUALIZATION_JSON_PATTERN = /^visualizations-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.json$/iu
const WIRE_UNSAFE_LABEL_PATTERN = /[\u0000-\u001f\u007f"\\]/

const SAFE_RESULT_MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.txt': 'text/plain',
}

function comparePath(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function sameSegments(left, right) {
  return left.length === right.length && left.every((segment, index) => segment === right[index])
}

function isInsidePrefix(segments, prefix) {
  return segments.length >= prefix.length && sameSegments(segments.slice(0, prefix.length), prefix) &&
    segments.slice(prefix.length).every((segment) => !segment.startsWith('.'))
}

function isPrefix(segments, prefix) {
  return segments.length <= prefix.length && segments.every((segment, index) => segment === prefix[index])
}

function isSensitivePath(segments) {
  if (segments.some((segment) => EXCLUDED_ROOT_SEGMENTS.has(segment.toLowerCase()))) return true
  const name = segments.at(-1)?.toLowerCase() ?? ''
  if (/\.(?:env|pem|key|p12|pfx|sqlite|db)$/iu.test(name)) return true
  return /(?:config|settings|credentials?|secrets?|password|token)/iu.test(name)
}

function isInternalMlccTaskPath(segments) {
  if (segments[0]?.toLowerCase() !== 'tasks' || segments.length < 3) return false
  const fileName = segments.at(-1) ?? ''
  return segments.slice(2).includes('payload') || INTERNAL_MLCC_TASK_CONTROL_FILE_PATTERN.test(fileName)
}

function isMlccTaskPayloadPath(segments) {
  return segments[0]?.toLowerCase() === 'tasks' && segments.length >= 3 && segments.slice(2).includes('payload')
}

function safeResultMimeType(relativePath) {
  return scientificResultArtifactMimeType(relativePath) ?? SAFE_RESULT_MIME_TYPES[extname(relativePath).toLowerCase()] ?? null
}

/**
 * Keep automatic harvesting on the public result surface.  Internal files
 * remain discoverable by an explicit tool call, but are never inferred from a
 * changed-file sweep.
 */
export function isDefaultHarvestPath(relativePath) {
  const segments = relativePath.split('/')
  if (isSensitivePath(segments) || isInternalMlccTaskPath(segments)) return false

  const outputPrefix = OUTPUT_PREFIXES.find((prefix) => isInsidePrefix(segments, prefix) || isPrefix(segments, prefix))
  const outputIndex = segments[0] === 'outputs'
    ? 0
    : outputPrefix === undefined ? -1 : outputPrefix.length - 1
  if (outputIndex < 0) return true

  const outputDirectory = segments[outputIndex + 1]?.toLowerCase()
  const name = segments.at(-1) ?? ''
  if (outputDirectory !== undefined && MD_PACKING_DIRECTORY_PATTERN.test(segments[outputIndex + 1])) return false
  if (outputDirectory === 'ced-reruns' && INTERNAL_CED_RERUN_TASK_PATTERN.test(segments[outputIndex + 2] ?? '') && INTERNAL_CED_RERUN_FILE_PATTERN.test(name)) return false
  if (outputDirectory !== undefined && INTERNAL_TASK_ROOTS.has(outputDirectory) && INTERNAL_TASK_ID_PATTERN.test(segments[outputIndex + 2] ?? '') && (
    INTERNAL_JOURNAL_FILE_PATTERN.test(name) || INTERNAL_TASK_CONTROL_FILE_PATTERN.test(name) ||
    (segments[outputIndex + 3] === 'reaction' && INTERNAL_REACTION_OPTIMIZATION_FILE_PATTERN.test(name)))) return false
  if (outputDirectory === 'worker' && segments.length === outputIndex + 3 && /^(?:allocation-[A-Za-z0-9_-]{1,120}|dispatcher-status|dispatch|status)\.json$/iu.test(name)) return false
  if (outputDirectory === 'jobs' && INTERNAL_JOB_DIRECTORY_PATTERN.test(segments[outputIndex + 2] ?? '') && segments.length >= outputIndex + 4) return false
  if (outputDirectory !== 'artifacts') return true
  const category = segments[outputIndex + 2]?.toLowerCase()
  if (category !== undefined && INTERNAL_ARTIFACT_CATEGORIES.has(category)) return false
  if (category === 'visualizations' && GENERATED_VISUALIZATION_JSON_PATTERN.test(name)) return false
  return true
}

function pathMayBeVisited(segments) {
  // Control records stay in the snapshot so an assistant may explicitly name
  // one when the original contract calls for it. They are excluded from the
  // changed-file selector below. Payload trees remain out of the scan.
  if (segments.length > MAX_RESULT_PATH_DEPTH || isSensitivePath(segments) || isMlccTaskPayloadPath(segments)) return false
  const hasKnownOutputPrefix = OUTPUT_PREFIXES.some((prefix) => isInsidePrefix(segments, prefix) || isPrefix(segments, prefix))
  if (hasKnownOutputPrefix) return true
  if (segments.some((segment) => segment.startsWith('.'))) return false
  return !EXCLUDED_ROOT_SEGMENTS.has(segments[0]?.toLowerCase() ?? '')
}

function pathIsWireSafe(relativePath, segments, displayName) {
  return relativePath.length <= 512 && !/^[A-Za-z]:/.test(relativePath) && segments.length <= MAX_RESULT_PATH_DEPTH &&
    segments.every((segment) => segment.length > 0 && segment.length <= 120 && segment !== '.' && segment !== '..' && !WIRE_UNSAFE_LABEL_PATTERN.test(segment)) &&
    displayName.length > 0 && displayName.length <= 160 && displayName !== '.' && displayName !== '..' && !WIRE_UNSAFE_LABEL_PATTERN.test(displayName)
}

function fileIdentity(info) {
  if (typeof info.dev !== 'number' || typeof info.ino !== 'number' || typeof info.size !== 'number' || typeof info.mtimeMs !== 'number' || typeof info.ctimeMs !== 'number' || !Number.isSafeInteger(info.size) || info.size < 0) return null
  return { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

function resultLimit(value) {
  if (value === undefined) return MAX_HARVESTED_ARTIFACTS
  if (!Number.isSafeInteger(value) || value < 0) return 0
  return Math.min(value, MAX_HARVESTED_ARTIFACTS)
}

function scanLimit(value) {
  if (value === undefined) return MAX_VISITED_ENTRIES
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_VISITED_ENTRIES) return MAX_VISITED_ENTRIES
  return value
}

function isWithin(root, candidate) {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

async function captureSnapshot(workspacePath, limits = {}) {
  const snapshot = new Map()
  const rootPath = resolve(workspacePath)
  let rootReal
  try {
    rootReal = await realpath(rootPath)
    const rootStat = await lstat(rootPath)
    if (!rootStat.isDirectory()) return { entries: snapshot, complete: false }
  } catch {
    return { entries: snapshot, complete: false }
  }

  const maximumVisitedEntries = scanLimit(limits.maxVisitedEntries)
  let visitedEntries = 0
  let complete = true
  const assertPath = async (path) => {
    const candidate = resolve(path)
    if (!isWithin(rootPath, candidate)) throw new Error('Path escapes workspace')
    const actual = await realpath(candidate)
    if (!isWithin(rootReal, actual)) throw new Error('Path escapes workspace')
  }
  const visit = async (directoryPath, parentSegments) => {
    if (!complete) return
    let entries
    try {
      await assertPath(directoryPath)
      entries = await readdir(directoryPath, { withFileTypes: true })
    } catch {
      complete = false
      return
    }
    entries.sort((left, right) => comparePath(left.name, right.name))
    for (const entry of entries) {
      if (visitedEntries >= maximumVisitedEntries) {
        complete = false
        return
      }
      visitedEntries += 1
      const segments = [...parentSegments, entry.name]
      if (!pathMayBeVisited(segments)) continue
      const childPath = join(directoryPath, entry.name)
      let info
      try {
        info = await lstat(childPath)
        if (info.isSymbolicLink()) continue
        await assertPath(childPath)
      } catch {
        continue
      }
      if (info.isDirectory()) {
        await visit(childPath, segments)
        if (!complete) return
        continue
      }
      if (!info.isFile()) continue
      const relativePath = segments.join('/')
      const mimeType = safeResultMimeType(relativePath)
      if (mimeType === null) continue
      const displayName = basename(relativePath)
      if (!pathIsWireSafe(relativePath, segments, displayName)) continue
      const identity = fileIdentity(info)
      if (identity === null || info.nlink !== 1 || identity.size > MAX_RESULT_ARTIFACT_BYTES) continue
      snapshot.set(relativePath, { relativePath, displayName, mimeType, identity })
    }
  }
  await visit(rootPath, [])
  return { entries: new Map([...snapshot.entries()].sort(([left], [right]) => comparePath(left, right))), complete }
}

export async function captureResultFileSnapshot(workspacePath, limits = {}) {
  return captureSnapshot(workspacePath, limits)
}

export async function findChangedResultFiles(workspacePath, before, excludedPaths = new Set(), limits = {}) {
  if (!before.complete) return []
  const after = await captureSnapshot(workspacePath, limits)
  return selectChangedResultFiles(before, after, excludedPaths)
}

export function selectChangedResultFiles(before, after, excludedPaths = new Set(), maximumResults = MAX_HARVESTED_ARTIFACTS) {
  if (!before.complete || !after.complete) return []
  const changed = [...after.entries.values()]
    .filter((entry) => {
      if (!isDefaultHarvestPath(entry.relativePath) || excludedPaths.has(entry.relativePath)) return false
      const previous = before.entries.get(entry.relativePath)
      return previous === undefined || !sameIdentity(previous.identity, entry.identity)
    })
    .sort((left, right) => comparePath(left.relativePath, right.relativePath))
  return changed.slice(0, resultLimit(maximumResults)).map(({ relativePath, displayName, mimeType }) => ({ relativePath, displayName, mimeType }))
}

function normalizeReference(value, trimPunctuation) {
  let normalized = value.trim()
  if (trimPunctuation) normalized = normalized.replace(/^[,.;:!?，。；：！？]+/u, '').replace(/[,.;:!?，。；：！？]+$/u, '')
  while (normalized.startsWith('./')) normalized = normalized.slice(2)
  if (normalized.length === 0 || normalized.startsWith('/') || /^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/)/u.test(normalized)) return null
  return normalized
}

function referenceTokens(text) {
  const bounded = text.slice(0, MAX_ASSISTANT_REFERENCE_TEXT_CHARS).replace(/\[[^\]\r\n]*\]\(\s*(?:(?:[A-Za-z][A-Za-z0-9+.-]*:)|\/\/)[^\)\r\n]*\)/gu, (match) => ' '.repeat(match.length))
  const quotedReferences = []
  const unquotedSource = bounded.replace(/(["'`])([\s\S]*?)\1/gu, (match, _quote, value) => {
    const normalized = normalizeReference(value, false)
    if (normalized !== null) quotedReferences.push({ value: normalized, quoted: true })
    return ' '.repeat(match.length)
  })
  const unquotedReferences = []
  for (const match of unquotedSource.matchAll(/[^\s"'`<>()[\]{}]+/gu)) {
    const normalized = normalizeReference(match[0], true)
    if (normalized !== null) unquotedReferences.push({ value: normalized, quoted: false })
  }
  return [...quotedReferences, ...unquotedReferences]
}

function unquotedCollisionFragments(snapshot) {
  const fragments = new Set()
  for (const entry of snapshot.entries.values()) {
    if (!/\s/u.test(entry.relativePath) && !/\s/u.test(entry.displayName)) continue
    for (const fragment of `${entry.relativePath} ${entry.displayName}`.split(/\s+/u)) {
      const normalized = normalizeReference(fragment, true)
      if (normalized !== null) fragments.add(normalized)
    }
  }
  return fragments
}

export function selectReferencedResultFiles(snapshot, assistantText, excludedPaths = new Set(), maximumResults = MAX_HARVESTED_ARTIFACTS) {
  if (!snapshot.complete || assistantText.length === 0) return []
  const references = referenceTokens(assistantText)
  if (references.length === 0) return []

  const byDisplayName = new Map()
  for (const entry of snapshot.entries.values()) {
    const entries = byDisplayName.get(entry.displayName) ?? []
    entries.push(entry)
    byDisplayName.set(entry.displayName, entries)
  }
  const collisionFragments = unquotedCollisionFragments(snapshot)
  const referenced = new Map()
  for (const reference of references) {
    if (!reference.quoted && collisionFragments.has(reference.value)) continue
    const direct = snapshot.entries.get(reference.value)
    if (direct !== undefined && !excludedPaths.has(direct.relativePath)) {
      referenced.set(direct.relativePath, { relativePath: direct.relativePath, displayName: direct.displayName, mimeType: direct.mimeType })
      continue
    }
    const matches = byDisplayName.get(reference.value)
    if (matches?.length !== 1) continue
    const match = matches[0]
    if (!excludedPaths.has(match.relativePath)) referenced.set(match.relativePath, { relativePath: match.relativePath, displayName: match.displayName, mimeType: match.mimeType })
  }
  return [...referenced.values()].sort((left, right) => comparePath(left.relativePath, right.relativePath)).slice(0, resultLimit(maximumResults))
}

export async function findReferencedResultFiles(workspacePath, assistantText, excludedPaths = new Set(), limits = {}) {
  const snapshot = await captureSnapshot(workspacePath, limits)
  return selectReferencedResultFiles(snapshot, assistantText, excludedPaths, limits.maxResults)
}
