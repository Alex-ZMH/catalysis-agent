import { scientificResultArtifactMimeType } from '../scientific-artifact.mjs'
import { VisualizationCache } from './visualization-cache.mjs'
import { VisualizationPreprocessor } from './visualization-preprocessor.mjs'
import { TEXT_TRAJECTORY_VISUALIZATION_ADAPTERS } from './trajectory-adapters.mjs'
import { SCALAR_VOLUME_VISUALIZATION_ADAPTERS } from './volume-adapters.mjs'
import { VASP_PLOT_VISUALIZATION_ADAPTERS } from './plot-adapters.mjs'

/**
 * The standalone server owns this registry.  It is deliberately assembled
 * from local modules so the public MLCC service never resolves @zeus or a
 * parent repository package at runtime.
 */
export const STANDALONE_VISUALIZATION_ADAPTERS = Object.freeze([
  ...TEXT_TRAJECTORY_VISUALIZATION_ADAPTERS,
  ...SCALAR_VOLUME_VISUALIZATION_ADAPTERS,
  ...VASP_PLOT_VISUALIZATION_ADAPTERS,
])

export function createVisualizationRuntime(stateRoot) {
  if (typeof stateRoot !== 'string' || stateRoot.length === 0) {
    throw new TypeError('Visualization state root is required')
  }
  const cache = new VisualizationCache({ stateRoot })
  const preprocessor = new VisualizationPreprocessor({
    adapters: STANDALONE_VISUALIZATION_ADAPTERS,
    cache,
  })
  return Object.freeze({ cache, preprocessor })
}

function sourceMimeType(artifact) {
  return scientificResultArtifactMimeType(artifact.name) || artifact.mimeType
}

/** Prepare a stored artifact through the same source boundary as the Zeus service. */
export function prepareArtifactVisualization(runtime, artifact, signal) {
  if (!runtime?.preprocessor || !artifact || !Number.isSafeInteger(artifact.contentLength) || artifact.contentLength < 0 || typeof artifact.bytes?.[Symbol.asyncIterator] !== 'function') {
    throw new TypeError('Invalid artifact visualization input')
  }
  return runtime.preprocessor.prepare({
    runId: artifact.id,
    sequence: 1,
    name: artifact.name,
    mimeType: sourceMimeType(artifact),
    contentLength: artifact.contentLength,
    bytes: artifact.bytes,
    ...(signal === undefined ? {} : { signal }),
  })
}

export { sourceMimeType }
