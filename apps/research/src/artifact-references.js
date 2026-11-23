// References are resolved only against this conversation's authorized artifacts.
// A path is presentation metadata, never a storage or download address.
export const escapeMessageHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

export function relativeArtifactPath(value) {
  if (typeof value !== 'string') return null;
  let path;
  try { path = decodeURIComponent(value.trim().split(/[?#]/, 1)[0]); } catch { return null; }
  if (!path || /[\\\u0000-\u001f\u007f]/.test(path) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)) return null;
  if (path.split('/').some(part => !part || part === '.' || part === '..')) return null;
  return path;
}

function unique(artifacts) {
  return [...new Map(artifacts.filter(item => item?.id).map(item => [item.id, item])).values()];
}

export function matchArtifactReference(value, artifacts, currentArtifacts = artifacts) {
  const path = relativeArtifactPath(value);
  if (!path) return undefined;
  const current = unique(currentArtifacts);
  const currentIds = new Set(current.map(item => item.id));
  const historical = unique(artifacts).filter(item => !currentIds.has(item.id));
  if (path.includes('/')) {
    for (const candidates of [current, historical]) {
      const matches = candidates.filter(item => item.path === path);
      if (matches.length) return matches.length === 1 ? matches[0] : undefined;
    }
    return undefined;
  }
  const name = path.split('/').at(-1);
  for (const candidates of [current, historical]) {
    const matches = candidates.filter(item => item.name === name);
    if (matches.length) return matches.length === 1 ? matches[0] : undefined;
  }
  return undefined;
}

