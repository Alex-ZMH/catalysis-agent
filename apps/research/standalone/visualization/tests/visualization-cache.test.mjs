import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

                                                                             

import {
  VisualizationCache,
  computeVisualizationCacheKey,
  openResource,
                                        
} from '../visualization-cache.mjs'

const descriptor = {
  id: 'coordinates',
  role: 'trajectory.coordinates'         ,
  mimeType: 'application/vnd.zeus.f32'         ,
  byteLength: 4,
}
const bytes = new Uint8Array([0, 1, 2, 3])

function manifest()                                      {
  return {
    version: 1,
    source: { runId: 'run_1', sequence: 1, name: 'result.extxyz', mimeType: 'chemical/x-extxyz' },
    resources: [descriptor],
    kind: 'trajectory',
    format: 'extxyz',
    atomCount: 1,
    frameCount: 1,
    elements: ['Si'],
    periodic: false,
    timeUnit: 'frame',
    timeStep: 1,
  }
}

function output(overrides                                            = {})                                   {
  return { manifest: manifest(), resources: [{ descriptor, bytes }], ...overrides }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'zeus-visualization-cache-'))
  return { root, cache: new VisualizationCache({ stateRoot: root }) }
}

test('cache key is stable for bytes and changes with bytes, adapter id, or version', () => {
  const key = computeVisualizationCacheKey(bytes, 'extxyz', '1')
  assert.match(key, /^[a-f0-9]{64}$/)
  assert.equal(key, computeVisualizationCacheKey(new Uint8Array(bytes), 'extxyz', '1'))
  assert.notEqual(key, computeVisualizationCacheKey(new Uint8Array([9]), 'extxyz', '1'))
  assert.notEqual(key, computeVisualizationCacheKey(bytes, 'extxyz', '2'))
  assert.notEqual(key, computeVisualizationCacheKey(bytes, 'xdatcar', '1'))
})

