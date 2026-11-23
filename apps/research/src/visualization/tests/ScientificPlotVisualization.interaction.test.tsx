import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'

import { JSDOM } from 'jsdom'
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import type {
  ServerArtifactVisualizationManifest,
  ServerArtifactVisualizationResource,
} from '../scientific-visualization'

void React

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1/' })
Object.assign(globalThis, {
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  SVGElement: dom.window.SVGElement,
  Node: dom.window.Node,
  MutationObserver: dom.window.MutationObserver,
  FocusEvent: dom.window.FocusEvent,
  KeyboardEvent: dom.window.KeyboardEvent,
  MouseEvent: dom.window.MouseEvent,
  window: dom.window,
})
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true, writable: true })

const { ScientificPlotVisualization } = await import('../ScientificPlotVisualization')

afterEach(() => {
  document.body.replaceChildren()
})

function manifest(kind: 'band' | 'dos'): Extract<ServerArtifactVisualizationManifest, { kind: 'band' | 'dos' }> {
  const resource: ServerArtifactVisualizationResource = {
    id: 'plot', role: 'plot.values', mimeType: 'application/json', byteLength: 0,
  }
  if (kind === 'dos') {
    return {
      version: 1,
      source: { runId: 'run-test', sequence: 1, name: 'DOSCAR', mimeType: 'chemical/x-vasp-doscar' },
      resources: [resource], kind, format: 'vasp-doscar', spinChannels: 1,
      points: 3, fermiEnergy: 1.5, resourceId: 'plot',
    }
  }
  return {
    version: 1,
    source: { runId: 'run-test', sequence: 1, name: 'EIGENVAL', mimeType: 'chemical/x-vasp-eigenval' },
    resources: [resource], kind, format: 'vasp-eigenval', spinChannels: 1,
    bands: 1, kpoints: 3, fermiEnergy: null, resourceId: 'plot',
  }
}

async function mountPlot(current: Extract<ServerArtifactVisualizationManifest, { kind: 'band' | 'dos' }>, data: unknown) {
  const payload = new Blob([JSON.stringify(data)], { type: 'application/json' })
  const descriptor = current.resources[0]!
  const currentManifest = {
    ...current,
    resources: [{ ...descriptor, byteLength: payload.size }],
  } as typeof current
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await React.act(async () => {
    root.render(
      <ScientificPlotVisualization
        manifest={currentManifest}
        loadResource={async (resource) => {
          assert.equal(resource, currentManifest.resources[0])
          return payload
        }}
        scopeKey="scope-test"
        identity={{ runId: currentManifest.source.runId, sequence: currentManifest.source.sequence }}
        generation={0}
        fallback={<p>fallback</p>}
      />,
    )
  })
  return { host, root }
}

async function waitForSelector(host: HTMLElement, selector: string): Promise<Element> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const element = host.querySelector(selector)
    if (element !== null) return element
    await React.act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    })
  }
  throw new Error(`Timed out waiting for ${selector}`)
}

test('renders a Chinese band title and exposes bounded keyboard/pointer readout state', async () => {
  const { host, root } = await mountPlot(manifest('band'), {
    kpoints: [[0, 0, 0], [0.5, 0, 0], [1, 0, 0]],
    weights: [0.3, 0.3, 0.4],
    energies: [[[-1], [0], [1]]],
    occupations: [[[1], [0.5], [0]]],
  })
  await waitForSelector(host, '[data-testid="scientific-plot-svg"]')
  assert.equal(host.querySelector('figcaption')?.textContent, '能带图')
  const series = host.querySelector('[data-testid="scientific-plot-series-0-0"]') as SVGPathElement
  assert.equal(series.getAttribute('stroke'), '#67e8f9')
  assert.equal(host.querySelector('[data-testid="scientific-plot-legend"] text')?.getAttribute('fill'), '#67e8f9')
  await React.act(async () => {
    series.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
  })
  assert.match(host.querySelector('[data-testid="scientific-plot-readout"]')?.textContent ?? '', /x:|y:/i)
  await React.act(async () => {
    series.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    series.dispatchEvent(new MouseEvent('pointermove', { clientX: 0, bubbles: true }))
  })
  assert.match(host.querySelector('[data-testid="scientific-plot-readout"]')?.textContent ?? '', /x:|y:/i)
  await React.act(async () => { root.unmount() })
})

test('uses the Chinese DOS title while keeping Fermi energy units visible', async () => {
  const { host, root } = await mountPlot(manifest('dos'), {
    energy: [-1, 0, 1],
    density: [[10, 20, 30]],
    integrated: [[0, 1, 2]],
  })
  await waitForSelector(host, '[data-testid="scientific-plot-svg"]')
  assert.equal(host.querySelector('figcaption')?.textContent, '态密度图')
  assert.match(host.textContent ?? '', /Energy − E_F|E_F/i)
  assert.match(host.textContent ?? '', /1\.5/)
  await React.act(async () => { root.unmount() })
})
