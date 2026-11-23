import test from 'node:test';
import assert from 'node:assert/strict';
import { matchArtifactReference, relativeArtifactPath } from './artifact-references.js';
import { renderMarkdown } from './markdown.js';
import { createArtifactTabs } from './artifact-tabs.js';

const a = { id: 'a', name: 'report.csv', path: 'first/report.csv' };
const b = { id: 'b', name: 'report.csv', path: 'second/report.csv' };
const c = { id: 'c', name: 'structure.cif', path: 'structure.cif' };

test('current exact path and unique basename take precedence over history', () => {
  const historical = { ...a, id: 'old' };
  assert.equal(matchArtifactReference('first/report.csv', [historical, a, b], [a, b]), a);
  assert.equal(matchArtifactReference('report.csv', [historical, a], [a]), a);
  assert.equal(matchArtifactReference('structure.cif', [a, c], [a]), c);
  assert.equal(matchArtifactReference('report.csv', [a, b], [a, b]), undefined);
  assert.equal(matchArtifactReference('report.csv', [a, b], []), undefined);
  assert.equal(matchArtifactReference('missing/report.csv', [a], [a]), undefined);
  assert.equal(matchArtifactReference('first/report.csv', [a, { ...a, id: 'duplicate' }], []), undefined);
});

test('identities are deduplicated and missing references stay ordinary text', () => {
  assert.equal(matchArtifactReference('report.csv', [a, a], [a, a]), a);
  assert.equal(matchArtifactReference('missing.csv', [a]), undefined);
  assert.equal(matchArtifactReference('first/report.csv?download=1#data', [a]), a);
  assert.equal(matchArtifactReference('first%2Freport.csv', [a]), a);
});

test('unsafe paths cannot become file authorities, including encoded variants', () => {
  for (const path of ['../report.csv', './report.csv', '/report.csv', '//host/report.csv', 'first/../report.csv', 'first\\report.csv', 'https://host/report.csv', 'file:report.csv', 'javascript:report.csv', '%2e%2e/report.csv', '%2freport.csv', '%5creport.csv', 'first/%00report.csv', 'a//report.csv', 'bad%xy']) {
    assert.equal(relativeArtifactPath(path), null, path);
    assert.equal(matchArtifactReference(path, [a]), undefined, path);
  }
});

test('inline code and relative Markdown links open authorized files only', () => {
  const html = renderMarkdown('请看 `structure.cif` 和 [表格](first/report.csv)。', [a, c], [a]);
  assert.match(html, /data-artifact-id="c"/);
  assert.match(html, /data-artifact-id="a"/);
  assert.match(html, /<code>structure.cif<\/code>/);
  assert.match(renderMarkdown('`report.csv`', [a, b]), /<p><code>report.csv<\/code><\/p>/);
  assert.doesNotMatch(renderMarkdown('```text\nstructure.cif\n```\n', [c]), /data-artifact-id/);
  assert.doesNotMatch(renderMarkdown('~~~text\n`structure.cif`\n~~~\n', [c]), /data-artifact-id/);
  assert.doesNotMatch(renderMarkdown('```\n`structure.cif`', [c]), /data-artifact-id/);
});

test('HTML, hostile labels and image URLs are escaped without implicit requests', () => {
  const malicious = { id: 'x" onmouseover="oops', name: '<img>', path: 'files/safe.csv' };
  const html = renderMarkdown('<script>x</script> [<img onerror=x>](files/safe.csv) ![picture](https://host/x.png) [x](javascript:alert)', [malicious]);
  assert.doesNotMatch(html, /<script|<img|href="javascript:|onmouseover="oops/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /data-artifact-id="x&quot;/);
  assert.match(renderMarkdown('[paper](https://example.com/article)', []), /rel="noopener noreferrer"/);
});

test('result tabs preserve order, reselect existing result and close to neighbor', () => {
  const tabs = createArtifactTabs();
  tabs.open('owner:chat', a); tabs.open('owner:chat', b); tabs.open('owner:chat', c);
  tabs.open('owner:chat', b);
  assert.deepEqual(tabs.items.map(item => item.id), ['a', 'b', 'c']);
  assert.equal(tabs.selected, b);
  tabs.close('b'); assert.equal(tabs.selected, c);
  tabs.close('c'); assert.equal(tabs.selected, a);
  tabs.close('a'); assert.equal(tabs.selected, null);
});

test('closing an unselected tab preserves selection and unknown selection is ignored', () => {
  const tabs = createArtifactTabs();
  tabs.open('one', a); tabs.open('one', b);
  tabs.close('missing'); tabs.close('a'); tabs.select('missing');
  assert.equal(tabs.selected, b);
  assert.deepEqual(tabs.items, [b]);
});

test('chat or account changes and explicit reset erase all prior tabs', () => {
  const tabs = createArtifactTabs();
  tabs.open('owner1:chat1', a); tabs.open('owner1:chat1', b);
  tabs.open('owner1:chat2', c);
  assert.deepEqual(tabs.items, [c]);
  tabs.open('owner2:chat2', a);
  assert.deepEqual(tabs.items, [a]);
  tabs.reset(); assert.equal(tabs.selected, null); assert.deepEqual(tabs.items, []);
});

test('research replies render headings, tables, nested items, math and code while keeping examples inert', () => {
  const html = renderMarkdown([
    '### HER 结果', '', '| 步骤 | ΔG |', '| --- | ---: |', '| **Volmer** | +0.13 |',
    '', '- 输入', '  - \\(\\mathrm{H_2}\\)', '', '$$\\Delta G=0.13$$', '',
    '> 参考', '', '```text', '`structure.cif`', '```',
  ].join('\n'), [c]);
  for (const tag of ['h3','table','th','td','strong','ul','math','msub','blockquote','pre'])
    assert.match(html,new RegExp('<'+tag+'[ >]'));
  assert.match(html, /<math[^>]+display="block"/);
  assert.doesNotMatch(html, /data-artifact-id/);
});

test('formatting a linked artifact name keeps a single authorized action', () => {
  const html = renderMarkdown('[`structure.cif`](structure.cif)', [c]);
  assert.equal((html.match(/<button/g)||[]).length,1);
  assert.match(html, /data-artifact-id="c"/);
  assert.doesNotMatch(renderMarkdown('![external](https://example.invalid/image.png)\n\n\\(\\href{javascript:alert(1)}{x}\\)'), /<img|href="javascript:/);
});

test('a site marker inside adsorption free energy survives Markdown emphasis', () => {
  const html = renderMarkdown('给定 **ΔG(H*) = 0.21 eV（0 V）**，以及 *常规斜体*。');
  assert.match(html, /<strong>ΔG\(H\*\) = 0.21 eV（0 V）<\/strong>/);
  assert.match(html, /<em>常规斜体<\/em>/);
});
