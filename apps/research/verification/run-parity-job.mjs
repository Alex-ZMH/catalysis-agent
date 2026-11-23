// Explicit engineering acceptance only. No model call, MCP tool, or scheduler job.
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createApi, workerConfig, publishArtifact, harvestAndPublishArtifacts } from '../standalone/worker.mjs';
import { ensureWorkspace } from '../standalone/workspace.mjs';
import { captureResultFileSnapshot } from '../standalone/artifact-harvest.mjs';
import { generateParityFiles } from './generate-parity-files.mjs';

const { RECEIPT_PATH, EVIDENCE_PATH } = process.env;
if (!RECEIPT_PATH || !EVIDENCE_PATH) throw new Error('Private receipt and evidence paths required');
const receipt = JSON.parse(await readFile(RECEIPT_PATH, 'utf8'));
const config = workerConfig();
const api = createApi(config);
const job = receipt.job;
const controller = new AbortController();
const { signal } = controller;
const events = items => api(`/worker/runs/${job.id}/events`, { leaseToken: job.leaseToken, events: items });
const heartbeat = async () => {
  await api('/worker/heartbeat', { workerId: receipt.workerId, ready: true });
  const state = await events([]);
  if (state.cancelRequested) controller.abort();
};
await heartbeat();
const timer = setInterval(() => heartbeat().catch(() => controller.abort()), 5000);
let complete = false, cookie;
try {
  await ensureWorkspace(config.workspaceRoot, job.ownerId, job.chatId);
  const workspace = join(config.workspaceRoot, job.ownerId, job.chatId);
  await mkdir(join(workspace, 'results'), { recursive: true, mode: 0o700 });
  await writeFile(join(workspace, 'results/existing.md'), 'Unchanged engineering report referenced in a later answer.\n', { flag: 'wx', mode: 0o600 });
  const before = await captureResultFileSnapshot(workspace);
  const files = await generateParityFiles(workspace);
  files.push('results/existing.md');
  await events([{ eventId: randomUUID(), type: 'run.started' }]);
  const explicitPaths = ['results/large-32MiB.bin', 'results/structure.cif'];
  const explicit = [];
  for (const path of explicitPaths) explicit.push((await publishArtifact(workspace, path, job, api, signal)).artifact);
  // A lost-response retry must return the same immutable artifact identity.
  const duplicate = await publishArtifact(workspace, explicitPaths[0], job, api, signal);
  assert.equal(duplicate.artifact.id, explicit[0].id);
  const text = '以下都是格式与链路工程夹具，不是科研计算结果。\n\n' +
    '态密度：`results/DOSCAR`；晶体结构：[structure.cif](results/structure.cif)；长字段表格：`results/long-field.csv`。\n' +
    '历史结果仍可引用：`results/existing.md`。\n' +
    '其余附件由完成后的目录扫描自动收集。大文件可直接下载，超出预览预算的文件会明确提示。';
  await events([{ eventId: randomUUID(), type: 'assistant.delta', text }]);
  const harvest = await harvestAndPublishArtifacts({ root: workspace, job, api, signal, before, assistantText: text, excludedPaths: new Set(explicitPaths), status: 'completed' });
  assert.equal(harvest.skipped, false);
  assert.equal(harvest.published.length, files.length - explicit.length);
  const artifacts = [...explicit, ...harvest.published.map(item => item.response.artifact)];
  assert.equal(new Set(artifacts.map(item => item.id)).size, files.length);
  assert.deepEqual(new Set(artifacts.map(item => item.path)), new Set(files));
  await events([{ eventId: randomUUID(), type: 'run.completed' }]);
  complete = true;
  clearInterval(timer);
  await api('/worker/heartbeat', { workerId: receipt.workerId, ready: false });

  const origin = new URL(config.apiOrigin).origin;
  const login = await fetch(`${config.apiOrigin}/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({contact:receipt.account.contact,password:receipt.account.password}) });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
  const checks = [];
  for (const artifact of artifacts) {
    const url = `${config.apiOrigin}/artifacts/${artifact.id}`;
    assert.equal((await fetch(url)).status, 401);
    const response = await fetch(url, { headers: { Cookie: cookie }, signal });
    assert.equal(response.status, 200);
    const expectedHash = createHash('sha256');
    for await (const bytes of createReadStream(join(workspace, artifact.path))) expectedHash.update(bytes);
    const actualHash = createHash('sha256'); let bytes = 0;
    for await (const chunk of response.body) { actualHash.update(chunk); bytes += chunk.byteLength; }
    const sha256 = actualHash.digest('hex');
    assert.equal(sha256, expectedHash.digest('hex'));
    assert.equal(bytes, artifact.size);
    checks.push({ name: artifact.name, path: artifact.path, bytes, sha256, mimeType: artifact.mimeType, exactDownload: true });
  }
  assert.equal(artifacts.find(item => item.name === 'preview.avif').mimeType, 'image/avif');
  assert.equal(artifacts.find(item => item.name === 'preview.htm').mimeType, 'text/html');
  assert.equal(artifacts.find(item => item.name === 'notes.markdown').mimeType, 'text/markdown');
  const largeVolume = artifacts.find(item => item.name === 'large-density.cube');
  const prepared = await fetch(`${config.apiOrigin}/artifacts/${largeVolume.id}/visualization`, {headers:{Cookie:cookie},signal});
  assert.equal(prepared.status,200);
  const manifest = await prepared.json();
  assert.equal(manifest.state,'ready');
  assert.equal(manifest.manifest.kind,'volume');
  for (const resource of manifest.manifest.resources) {
    const response = await fetch(`${config.apiOrigin}/artifacts/${largeVolume.id}/visualization/resources/${resource.id}`,{headers:{Cookie:cookie},signal});
    assert.equal(response.status,200);
    assert.equal((await response.arrayBuffer()).byteLength,resource.byteLength);
  }
  const largeScientificPreview = {name:largeVolume.name,bytes:largeVolume.size,state:manifest.state,kind:manifest.manifest.kind,resources:manifest.manifest.resources.length};
  const { job: _job, ...privateReceipt } = receipt;
  await writeFile(RECEIPT_PATH, JSON.stringify({ ...privateReceipt, artifacts }, null, 2) + '\n', { mode: 0o600 });
  const evidence = { checkedAt: new Date().toISOString(), origin: config.apiOrigin, engineeringOnly: true, scientificCalculationSubmitted: false, artifactCount: artifacts.length, explicitCount: explicit.length, largeScientificPreview, automaticallyPublished: harvest.published.length, referencedFirst: harvest.referenced.map(item => item.relativePath), duplicateUploadReusedIdentity: true, checks };
  await writeFile(EVIDENCE_PATH, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ artifactCount: artifacts.length, automaticallyPublished: harvest.published.length, largeBytes: checks.find(item => item.name.endsWith('.bin')).bytes, largeScientificPreview, allChecksPassed: true, scientificCalculationSubmitted: false }));
} catch (error) {
  if (!complete) await events([{ eventId: randomUUID(), type: 'run.failed', message: `Engineering verification failed: ${error.message}` }]).catch(() => {});
  throw error;
} finally {
  clearInterval(timer);
  await api('/worker/heartbeat', { workerId: receipt.workerId, ready: false }).catch(() => {});
  if (cookie) await fetch(`${config.apiOrigin}/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: new URL(config.apiOrigin).origin, 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
}
