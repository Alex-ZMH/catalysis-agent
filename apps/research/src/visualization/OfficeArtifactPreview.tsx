import * as React from 'react'
import { strFromU8, unzip } from 'fflate'
import type { ServerAgentArtifactReference } from './types'

void React

export const SERVER_AGENT_RESULTS_MAX_OFFICE_BYTES = 25 * 1024 * 1024
const MAX_OFFICE_XML_ENTRY_BYTES = 4 * 1024 * 1024
const MAX_OFFICE_XML_TOTAL_BYTES = 16 * 1024 * 1024
const MAX_POWERPOINT_SLIDES = 200
const MAX_OFFICE_TEXT_CHARS = 1_000_000
const MAX_OFFICE_ZIP_ENTRIES = 2_048
const MAX_OFFICE_CENTRAL_DIRECTORY_BYTES = 2 * 1024 * 1024
const MAX_OFFICE_ZIP_ENTRY_NAME_BYTES = 512
const MAX_OFFICE_XML_ELEMENTS = 20_000
const MAX_OFFICE_XML_ATTRIBUTES = 50_000
const MAX_OFFICE_XML_DEPTH = 64
const MAX_WORD_BLOCKS = 5_000
const MAX_WORD_TABLE_ROWS = 5_000
const MAX_WORD_TABLE_CELLS = 20_000
const MAX_POWERPOINT_TEXT_BLOCKS = 20_000

export class OfficePreviewError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OfficePreviewError'
  }
}

function fail(message: string): never {
  throw new OfficePreviewError(message)
}

export type WordPreviewBlock = Readonly<
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'table'; rows: readonly (readonly string[])[] }
>

export type OfficePreviewDocument = Readonly<
  | { kind: 'word'; blocks: readonly WordPreviewBlock[] }
  | { kind: 'powerpoint'; slides: readonly Readonly<{ texts: readonly string[] }>[] }
>

function publicName(reference: ServerAgentArtifactReference): string {
  const name = reference.name.replace(/[\\/\u0000-\u001f\u007f]/g, '_').trim()
  return name || '结果文件'
}

function localElements(parent: Element | Document, localName: string): Element[] {
  return Array.from(parent.getElementsByTagNameNS('*', localName))
}

function xmlDocument(source: string): Document {
  if (/<!\s*(?:doctype|entity)\b/i.test(source)) fail('Office XML 声明不安全。')
  const openingTag = /<(?![!?/])[^>]*>/g
  let tagCount = 0
  while (openingTag.exec(source) !== null) {
    tagCount += 1
    if (tagCount > MAX_OFFICE_XML_ELEMENTS) fail('Office XML 结构超过预览上限。')
  }
  if (typeof window === 'undefined' || typeof window.DOMParser !== 'function') {
    fail('当前环境无法解析 Office 文件。')
  }
  const document = new window.DOMParser().parseFromString(source, 'application/xml')
  if (document.getElementsByTagName('parsererror').length > 0) fail('Office XML 格式无效。')
  const root = document.documentElement
  const stack: Array<{ element: Element; depth: number }> = [{ element: root, depth: 1 }]
  let elements = 0
  let attributes = 0
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) break
    elements += 1
    attributes += current.element.attributes.length
    if (
      elements > MAX_OFFICE_XML_ELEMENTS
      || attributes > MAX_OFFICE_XML_ATTRIBUTES
      || current.depth > MAX_OFFICE_XML_DEPTH
    ) fail('Office XML 结构超过预览上限。')
    for (const child of Array.from(current.element.children)) {
      stack.push({ element: child, depth: current.depth + 1 })
    }
  }
  return document
}

