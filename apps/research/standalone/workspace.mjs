import { constants as fsConstants } from 'node:fs'
import { mkdir, lstat, open, realpath, readdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const idPattern = /^[A-Za-z0-9_-]{1,80}$/
const taskIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/
const noFollow = fsConstants.O_NOFOLLOW

function fail(message) {
  throw new Error(message)
}

function assertId(value, label) {
  if (typeof value !== 'string' || !idPattern.test(value)) fail(`Invalid ${label}`)
  return value
}

function isWithin(root, candidate) {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

async function existingEntry(path, label) {
  let stat
  try {
    stat = await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  if (stat.isSymbolicLink()) fail(`${label} cannot be a symlink`)
  return stat
}

async function ensureDirectory(path, label) {
  let stat = await existingEntry(path, label)
  if (!stat) {
    await mkdir(path, { mode: 0o700 })
    stat = await existingEntry(path, label)
  }
  if (!stat?.isDirectory()) fail(`${label} must be a directory`)
  return stat
}

async function rejectDirectSymlinks(path, label) {
  const entries = await readdir(path, { withFileTypes: true })
  for (const entry of entries) {
    const child = join(path, entry.name)
    const stat = await lstat(child)
    if (stat.isSymbolicLink()) fail(`${label} entries cannot be symlinks`)
  }
}

async function requireDirectory(path, label) {
  const stat = await existingEntry(path, label)
  if (!stat) fail(`${label} does not exist`)
  if (!stat.isDirectory()) fail(`${label} must be a directory`)
  return stat
}

async function resolvedDirectory(path, label) {
  await requireDirectory(path, label)
  return realpath(path)
}

function assertRelativeFile(rootPath, value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\')) {
    fail('Invalid file path')
  }
  const candidate = resolve(rootPath, value)
  const rel = relative(rootPath, candidate)
  if (!rel || rel.startsWith('..') || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    fail('File must belong to this workspace')
  }
  return { candidate, rel }
}

function assertAllowedArtifactPath(rel) {
  const parts = rel.split(sep)
  if (parts.some(part => part.startsWith('.') || /^(configs?|secrets?|credentials?)$/i.test(part))) {
    fail('Configuration files cannot be published')
  }
  if (/\.(env|pem|key|sqlite|db)$/i.test(rel)) fail('Configuration files cannot be published')
}

async function checkPathComponents(rootPath, rel) {
  let part = rootPath
  for (const component of rel.split(sep)) {
    part = join(part, component)
    const stat = await lstat(part)
    if (stat.isSymbolicLink()) fail('Symlink paths are not allowed')
  }
}

async function rootDirectory(root, label = 'Workspace') {
  const rootPath = resolve(root)
  await requireDirectory(rootPath, label)
  const rootReal = await realpath(rootPath)
  return { rootPath, rootReal }
}

async function managedDirectory(workspacePath, workspaceReal, name, { create = false } = {}) {
  const path = join(workspacePath, name)
  const label = `${name} directory`
  if (create) await ensureDirectory(path, label)
  else await requireDirectory(path, label)
  await checkPathComponents(workspaceReal, name)
  const real = await realpath(path)
  if (!isWithin(workspaceReal, real)) fail(`${label} escapes chat workspace`)
  await rejectDirectSymlinks(path, label)
  return { path, real }
}

async function verifyExistingTask(tasks, tasksReal, workspacePath, taskId) {
  const taskPath = join(tasks, taskId)
  const taskStat = await existingEntry(taskPath, 'Task directory')
  if (!taskStat) return { task: taskPath }
  if (!taskStat.isDirectory()) fail('Task directory must be a directory')
  await checkPathComponents(workspacePath, join('tasks', taskId))
  const taskReal = await realpath(taskPath)
  if (!isWithin(tasksReal, taskReal)) fail('Task directory escapes task root')

  const taskFile = join(taskPath, 'task.json')
  const taskFileStat = await existingEntry(taskFile, 'Task record')
  if (taskFileStat && !taskFileStat.isFile()) fail('Task record must be a regular file')
  return { task: taskPath, taskFile }
}

export async function ensureWorkspace(root, ownerId, chatId) {
  assertId(ownerId, 'owner id')
  assertId(chatId, 'chat id')
  const rootPath = resolve(root)
  await ensureDirectory(rootPath, 'Workspace root')
  const rootReal = await resolvedDirectory(rootPath, 'Workspace root')

  const ownerPath = join(rootPath, ownerId)
  await ensureDirectory(ownerPath, 'Owner workspace')
  const ownerReal = await resolvedDirectory(ownerPath, 'Owner workspace')
  if (!isWithin(rootReal, ownerReal)) fail('Owner workspace escapes workspace root')

  const workspace = join(ownerPath, chatId)
  await ensureDirectory(workspace, 'Chat workspace')
  const workspaceReal = await resolvedDirectory(workspace, 'Chat workspace')
  if (!isWithin(rootReal, workspaceReal)) fail('Chat workspace escapes workspace root')

  const managed = {}
  for (const name of ['tasks', 'inputs', 'requests', 'configs']) {
    managed[name] = await managedDirectory(workspace, workspaceReal, name, { create: true })
  }

  return {
    root: rootPath,
    owner: ownerPath,
    workspace,
    tasks: managed.tasks.path,
    inputs: managed.inputs.path,
    requests: managed.requests.path,
    configs: managed.configs.path,
  }
}

export async function verifyTaskRoot(workspace, args = {}) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) fail('Tool arguments must be an object')
  const { rootPath: workspacePath, rootReal: workspaceReal } = await rootDirectory(workspace, 'Chat workspace')
  const managed = {}
  for (const name of ['tasks', 'inputs', 'requests', 'configs']) {
    managed[name] = await managedDirectory(workspacePath, workspaceReal, name)
  }
  const tasks = managed.tasks.path
  const tasksReal = managed.tasks.real

  const requestedIds = []
  if (args.task_id !== undefined) requestedIds.push(args.task_id)
  if (args.request && typeof args.request === 'object' && !Array.isArray(args.request) && args.request.task_id !== undefined) {
    requestedIds.push(args.request.task_id)
  }
  const taskIds = [...new Set(requestedIds.map(value => {
    if (typeof value !== 'string' || !taskIdPattern.test(value)) fail('Invalid task id')
    return value
  }))]
  if (!taskIds.length) {
    return {
      workspace: workspacePath,
      tasks,
      inputs: managed.inputs.path,
      requests: managed.requests.path,
      configs: managed.configs.path,
    }
  }

  const checked = []
  for (const taskId of taskIds) checked.push(await verifyExistingTask(tasks, tasksReal, workspacePath, taskId))
  return {
    workspace: workspacePath,
    tasks,
    inputs: managed.inputs.path,
    requests: managed.requests.path,
    configs: managed.configs.path,
    ...checked[0],
    taskIds,
  }
}

