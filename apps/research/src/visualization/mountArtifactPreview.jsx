import {renderMarkdown} from '../markdown.js'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { AtomicStructurePreview } from './AtomicStructurePreview.tsx'
import {
  DerivedVisualizationPreview,
  isDerivedVisualizationCandidate,
} from './DerivedVisualizationPreview.tsx'
import {
  OfficeArtifactPreview,
  prepareOfficePreview,
} from './OfficeArtifactPreview.tsx'
import { PdfArtifactPreview } from './PdfArtifactPreview.jsx'
import { scientificStructureArtifactFormat, scientificResultArtifactMimeType } from '../../standalone/scientific-artifact.mjs'
import { sanitizeSvgSource } from './SvgPreviewSanitizer.ts'
import {
  htmlSrcDoc,
  parseDelimited,
  PreviewSizeLimitError,
  previewKindForArtifact,
  artifactDownloadHref,
  readResponseBytes,
} from './preview-utils.mjs'
import './server-agent.css'
import './server-agent-results.css'
import './visualization.css'

export const MAX_STRUCTURE_BYTES = 10 * 1024 * 1024
export const MAX_RASTER_BYTES = 25 * 1024 * 1024
export const MAX_SOURCE_BYTES = 512 * 1024
export const MAX_TABLE_BYTES = 1024 * 1024
export const MAX_SVG_BYTES = 2 * 1024 * 1024
export const MAX_OFFICE_BYTES = 25 * 1024 * 1024
export const MAX_PDF_BYTES = 25 * 1024 * 1024
export const MAX_RESOURCE_BYTES = 256 * 1024 * 1024
function normalizeApiBase(value) {
  const base = typeof value === 'string' && value.trim() !== '' ? value.trim() : '/api'
  return base.replace(/\/+$/, '')
}

function safeName(value) {
  const name = String(value ?? '').replace(/[\\/\u0000-\u001f\u007f]/g, '_').trim()
  return name || '结果文件'
}

