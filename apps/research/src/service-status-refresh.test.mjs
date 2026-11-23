import test from 'node:test';
import assert from 'node:assert/strict';
import { startServiceStatusRefresh } from './service-status-refresh.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
function setup(refresh) {
  const document = Object.assign(new EventTarget(), { hidden: false });
  const window = new EventTarget();
  let tick;
  const stop = startServiceStatusRefresh({ refresh, document, window, schedule: fn => { tick = fn; return 1; }, cancel: () => { tick = null; } });
  return { document, window, stop, tick: () => tick() };
}

test('an open conversation recovers its service status without reload or login', async () => {
  let server = 'offline', displayed = 'offline', calls = 0;
  const page = setup(async () => { calls++; displayed = server; });
  await page.tick(); assert.equal(displayed, 'offline');
  server = 'online'; await page.tick(); assert.equal(displayed, 'online');
  page.document.hidden = true; await page.tick(); assert.equal(calls, 2);
  page.document.hidden = false; page.document.dispatchEvent(new Event('visibilitychange'));
  await settle(); assert.equal(calls, 3);
  page.stop(); page.window.dispatchEvent(new Event('focus')); await settle(); assert.equal(calls, 3);
});

test('focus and polling cannot overlap requests, and a network failure can recover', async () => {
  let calls = 0, release;
  const page = setup(() => { calls++; return calls === 1 ? new Promise((_, reject) => { release = reject; }) : Promise.resolve(); });
  page.window.dispatchEvent(new Event('focus')); await settle();
  page.window.dispatchEvent(new Event('focus')); const pending = page.tick();
  assert.equal(calls, 1); release(new Error('offline')); await pending;
  await page.tick(); assert.equal(calls, 2); page.stop();
});