test('single-flight producer runs once and complete entries survive only atomic rename', async () => {
  const { root, cache } = await fixture()
  try {
    const key = computeVisualizationCacheKey(bytes, 'extxyz', '1')
    let calls = 0
    let release             
    let markStarted             
    const started = new Promise      ((resolve) => { markStarted = resolve })
    const gate = new Promise      ((resolve) => { release = resolve })
    const producer = async () => {
      calls += 1
      markStarted()
      await gate
      return output()
    }
    const first = cache.getOrCreate(key, producer)
    const second = cache.getOrCreate(key, producer)
    await started
    assert.equal(calls, 1)
    release()
    const [left, right] = await Promise.all([first, second])
    assert.equal(left.key, key)
    assert.equal(right.key, key)
    assert.equal((await readdir(join(root, 'scientific-visualization-cache', key))).includes('.tmp'), false)
    const info = await lstat(join(root, 'scientific-visualization-cache', key, 'manifest.json'))
    assert.equal(info.nlink, 1)
    assert.equal(info.mode & 0o777, 0o600)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('failed producers remove temporary data, clear single-flight, and permit retry', async () => {
  const { root, cache } = await fixture()
  try {
    const key = computeVisualizationCacheKey(bytes, 'extxyz', '1')
    let calls = 0
    await assert.rejects(() => cache.getOrCreate(key, async () => {
      calls += 1
      throw new Error('producer failed')
    }))
    const entry = await cache.getOrCreate(key, async () => { calls += 1; return output() })
    assert.equal(entry.key, key)
    assert.equal(calls, 2)
    const names = await readdir(join(root, 'scientific-visualization-cache'))
    assert.deepEqual(names, [key])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('cache hit revalidates digest, byte length, manifest, links, symlinks, traversal, and unexpected files', async () => {
  const { root, cache } = await fixture()
  try {
    const key = computeVisualizationCacheKey(bytes, 'extxyz', '1')
    const entry = await cache.getOrCreate(key, async () => output())
    const cacheDir = join(root, 'scientific-visualization-cache', key)
    const resourcePath = join(cacheDir, 'resources', descriptor.id)
    await writeFile(resourcePath, new Uint8Array([0, 1, 2]))
    await assert.rejects(() => cache.getOrCreate(key, async () => output()), /corrupt|invalid/i)

    await rm(cacheDir, { recursive: true, force: true })
    await cache.getOrCreate(key, async () => output())
    await writeFile(join(cacheDir, 'unexpected'), 'nope')
    await assert.rejects(() => cache.getOrCreate(key, async () => output()), /corrupt|invalid/i)

    await rm(join(cacheDir, 'unexpected'))
    await symlink(join(cacheDir, 'manifest.json'), join(cacheDir, 'manifest-link'))
    await assert.rejects(() => openResource(entry, descriptor.id), /corrupt|invalid|symlink/i)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('openResource validates opaque membership and returns exact descriptor plus bounded bytes', async () => {
  const { root, cache } = await fixture()
  try {
    const key = computeVisualizationCacheKey(bytes, 'extxyz', '1')
    const entry = await cache.getOrCreate(key, async () => output())
    const opened = await cache.openResource(entry, descriptor.id)
    assert.deepEqual(opened.descriptor, descriptor)
    assert.deepEqual(opened.bytes, bytes)
    assert.deepEqual(await openResource(entry, descriptor.id), opened)
    for (const id of ['../outside', 'coordinates/../outside', 'missing']) {
      await assert.rejects(() => cache.openResource(entry, id), /invalid|not available|not found|membership/i)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('rejects hard-linked resource files', async () => {
  const { root, cache } = await fixture()
  try {
    const key = computeVisualizationCacheKey(bytes, 'extxyz', '1')
    const entry = await cache.getOrCreate(key, async () => output())
    const cacheDir = join(root, 'scientific-visualization-cache', key)
    await link(join(cacheDir, 'resources', descriptor.id), join(cacheDir, 'resources', 'linked'))
    await assert.rejects(() => cache.getOrCreate(key, async () => output()), /corrupt|invalid|link/i)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('cache resources use private modes and cache root is private', async () => {
  const { root, cache } = await fixture()
  try {
    const key = computeVisualizationCacheKey(bytes, 'extxyz', '1')
    await cache.getOrCreate(key, async () => output())
    const cacheRoot = join(root, 'scientific-visualization-cache')
    assert.equal((await lstat(cacheRoot)).mode & 0o777, 0o700)
    assert.equal((await lstat(join(cacheRoot, key))).mode & 0o777, 0o700)
    assert.equal((await lstat(join(cacheRoot, key, 'resources'))).mode & 0o777, 0o700)
    assert.equal((await lstat(join(cacheRoot, key, 'resources', descriptor.id))).mode & 0o777, 0o600)
    assert.equal(JSON.parse(await readFile(join(cacheRoot, key, 'manifest.json'), 'utf8')).kind, 'trajectory')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('cache-key encoding is domain-separated, length-prefixed, and rejects unsafe adapter identity', () => {
  assert.notEqual(
    computeVisualizationCacheKey(new Uint8Array([1]), 'adapter', 'version'),
    computeVisualizationCacheKey(new Uint8Array([1, 0]), 'adapter', 'version'),
  )
  assert.throws(() => computeVisualizationCacheKey(bytes, 'adapter', 'version\0tail'), TypeError)
  assert.throws(() => computeVisualizationCacheKey(bytes, 'adapter\0version', 'tail'), TypeError)
  for (const value of ['', 'has space', 'has/slash', 'has\\slash', 'has\0nul', 'é', 'a'.repeat(81)]) {
    assert.throws(() => computeVisualizationCacheKey(bytes, value, '1'), TypeError)
    assert.throws(() => computeVisualizationCacheKey(bytes, 'adapter', value), TypeError)
  }
})

test('missing stateRoot fails closed and an existing stateRoot keeps its mode', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'zeus-visualization-state-parent-'))
  const missing = join(parent, 'missing-state')
  try {
    const missingCache = new VisualizationCache({ stateRoot: missing })
    const key = computeVisualizationCacheKey(bytes, 'extxyz', '1')
    await assert.rejects(() => missingCache.getOrCreate(key, async () => output()))

    await mkdir(join(parent, 'existing-state'))
    await chmod(join(parent, 'existing-state'), 0o755)
    const cache = new VisualizationCache({ stateRoot: join(parent, 'existing-state') })
    await cache.getOrCreate(key, async () => output())
    assert.equal((await lstat(join(parent, 'existing-state'))).mode & 0o777, 0o755)
  } finally { await rm(parent, { recursive: true, force: true }) }
})

test('manifest and integrity size caps reject oversized sparse-looking files before parsing', async () => {
  const { root, cache } = await fixture()
  try {
    const key = computeVisualizationCacheKey(bytes, 'extxyz', '1')
    await cache.getOrCreate(key, async () => output())
    const cacheDir = join(root, 'scientific-visualization-cache', key)
    const manifestPath = join(cacheDir, 'manifest.json')
    const manifestText = await readFile(manifestPath, 'utf8')
    await writeFile(manifestPath, `${manifestText}${' '.repeat(8 * 1024 * 1024 + 1)}`)
    await assert.rejects(() => cache.getOrCreate(key, async () => output()), /corrupt|invalid/i)

    await rm(cacheDir, { recursive: true, force: true })
    await cache.getOrCreate(key, async () => output())
    const integrityPath = join(cacheDir, 'integrity.json')
    const integrityText = await readFile(integrityPath, 'utf8')
    await writeFile(integrityPath, `${integrityText}${' '.repeat(1024 * 1024 + 1)}`)
    await assert.rejects(() => cache.getOrCreate(key, async () => output()), /corrupt|invalid/i)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('openResource rejects forged entries even when directory and root fields point at a valid cache', async () => {
  const { root, cache } = await fixture()
  try {
    const key = computeVisualizationCacheKey(bytes, 'extxyz', '1')
    const entry = await cache.getOrCreate(key, async () => output())
    const forged = { ...entry }
    await assert.rejects(() => openResource(forged, descriptor.id), /invalid|entry|corrupt/i)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('openResource fails when a same-length replacement is made after the entry object was created', async () => {
  const { root, cache } = await fixture()
  try {
    const key = computeVisualizationCacheKey(bytes, 'extxyz', '1')
    const entry = await cache.getOrCreate(key, async () => output())
    const resourcePath = join(root, 'scientific-visualization-cache', key, 'resources', descriptor.id)
    await writeFile(resourcePath, new Uint8Array([9, 8, 7, 6]))
    await assert.rejects(() => cache.openResource(entry, descriptor.id), /corrupt|digest|invalid/i)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('openResource rejects an entry-directory replacement at the same pathname', async () => {
  const { root, cache } = await fixture()
  try {
    const key = computeVisualizationCacheKey(bytes, 'extxyz', '1')
    const entry = await cache.getOrCreate(key, async () => output())
    const cacheDir = join(root, 'scientific-visualization-cache', key)
    const movedDir = join(root, 'moved-entry-directory')
    await rename(cacheDir, movedDir)
    await mkdir(join(cacheDir, 'resources'), { recursive: true, mode: 0o700 })
    await chmod(cacheDir, 0o700)
    await chmod(join(cacheDir, 'resources'), 0o700)
    await writeFile(join(cacheDir, 'manifest.json'), await readFile(join(movedDir, 'manifest.json')), { mode: 0o600 })
    await writeFile(join(cacheDir, 'integrity.json'), await readFile(join(movedDir, 'integrity.json')), { mode: 0o600 })
    await writeFile(join(cacheDir, 'resources', descriptor.id), await readFile(join(movedDir, 'resources', descriptor.id)), { mode: 0o600 })
    await assert.rejects(() => openResource(entry, descriptor.id), /corrupt|invalid|identity/i)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('openResource rejects a resources-directory replacement at the same pathname', async () => {
  const { root, cache } = await fixture()
  try {
    const key = computeVisualizationCacheKey(bytes, 'extxyz', '1')
    const entry = await cache.getOrCreate(key, async () => output())
    const resourcesDir = join(root, 'scientific-visualization-cache', key, 'resources')
    const movedDir = join(root, 'moved-resources-directory')
    await rename(resourcesDir, movedDir)
    await mkdir(resourcesDir, { recursive: false, mode: 0o700 })
    await chmod(resourcesDir, 0o700)
    await writeFile(join(resourcesDir, descriptor.id), await readFile(join(movedDir, descriptor.id)), { mode: 0o600 })
    await assert.rejects(() => openResource(entry, descriptor.id), /corrupt|invalid|identity/i)
  } finally { await rm(root, { recursive: true, force: true }) }
})
