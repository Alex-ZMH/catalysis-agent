import test from 'node:test'
import assert from 'node:assert/strict'
import { link, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempRoot = () => mkdtemp(join(tmpdir(), 'mlcc-harvest-'))

test('snapshot keeps result formats while excluding inputs, credentials, task controls and symlinks', async t => {
  const root = await tempRoot()
  const outside = await tempRoot()
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]))
  await mkdir(join(root, 'outputs'), { recursive: true })
  await mkdir(join(root, 'inputs'))
  await mkdir(join(root, 'configs'))
  await mkdir(join(root, 'credentials'))
  await mkdir(join(root, 'tasks', 'task-01'), { recursive: true })
  await writeFile(join(root, 'outputs', 'plot.avif'), 'avif')
  await writeFile(join(root, 'outputs', 'report.htm'), '<html/>')
  await writeFile(join(root, 'outputs', 'notes.markdown'), '# notes')
  await writeFile(join(root, 'outputs', 'real-result.json'), '{}')
  await writeFile(join(root, 'outputs', 'configuration.json'), '{}')
  await writeFile(join(root, 'inputs', 'user.json'), '{}')
  await writeFile(join(root, 'configs', 'site.json'), '{}')
  await writeFile(join(root, 'credentials', 'token.json'), '{}')
  await writeFile(join(root, 'tasks', 'task-01', 'task.json'), '{}')
  await writeFile(join(root, 'tasks', 'task-01', 'operation-request.json'), '{}')
  await writeFile(join(root, 'tasks', 'task-01', 'operation-result.json'), '{}')
  await writeFile(join(root, 'tasks', 'task-01', 'result.json'), '{}')
  await writeFile(join(outside, 'outside.svg'), '<svg/>')
  await symlink(join(outside, 'outside.svg'), join(root, 'outputs', 'linked.svg'))
  await writeFile(join(outside, 'outside.json'), '{}')
  await link(join(outside, 'outside.json'), join(root, 'outputs', 'hardlinked.json'))

  const { captureResultFileSnapshot, selectReferencedResultFiles } = await import('./artifact-harvest.mjs')
  const snapshot = await captureResultFileSnapshot(root)
  assert.equal(snapshot.complete, true)
  assert.deepEqual([...snapshot.entries.keys()], [
    'outputs/notes.markdown', 'outputs/plot.avif', 'outputs/real-result.json', 'outputs/report.htm',
    'tasks/task-01/operation-request.json', 'tasks/task-01/operation-result.json',
    'tasks/task-01/result.json', 'tasks/task-01/task.json',
  ])
  assert.deepEqual(selectReferencedResultFiles(snapshot, '结果见 outputs/real-result.json 和 tasks/task-01/task.json。'), [
    { relativePath: 'outputs/real-result.json', displayName: 'real-result.json', mimeType: 'application/json' },
    { relativePath: 'tasks/task-01/task.json', displayName: 'task.json', mimeType: 'application/json' },
  ])
})

test('changed selection is bounded, deterministic and excludes explicitly published paths', async t => {
  const root = await tempRoot()
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'outputs'))
  const { captureResultFileSnapshot, selectChangedResultFiles } = await import('./artifact-harvest.mjs')
  const before = await captureResultFileSnapshot(root)
  for (let index = 0; index < 30; index += 1) await writeFile(join(root, 'outputs', `result-${String(index).padStart(2, '0')}.csv`), String(index))
  const after = await captureResultFileSnapshot(root)
  const selected = selectChangedResultFiles(before, after, new Set(['outputs/result-00.csv']), 24)
  assert.equal(selected.length, 24)
  assert.equal(selected.some(entry => entry.relativePath === 'outputs/result-00.csv'), false)
  assert.equal(selected[0].relativePath, 'outputs/result-01.csv')
  assert.equal(selected.at(-1).relativePath, 'outputs/result-24.csv')
})

test('MLCC task control records are explicit-only while real task results remain eligible', async t => {
  const root = await tempRoot()
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'tasks', 'task-01'), { recursive: true })
  await writeFile(join(root, 'tasks', 'task-01', 'task.json'), '{"status":"defined"}')
  await writeFile(join(root, 'tasks', 'task-01', 'operation-result.json'), '{}')
  await writeFile(join(root, 'tasks', 'task-01', 'result.json'), '{"value":1}')
  const { captureResultFileSnapshot, selectChangedResultFiles } = await import('./artifact-harvest.mjs')
  const before = await captureResultFileSnapshot(root)
  await writeFile(join(root, 'tasks', 'task-01', 'task.json'), '{"status":"submitted"}')
  await writeFile(join(root, 'tasks', 'task-01', 'operation-result.json'), '{"status":"done"}')
  await writeFile(join(root, 'tasks', 'task-01', 'result.json'), '{"value":2}')
  for (const name of ['scale-request.json', 'scale-response.json', 'host-deployment.json']) {
    await writeFile(join(root, 'tasks', 'task-01', name), '{"deployment":"/private/engine"}')
  }
  const after = await captureResultFileSnapshot(root)
  assert.deepEqual(selectChangedResultFiles(before, after), [{
    relativePath: 'tasks/task-01/result.json', displayName: 'result.json', mimeType: 'application/json',
  }])
})

test('incomplete before or after snapshots never infer changed files', async t => {
  const { selectChangedResultFiles } = await import('./artifact-harvest.mjs')
  const entry = { relativePath: 'outputs/result.csv', displayName: 'result.csv', mimeType: 'text/csv', identity: { dev: 1, ino: 1, size: 1, mtimeMs: 1, ctimeMs: 1 } }
  const complete = { entries: new Map([[entry.relativePath, entry]]), complete: true }
  const incomplete = { entries: new Map(), complete: false }
  assert.deepEqual(selectChangedResultFiles(incomplete, complete), [])
  assert.deepEqual(selectChangedResultFiles(complete, incomplete), [])
})