function normalizedText(elements: readonly Element[]): string {
  return elements
    .map((element) => element.textContent ?? '')
    .join('')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

function paragraphText(paragraph: Element): string {
  return normalizedText(localElements(paragraph, 't'))
}

function headingLevel(paragraph: Element): number | null {
  const style = localElements(paragraph, 'pStyle')[0]
  const value = style?.getAttribute('w:val') ?? style?.getAttribute('val') ?? ''
  const match = value.match(/^Heading\s*([1-6])$/i)
  return match?.[1] === undefined ? null : Number(match[1])
}

function parseWord(source: string): OfficePreviewDocument {
  const document = xmlDocument(source)
  const body = localElements(document, 'body')[0]
  if (body === undefined) fail('Word 正文缺失。')
  const blocks: WordPreviewBlock[] = []
  let textCharacters = 0
  let tableRows = 0
  let tableCells = 0

  for (const child of Array.from(body.children)) {
    if (child.localName === 'p') {
      const text = paragraphText(child)
      if (!text) continue
      textCharacters += text.length
      if (textCharacters > MAX_OFFICE_TEXT_CHARS) fail('Word 文本超过预览上限。')
      const level = headingLevel(child)
      blocks.push(level === null ? { kind: 'paragraph', text } : { kind: 'heading', level, text })
      if (blocks.length > MAX_WORD_BLOCKS) fail('Word 内容结构超过预览上限。')
      continue
    }
    if (child.localName !== 'tbl') continue
    const rows = localElements(child, 'tr').map((row) => (
      localElements(row, 'tc').map((cell) => {
        tableCells += 1
        if (tableCells > MAX_WORD_TABLE_CELLS) fail('Word 表格结构超过预览上限。')
        const text = normalizedText(localElements(cell, 't'))
        textCharacters += text.length
        return text
      })
    ))
    tableRows += rows.length
    if (tableRows > MAX_WORD_TABLE_ROWS) fail('Word 表格结构超过预览上限。')
    if (textCharacters > MAX_OFFICE_TEXT_CHARS) fail('Word 文本超过预览上限。')
    if (rows.some((row) => row.some(Boolean))) blocks.push({ kind: 'table', rows })
    if (blocks.length > MAX_WORD_BLOCKS) fail('Word 内容结构超过预览上限。')
  }

  return {
    kind: 'word',
    blocks: blocks.length > 0 ? blocks : [{ kind: 'paragraph', text: '未读取到可显示的 Word 正文。' }],
  }
}

function slideNumber(path: string): number {
  const value = Number(path.match(/slide(\d+)\.xml$/i)?.[1])
  return Number.isSafeInteger(value) && value > 0 ? value : Number.MAX_SAFE_INTEGER
}

function parsePowerPoint(slideEntries: readonly Readonly<{ path: string; source: string }>[]): OfficePreviewDocument {
  let textCharacters = 0
  let textBlocks = 0
  const slides = [...slideEntries]
    .sort((left, right) => slideNumber(left.path) - slideNumber(right.path) || left.path.localeCompare(right.path))
    .map(({ source }) => {
      const document = xmlDocument(source)
      const texts = localElements(document, 'p')
        .map((paragraph) => normalizedText(localElements(paragraph, 't')))
        .filter(Boolean)
      textBlocks += texts.length
      if (textBlocks > MAX_POWERPOINT_TEXT_BLOCKS) fail('PowerPoint 内容结构超过预览上限。')
      textCharacters += texts.reduce((total, text) => total + text.length, 0)
      if (textCharacters > MAX_OFFICE_TEXT_CHARS) fail('PowerPoint 文本超过预览上限。')
      return { texts: texts.length > 0 ? texts : ['该页没有可提取的文本。'] }
    })
  if (slides.length === 0) fail('PowerPoint 幻灯片缺失。')
  return { kind: 'powerpoint', slides }
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8)
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0
}

function selectedOfficeEntry(kind: OfficePreviewDocument['kind'], name: string): boolean {
  return kind === 'word'
    ? name === 'word/document.xml'
    : /^ppt\/slides\/slide\d+\.xml$/i.test(name)
}

function inspectOfficeArchive(input: Uint8Array, kind: OfficePreviewDocument['kind']): void {
  const minimumEocdOffset = Math.max(0, input.length - 65_557)
  let eocdOffset = -1
  for (let offset = input.length - 22; offset >= minimumEocdOffset; offset -= 1) {
    if (readUint32(input, offset) !== 0x06054b50) continue
    const commentLength = readUint16(input, offset + 20)
    if (offset + 22 + commentLength === input.length) {
      eocdOffset = offset
      break
    }
  }
  if (eocdOffset < 0) fail('Office 文件损坏或格式不受支持。')
  const disk = readUint16(input, eocdOffset + 4)
  const centralDisk = readUint16(input, eocdOffset + 6)
  const diskEntries = readUint16(input, eocdOffset + 8)
  const entryCount = readUint16(input, eocdOffset + 10)
  const centralSize = readUint32(input, eocdOffset + 12)
  const centralOffset = readUint32(input, eocdOffset + 16)
  if (
    disk !== 0
    || centralDisk !== 0
    || diskEntries !== entryCount
    || entryCount === 0xffff
    || centralSize === 0xffffffff
    || centralOffset === 0xffffffff
    || entryCount > MAX_OFFICE_ZIP_ENTRIES
    || centralSize > MAX_OFFICE_CENTRAL_DIRECTORY_BYTES
  ) fail('Office 压缩包结构超过预览上限。')
  const centralEnd = centralOffset + centralSize
  if (!Number.isSafeInteger(centralEnd) || centralEnd > eocdOffset || centralOffset > input.length) {
    fail('Office 文件损坏或格式不受支持。')
  }

  const selectedNames = new Set<string>()
  let selectedEntries = 0
  let selectedBytes = 0
  let offset = centralOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > centralEnd || readUint32(input, offset) !== 0x02014b50) {
      fail('Office 文件损坏或格式不受支持。')
    }
    const compressedSize = readUint32(input, offset + 20)
    const originalSize = readUint32(input, offset + 24)
    const nameLength = readUint16(input, offset + 28)
    const extraLength = readUint16(input, offset + 30)
    const commentLength = readUint16(input, offset + 32)
    if (
      compressedSize === 0xffffffff
      || originalSize === 0xffffffff
      || nameLength === 0
      || nameLength > MAX_OFFICE_ZIP_ENTRY_NAME_BYTES
    ) fail('Office 压缩包结构超过预览上限。')
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength
    if (nextOffset > centralEnd) fail('Office 文件损坏或格式不受支持。')
    const name = strFromU8(input.subarray(offset + 46, offset + 46 + nameLength))
    if (selectedOfficeEntry(kind, name)) {
      if (selectedNames.has(name)) fail('Office 压缩包包含重复的正文条目。')
      selectedNames.add(name)
      selectedEntries += 1
      if (kind === 'powerpoint' && selectedEntries > MAX_POWERPOINT_SLIDES) {
        fail('PowerPoint 页数超过预览上限。')
      }
      if (originalSize > MAX_OFFICE_XML_ENTRY_BYTES) fail('Office XML 条目超过预览上限。')
      selectedBytes += originalSize
      if (selectedBytes > MAX_OFFICE_XML_TOTAL_BYTES) fail('Office XML 总量超过预览上限。')
    }
    offset = nextOffset
  }
  if (offset !== centralEnd) fail('Office 文件损坏或格式不受支持。')
}

