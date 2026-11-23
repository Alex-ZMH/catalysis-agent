import {
  parseServerArtifactVisualizationResourceId,
  parseServerArtifactVisualizationResponse,
  SERVER_ARTIFACT_VISUALIZATION_MAX_RESOURCE_BYTES,
  SERVER_ARTIFACT_VISUALIZATION_SOURCE_MAX_BYTES,
                                           
                                           
} from './scientific-visualization.mjs'

import {
  computeVisualizationCacheKey,
  VisualizationCache,
  VisualizationCacheProducerError,
                               
                                        
                                       
                                 
} from './visualization-cache.mjs'

                                                    
               
                  
              
                  
  

                                                                          
                       
                                  
                      
  

                                                                  

                                                                         

                                             
            
                                                                 
                  
                                                                        
                         
                                                                        
                                                                                                          
  

                                                 
                
                                               
                  
                                             
                                      
               
                      
                                                          
  

                                                      
                                                 
                                  
  

export class VisualizationPreprocessorError extends Error {
  constructor() {
    super('Visualization preprocessing failed.')
    this.name = 'VisualizationPreprocessorError'
  }
}

export class VisualizationMalformedError extends VisualizationPreprocessorError {
  constructor() {
    super()
    this.message = 'Visualization input is malformed.'
    this.name = 'VisualizationMalformedError'
  }
}

export class VisualizationTooLargeError extends VisualizationPreprocessorError {
  constructor() {
    super()
    this.message = 'Visualization input is too large.'
    this.name = 'VisualizationTooLargeError'
  }
}

export class VisualizationUnsupportedError extends VisualizationPreprocessorError {
  constructor() {
    super()
    this.message = 'Visualization format is unsupported.'
    this.name = 'VisualizationUnsupportedError'
  }
}

export class VisualizationRegistryError extends VisualizationPreprocessorError {
  constructor() {
    super()
    this.message = 'Multiple visualization adapters matched the source.'
    this.name = 'VisualizationRegistryError'
  }
}

const ADAPTER_ID_PATTERN = /^[A-Za-z0-9._-]{1,80}$/
const PREPARATION_BRAND = new WeakSet        ()

function isUint8Array(value         )                      {
  return value instanceof Uint8Array
}

function safeInteger(value         , minimum        )                  {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}

function hasOwnKeys(value        , keys                   )          {
  const ownKeys = Reflect.ownKeys(value)
  return ownKeys.length === keys.length && ownKeys.every((key) => typeof key === 'string' && keys.includes(key))
}

function isSafeSourceMetadata(value                     )                               {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  if (!hasOwnKeys(value, ['runId', 'sequence', 'name', 'mimeType', 'contentLength', 'bytes'])) {
    // An AbortSignal is optional and does not become part of the trusted
    // manifest source. It is accepted as an extra transport control field.
    const allowed = ['runId', 'sequence', 'name', 'mimeType', 'contentLength', 'bytes', 'signal']
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.length !== allowed.length || ownKeys.some((key) => typeof key !== 'string' || !allowed.includes(key))) return false
  }
  const signal = value.signal
  const validSignal = signal === undefined || (
    typeof signal === 'object' && signal !== null &&
    typeof signal.addEventListener === 'function' && typeof signal.removeEventListener === 'function'
  )
  return validSignal && typeof value.runId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value.runId) &&
    safeInteger(value.sequence, 1) &&
    typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 500 &&
    value.name !== '.' && value.name !== '..' && !value.name.includes('/') && !value.name.includes('\\') &&
    !/[\u0000-\u001f\u007f"\r\n]/.test(value.name) &&
    typeof value.mimeType === 'string' && /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+\/-]{0,126}$/.test(value.mimeType) &&
    safeInteger(value.contentLength, 0) &&
    typeof value.bytes?.[Symbol.asyncIterator] === 'function'
}

function metadataOf(source                     )                              {
  return Object.freeze({
    runId: source.runId,
    sequence: source.sequence,
    name: source.name,
    mimeType: source.mimeType,
  })
}

function matchMetadataOf(source                     )                                                           {
  return Object.freeze({ name: source.name, mimeType: source.mimeType })
}

function sourceManifest(manifest                                     , metadata                             )                                      {
  const rebound = {
    ...manifest,
    source: { ...metadata },
  }
  const parsed = parseServerArtifactVisualizationResponse({ state: 'ready', manifest: rebound })
  if (parsed.state !== 'ready') throw new VisualizationMalformedError()
  return parsed.manifest
}

function adapterVersion(adapter                      )         {
  const version = adapter.version ?? adapter.adapterVersion
  if (typeof version !== 'string' || !ADAPTER_ID_PATTERN.test(version)) {
    throw new TypeError('Every visualization adapter requires an explicit version')
  }
  return version
}

