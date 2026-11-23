// Keep PDF decoding and fonts on the same origin, including CJK documents.
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const root = new URL('../', import.meta.url)
const destination = new URL('public/pdfjs/', root)
await mkdir(destination, { recursive: true })
for (const name of ['cmaps', 'standard_fonts', 'wasm']) {
  await cp(new URL(`node_modules/pdfjs-dist/${name}`, root), new URL(name, destination), { recursive: true, force: true })
}
await cp(new URL('node_modules/pdfjs-dist/LICENSE', root), new URL('LICENSE', destination))
console.log(`Prepared local PDF fonts and decoders in ${fileURLToPath(destination)}`)

await cp(new URL('../web/electrochem/',root),new URL('public/lab/',root),{recursive:true})
const labIndex = new URL('public/lab/index.html',root)
const labHtml = await readFile(labIndex,'utf8')
await writeFile(labIndex,labHtml.replace('</head>','<meta name="catalysis-research-studio" content="1"></head>'))
