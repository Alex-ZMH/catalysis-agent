import test from 'node:test'
import assert from 'node:assert/strict'
import { lstat, link, mkdir, readFile, symlink, unlink, writeFile, rm } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempRoot = () => mkdtemp(join(tmpdir(), 'mlcc-workspace-'))

test('ensureWorkspace creates private chat paths and rejects symlink components', async t => {
  const root = await tempRoot()
  const outside = await tempRoot()
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]))
  const { ensureWorkspace } = await import('./workspace.mjs')

  const created = await ensureWorkspace(join(root, 'work'), 'owner-1', 'chat-1')
  assert.equal(created.workspace, join(root, 'work', 'owner-1', 'chat-1'))
  assert.equal(created.tasks, join(created.workspace, 'tasks'))
  assert.equal((await lstat(created.workspace)).isDirectory(), true)
  assert.equal((await lstat(created.tasks)).isDirectory(), true)
  for (const name of ['inputs', 'requests', 'configs']) {
    assert.equal((await lstat(join(created.workspace, name))).isDirectory(), true)
  }

  await symlink(outside, join(root, 'work', 'owner-link'))
  await assert.rejects(
    ensureWorkspace(join(root, 'work'), 'owner-link', 'chat-1'),
    /symlink|symbolic/i,
  )

  await symlink(outside, join(root, 'work', 'owner-1', 'chat-link'))
  await assert.rejects(
    ensureWorkspace(join(root, 'work'), 'owner-1', 'chat-link'),
    /symlink|symbolic/i,
  )

  await rm(created.tasks, { recursive: true, force: true })
  await symlink(outside, created.tasks)
  await assert.rejects(
    ensureWorkspace(join(root, 'work'), 'owner-1', 'chat-1'),
    /symlink|symbolic/i,
  )

  await rm(created.tasks, { recursive: true, force: true })
  await mkdir(created.tasks)
  await rm(join(created.workspace, 'configs'), { recursive: true, force: true })
  await symlink(outside, join(created.workspace, 'configs'))
  await assert.rejects(
    ensureWorkspace(join(root, 'work'), 'owner-1', 'chat-1'),
    /symlink|symbolic/i,
  )
})

test('verifyTaskRoot validates existing task paths without creating missing tasks', async t => {
  const root = await tempRoot()
  const outside = await tempRoot()
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]))
  const { ensureWorkspace, verifyTaskRoot } = await import('./workspace.mjs')
  const { workspace, tasks } = await ensureWorkspace(root, 'owner-1', 'chat-1')

  await verifyTaskRoot(workspace, {})
  await verifyTaskRoot(workspace, { task_id: 'future-task' })
  assert.equal((await lstat(join(tasks, 'future-task')).catch(() => null)), null)
  const longTaskId = `task-${'x'.repeat(91)}`
  assert.equal(longTaskId.length, 96)
  await verifyTaskRoot(workspace, { task_id: longTaskId })
  await assert.rejects(
    verifyTaskRoot(workspace, { task_id: `${longTaskId}x` }),
    /invalid|task/i,
  )
  await verifyTaskRoot(workspace, { request: { task_id: 'nested-task' } })
  await assert.rejects(
    verifyTaskRoot(workspace, { request: { task_id: '../outside' } }),
    /invalid|task|path/i,
  )

  await mkdir(join(tasks, 'existing-task'))
  await writeFile(join(tasks, 'existing-task', 'task.json'), '{}\n')
  await verifyTaskRoot(workspace, { task_id: 'existing-task' })

  for (const name of ['inputs', 'requests']) {
    const managedRoot = join(workspace, name)
    const linkedRoot = join(outside, `${name}-target`)
    await rm(managedRoot, { recursive: true, force: true })
    await symlink(linkedRoot, managedRoot)
    await assert.rejects(verifyTaskRoot(workspace, {}), /symlink|symbolic/i)
    await unlink(managedRoot)
    await mkdir(managedRoot)
  }

  for (const name of ['inputs', 'requests']) {
    const linkedFile = join(workspace, name, `${longTaskId}.json`)
    await symlink(join(outside, `${name}.json`), linkedFile)
    await assert.rejects(verifyTaskRoot(workspace, {}), /symlink|symbolic/i)
    await rm(linkedFile, { force: true })
  }

  await symlink(outside, join(tasks, 'linked-task'))
  await assert.rejects(
    verifyTaskRoot(workspace, { task_id: 'linked-task' }),
    /symlink|symbolic/i,
  )

  await rm(join(tasks, 'existing-task', 'task.json'))
  await symlink(join(outside, 'task.json'), join(tasks, 'existing-task', 'task.json'))
  await assert.rejects(
    verifyTaskRoot(workspace, { task_id: 'existing-task' }),
    /symlink|symbolic/i,
  )

  await rm(tasks, { recursive: true, force: true })
  await symlink(outside, tasks)
  await assert.rejects(verifyTaskRoot(workspace, {}), /symlink|symbolic/i)
})

test('readConfinedFile reads regular files within the workspace and rejects escape paths', async t => {
  const root = await tempRoot()
  const outside = await tempRoot()
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]))
  const { readConfinedFile } = await import('./workspace.mjs')
  await mkdir(join(root, 'results'))
  await mkdir(join(root, 'configs'))
  await writeFile(join(root, 'results', 'report.txt'), 'real result')
  await writeFile(join(root, 'configs', 'site.json'), 'secret')
  await writeFile(join(root, 'results', 'secret.pem'), 'private')
  await writeFile(join(outside, 'hardlinked.txt'), 'outside')
  await link(join(outside, 'hardlinked.txt'), join(root, 'results', 'hardlinked.txt'))
  await symlink(outside, join(root, 'alias'))

  const result = await readConfinedFile(root, 'results/report.txt', 1024)
  assert.equal(result.rel, join('results', 'report.txt'))
  assert.equal(result.buffer.toString(), 'real result')
  assert.equal(result.stat.isFile(), true)
  assert.equal(await readFile(result.path, 'utf8'), 'real result')
  await assert.rejects(readConfinedFile(root, '../outside.txt', 1024), /workspace|outside|path/i)
  await assert.rejects(readConfinedFile(root, 'alias/report.txt', 1024), /symlink|symbolic/i)
  await assert.rejects(readConfinedFile(root, 'results/report.txt', 4), /limit|exceed|size/i)
  await assert.rejects(readConfinedFile(root, 'configs/site.json', 1024, { denyConfig: true }), /config|secret/i)
  await assert.rejects(readConfinedFile(root, 'results/secret.pem', 1024, { denyConfig: true }), /config|secret/i)
  await assert.rejects(readConfinedFile(root, 'results/hardlinked.txt', 1024), /hard|link/i)

  const linkedRoot = join(root, 'root-link')
  await symlink(root, linkedRoot)
  await assert.rejects(readConfinedFile(linkedRoot, 'results/report.txt', 1024), /symlink|symbolic/i)
})