function baseMime(value) {
  return String(value ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

function fileSuffix(value) {
  const name = safeName(value).toLowerCase()
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1)
}

function formatArtifactSize(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  if (value < 1024) return `${Math.round(value)} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function artifactTypeLabel(reference) {
  const name = safeName(reference?.name).toLowerCase()
  const mime = baseMime(reference?.mimeType)
  const upperName = name.toUpperCase()
  if (name.endsWith('.cif') || mime === 'chemical/x-cif') return '晶体结构（CIF）'
  if (name.endsWith('.extxyz')) return '原子轨迹（ExtXYZ）'
  if (name.endsWith('.xyz') || mime === 'chemical/x-xyz') return 'XYZ 结构与轨迹'
  if (upperName === 'XDATCAR' || mime === 'chemical/x-vasp-xdatcar') return '原子轨迹（XDATCAR）'
  if (name.endsWith('.lammpstrj') || name.endsWith('.dump') || mime === 'application/x-lammps-dump') return '原子轨迹（LAMMPS）'
  if (name.endsWith('.cube') || mime === 'chemical/x-cube') return '体数据（CUBE）'
  if (upperName === 'CHGCAR' || mime === 'chemical/x-vasp-chgcar') return '电荷密度（CHGCAR）'
  if (upperName === 'ELFCAR' || mime === 'chemical/x-vasp-elfcar') return '电子局域函数（ELFCAR）'
  if (upperName === 'EIGENVAL' || mime === 'chemical/x-vasp-eigenval') return '能带数据（EIGENVAL）'
  if (upperName === 'DOSCAR' || mime === 'chemical/x-vasp-doscar') return '态密度数据（DOSCAR）'
  if (['poscar', 'contcar'].includes(name) || name.endsWith('.vasp') || mime === 'chemical/x-vasp') return '晶体结构（VASP）'
  if (name.endsWith('.pdb') || mime === 'chemical/x-pdb') return '分子结构（PDB）'
  if (name.endsWith('.sdf') || name.endsWith('.mol')) return '分子结构（SDF/MOL）'
  if (mime === 'image/svg+xml' || name.endsWith('.svg')) return '矢量图（SVG）'
  if (mime.startsWith('image/')) return '图片'
  if (mime === 'application/pdf' || name.endsWith('.pdf')) return 'PDF 文档'
  if (mime === 'text/html' || name.endsWith('.html') || name.endsWith('.htm')) return '网页（HTML）'
  if (mime === 'text/csv' || mime === 'application/csv' || mime === 'text/tab-separated-values' || mime === 'text/tsv' || name.endsWith('.csv') || name.endsWith('.tsv')) return '表格数据'
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || name.endsWith('.docx')) return 'Word 文档'
  if (mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' || name.endsWith('.pptx')) return 'PowerPoint 演示'
  if (mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || name.endsWith('.xlsx')) return 'Excel 表格'
  if (mime === 'application/json' || mime === 'text/json' || name.endsWith('.json')) return 'JSON 数据'
  if (mime === 'text/markdown' || mime === 'text/x-markdown' || name.endsWith('.md') || name.endsWith('.markdown')) return 'Markdown 文档'
  if (mime === 'text/plain' || name.endsWith('.txt')) return '文本文件'
  return '结果文件'
}

function artifactMetaLabel(reference, size) {
  const sizeLabel = formatArtifactSize(size)
  return sizeLabel === null ? artifactTypeLabel(reference) : `${artifactTypeLabel(reference)} · ${sizeLabel}`
}

function isTextMime(mime, name) {
  const suffix = fileSuffix(name)
  return [
    'application/json',
    'text/plain',
    'text/markdown',
    'text/x-markdown',
    'text/csv',
    'text/tab-separated-values',
    'text/tsv',
  ].includes(baseMime(mime)) || ['json', 'md', 'markdown', 'txt', 'csv', 'tsv'].includes(suffix)
}

function delimiterFor(mime, name) {
  const suffix = fileSuffix(name)
  return baseMime(mime) === 'text/tab-separated-values' || baseMime(mime) === 'text/tsv' || suffix === 'tsv' ? '\t' : ','
}

/**
 * Suffixes are part of the artifact contract. In particular, old artifact
 * endpoints often return application/octet-stream for AVIF/HTML/Markdown.
 * MIME remains a fallback for files that have no useful extension.
 */
export function genericPreviewKind(reference) {
  return previewKindForArtifact(reference)
}

function previewBudget(kind) {
  switch (kind) {
    case 'image': return MAX_RASTER_BYTES
    case 'svg': return MAX_SVG_BYTES
    case 'table': return MAX_TABLE_BYTES
    case 'source':
    case 'html': return MAX_SOURCE_BYTES
    case 'office': return MAX_OFFICE_BYTES
    case 'pdf': return MAX_PDF_BYTES
    default: return null
  }
}

function previewLimitMessage(kind) {
  switch (kind) {
    case 'image': return '图片过大，无法内联预览。'
    case 'svg': return 'SVG 文件超过 2 MiB，请下载原文件查看。'
    case 'table': return '表格文件超过 1 MiB，请下载原文件查看。'
    case 'source':
    case 'html': return '文本/网页内容超过 512 KiB，请下载原文件查看。'
    case 'office': return 'Office 文件超过 25 MiB，无法预览。'
    case 'pdf': return 'PDF 文件超过 25 MiB，无法预览。'
    default: return '结果文件无法预览。'
  }
}

function previewMimeType(reference, responseMime = '') {
  const suffix = fileSuffix(reference?.name)
  const knownBySuffix = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    svg: 'image/svg+xml',
    htm: 'text/html',
    html: 'text/html',
    md: 'text/markdown',
    markdown: 'text/markdown',
    csv: 'text/csv',
    tsv: 'text/tab-separated-values',
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  }
  return knownBySuffix[suffix] ?? (baseMime(reference?.mimeType) || baseMime(responseMime))
}

function artifactReference(artifact) {
  const name = safeName(artifact?.name)
  return {
    runId: String(artifact?.id ?? ''),
    sequence: 1,
    name,
    mimeType: scientificResultArtifactMimeType(name) ?? String(artifact?.mimeType ?? 'application/octet-stream'),
  }
}

class ArtifactPreviewError extends Error {
  constructor(message, status = 0) {
    super(message)
    this.name = 'ArtifactPreviewError'
    this.status = status
  }
}

function useArtifactApi({ artifact, apiBase, onAuthExpired }) {
  const base = normalizeApiBase(apiBase)
  const artifactId = encodeURIComponent(String(artifact?.id ?? ''))
  const fetchJson = React.useCallback(async (path, signal) => {
    const response = await fetch(`${base}${path}`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
      signal,
    })
    if (response.status === 401) {
      onAuthExpired?.()
      throw new ArtifactPreviewError('登录已失效，请重新登录。', response.status)
    }
    if (!response.ok) throw new ArtifactPreviewError(`结果请求失败（${response.status}）。`, response.status)
    return response.json()
  }, [artifactId, base, onAuthExpired])

  const fetchPreviewBlob = React.useCallback(async (path, signal, maximumBytes, tooLargeMessage, mimeType) => {
    const response = await fetch(`${base}${path}`, { credentials: 'include', signal })
    if (response.status === 401) {
      onAuthExpired?.()
      throw new ArtifactPreviewError('登录已失效，请重新登录。', response.status)
    }
    if (!response.ok) throw new ArtifactPreviewError(`结果文件请求失败（${response.status}）。`, response.status)
    try {
      const bytes = await readResponseBytes(response, maximumBytes, signal)
      return new Blob([bytes], {
        type: baseMime(mimeType) || baseMime(response.headers.get('content-type')),
      })
    } catch (cause) {
      if (cause instanceof PreviewSizeLimitError) {
        throw new ArtifactPreviewError(tooLargeMessage, response.status)
      }
      throw cause
    }
  }, [base, onAuthExpired])

  const loadPreviewArtifact = React.useCallback((reference, signal, maximumBytes, tooLargeMessage) => (
    fetchPreviewBlob(
      `/artifacts/${artifactId}`,
      signal,
      maximumBytes,
      tooLargeMessage,
      previewMimeType(reference),
    )
  ), [artifactId, fetchPreviewBlob])

  const downloadHref = artifactDownloadHref(base, artifact?.id)

  return React.useMemo(() => ({
    // Kept for the child viewer seam. The result-panel download itself is a
    // native link and never calls this loader.
    loadArtifact: (reference, signal) => loadPreviewArtifact(
      reference,
      signal,
      MAX_RASTER_BYTES,
      '结果文件超过 25 MiB，无法在浏览器中预览。',
    ),
    loadPreviewArtifact,
    downloadHref,
    loadManifest: (_reference, signal) => fetchJson(`/artifacts/${artifactId}/visualization`, signal),
    loadResource: async (_reference, resource, signal) => {
      const blob = await fetchPreviewBlob(
        `/artifacts/${artifactId}/visualization/resources/${encodeURIComponent(resource.id)}`,
        signal,
        MAX_RESOURCE_BYTES,
        '科学可视化资源超过 256 MiB，无法预览。',
        resource.mimeType,
      )
      // The descriptor is authenticated by the manifest. Keep the browser
      // Blob MIME aligned even when a proxy falls back to octet-stream.
      return blob.type === resource.mimeType ? blob : new Blob([blob], { type: resource.mimeType })
    },
  }), [artifactId, downloadHref, fetchJson, fetchPreviewBlob, loadPreviewArtifact])
}

function DownloadButton({ reference, downloadHref }) {
  return <a
    className="mlcc-visualization-download"
    href={downloadHref}
    download={safeName(reference.name)}
    rel="noopener"
  >
    下载原始文件
  </a>
}

function Fallback({ message, retry, reference, downloadHref }) {
  return <div className="mlcc-visualization-fallback" role="alert">
    <p>{message}</p>
    <div className="mlcc-visualization-fallback-actions">
      <button type="button" onClick={retry}>重试预览</button>
      <DownloadButton reference={reference} downloadHref={downloadHref} />
    </div>
  </div>
}

function GenericPreview({ reference, blob }) {
  const mime = baseMime(reference.mimeType)
  const previewKind = genericPreviewKind(reference)
  const [url, setUrl] = React.useState(null)
  const [source, setSource] = React.useState(null)
  const [html, setHtml] = React.useState(null)
  const [rows, setRows] = React.useState(null)
  const [office, setOffice] = React.useState(null)
  const [previewError, setPreviewError] = React.useState(null)
  React.useEffect(() => {
    let active = true
    setUrl(null)
    setSource(null)
    setHtml(null)
    setRows(null)
    setOffice(null)
    setPreviewError(null)
    if (blob === undefined) return () => { active = false }
    if (previewKind === 'svg' && typeof URL.createObjectURL === 'function') {
      let ownedUrl = null
      void blob.text().then((text) => {
        const sanitized = sanitizeSvgSource(text)
        if (!active || sanitized === null) {
          if (sanitized === null && active) setPreviewError('SVG 内容无法安全预览。')
          return
        }
        ownedUrl = URL.createObjectURL(new Blob([sanitized], { type: 'image/svg+xml' }))
        setUrl(ownedUrl)
      })
      return () => {
        active = false
        if (ownedUrl !== null) URL.revokeObjectURL(ownedUrl)
      }
    }
    if (previewKind === 'image' && typeof URL.createObjectURL === 'function') {
      const nextUrl = URL.createObjectURL(blob)
      setUrl(nextUrl)
      return () => {
        active = false
        URL.revokeObjectURL(nextUrl)
      }
    }
    if (previewKind === 'html') {
      void blob.text().then((text) => {
        if (active) setHtml(htmlSrcDoc(text))
      })
      return () => { active = false }
    }
    if (previewKind === 'office') {
      void prepareOfficePreview(reference, blob).then((document) => {
        if (active) setOffice(document)
      }).catch((cause) => {
        if (active) setPreviewError(cause instanceof Error ? cause.message : 'Office 文件无法安全预览。')
      })
      return () => { active = false }
    }
    if (previewKind === 'table') {
      void blob.text().then((text) => {
        if (active) setRows(parseDelimited(text, delimiterFor(mime, reference.name)))
      })
      return () => { active = false }
    }
    if (previewKind === 'source') {
      void blob.text().then((text) => {
        if (active) setSource(text)
      })
    }
    return () => { active = false }
  }, [blob, mime, previewKind, reference])

  if (previewKind === 'pdf' && blob !== undefined) return <PdfArtifactPreview reference={reference} blob={blob} />
  if (url !== null) return <div className="mlcc-visualization-generic"><img src={url} alt={safeName(reference.name)} /></div>
  if (html !== null) return <iframe className="mlcc-visualization-html" title={`${safeName(reference.name)} HTML 预览`} sandbox="" srcDoc={html} />
  if (office !== null) return <div className="mlcc-visualization-office"><OfficeArtifactPreview reference={reference} document={office} /></div>
  if (rows !== null) return <div className="mlcc-visualization-table-wrap"><table className="mlcc-visualization-table" aria-label={safeName(reference.name)}><tbody>{rows.rows.map((row, rowIndex) => <tr key={`row-${rowIndex}`}>{row.map((cell, cellIndex) => <td key={`cell-${rowIndex}-${cellIndex}`}>{cell}</td>)}</tr>)}</tbody></table>{rows.truncated ? <p>预览已限制为前 100 行、50 列。</p> : null}</div>
  if (source !== null && (['text/markdown','text/x-markdown'].includes(baseMime(mime)) || /\.(md|markdown)$/i.test(reference.name)))
    return <div className="md-document"><article className="rich-text" dangerouslySetInnerHTML={{__html: renderMarkdown(source)}} /></div>
  if (source !== null) return <pre className="mlcc-visualization-source"><code>{source}</code></pre>
  return <div className="mlcc-visualization-fallback"><p>{previewError ?? (previewKind === 'download' ? '该格式暂不支持内联预览。' : '预览内容正在准备。')}</p></div>
}

function ArtifactPreviewIsland({ artifact, apiBase, onClose, onAuthExpired }) {
  const reference = React.useMemo(() => artifactReference(artifact), [artifact?.id, artifact?.mimeType, artifact?.name])
  const api = useArtifactApi({ artifact, apiBase, onAuthExpired })
  const [retryGeneration, setRetryGeneration] = React.useState(0)
  const [blob, setBlob] = React.useState(null)
  const [loadState, setLoadState] = React.useState('loading')
  const [error, setError] = React.useState(null)
  const [fullscreen, setFullscreen] = React.useState(false)
  const panelRef = React.useRef(null)
  const kind = isDerivedVisualizationCandidate(reference)
    ? 'derived'
    : scientificStructureArtifactFormat(reference.name) !== null
      ? 'structure'
      : 'generic'
  const genericKind = kind === 'generic' ? genericPreviewKind(reference) : null

  React.useEffect(() => {
    if (kind === 'derived') {
      setLoadState('ready')
      setBlob(null)
      setError(null)
      return undefined
    }
    if (kind === 'generic' && genericKind === 'download') {
      // Unknown formats stay lazy. The native download link below points at
      // the authenticated artifact endpoint and lets the browser stream it.
      setLoadState('ready')
      setBlob(undefined)
      setError(null)
      return undefined
    }
    const controller = new AbortController()
    let active = true
    setLoadState('loading')
    setBlob(null)
    setError(null)
    const maximumBytes = kind === 'structure'
      ? MAX_STRUCTURE_BYTES
      : previewBudget(genericKind)
    const tooLargeMessage = kind === 'structure'
      ? '结构文件超过 10 MiB，无法预览。'
      : previewLimitMessage(genericKind)
    api.loadPreviewArtifact(reference, controller.signal, maximumBytes, tooLargeMessage).then((nextBlob) => {
      if (!active) return
      setBlob(nextBlob)
      setLoadState('ready')
    }).catch((cause) => {
      if (!active || controller.signal.aborted) return
      setLoadState('error')
      setError(cause instanceof Error ? cause.message : '结果文件无法读取。')
    })
    return () => {
      active = false
      controller.abort()
    }
  }, [api, genericKind, kind, reference, retryGeneration])

  React.useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && fullscreen) setFullscreen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [fullscreen])

  const retry = () => setRetryGeneration((current) => current + 1)
  const title = safeName(reference.name)
  return <section ref={panelRef} className={`mlcc-visualization-panel${fullscreen ? ' is-fullscreen' : ''}`} aria-label={`${title} 可视化预览`}>
    <header className="mlcc-visualization-header">
      <div className="mlcc-visualization-heading">
        <span className="mlcc-visualization-kicker">结果预览</span>
        <h2>{title}</h2>
        <small>{artifactMetaLabel(reference, artifact?.size ?? artifact?.sizeBytes)}</small>
      </div>
      <div className="mlcc-visualization-actions">
        <button type="button" onClick={() => setFullscreen((current) => !current)}>{fullscreen ? '退出全屏' : '全屏'}</button>
        <button type="button" onClick={onClose}>关闭</button>
      </div>
    </header>
    <div className="mlcc-visualization-body">
      {loadState === 'loading' ? <div className="mlcc-visualization-state" role="status">正在读取结果…</div> : null}
      {loadState === 'error' ? <Fallback message={error ?? '结果文件无法读取。'} retry={retry} reference={reference} downloadHref={api.downloadHref} /> : null}
      {loadState === 'ready' && kind === 'derived' ? (
        <DerivedVisualizationPreview
          key={`${reference.runId}-${retryGeneration}`}
          scopeKey={`mlcc-artifact-${reference.runId}`}
          reference={reference}
          loadManifest={api.loadManifest}
          loadResource={api.loadResource}
          retryGeneration={retryGeneration}
          fallback={() => <Fallback message="科学可视化暂不可用。" retry={retry} reference={reference} downloadHref={api.downloadHref} />}
        />
      ) : null}
      {loadState === 'ready' && kind === 'structure' && blob !== null ? (
        <AtomicStructurePreview
          key={`${reference.runId}-${retryGeneration}`}
          reference={reference}
          blob={blob}
          loadArtifact={api.loadArtifact}
          isCurrent={() => true}
          showDownload={false}
          downloadHref={api.downloadHref}
        />
      ) : null}
      {loadState === 'ready' && kind === 'generic' && blob !== null ? <GenericPreview reference={reference} blob={blob} /> : null}
    </div>
    {loadState === 'ready' ? <footer className="mlcc-visualization-footer"><DownloadButton reference={reference} downloadHref={api.downloadHref} /></footer> : null}
  </section>
}

/** Mount one independent MLCC artifact into a host-owned result pane. */
export function mountArtifactPreview(container, { artifact, apiBase = '/api', onClose, onAuthExpired } = {}) {
  if (!(container instanceof HTMLElement)) throw new TypeError('mountArtifactPreview requires an HTMLElement')
  if (!artifact || typeof artifact.id !== 'string' || artifact.id.length === 0) throw new TypeError('artifact.id is required')
  const root = createRoot(container)
  root.render(<ArtifactPreviewIsland artifact={artifact} apiBase={apiBase} onClose={onClose} onAuthExpired={onAuthExpired} />)
  return {
    destroy() {
      root.unmount()
      container.replaceChildren()
    },
  }
}
