export function createArtifactTabs() {
  let scope = '', tabs = [], selectedId = null;
  return {
    get items() { return [...tabs]; },
    get selected() { return tabs.find(item => item.id === selectedId) ?? null; },
    open(nextScope, artifact) {
      if (scope !== nextScope) { scope = nextScope; tabs = []; }
      const index = tabs.findIndex(item => item.id === artifact.id);
      if (index < 0) tabs.push(artifact); else tabs[index] = artifact;
      selectedId = artifact.id;
    },
    select(id) { if (tabs.some(item => item.id === id)) selectedId = id; },
    close(id) {
      const index = tabs.findIndex(item => item.id === id);
      if (index < 0) return;
      tabs.splice(index, 1);
      if (selectedId === id) selectedId = tabs[Math.min(index, tabs.length - 1)]?.id ?? null;
    },
    reset() { scope = ''; tabs = []; selectedId = null; },
  };
}
