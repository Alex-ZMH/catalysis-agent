import { createArtifactTabs } from './artifact-tabs.js';
import { escapeMessageHtml as esc } from './artifact-references.js';

function resultOptions(artifacts, selected) {
  const counts = new Map();
  for (const item of artifacts) counts.set(item.name, (counts.get(item.name) || 0) + 1);
  return artifacts.map(item => {
    const label = counts.get(item.name) > 1 && item.path ? item.path : item.name;
    return `<option value="${esc(item.id)}" ${item.id === selected ? 'selected' : ''}>${esc(label)}</option>`;
  }).join('');
}

export function createArtifactPanel({ dialog, apiBase, getScope, getArtifacts, onAuthExpired, loadViewer = () => import('./visualization/index.jsx') }) {
  const tabs = createArtifactTabs();
  let viewer = null, generation = 0;
  const cleanup = () => { generation++; viewer?.destroy(); viewer = null; };
  const hide = () => { cleanup(); dialog.replaceChildren(); if (dialog.open) dialog.close(); };
  const reset = () => { tabs.reset(); hide(); };

  async function render({ focusTab = false } = {}) {
    cleanup();
    const selected = tabs.selected;
    if (!selected) { hide(); return; }
    const current = generation;
    const artifacts = [...new Map(getArtifacts().map(item => [item.id, item])).values()];
    dialog.innerHTML = `<div class="artifact-panel-layout">
      <div class="artifact-panel-toolbar"><label for="artifact-result-select">对话结果 <span>${artifacts.length}</span></label><select id="artifact-result-select" aria-label="选择对话结果">${resultOptions(artifacts, selected.id)}</select><button type="button" data-panel-close aria-label="关闭结果面板">关闭</button></div>
      <div class="artifact-tabs" role="tablist" aria-label="已打开的结果">${tabs.items.map(item => `<div class="artifact-tab-item${item.id === selected.id ? ' selected' : ''}"><button type="button" role="tab" id="artifact-tab-${esc(item.id)}" aria-selected="${item.id === selected.id}" aria-controls="artifact-preview-root" tabindex="${item.id === selected.id ? '0' : '-1'}" data-tab-id="${esc(item.id)}" title="${esc(item.path || item.name)}">${esc(item.name)}</button><button type="button" class="artifact-tab-close" data-tab-close="${esc(item.id)}" aria-label="关闭结果 ${esc(item.name)}">×</button></div>`).join('')}</div>
      <div id="artifact-preview-root" role="tabpanel" aria-labelledby="artifact-tab-${esc(selected.id)}"><div class="artifact-loading"><p role="status">正在打开研究结果…</p></div></div>
    </div>`;
    if (!dialog.open) {
      if (dialog.ownerDocument.defaultView.matchMedia?.('(min-width: 900px)').matches) dialog.show();
      else dialog.showModal();
    }
    if (focusTab) dialog.querySelector('[role="tab"][aria-selected="true"]')?.focus();
    dialog.querySelector('[role="tab"][aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const container = dialog.querySelector('#artifact-preview-root');
    try {
      const { mountArtifactPreview } = await loadViewer();
      if (current !== generation || !dialog.open) return;
      container.replaceChildren();
      viewer = mountArtifactPreview(container, { artifact: selected, apiBase, onClose: hide, onAuthExpired });
    } catch {
      if (current !== generation) return;
      container.innerHTML = `<div class="artifact-loading"><p role="alert">预览暂时不可用，可下载原文件。</p><a href="${esc(`${apiBase}/artifacts/${encodeURIComponent(selected.id)}`)}" download="${esc(selected.name)}">下载原文件</a><button type="button" data-preview-retry>重试预览</button></div>`;
    }
  }
  function open(artifact) {
    tabs.open(getScope(), artifact);
    void render();
  }
  function refresh() {
    if (!dialog.open || !tabs.selected) return;
    const artifacts = [...new Map(getArtifacts().map(item => [item.id, item])).values()];
    const select = dialog.querySelector('#artifact-result-select');
    if (!select) return;
    select.innerHTML = resultOptions(artifacts, tabs.selected.id);
    dialog.querySelector('.artifact-panel-toolbar label span').textContent = String(artifacts.length);
  }
  function closeTab(id) {
    const previous = tabs.selected?.id;
    tabs.close(id);
    if (previous !== tabs.selected?.id) void render({ focusTab: true });
    else {
      const closedTab = [...dialog.querySelectorAll('[data-tab-id]')].find(element => element.dataset.tabId === id);
      closedTab?.closest('.artifact-tab-item')?.remove();
      dialog.querySelector('[role="tab"][aria-selected="true"]')?.focus();
    }
  }
  dialog.addEventListener('close', () => { if (!dialog.open) { cleanup(); dialog.replaceChildren(); } });
  dialog.addEventListener('click', event => {
    const close = event.target.closest('[data-tab-close]');
    const tab = event.target.closest('[data-tab-id]');
    if (close) closeTab(close.dataset.tabClose);
    else if (tab) { if (tabs.selected?.id !== tab.dataset.tabId) { tabs.select(tab.dataset.tabId); void render({ focusTab: true }); } }
    else if (event.target.closest('[data-panel-close]')) hide();
    else if (event.target.closest('[data-preview-retry]')) void render();
  });
  dialog.addEventListener('change', event => {
    if (event.target.id !== 'artifact-result-select') return;
    const artifact = getArtifacts().find(item => item.id === event.target.value);
    if (artifact) open(artifact);
  });
  dialog.addEventListener('keydown', event => {
    const tab = event.target.closest('[role="tab"]');
    if (!tab) return;
    const items = tabs.items, index = items.findIndex(item => item.id === tab.dataset.tabId);
    let next;
    if (event.key === 'ArrowRight') next = items[(index + 1) % items.length];
    else if (event.key === 'ArrowLeft') next = items[(index - 1 + items.length) % items.length];
    else if (event.key === 'Home') next = items[0];
    else if (event.key === 'End') next = items.at(-1);
    else if (event.key === 'Delete') { event.preventDefault(); closeTab(tab.dataset.tabId); return; }
    if (next) { event.preventDefault(); tabs.select(next.id); void render({ focusTab: true }); }
  });
  return { open, reset, hide, refresh };
}