function descriptorMatches(
  descriptor                                     ,
  expected                                     ,
)          {
  return descriptor.id === expected.id && descriptor.role === expected.role &&
    descriptor.mimeType === expected.mimeType && descriptor.byteLength === expected.byteLength
}

function markReadyPreparation(value   
                
                                               
                  
                                             
                                      
 )                           {
  const prepared = Object.freeze(value)
  PREPARATION_BRAND.add(prepared)
  return prepared
}

function validateAdapterOutput(
  value                            ,
  metadata                             ,
)                             {
  if (value === null || typeof value !== 'object' || !Array.isArray(value.resources)) {
    throw new VisualizationMalformedError()
  }
  for (const resource of value.resources) {
    if (!isUint8Array(resource?.bytes)) throw new VisualizationMalformedError()
    if (resource.bytes.byteLength > SERVER_ARTIFACT_VISUALIZATION_MAX_RESOURCE_BYTES) {
      throw new VisualizationTooLargeError()
    }
  }
  let parsed                                                             
  try {
    parsed = parseServerArtifactVisualizationResponse({ state: 'ready', manifest: value.manifest })
  } catch {
    throw new VisualizationMalformedError()
  }
  if (parsed.state !== 'ready') throw new VisualizationMalformedError()
  const manifest = sourceManifest(parsed.manifest, metadata)
  if (value.resources.length !== manifest.resources.length) throw new VisualizationMalformedError()
  const resourcesById = new Map(manifest.resources.map((resource) => [resource.id, resource]))
  const seen = new Set        ()
  const resources                         = []
  for (const item of value.resources) {
    let id        
    try { id = parseServerArtifactVisualizationResourceId(item?.descriptor?.id) } catch { throw new VisualizationMalformedError() }
    if (seen.has(id)) throw new VisualizationMalformedError()
    seen.add(id)
    const expected = resourcesById.get(id)
    if (expected === undefined || !descriptorMatches(item.descriptor, expected)) {
      throw new VisualizationMalformedError()
    }
    if (item.bytes.byteLength !== expected.byteLength) throw new VisualizationMalformedError()
    resources.push({ descriptor: expected, bytes: new Uint8Array(item.bytes) })
  }
  if (seen.size !== resourcesById.size) throw new VisualizationMalformedError()
  return { manifest, resources }
}

function returnIterator(
  iterator                           ,
  returned                             ,
)                {
  if (returned.promise !== undefined) return returned.promise
  if (typeof iterator.return !== 'function') {
    returned.promise = Promise.resolve()
    return returned.promise
  }
  returned.promise = Promise.resolve()
    .then(() => iterator.return?.())
    .then(() => undefined, () => undefined)
  return returned.promise
}

async function readSource(source                     )                      {
  if (source.contentLength > SERVER_ARTIFACT_VISUALIZATION_SOURCE_MAX_BYTES) {
    throw new VisualizationTooLargeError()
  }
  let iterator                           
  try {
    iterator = source.bytes[Symbol.asyncIterator]()
  } catch {
    throw new VisualizationPreprocessorError()
  }
  const returned                              = {}
  let done = false
  let aborted = source.signal?.aborted === true
  let abortResolve             
  const abortSignal = new Promise      ((resolve) => { abortResolve = resolve })
  const onAbort = () => {
    aborted = true
    abortResolve()
    void returnIterator(iterator, returned)
  }
  source.signal?.addEventListener('abort', onAbort, { once: true })
  // Allocate the declared source size once and fill it as the transport
  // yields chunks. This keeps the parser's required 256 MiB ceiling without
  // retaining a second chunk array and then making another full-size concat
  // copy before handing bytes to an adapter.
  const bytes = new Uint8Array(source.contentLength)
  let length = 0
  try {
    if (aborted) throw new VisualizationMalformedError()
    while (!done) {
      const next = await Promise.race([
        iterator.next(),
        abortSignal.then(() => ({ done: true         , value: undefined })),
      ])
      if (aborted) throw new VisualizationMalformedError()
      if (next.done) {
        done = true
        break
      }
      if (!isUint8Array(next.value)) throw new VisualizationMalformedError()
      if (length + next.value.byteLength > SERVER_ARTIFACT_VISUALIZATION_SOURCE_MAX_BYTES) throw new VisualizationTooLargeError()
      if (next.value.byteLength > source.contentLength - length) throw new VisualizationMalformedError()
      bytes.set(next.value, length)
      length += next.value.byteLength
    }
    if (length !== source.contentLength) throw new VisualizationMalformedError()
    return bytes
  } catch (error) {
    await returnIterator(iterator, returned)
    if (error instanceof VisualizationPreprocessorError) throw error
    throw new VisualizationPreprocessorError()
  } finally {
    await returnIterator(iterator, returned)
    source.signal?.removeEventListener('abort', onAbort)
  }
}

