import React from 'react'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { destroyPdfLoadingTask } from './preview-utils.mjs'

const MIN_SCALE = 0.75
const MAX_SCALE = 2.5
const SCALE_STEP = 0.25

function pdfAssetDirectory(directory) {
  const base = typeof import.meta.env?.BASE_URL === 'string' ? import.meta.env.BASE_URL : '/'
  return `${base.replace(/\/+$/, '')}/pdfjs/${directory}/`
}

function boundedScale(value) {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, Number(value.toFixed(2))))
}

function errorMessage(cause) {
  if (cause?.name === 'RenderingCancelledException') return null
  if (cause instanceof Error && cause.message.trim() !== '') return cause.message
  return 'PDF 无法预览，请下载原始文件。'
}

/**
 * Render PDFs into a canvas so the in-app browser does not depend on its
 * native PDF plug-in. pdf.js and its worker are loaded only when a PDF is
 * selected; all page and render tasks are cancelled on replacement/unmount.
 */
export function PdfArtifactPreview({ reference, blob }) {
  const canvasRef = React.useRef(null)
  const loadingTaskRef = React.useRef(null)
  const renderTaskRef = React.useRef(null)
  const [pdfDocument, setPdfDocument] = React.useState(null)
  const [pageCount, setPageCount] = React.useState(0)
  const [pageNumber, setPageNumber] = React.useState(1)
  const [scale, setScale] = React.useState(1)
  const [status, setStatus] = React.useState('loading')
  const [error, setError] = React.useState(null)
  const safeTitle = String(reference?.name ?? 'PDF')

  React.useEffect(() => {
    let active = true
    let ownedLoadingTask = null
    let loadingTaskDestroyed = false
    const destroyOwnedLoadingTask = () => {
      if (loadingTaskDestroyed) return
      loadingTaskDestroyed = true
      if (loadingTaskRef.current === ownedLoadingTask) loadingTaskRef.current = null
      destroyPdfLoadingTask(ownedLoadingTask)
    }
    setPdfDocument(null)
    setPageCount(0)
    setPageNumber(1)
    setScale(1)
    setStatus('loading')
    setError(null)

    const load = async () => {
      try {
        const pdfjs = await import('pdfjs-dist')
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
        const bytes = new Uint8Array(await blob.arrayBuffer())
        if (!active) return
        const loadingTask = pdfjs.getDocument({
          data: bytes,
          useWorkerFetch: false,
          isEvalSupported: false,
          cMapUrl: pdfAssetDirectory('cmaps'),
          cMapPacked: true,
          standardFontDataUrl: pdfAssetDirectory('standard_fonts'),
          wasmUrl: pdfAssetDirectory('wasm'),
        })
        ownedLoadingTask = loadingTask
        loadingTaskRef.current = loadingTask
        const document = await loadingTask.promise
        if (!active) {
          destroyOwnedLoadingTask()
          return
        }
        setPdfDocument(document)
        setPageCount(document.numPages)
        setStatus('ready')
      } catch (cause) {
        if (!active) return
        setStatus('error')
        setError(errorMessage(cause) ?? 'PDF 渲染已取消。')
      }
    }
    void load()

    return () => {
      active = false
      renderTaskRef.current?.cancel()
      renderTaskRef.current = null
      destroyOwnedLoadingTask()
    }
  }, [blob])

  React.useEffect(() => {
    let active = true
    const document = pdfDocument
    const canvas = canvasRef.current
    if (document === null || canvas === null) return () => { active = false }
    let renderTask = null
    const renderPage = async () => {
      setStatus('rendering')
      try {
        const page = await document.getPage(pageNumber)
        if (!active) return
        const viewport = page.getViewport({ scale })
        const deviceScale = Math.min(2, Math.max(1, Number(window.devicePixelRatio) || 1))
        canvas.width = Math.ceil(viewport.width * deviceScale)
        canvas.height = Math.ceil(viewport.height * deviceScale)
        canvas.style.width = `${Math.ceil(viewport.width)}px`
        canvas.style.height = `${Math.ceil(viewport.height)}px`
        const context = canvas.getContext('2d', { alpha: false })
        if (context === null) throw new Error('当前浏览器不支持 PDF 画布。')
        renderTask = page.render({
          canvasContext: context,
          viewport,
          transform: deviceScale === 1 ? undefined : [deviceScale, 0, 0, deviceScale, 0, 0],
        })
        renderTaskRef.current = renderTask
        await renderTask.promise
        if (active) setStatus('ready')
        page.cleanup()
      } catch (cause) {
        const message = errorMessage(cause)
        if (active && message !== null) {
          setStatus('error')
          setError(message)
        }
      } finally {
        if (renderTaskRef.current === renderTask) renderTaskRef.current = null
      }
    }
    void renderPage()
    return () => {
      active = false
      renderTask?.cancel()
      if (renderTaskRef.current === renderTask) renderTaskRef.current = null
    }
  }, [pageNumber, pdfDocument, scale])

  const movePage = (delta) => setPageNumber((current) => Math.max(1, Math.min(pageCount, current + delta)))
  const changeScale = (delta) => setScale((current) => boundedScale(current + delta))

  return <section className="mlcc-pdf-preview" aria-label={`${safeTitle} PDF 预览`}>
    <div className="mlcc-pdf-toolbar" role="toolbar" aria-label="PDF 阅读工具">
      <button type="button" onClick={() => movePage(-1)} disabled={pageNumber <= 1 || pageCount === 0}>上一页</button>
      <span aria-live="polite">第 {pageCount === 0 ? '—' : pageNumber} / {pageCount || '—'} 页</span>
      <button type="button" onClick={() => movePage(1)} disabled={pageNumber >= pageCount || pageCount === 0}>下一页</button>
      <span className="mlcc-pdf-toolbar-divider" aria-hidden="true" />
      <button type="button" onClick={() => changeScale(-SCALE_STEP)} disabled={scale <= MIN_SCALE}>缩小</button>
      <span aria-label="当前缩放比例">{Math.round(scale * 100)}%</span>
      <button type="button" onClick={() => changeScale(SCALE_STEP)} disabled={scale >= MAX_SCALE}>放大</button>
    </div>
    {status === 'loading' ? <p className="mlcc-pdf-state" role="status">正在解析 PDF…</p> : null}
    {status === 'error' ? <div className="mlcc-pdf-state" role="alert"><p>{error ?? 'PDF 无法预览，请下载原始文件。'}</p></div> : null}
    <div className="mlcc-pdf-canvas-wrap" hidden={status === 'loading' || status === 'error'}>
      <canvas ref={canvasRef} aria-label={`${safeTitle} 第 ${pageNumber} 页`} />
    </div>
  </section>
}