export async function readConfinedFile(root, value, maxBytes, { denyConfig = false } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) fail('Invalid file size limit')
  const file = await openConfinedFile(root, value, maxBytes, { denyConfig })
  try {
    const buffer = Buffer.alloc(maxBytes + 1)
    let total = 0
    while (total < buffer.length) {
      const result = await file.handle.read({ buffer, offset: total, length: buffer.length - total, position: total })
      if (!result.bytesRead) break
      total += result.bytesRead
    }
    const stat = await file.handle.stat()
    if (!stat.isFile()) fail('Not a regular file')
    if (stat.nlink !== 1) fail('Hard-linked files are not allowed')
    if (stat.size > maxBytes || total > maxBytes) fail('File exceeds the download limit')
    assertUnchanged(file.stat, stat)
    return { buffer: buffer.subarray(0, total), rel: file.rel, path: file.path, stat }
  } finally {
    await file.handle.close()
  }
}

/**
 * Open a workspace file for bounded streaming.  The caller owns the returned
 * handle and must close it.  Both the path components and the final file are
 * checked before opening; callers should use assertUnchanged after streaming
 * to retain the same before/after race protection as readConfinedFile.
 */
export async function openConfinedFile(root, value, maxBytes, { denyConfig = false } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) fail('Invalid file size limit')
  const { rootReal } = await rootDirectory(root)
  const { candidate, rel } = assertRelativeFile(rootReal, value)
  if (denyConfig) assertAllowedArtifactPath(rel)
  await checkPathComponents(rootReal, rel)

  if (!noFollow) fail('O_NOFOLLOW is required for confined file reads')
  let handle
  try {
    handle = await open(candidate, fsConstants.O_RDONLY | noFollow)
  } catch (error) {
    if (error?.code === 'ELOOP') fail('Symlink paths are not allowed')
    throw error
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) fail('Not a regular file')
    if (stat.nlink !== 1) fail('Hard-linked files are not allowed')
    if (stat.size > maxBytes) fail('File exceeds the download limit')
    return { handle, rel, path: candidate, stat }
  } catch (error) {
    await handle.close().catch(() => {})
    throw error
  }
}

export function assertUnchanged(initial, current) {
  if (!initial || !current || !current.isFile() || initial.nlink !== current.nlink || current.nlink !== 1 ||
    initial.dev !== current.dev || initial.ino !== current.ino ||
    initial.size !== current.size || initial.mtimeMs !== current.mtimeMs ||
    initial.ctimeMs !== current.ctimeMs) {
    fail('File changed while it was being read')
  }
}
