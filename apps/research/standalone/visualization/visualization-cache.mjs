import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
} from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

import {
  parseServerArtifactVisualizationResourceId,
  parseServerArtifactVisualizationResponse,
  SERVER_ARTIFACT_VISUALIZATION_MAX_RESOURCES,
  SERVER_ARTIFACT_VISUALIZATION_MAX_RESOURCE_BYTES,
                                           
                                           
} from './scientific-visualization.mjs'

const CACHE_DIRECTORY_NAME = 'scientific-visualization-cache'
const MANIFEST_FILE = 'manifest.json'
const INTEGRITY_FILE = 'integrity.json'
const RESOURCES_DIRECTORY = 'resources'
const CACHE_KEY_PATTERN = /^[a-f0-9]{64}$/
const DIGEST_PATTERN = /^[a-f0-9]{64}$/
const ADAPTER_ID_PATTERN = /^[A-Za-z0-9._-]{1,80}$/
const CACHE_KEY_DOMAIN = Buffer.from('zeus.scientific-visualization.cache.v1', 'utf8')
const MANIFEST_MAX_BYTES = 8 * 1024 * 1024
const INTEGRITY_MAX_BYTES = 1024 * 1024

const CACHE_ENTRY_BRAND = new WeakSet        ()
const CACHE_ENTRY_INTEGRITY = new WeakMap                                              ()
                                   
              
             
             
  
const CACHE_ENTRY_DIRECTORIES = new WeakMap                   
                         
                          
                              
   ()

                                                        
                                                 
                   
  

                                                         
                                               
                                                       
  

                                                
             
                  
                                               
                                                                      
                   
                                                                          
              
  

                                                  
                                                 
                   
                                   
  

export class VisualizationCacheError extends Error {
  constructor(message = 'Visualization cache operation failed.') {
    super(message)
    this.name = 'VisualizationCacheError'
  }
}

export class VisualizationCacheCorruptionError extends VisualizationCacheError {
  constructor() {
    super('Visualization cache entry is corrupt.')
    this.name = 'VisualizationCacheCorruptionError'
  }
}

                                                                                                      

/**
 * Closed adapter failures must cross the cache boundary without exposing an
 * adapter's arbitrary exception text.  The preprocessor unwraps this small
 * public reason set and maps it back to its normal unsupported response.
 */
export class VisualizationCacheProducerError extends VisualizationCacheError {
           reason                                         

  constructor(reason                                         ) {
    super('Visualization producer rejected the source.')
    this.name = 'VisualizationCacheProducerError'
    this.reason = reason
  }
}

function cacheError()                          {
  return new VisualizationCacheError()
}

function corruption()                                    {
  return new VisualizationCacheCorruptionError()
}

function isSafeKey(value         )                  {
  return typeof value === 'string' && CACHE_KEY_PATTERN.test(value)
}

