const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace'
const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/'
const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink'
const MAX_SVG_ELEMENTS = 10_000
const MAX_SVG_ATTRIBUTES = 50_000
const MAX_SVG_ATTRIBUTE_CHARS = 1_000_000
const MAX_SVG_DEPTH = 64

const SAFE_SVG_ELEMENTS = new Set([
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'defs', 'clippath', 'mask', 'lineargradient', 'radialgradient',
  'stop', 'pattern', 'marker', 'title', 'desc', 'symbol', 'style', 'use',
])

const ATOMIC_USE_TARGETS = new Set([
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text',
])

// These properties affect only SVG paint, geometry, and text presentation.
// Layout, content generation, external resources, and browser behavior are
// deliberately excluded even when a browser would accept them in an SVG.
const SAFE_PRESENTATION_PROPERTIES = new Set([
  'alignment-baseline',
  'baseline-shift',
  'clip-path',
  'clip-rule',
  'color',
  'color-interpolation',
  'color-interpolation-filters',
  'color-rendering',
  'dominant-baseline',
  'fill',
  'fill-opacity',
  'fill-rule',
  'flood-color',
  'flood-opacity',
  'font',
  'font-family',
  'font-size',
  'font-size-adjust',
  'font-stretch',
  'font-style',
  'font-variant',
  'font-weight',
  'glyph-orientation-horizontal',
  'glyph-orientation-vertical',
  'image-rendering',
  'kerning',
  'letter-spacing',
  'lighting-color',
  'marker-end',
  'marker-mid',
  'marker-start',
  'opacity',
  'paint-order',
  'shape-rendering',
  'stop-color',
  'stop-opacity',
  'stroke',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-opacity',
  'stroke-width',
  'text-anchor',
  'text-decoration',
  'text-rendering',
  'vector-effect',
  'visibility',
  'word-spacing',
])