export class VisualizationPreprocessor {
                   adapters                                 
                   cache                                

  constructor(
    options                                                                                                                       ,
    cache                     ,
  ) {
    const arrayOptions = Array.isArray(options)
    const configured = options                                                                                        
    const adapters = arrayOptions ? options                                    : configured.adapters
    if (!Array.isArray(adapters)) throw new TypeError('Visualization adapters are required')
    const adapterIds = new Set        ()
    const snapshots = adapters.map((adapter) => {
      if (adapter === null || typeof adapter !== 'object' || typeof adapter.id !== 'string' ||
        typeof adapter.match !== 'function' || typeof adapter.prepare !== 'function') {
        throw new TypeError('Invalid visualization adapter')
      }
      if (!ADAPTER_ID_PATTERN.test(adapter.id)) throw new TypeError('Invalid visualization adapter id')
      if (adapterIds.has(adapter.id)) throw new TypeError('Duplicate visualization adapter id')
      adapterIds.add(adapter.id)
      const id = adapter.id
      const version = adapterVersion(adapter)
      const receiver = Object.freeze({ id, version })
      const originalMatch = adapter.match
      const originalPrepare = adapter.prepare
      return Object.freeze({
        id,
        version,
        match: (input                                                          )          => (
          Reflect.apply(originalMatch, receiver, [input])           
        ),
        prepare: (input            , metadata                              )                                      => (
          Reflect.apply(originalPrepare, receiver, [input, metadata])                                       
        ),
      })
    })
    this.adapters = Object.freeze(snapshots)
    this.cache = arrayOptions ? cache : configured.cache
    this.preparationActive = false
    this.preparationQueue = []
  }