function safeAdapterIdentity(value         , label        )         {
  if (typeof value !== 'string' || !ADAPTER_ID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a safe adapter identity`)
  }
  return value
}

function isUint8Array(value         )                      {
  return value instanceof Uint8Array
}

function sha256(bytes            )         {
  return createHash('sha256').update(bytes).digest('hex')
}

function cloneBytes(bytes            )             {
  return new Uint8Array(bytes)
}

async function captureDirectoryIdentity(pathname        )                             {
  try {
    const info = await lstat(pathname)
    if (info.isSymbolicLink() || !info.isDirectory() ||
      !Number.isSafeInteger(info.dev) || !Number.isSafeInteger(info.ino)) throw corruption()
    return Object.freeze({ path: resolve(pathname), dev: info.dev, ino: info.ino })
  } catch (error) {
    if (error instanceof VisualizationCacheError) throw error
    throw cacheError()
  }
}

async function verifyDirectoryIdentity(identity                   )                {
  const current = await captureDirectoryIdentity(identity.path)
  if (current.dev !== identity.dev || current.ino !== identity.ino) throw corruption()
}

async function readDirectoryNames(
  pathname        ,
  identity                   ,
)                    {
  await verifyDirectoryIdentity(identity)
  let names          
  try {
    names = await readdir(pathname)
  } catch {
    throw corruption()
  }
  await verifyDirectoryIdentity(identity)
  return names
}

function assertContained(root        , pathname        )       {
  const canonicalRoot = resolve(root)
  const canonicalPath = resolve(pathname)
  const suffix = relative(canonicalRoot, canonicalPath)
  if (suffix === '' || suffix.startsWith(`..${requirePathSeparator()}`) || suffix === '..') {
    throw corruption()
  }
}

// Kept as a function so the containment check remains platform-safe without
// exposing path details in any error text.
function requirePathSeparator()         {
  return process.platform === 'win32' ? '\\' : '/'
}

async function assertTrustedStateRoot(pathname        )                             {
  try {
    return await captureDirectoryIdentity(pathname)
  } catch {
    throw cacheError()
  }
}

async function ensurePrivateDirectory(
  pathname        ,
  parentIdentity                    ,
)                             {
  const parent = dirname(pathname)
  let parentGuard                   
  try {
    parentGuard = parentIdentity ?? await captureDirectoryIdentity(parent)
    await verifyDirectoryIdentity(parentGuard)
  } catch (error) {
    if (error instanceof VisualizationCacheError) throw error
    throw cacheError()
  }
  try {
    const info = await lstat(pathname)
    if (info.isSymbolicLink() || !info.isDirectory()) throw corruption()
    await verifyDirectoryIdentity(parentGuard)
    await chmod(pathname, 0o700)
    const identity = await captureDirectoryIdentity(pathname)
    const after = await lstat(pathname)
    if (after.isSymbolicLink() || !after.isDirectory() || (after.mode & 0o777) !== 0o700 ||
      after.dev !== identity.dev || after.ino !== identity.ino) throw corruption()
    await verifyDirectoryIdentity(parentGuard)
    return identity
  } catch (error) {
    if (error instanceof VisualizationCacheError) throw error
    if ((error                         ).code !== 'ENOENT') throw cacheError()
    try {
      await verifyDirectoryIdentity(parentGuard)
      await mkdir(pathname, { recursive: false, mode: 0o700 })
      await chmod(pathname, 0o700)
      await verifyDirectoryIdentity(parentGuard)
      return await captureDirectoryIdentity(pathname)
    } catch (innerError) {
      if (innerError instanceof VisualizationCacheError) throw innerError
      throw cacheError()
    }
  }
}

async function assertPrivateDirectory(pathname        )                             {
  let info
  try {
    info = await lstat(pathname)
  } catch {
    throw corruption()
  }
  if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o777) !== 0o700 ||
    !Number.isSafeInteger(info.dev) || !Number.isSafeInteger(info.ino)) {
    throw corruption()
  }
  return Object.freeze({ path: resolve(pathname), dev: info.dev, ino: info.ino })
}

async function assertPrivateFile(pathname        , parentIdentity                    )                {
  let info
  try {
    if (parentIdentity !== undefined) await verifyDirectoryIdentity(parentIdentity)
    info = await lstat(pathname)
  } catch {
    throw corruption()
  }
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600) {
    throw corruption()
  }
  if (parentIdentity !== undefined) await verifyDirectoryIdentity(parentIdentity)
}

async function syncDirectory(pathname        , identity                   )                {
  try {
    await verifyDirectoryIdentity(identity)
    const handle = await open(pathname, constants.O_RDONLY)
    try { await handle.sync() } finally { await handle.close() }
    await verifyDirectoryIdentity(identity)
  } catch (error) {
    const code = (error                         ).code
    // Directory fsync is not available on every supported filesystem. It is
    // best effort; file fsync and atomic rename still provide the commit edge.
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR' && code !== 'EPERM') {
      throw cacheError()
    }
  }
}

async function writePrivateFile(
  pathname        ,
  bytes                     ,
  parentIdentity                   ,
)                {
  try {
    await verifyDirectoryIdentity(parentIdentity)
    const handle = await open(pathname, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    try {
      if (typeof bytes === 'string') await handle.writeFile(bytes, 'utf8')
      else await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await chmod(pathname, 0o600)
    await verifyDirectoryIdentity(parentIdentity)
  } catch {
    throw cacheError()
  }
}

async function readPrivateBytes(
  pathname        ,
  maxBytes        ,
  parentIdentity                   ,
)                  {
  try {
    await verifyDirectoryIdentity(parentIdentity)
    const noFollow = (constants                                              ).O_NOFOLLOW ?? 0
    const handle = await open(pathname, constants.O_RDONLY | noFollow)
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 ||
        !Number.isSafeInteger(info.size) || info.size < 0 || info.size > maxBytes) throw corruption()
      const bytes = await handle.readFile()
      const after = await handle.stat()
      if (!after.isFile() || after.nlink !== 1 || (after.mode & 0o777) !== 0o600 ||
        !Number.isSafeInteger(after.size) || after.size < 0 || after.size > maxBytes ||
        after.size !== info.size || bytes.byteLength !== after.size) throw corruption()
      await verifyDirectoryIdentity(parentIdentity)
      return bytes
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (error instanceof VisualizationCacheError) throw error
    throw corruption()
  }
}

function validateProducerOutput(output                                  )                                   {
  let parsedManifest                                     
  try {
    const parsed = parseServerArtifactVisualizationResponse({
      state: 'ready',
      manifest: output?.manifest,
    })
    if (parsed.state !== 'ready') throw corruption()
    parsedManifest = parsed.manifest
  } catch {
    throw corruption()
  }
  if (!Array.isArray(output?.resources) || output.resources.length !== parsedManifest.resources.length) {
    throw corruption()
  }
  if (output.resources.length > SERVER_ARTIFACT_VISUALIZATION_MAX_RESOURCES) throw corruption()
  const byId = new Map(parsedManifest.resources.map((resource) => [resource.id, resource]))
  const seen = new Set        ()
  const resources                                    = []
  for (const item of output.resources) {
    if (item === null || typeof item !== 'object' || !isUint8Array(item.bytes)) throw corruption()
    let id        
    try { id = parseServerArtifactVisualizationResourceId(item.descriptor?.id) } catch { throw corruption() }
    if (seen.has(id)) throw corruption()
    seen.add(id)
    const expected = byId.get(id)
    const descriptor = item.descriptor
    if (
      expected === undefined ||
      descriptor.mimeType !== expected.mimeType ||
      descriptor.role !== expected.role ||
      descriptor.byteLength !== expected.byteLength ||
      item.bytes.byteLength !== expected.byteLength ||
      item.bytes.byteLength > SERVER_ARTIFACT_VISUALIZATION_MAX_RESOURCE_BYTES
    ) throw corruption()
    resources.push({ descriptor: expected, bytes: cloneBytes(item.bytes) })
  }
  if (seen.size !== byId.size) throw corruption()
  return { manifest: parsedManifest, resources }
}

                                                                       

async function readJson(pathname        , maxBytes        , parentIdentity                   )                   {
  try {
    return JSON.parse((await readPrivateBytes(pathname, maxBytes, parentIdentity)).toString('utf8'))           
  } catch {
    throw corruption()
  }
}

function isPlainRecord(value         )                                   {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function parseIntegrity(value         , resources                                                )                               {
  if (!isPlainRecord(value)) throw corruption()
  const expectedIds = new Set(resources.map((resource) => resource.id))
  const keys = Reflect.ownKeys(value)
  if (keys.length !== expectedIds.size || keys.some((key) => typeof key !== 'string' || !expectedIds.has(key))) {
    throw corruption()
  }
  const parsed = new Map                         ()
  for (const id of expectedIds) {
    const record = value[id]
    if (!isPlainRecord(record) || Reflect.ownKeys(record).length !== 2 ||
      typeof record.sha256 !== 'string' || !DIGEST_PATTERN.test(record.sha256) ||
      typeof record.byteLength !== 'number' || !Number.isSafeInteger(record.byteLength) ||
      record.byteLength < 0 || record.byteLength > SERVER_ARTIFACT_VISUALIZATION_MAX_RESOURCE_BYTES) {
      throw corruption()
    }
    parsed.set(id, { sha256: record.sha256, byteLength: record.byteLength })
  }
  return parsed
}

async function readValidatedEntry(
  key        ,
  directory        ,
  root         ,
  expectedRootIdentity                    ,
)                                   {
  if (!isSafeKey(key)) throw corruption()
  const trustedRoot = resolve(root ?? dirname(directory))
  if (resolve(directory) !== resolve(join(trustedRoot, key))) throw corruption()
  const rootIdentity = expectedRootIdentity ?? await captureDirectoryIdentity(trustedRoot)
  if (resolve(rootIdentity.path) !== trustedRoot) throw corruption()
  await verifyDirectoryIdentity(rootIdentity)
  const entryIdentity = await assertPrivateDirectory(directory)
  await verifyDirectoryIdentity(rootIdentity)
  const names = await readDirectoryNames(directory, entryIdentity)
  if (names.length !== 3 || !names.includes(MANIFEST_FILE) || !names.includes(INTEGRITY_FILE) || !names.includes(RESOURCES_DIRECTORY)) {
    throw corruption()
  }
  const manifestPath = join(directory, MANIFEST_FILE)
  const integrityPath = join(directory, INTEGRITY_FILE)
  const resourcesDirectory = join(directory, RESOURCES_DIRECTORY)
  assertContained(directory, manifestPath)
  assertContained(directory, integrityPath)
  assertContained(directory, resourcesDirectory)
  await assertPrivateFile(manifestPath, entryIdentity)
  await assertPrivateFile(integrityPath, entryIdentity)
  const resourcesIdentity = await assertPrivateDirectory(resourcesDirectory)

  const manifestValue = await readJson(manifestPath, MANIFEST_MAX_BYTES, entryIdentity)
  let manifest                                     
  try {
    const parsed = parseServerArtifactVisualizationResponse({ state: 'ready', manifest: manifestValue })
    if (parsed.state !== 'ready') throw corruption()
    manifest = parsed.manifest
  } catch {
    throw corruption()
  }
  if (manifest.resources.length > SERVER_ARTIFACT_VISUALIZATION_MAX_RESOURCES) throw corruption()
  const integrity = parseIntegrity(await readJson(integrityPath, INTEGRITY_MAX_BYTES, entryIdentity), manifest.resources)
  const resourceNames = await readDirectoryNames(resourcesDirectory, resourcesIdentity)
  if (resourceNames.length !== manifest.resources.length) throw corruption()
  const expectedIds = new Set(manifest.resources.map((resource) => resource.id))
  for (const name of resourceNames) {
    let id        
    try { id = parseServerArtifactVisualizationResourceId(name) } catch { throw corruption() }
    if (!expectedIds.has(id)) throw corruption()
    const resourcePath = join(resourcesDirectory, id)
    assertContained(resourcesDirectory, resourcePath)
    await assertPrivateFile(resourcePath, resourcesIdentity)
    const bytes = await readPrivateBytes(resourcePath, SERVER_ARTIFACT_VISUALIZATION_MAX_RESOURCE_BYTES, resourcesIdentity)
    const descriptor = manifest.resources.find((resource) => resource.id === id)
    const record = integrity.get(id)
    if (descriptor === undefined || record === undefined ||
      bytes.byteLength !== descriptor.byteLength || bytes.byteLength !== record.byteLength ||
      sha256(bytes) !== record.sha256) throw corruption()
  }
  await verifyDirectoryIdentity(rootIdentity)
  await verifyDirectoryIdentity(entryIdentity)
  await verifyDirectoryIdentity(resourcesIdentity)
  const entry = Object.freeze({ key, cacheKey: key, manifest, directory, root: trustedRoot })
  CACHE_ENTRY_BRAND.add(entry)
  CACHE_ENTRY_INTEGRITY.set(entry, integrity)
  CACHE_ENTRY_DIRECTORIES.set(entry, { root: rootIdentity, entry: entryIdentity, resources: resourcesIdentity })
  return entry
}

export function computeVisualizationCacheKey(
  bytes            ,
  adapterId        ,
  adapterVersion        ,
)         {
  if (!isUint8Array(bytes)) throw new TypeError('Invalid visualization cache key input')
  const safeId = safeAdapterIdentity(adapterId, 'adapterId')
  const safeVersion = safeAdapterIdentity(adapterVersion, 'adapterVersion')
  const frame = (value            )         => {
    const length = Buffer.allocUnsafe(8)
    length.writeBigUInt64BE(BigInt(value.byteLength), 0)
    return Buffer.concat([length, Buffer.from(value)])
  }
  return createHash('sha256')
    .update(CACHE_KEY_DOMAIN)
    .update(frame(bytes))
    .update(frame(Buffer.from(safeId, 'utf8')))
    .update(frame(Buffer.from(safeVersion, 'utf8')))
    .digest('hex')
}

export class VisualizationCache {
                   stateRoot        
                   root        
                   flights = new Map                                          ()

  constructor(options                                 ) {
    if (typeof options?.stateRoot !== 'string' || options.stateRoot.length === 0) {
      throw new TypeError('Visualization cache stateRoot is required')
    }
    this.stateRoot = resolve(options.stateRoot)
    this.root = join(this.stateRoot, CACHE_DIRECTORY_NAME)
  }

  get rootPath()         {
    return this.root
  }

  async getOrCreate(
    key        ,
    producer                                                 ,
  )                                   {
    if (!isSafeKey(key) || typeof producer !== 'function') throw new TypeError('Invalid visualization cache request')
    const inFlight = this.flights.get(key)
    if (inFlight !== undefined) return inFlight
    const task = this.loadOrProduce(key, producer)
    this.flights.set(key, task)
    try {
      return await task
    } finally {
      if (this.flights.get(key) === task) this.flights.delete(key)
    }
  }

  async openResource(entry                         , resourceId        )                                     {
    if (!CACHE_ENTRY_BRAND.has(entry          ) || entry.root !== this.root) {
      throw new TypeError('Invalid visualization cache entry')
    }
    return openResource(entry, resourceId)
  }

          async loadOrProduce(
    key        ,
    producer                                                 ,
  )                                   {
    const stateRootIdentity = await assertTrustedStateRoot(this.stateRoot)
    const rootIdentity = await ensurePrivateDirectory(this.root, stateRootIdentity)
    await verifyDirectoryIdentity(stateRootIdentity)
    const directory = join(this.root, key)
    assertContained(this.root, directory)
    try {
      await verifyDirectoryIdentity(rootIdentity)
      const existing = await lstat(directory)
      await verifyDirectoryIdentity(rootIdentity)
      if (existing.isSymbolicLink() || !existing.isDirectory()) throw corruption()
      return await readValidatedEntry(key, directory, this.root, rootIdentity)
    } catch (error) {
      if (error instanceof VisualizationCacheError) throw error
      if ((error                         ).code !== 'ENOENT') throw cacheError()
    }

    const temporaryDirectory = join(this.root, `.${key}.${randomUUID()}.tmp`)
    assertContained(this.root, temporaryDirectory)
    const cleanupTemporaryDirectory = async ()                => {
      try {
        await verifyDirectoryIdentity(rootIdentity)
        await rm(temporaryDirectory, { recursive: true, force: true })
        await verifyDirectoryIdentity(rootIdentity)
      } catch {
        // Preserve the operation's original error. The root guard above still
        // prevents cleanup from traversing a replaced ancestor directory.
      }
    }
    try {
      await verifyDirectoryIdentity(rootIdentity)
      await mkdir(temporaryDirectory, { recursive: false, mode: 0o700 })
      await chmod(temporaryDirectory, 0o700)
      await verifyDirectoryIdentity(rootIdentity)
      const temporaryIdentity = await assertPrivateDirectory(temporaryDirectory)
      const resourcesDirectory = join(temporaryDirectory, RESOURCES_DIRECTORY)
      const resourcesIdentity = await ensurePrivateDirectory(resourcesDirectory, temporaryIdentity)
      const produced = validateProducerOutput(await producer())
      await writePrivateFile(
        join(temporaryDirectory, MANIFEST_FILE),
        `${JSON.stringify(produced.manifest)}\n`,
        temporaryIdentity,
      )
      const integrity                                  = Object.create(null)                                   
      for (const resource of produced.resources) {
        const resourcePath = join(resourcesDirectory, resource.descriptor.id)
        assertContained(resourcesDirectory, resourcePath)
        await writePrivateFile(resourcePath, resource.bytes, resourcesIdentity)
        integrity[resource.descriptor.id] = {
          sha256: sha256(resource.bytes),
          byteLength: resource.bytes.byteLength,
        }
      }
      await writePrivateFile(
        join(temporaryDirectory, INTEGRITY_FILE),
        `${JSON.stringify(integrity)}\n`,
        temporaryIdentity,
      )
      await syncDirectory(resourcesDirectory, resourcesIdentity)
      await syncDirectory(temporaryDirectory, temporaryIdentity)
      try {
        await verifyDirectoryIdentity(rootIdentity)
        await rename(temporaryDirectory, directory)
        await verifyDirectoryIdentity(rootIdentity)
      } catch (renameError) {
        // Another process may have completed the same content-addressed key.
        // Never replace an existing entry; validate it instead.
        await verifyDirectoryIdentity(rootIdentity)
        await cleanupTemporaryDirectory()
        if ((renameError                         ).code !== 'EEXIST' &&
          (renameError                         ).code !== 'ENOTEMPTY') {
          throw renameError
        }
        return await readValidatedEntry(key, directory, this.root, rootIdentity)
      }
      await syncDirectory(this.root, rootIdentity)
      return await readValidatedEntry(key, directory, this.root, rootIdentity)
    } catch (error) {
      await cleanupTemporaryDirectory()
      if (error instanceof VisualizationCacheError) throw error
      throw cacheError()
    }
  }
}

/** Open one resource after revalidating the complete private cache entry. */
export async function openResource(
  entry                         ,
  resourceId        ,
)                                     {
  if (entry === null || typeof entry !== 'object' || !isSafeKey(entry.key) ||
    typeof entry.directory !== 'string' || typeof entry.root !== 'string' ||
    !CACHE_ENTRY_BRAND.has(entry          ) ||
    ('cacheKey' in entry && entry.cacheKey !== entry.key) ||
    resolve(entry.directory) !== resolve(join(entry.root, entry.key))) {
    throw new TypeError('Invalid visualization cache entry')
  }
  let id        
  try { id = parseServerArtifactVisualizationResourceId(resourceId) } catch { throw new VisualizationCacheError('Invalid visualization resource id.') }
  const boundDirectories = CACHE_ENTRY_DIRECTORIES.get(entry          )
  if (boundDirectories === undefined) throw corruption()
  await verifyDirectoryIdentity(boundDirectories.root)
  await verifyDirectoryIdentity(boundDirectories.entry)
  await verifyDirectoryIdentity(boundDirectories.resources)
  const entryIntegrity = CACHE_ENTRY_INTEGRITY.get(entry          )
  if (entryIntegrity === undefined) throw corruption()
  const validated = await readValidatedEntry(entry.key, entry.directory, entry.root)
  const descriptor = validated.manifest.resources.find((resource) => resource.id === id)
  if (descriptor === undefined) throw new VisualizationCacheError('Visualization resource is not available.')
  const expectedIntegrity = entryIntegrity.get(id)
  if (expectedIntegrity === undefined) throw corruption()
  const resourcesDirectory = join(validated.directory, RESOURCES_DIRECTORY)
  const resourcePath = join(resourcesDirectory, id)
  assertContained(resourcesDirectory, resourcePath)
  await assertPrivateFile(resourcePath, boundDirectories.resources)
  const bytes = cloneBytes(await readPrivateBytes(resourcePath, SERVER_ARTIFACT_VISUALIZATION_MAX_RESOURCE_BYTES, boundDirectories.resources))
  if (bytes.byteLength !== descriptor.byteLength || bytes.byteLength !== expectedIntegrity.byteLength ||
    sha256(bytes) !== expectedIntegrity.sha256) throw corruption()
  await verifyDirectoryIdentity(boundDirectories.root)
  await verifyDirectoryIdentity(boundDirectories.entry)
  await verifyDirectoryIdentity(boundDirectories.resources)
  const streamBytes = cloneBytes(bytes)
  const stream = (async function* ()                             {
    yield streamBytes
  })()
  return { descriptor, bytes, stream }
}