const SAFE_FRAGMENT = /^[A-Za-z_][A-Za-z0-9_.:-]*$/
const SAFE_SELECTOR_TOKEN = /^(?:\*|[A-Za-z_][A-Za-z0-9_.-]*|[.#][A-Za-z_][A-Za-z0-9_.-]*)$/
const LOCAL_URL = /url\s*\(\s*(?:(['"])\s*#([A-Za-z_][A-Za-z0-9_.:-]*)\s*\1|#([A-Za-z_][A-Za-z0-9_.:-]*))\s*\)/gi

function stripStandardSvgDoctype(source: string): string | null {
  if (/<!\s*ENTITY\b/i.test(source)) return null
  const matches = [...source.matchAll(/<!\s*DOCTYPE[\s\S]*?>/gi)]
  if (matches.length === 0) return source
  if (matches.length !== 1) return null
  const match = matches[0]
  if (match === undefined || !/^<!\s*DOCTYPE\s+svg\s+PUBLIC\s+["']-\/\/W3C\/\/DTD SVG 1\.1\/\/EN["']\s+["']https?:\/\/www\.w3\.org\/Graphics\/SVG\/1\.1\/DTD\/svg11\.dtd["']\s*>$/i.test(match[0])) {
    return null
  }
  return source.slice(0, match.index) + source.slice(match.index + match[0].length)
}

function splitCssDeclarations(source: string): string[] | null {
  const declarations: string[] = []
  let start = 0
  let parentheses = 0
  let quote: '"' | "'" | null = null
  let escaped = false

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? ''
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (quote !== null) {
      if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '(') {
      parentheses += 1
      continue
    }
    if (character === ')') {
      parentheses -= 1
      if (parentheses < 0) return null
      continue
    }
    if (parentheses === 0 && (character === '{' || character === '}')) return null
    if (parentheses === 0 && character === ';') {
      declarations.push(source.slice(start, index))
      start = index + 1
    }
  }
  if (quote !== null || escaped || parentheses !== 0) return null
  declarations.push(source.slice(start))
  return declarations
}

function findDeclarationColon(source: string): number {
  let parentheses = 0
  let quote: '"' | "'" | null = null
  let escaped = false
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? ''
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (quote !== null) {
      if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '(') {
      parentheses += 1
      continue
    }
    if (character === ')') {
      parentheses -= 1
      continue
    }
    if (character === ':' && parentheses === 0) return index
  }
  return -1
}

function sanitizeCssValue(value: string): string | null {
  const trimmed = value.trim()
  if (
    trimmed.length === 0
    || trimmed.includes('\\')
    || trimmed.includes('/*')
    || trimmed.includes('*/')
    || /[<>\u0000-\u001f\u007f]/.test(trimmed)
    || /(?:expression\s*\(|javascript\s*:|vbscript\s*:|data\s*:|https?\s*:|\/\/|@import|@font-face)/i.test(trimmed)
  ) return null
  const normalized = trimmed.replace(LOCAL_URL, (_match, _quote, quotedId, plainId) => `url(#${quotedId ?? plainId})`)
  const withoutLocalUrls = normalized.replace(/url\s*\(\s*#[A-Za-z_][A-Za-z0-9_.:-]*\s*\)/gi, '')
  if (/url\s*\(/i.test(withoutLocalUrls)) return null
  return normalized
}

function sanitizeCssDeclarations(source: string): string | null {
  const declarations = splitCssDeclarations(source)
  if (declarations === null) return null
  const safe: string[] = []
  for (const declaration of declarations) {
    if (declaration.trim().length === 0) continue
    const colon = findDeclarationColon(declaration)
    if (colon < 0) continue
    const property = declaration.slice(0, colon).trim().toLowerCase()
    if (!SAFE_PRESENTATION_PROPERTIES.has(property)) continue
    const value = sanitizeCssValue(declaration.slice(colon + 1))
    if (value !== null) safe.push(`${property}: ${value}`)
  }
  return safe.join('; ')
}

function removeCssComments(source: string): string | null {
  let result = ''
  let cursor = 0
  while (cursor < source.length) {
    const start = source.indexOf('/*', cursor)
    if (start < 0) {
      result += source.slice(cursor)
      break
    }
    result += source.slice(cursor, start)
    const end = source.indexOf('*/', start + 2)
    if (end < 0) return null
    result += ' '
    cursor = end + 2
  }
  return result
}

function safeSvgSelector(source: string): string | null {
  const selectors = source.split(',').map((selector) => selector.trim()).filter(Boolean)
  if (selectors.length === 0) return null
  for (const selector of selectors) {
    const tokens = selector.split(/\s+/).filter(Boolean)
    if (tokens.length === 0 || tokens.some((token) => !SAFE_SELECTOR_TOKEN.test(token))) return null
  }
  return selectors.join(', ')
}

function findCssBlockEnd(source: string, openingBrace: number): number | null {
  let parentheses = 0
  let quote: '"' | "'" | null = null
  let escaped = false
  for (let index = openingBrace + 1; index < source.length; index += 1) {
    const character = source[index] ?? ''
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (quote !== null) {
      if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '(') {
      parentheses += 1
      continue
    }
    if (character === ')') {
      parentheses -= 1
      if (parentheses < 0) return null
      continue
    }
    if (parentheses === 0 && character === '{') return null
    if (parentheses === 0 && character === '}') return index
  }
  return null
}

function sanitizeSvgStyleSheet(source: string): string | null {
  const withoutComments = removeCssComments(source)
  if (withoutComments === null || /@/u.test(withoutComments)) return null
  const rules: string[] = []
  let cursor = 0
  while (cursor < withoutComments.length) {
    while (/\s/u.test(withoutComments[cursor] ?? '')) cursor += 1
    if (cursor >= withoutComments.length) break
    const openingBrace = withoutComments.indexOf('{', cursor)
    if (openingBrace < 0) return null
    const selector = safeSvgSelector(withoutComments.slice(cursor, openingBrace))
    const closingBrace = findCssBlockEnd(withoutComments, openingBrace)
    if (closingBrace === null) return null
    const declarations = sanitizeCssDeclarations(withoutComments.slice(openingBrace + 1, closingBrace))
    if (selector !== null && declarations !== null && declarations.length > 0) {
      rules.push(`${selector}{${declarations}}`)
    }
    cursor = closingBrace + 1
  }
  return rules.join('')
}

function fragmentFrom(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed.startsWith('#')) return null
  const fragment = trimmed.slice(1)
  return SAFE_FRAGMENT.test(fragment) ? fragment : null
}

function sanitizeAttributes(element: Element): void {
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase()
    const value = attribute.value.trim()
    const isHref = name === 'href' || name === 'xlink:href'
    if (
      name.startsWith('on')
      || name === 'src'
      || name === 'xml:base'
      || attribute.namespaceURI === XML_NAMESPACE
      || (attribute.namespaceURI !== null
        && attribute.namespaceURI !== XMLNS_NAMESPACE
        && attribute.namespaceURI !== XLINK_NAMESPACE)
      || (isHref && fragmentFrom(value) === null)
    ) {
      element.removeAttribute(attribute.name)
      continue
    }
    if (name === 'style') {
      const sanitized = sanitizeCssDeclarations(value)
      if (sanitized === null || sanitized.length === 0) element.removeAttribute(attribute.name)
      else element.setAttribute(attribute.name, sanitized)
      continue
    }
    if (SAFE_PRESENTATION_PROPERTIES.has(name)
      || name === 'filter' || name === 'mask' || name === 'cursor'
      || /url\s*\(/i.test(value)) {
      const sanitizedUrlValue = sanitizeCssValue(value)
      if (sanitizedUrlValue === null) element.removeAttribute(attribute.name)
      else element.setAttribute(attribute.name, sanitizedUrlValue)
    }
  }
}

function sanitizeUse(element: Element, document: Document): void {
  const hrefAttributes = Array.from(element.attributes).filter((attribute) => {
    const name = attribute.name.toLowerCase()
    return name === 'href' || (name === 'xlink:href' && attribute.namespaceURI === XLINK_NAMESPACE)
  })
  const href = hrefAttributes[0]
  const fragment = href === undefined ? null : fragmentFrom(href.value)
  const target = fragment === null ? null : document.getElementById(fragment)
  if (
    fragment === null
    || target === null
    || target.namespaceURI !== SVG_NAMESPACE
    || !ATOMIC_USE_TARGETS.has(target.localName.toLowerCase())
    || target === element
    || target.contains(element)
    || target.querySelector('*') !== null
  ) {
    element.remove()
    return
  }
  for (const attribute of hrefAttributes) element.removeAttribute(attribute.name)
  // href is the SVG 2 spelling and is understood by current Chromium,
  // Firefox, and WebKit image viewers. The source xlink namespace remains on
  // the root when the original file declares it, but is not needed for output.
  element.setAttribute('href', `#${fragment}`)
}

/**
 * Returns a static, bounded SVG source suitable for an inert object URL, or
 * null when the source cannot be reduced to the allowlisted SVG subset.
 */
export function sanitizeSvgSource(source: string): string | null {
  const sourceWithoutDoctype = stripStandardSvgDoctype(source)
  if (sourceWithoutDoctype === null) return null
  if (typeof window === 'undefined' || typeof window.DOMParser !== 'function' || typeof window.XMLSerializer !== 'function') return null

  const document = new window.DOMParser().parseFromString(sourceWithoutDoctype, 'image/svg+xml')
  const root = document.documentElement
  if (
    document.getElementsByTagName('parsererror').length > 0
    || root.localName.toLowerCase() !== 'svg'
    || root.namespaceURI !== SVG_NAMESPACE
  ) return null

  const elements = [root, ...Array.from(root.querySelectorAll('*'))]
  if (elements.length > MAX_SVG_ELEMENTS) return null
  let attributeCount = 0
  let attributeCharacters = 0
  for (const element of elements) {
    attributeCount += element.attributes.length
    attributeCharacters += Array.from(element.attributes)
      .reduce((total, attribute) => total + attribute.name.length + attribute.value.length, 0)
    let depth = 1
    for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) depth += 1
    if (
      attributeCount > MAX_SVG_ATTRIBUTES
      || attributeCharacters > MAX_SVG_ATTRIBUTE_CHARS
      || depth > MAX_SVG_DEPTH
    ) return null
  }
  for (const element of elements) {
    if (element.namespaceURI !== SVG_NAMESPACE) element.remove()
  }
  for (const element of [...elements].reverse()) {
    if (!element.isConnected) continue
    const localName = element.localName.toLowerCase()
    if (!SAFE_SVG_ELEMENTS.has(localName)) {
      element.remove()
      continue
    }
    if (localName === 'style') {
      sanitizeAttributes(element)
      const styleSource = Array.from(element.childNodes)
        .filter((child) => child.nodeType === 3 || child.nodeType === 4)
        .map((child) => child.nodeValue ?? '')
        .join('')
      const sanitizedStyle = sanitizeSvgStyleSheet(styleSource)
      if (sanitizedStyle === null || sanitizedStyle.length === 0) element.remove()
      else element.textContent = sanitizedStyle
      continue
    }
    sanitizeAttributes(element)
  }
  for (const element of [...elements].reverse()) {
    if (!element.isConnected) continue
    if (element.localName.toLowerCase() === 'use') sanitizeUse(element, document)
  }

  const stack: Element[] = [root]
  while (stack.length > 0) {
    const element = stack.pop()
    if (element === undefined || !element.isConnected) continue
    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType === 1) stack.push(child as Element)
      else if (child.nodeType !== 3) child.remove()
    }
  }
  return new window.XMLSerializer().serializeToString(root)
}