  acquirePreparation(signal) {
    if (!this.preparationActive) {
      this.preparationActive = true
      return Promise.resolve(this.acquireRelease())
    }
    return new Promise((resolve, reject) => {
      const next = {
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.preparationQueue.indexOf(next)
          if (index >= 0) this.preparationQueue.splice(index, 1)
          signal.removeEventListener('abort', next.onAbort)
          reject(new VisualizationMalformedError())
        },
      }
      if (signal?.aborted) {
        reject(new VisualizationMalformedError())
        return
      }
      signal?.addEventListener('abort', next.onAbort, { once: true })
      this.preparationQueue.push(next)
    })
  }

  acquireRelease() {
    let released = false
    const release = () => {
      if (released) return
      released = true
      while (this.preparationQueue.length > 0) {
        const next = this.preparationQueue.shift()
        next.signal?.removeEventListener('abort', next.onAbort)
        if (next.signal?.aborted) {
          next.reject(new VisualizationMalformedError())
          continue
        }
        this.preparationActive = true
        next.resolve(this.acquireRelease())
        return
      }
      this.preparationActive = false
    }
    return release
  }

  async prepare(source                     )                                    {
    if (!isSafeSourceMetadata(source)) return { state: 'unsupported', reason: 'malformed' }
    let release
    try {
      release = await this.acquirePreparation(source.signal)
    } catch (error) {
      if (error instanceof VisualizationMalformedError) return { state: 'unsupported', reason: 'malformed' }
      throw error
    }
    try {
      return await this.prepareOwned(source)
    } finally {
      release()
    }
  }

  async prepareOwned(source                     )                                    {
    const metadata = metadataOf(source)
    let sourceBytes            
    try {
      sourceBytes = await readSource(source)
    } catch (error) {
      if (error instanceof VisualizationTooLargeError) return { state: 'unsupported', reason: 'too_large' }
      if (error instanceof VisualizationMalformedError) return { state: 'unsupported', reason: 'malformed' }
      throw error instanceof VisualizationPreprocessorError
        ? error
        : new VisualizationPreprocessorError()
    }

    const matches                         = []
    const matchMetadata = matchMetadataOf(source)
    for (const adapter of this.adapters) {
      let matched = false
      try { matched = adapter.match(matchMetadata) } catch { throw new VisualizationRegistryError() }
      if (typeof matched !== 'boolean') throw new VisualizationRegistryError()
      if (matched) matches.push(adapter)
    }
    if (matches.length === 0) return { state: 'unsupported', reason: 'unsupported_format' }
    if (matches.length > 1) throw new VisualizationRegistryError()
    const selected = matches[0] 
    const version = adapterVersion(selected)
    const cacheKey = computeVisualizationCacheKey(sourceBytes, selected.id, version)
    const produce = async ()                                            => {
      let output                            
      try {
        output = await selected.prepare(new Uint8Array(sourceBytes), metadata)
      } catch (error) {
        if (error instanceof VisualizationTooLargeError) {
          throw new VisualizationCacheProducerError('too_large')
        }
        if (error instanceof VisualizationMalformedError) {
          throw new VisualizationCacheProducerError('malformed')
        }
        if (error instanceof VisualizationUnsupportedError) {
          throw new VisualizationCacheProducerError('unsupported_format')
        }
        if (error instanceof VisualizationPreprocessorError) throw error
        // Adapter implementations must opt into a public closed reason. A
        // generic failure remains an internal preprocessing error and is
        // surfaced only as a sanitized server error, never guessed as a
        // malformed source.
        throw new VisualizationPreprocessorError()
      }
      return validateAdapterOutput(output, metadata)
    }
    try {
      if (this.cache === undefined) {
        const prepared = await produce()
        return markReadyPreparation({
          state: 'ready',
          manifest: prepared.manifest,
          cacheKey,
          resources: prepared.resources,
        })
      }
      const entry = await this.cache.getOrCreate(cacheKey, produce)
      return markReadyPreparation({
        state: 'ready',
        manifest: sourceManifest(entry.manifest, metadata),
        cacheKey,
        cacheEntry: entry,
      })
    } catch (error) {
      if (error instanceof VisualizationCacheProducerError) {
        return { state: 'unsupported', reason: error.reason }
      }
      if (error instanceof VisualizationTooLargeError) return { state: 'unsupported', reason: 'too_large' }
      if (error instanceof VisualizationMalformedError) return { state: 'unsupported', reason: 'malformed' }
      if (error instanceof VisualizationUnsupportedError) return { state: 'unsupported', reason: 'unsupported_format' }
      throw error
    }
  }

  /**
   * Open one exact resource from this preprocessor's own ready preparation.
   * The preparation is branded at creation time so callers cannot forge cache
   * authority or substitute a descriptor. Cache-backed opens revalidate the
   * complete private entry through VisualizationCache.openResource.
   */
  async openPreparedResource(
    preparation                          ,
    resourceId        ,
  )                                         {
    if (
      preparation === null ||
      typeof preparation !== 'object' ||
      preparation.state !== 'ready' ||
      !PREPARATION_BRAND.has(preparation          )
    ) throw new VisualizationPreprocessorError()

    let id        
    try { id = parseServerArtifactVisualizationResourceId(resourceId) } catch {
      throw new VisualizationPreprocessorError()
    }
    const expected = preparation.manifest.resources.find((resource) => resource.id === id)
    if (expected === undefined) throw new VisualizationPreprocessorError()

    if (preparation.cacheEntry !== undefined) {
      if (this.cache === undefined) throw new VisualizationPreprocessorError()
      let opened                           
      try {
        opened = await this.cache.openResource(preparation.cacheEntry, id)
      } catch (error) {
        if (error instanceof VisualizationPreprocessorError) throw error
        throw error
      }
      if (!descriptorMatches(opened.descriptor, expected) || opened.bytes.byteLength !== expected.byteLength) {
        throw new VisualizationPreprocessorError()
      }
      return { descriptor: expected, bytes: opened.stream }
    }

    const resources = preparation.resources
    if (resources === undefined || resources.length !== preparation.manifest.resources.length) {
      throw new VisualizationPreprocessorError()
    }
    const seen = new Set        ()
    for (const item of resources) {
      let itemId        
      try { itemId = parseServerArtifactVisualizationResourceId(item?.descriptor?.id) } catch {
        throw new VisualizationPreprocessorError()
      }
      if (seen.has(itemId)) throw new VisualizationPreprocessorError()
      seen.add(itemId)
      const manifestDescriptor = preparation.manifest.resources.find((resource) => resource.id === itemId)
      if (
        manifestDescriptor === undefined ||
        !descriptorMatches(item.descriptor, manifestDescriptor) ||
        !isUint8Array(item.bytes) ||
        item.bytes.byteLength !== manifestDescriptor.byteLength
      ) throw new VisualizationPreprocessorError()
    }
    if (seen.size !== preparation.manifest.resources.length) throw new VisualizationPreprocessorError()
    const item = resources.find((candidate) => candidate.descriptor.id === id)
    if (item === undefined) throw new VisualizationPreprocessorError()
    const bytes = new Uint8Array(item.bytes)
    return {
      descriptor: expected,
      bytes: (async function* ()                             { yield bytes })(),
    }
  }
}

export { VisualizationCache, computeVisualizationCacheKey }
