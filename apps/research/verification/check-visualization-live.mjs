// Uses a private engineering account receipt; submits no model or simulation run.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const origin = process.env.MLCC_VERIFY_ORIGIN
const receipt = process.env.RECEIPT_PATH
if (!origin || !receipt) throw new Error('Set MLCC_VERIFY_ORIGIN and private RECEIPT_PATH.')
const data = JSON.parse(await readFile(receipt, 'utf8'))
const base = origin.replace(/\/$/, '')
const login = await fetch(`${base}/api/login`, {
  method: 'POST', headers: { 'content-type': 'application/json', Origin: new URL(base).origin },
  body: JSON.stringify({ contact: data.account.contact, password: data.account.password }),
})
assert.equal(login.status, 200)
const cookie = login.headers.get('set-cookie')?.split(';')[0]
assert.ok(cookie?.startsWith('catalysis_research_session='))
const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'visualization-fixtures')
const sha256 = value => createHash('sha256').update(value).digest('hex')
const derived = new Set(['trajectory.extxyz', 'XDATCAR', 'trajectory.lammpstrj', 'density.cube', 'CHGCAR', 'ELFCAR', 'EIGENVAL', 'DOSCAR'])
const checks = []
for (const artifact of data.artifacts) {
  const path = `${base}/api/artifacts/${encodeURIComponent(artifact.id)}`
  assert.equal((await fetch(path)).status, 401)
  const raw = await fetch(path, { headers: { Cookie: cookie } })
  assert.equal(raw.status, 200)
  const actual = Buffer.from(await raw.arrayBuffer())
  assert.equal(sha256(actual), sha256(await readFile(join(fixtures, artifact.name))))
  const record = { name: artifact.name, bytes: actual.length, rawDownload: 'exact' }
  if (derived.has(artifact.name)) {
    assert.equal((await fetch(`${path}/visualization`)).status, 401)
    const response = await fetch(`${path}/visualization`, { headers: { Cookie: cookie } })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    const manifest = await response.json()
    assert.equal(manifest.state, 'ready')
    record.kind = manifest.manifest.kind
    record.resources = []
    for (const resource of manifest.manifest.resources) {
      const resourceUrl = `${path}/visualization/resources/${encodeURIComponent(resource.id)}`
      assert.equal((await fetch(resourceUrl)).status, 401)
      const result = await fetch(resourceUrl, { headers: { Cookie: cookie } })
      assert.equal(result.status, 200)
      assert.equal(result.headers.get('content-type'), resource.mimeType)
      const bytes = Buffer.from(await result.arrayBuffer())
      assert.equal(bytes.length, resource.byteLength)
      record.resources.push({ role: resource.role, bytes: bytes.length, sha256: sha256(bytes) })
    }
  }
  checks.push(record)
}
const status = await (await fetch(`${base}/api/status`)).json()
assert.equal(status.mode, 'independent')
await fetch(`${base}/api/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: new URL(base).origin, 'content-type': 'application/json' }, body: '{}' })
const evidence = { checkedAt: new Date().toISOString(), origin: base, artifactCount: checks.length, derivedCount: checks.filter(x => x.resources).length, status, scientificCalculationSubmitted: false, checks }
if (process.env.EVIDENCE_PATH) await writeFile(process.env.EVIDENCE_PATH, JSON.stringify(evidence, null, 2) + '\n')
console.log(JSON.stringify({ artifactCount: checks.length, derivedCount: evidence.derivedCount, status, allChecksPassed: true }))
