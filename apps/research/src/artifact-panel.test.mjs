import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createArtifactPanel } from './artifact-panel.js';

const artifacts = [{ id: 'a', name: 'structure.cif' }, { id: 'b', name: 'report.csv' }, { id: 'c', name: 'DOSCAR' }];
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture({ delayed = false } = {}) {
  const dom = new JSDOM('<dialog></dialog>');
  const dialog = dom.window.document.querySelector('dialog');
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new dom.window.Event('close')); };
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  let resolveViewer, scope = 'owner:chat', available = [...artifacts];
  const mounts = [], destroyed = [];
  const module = { mountArtifactPreview(container, options) {
    mounts.push(options.artifact.id);
    container.textContent = options.artifact.name;
    return { destroy() { destroyed.push(options.artifact.id); } };
  } };
  const loading = delayed ? new Promise(resolve => { resolveViewer = () => resolve(module); }) : Promise.resolve(module);
  const panel = createArtifactPanel({ dialog, apiBase: '/mlcc/api', getScope: () => scope, getArtifacts: () => available, loadViewer: () => loading });
  const click = selector => dialog.querySelector(selector).click();
  const choose = id => { const select = dialog.querySelector('select'); select.value = id; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); };
  return { dom, dialog, panel, mounts, destroyed, click, choose, resolveViewer, setScope(value) { scope = value; }, setArtifacts(value) { available = value; } };
}

test('result selector, tab switching, close neighbor and keyboard are connected to the viewer', async () => {
  const f = fixture();
  f.panel.open(artifacts[0]); await tick();
  f.choose('b'); await tick();
  f.choose('c'); await tick();
  assert.equal(f.dialog.querySelectorAll('[role=tab]').length, 3);
  f.click('[data-tab-id="a"]'); await tick();
  assert.equal(f.dialog.querySelector('[aria-selected=true]').textContent, 'structure.cif');
  f.dialog.querySelector('[data-tab-id="a"]').dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await tick(); assert.equal(f.mounts.at(-1), 'b');
  f.click('[data-tab-close="b"]'); await tick();
  assert.equal(f.mounts.at(-1), 'c');
  assert.equal(f.dialog.querySelectorAll('[role=tab]').length, 2);
  f.click('[data-tab-close="c"]'); await tick();
  f.click('[data-tab-close="a"]'); await tick();
  assert.equal(f.dialog.open, false);
  assert.equal(f.destroyed.length, f.mounts.length);
});

test('hide keeps tabs for reopening, reset or changed account clears them', async () => {
  const f = fixture();
  f.panel.open(artifacts[0]); await tick(); f.choose('b'); await tick();
  f.panel.hide(); f.panel.open(artifacts[0]); await tick();
  assert.equal(f.dialog.querySelectorAll('[role=tab]').length, 2);
  f.panel.reset(); f.panel.open(artifacts[2]); await tick();
  assert.equal(f.dialog.querySelectorAll('[role=tab]').length, 1);
  f.setScope('another:chat'); f.panel.open(artifacts[1]); await tick();
  assert.equal(f.dialog.querySelectorAll('[role=tab]').length, 1);
  assert.equal(f.dialog.querySelector('[role=tab]').textContent, 'report.csv');
  f.panel.reset();
});

test('closing a background tab keeps current 3D/PDF view and network lifecycle intact', async () => {
  const f = fixture();
  f.panel.open(artifacts[0]); await tick(); f.choose('b'); await tick();
  const mounts = [...f.mounts], destroyed = [...f.destroyed];
  const content = f.dialog.querySelector('#artifact-preview-root');
  f.click('[data-tab-close="a"]'); await tick();
  assert.deepEqual(f.mounts, mounts);
  assert.deepEqual(f.destroyed, destroyed);
  assert.equal(f.dialog.querySelector('#artifact-preview-root'), content);
  assert.equal(f.dialog.querySelectorAll('[role=tab]').length, 1);
  f.panel.reset();
});

test('stale lazy imports cannot remount a closed, switched or logged-out preview', async () => {
  const f = fixture({ delayed: true });
  f.panel.open(artifacts[0]); f.panel.open(artifacts[1]);
  f.resolveViewer(); await tick();
  assert.deepEqual(f.mounts, ['b']);
  f.panel.reset();
  assert.deepEqual(f.destroyed, ['b']);
  const closed = fixture({ delayed: true });
  closed.panel.open(artifacts[0]); closed.panel.reset(); closed.resolveViewer(); await tick();
  assert.deepEqual(closed.mounts, []);
  assert.equal(closed.dialog.textContent, '');
});

test('streamed artifact arrivals update the result list without restarting the active viewer', async () => {
  const f = fixture();
  f.setArtifacts([artifacts[0]]); f.panel.open(artifacts[0]); await tick();
  f.setArtifacts(artifacts); f.panel.refresh();
  assert.equal(f.dialog.querySelectorAll('option').length, 3);
  assert.equal(f.dialog.querySelector('select').value, 'a');
  assert.deepEqual(f.mounts, ['a']);
  assert.deepEqual(f.destroyed, []);
  f.panel.reset();
});
