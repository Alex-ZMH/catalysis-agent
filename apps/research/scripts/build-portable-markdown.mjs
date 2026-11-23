// Keep the file:// workbench usable without a package manager or a CDN.
import {build} from 'vite'
import {fileURLToPath} from 'node:url'
const path = name => fileURLToPath(new URL(name,import.meta.url))
await build({
  configFile: false,
  publicDir: false,
  build: {
    lib: {entry:path('../src/markdown.js'),name:'CatalysisMarkdown',formats:['iife'],fileName:()=>'markdown.js'},
    outDir:path('../../web/electrochem/vendor/'),emptyOutDir:false,
    target:'es2022', reportCompressedSize:false,
  },
})