function officeKind(reference: ServerAgentArtifactReference): OfficePreviewDocument['kind'] | null {
  const mimeType = reference.mimeType.split(';', 1)[0]?.trim().toLowerCase()
  const name = publicName(reference).toLowerCase()
  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    || name.endsWith('.docx')
  ) return 'word'
  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    || name.endsWith('.pptx')
  ) return 'powerpoint'
  return null
}

export async function prepareOfficePreview(
  reference: ServerAgentArtifactReference,
  blob: Blob,
): Promise<OfficePreviewDocument> {
  if (blob.size > SERVER_AGENT_RESULTS_MAX_OFFICE_BYTES) fail('Office 文件超过 25 MiB，无法预览。')
  const kind = officeKind(reference)
  if (kind === null) fail('该 Office 文件格式暂不支持预览。')
  const input = new Uint8Array(await blob.arrayBuffer())
  inspectOfficeArchive(input, kind)
  let archive: Record<string, Uint8Array>
  try {
    archive = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
      unzip(input, { filter: (entry) => selectedOfficeEntry(kind, entry.name) }, (error, result) => {
        if (error) reject(error)
        else resolve(result)
      })
    })
  } catch (error) {
    if (error instanceof OfficePreviewError) throw error
    fail('Office 文件损坏或格式不受支持。')
  }
  if (kind === 'word') {
    const documentXml = archive['word/document.xml']
    if (documentXml === undefined) fail('Word 正文缺失。')
    return parseWord(strFromU8(documentXml))
  }
  return parsePowerPoint(Object.entries(archive).map(([path, bytes]) => ({ path, source: strFromU8(bytes) })))
}

function WordBlock({ block, tableIndex, name }: { block: WordPreviewBlock; tableIndex: number; name: string }) {
  if (block.kind === 'heading') {
    const Heading = (`h${Math.min(6, Math.max(3, block.level + 2))}`) as keyof React.JSX.IntrinsicElements
    return <Heading>{block.text}</Heading>
  }
  if (block.kind === 'paragraph') return <p>{block.text}</p>
  return (
    <div className="zeus-office-table-wrap">
      <table aria-label={`${name} 表格 ${tableIndex}`}>
        <tbody>
          {block.rows.map((row, rowIndex) => (
            <tr key={`row-${rowIndex}`}>
              {row.map((cell, cellIndex) => <td key={`cell-${rowIndex}-${cellIndex}`}>{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function OfficeArtifactPreview({
  reference,
  document,
}: {
  reference: ServerAgentArtifactReference
  document: OfficePreviewDocument
}) {
  const name = publicName(reference)
  if (document.kind === 'word') {
    let tableIndex = 0
    return (
      <article className="zeus-office-word-preview" aria-label={`${name} Word 预览`}>
        {document.blocks.map((block, index) => {
          if (block.kind === 'table') tableIndex += 1
          return <WordBlock block={block} tableIndex={tableIndex} name={name} key={`block-${index}`} />
        })}
        <p className="zeus-office-preview-note">已提取安全预览；复杂排版可能与 Word 略有差异。</p>
      </article>
    )
  }
  return (
    <section className="zeus-office-powerpoint-preview" aria-label={`${name} PowerPoint 预览`}>
      {document.slides.map((slide, index) => (
        <article className="zeus-office-slide" role="group" aria-label={`第 ${index + 1} 张幻灯片`} key={`slide-${index}`}>
          <header>幻灯片 {index + 1}</header>
          <div>
            {slide.texts.map((text, textIndex) => textIndex === 0
              ? <h4 key={`text-${textIndex}`}>{text}</h4>
              : <p key={`text-${textIndex}`}>{text}</p>)}
          </div>
        </article>
      ))}
      <p className="zeus-office-preview-note">已提取安全预览；动画、媒体和复杂版式未执行。</p>
    </section>
  )
}
