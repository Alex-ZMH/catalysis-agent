import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchPapers, readPaper, writeResearchReport } from './literature.mjs'

test('search survives one unavailable index and returns matching bibliographic records',async()=>{
  const get=async url=>{
    if(url.includes('openalex'))throw Error('unavailable')
    assert.match(decodeURIComponent(url),/basal activity/)
    return {message:{items:[{title:['Comparison of basal planes'],DOI:'10.1234/A',published:{'date-parts':[[2024]]}}]}}
  }
  const result=await searchPapers({query:'basal activity'},undefined,get)
  assert.deepEqual(result.indexes,['Crossref'])
  assert.equal(result.papers[0].doi,'10.1234/a')
})
test('full-text passages are taken from PMC and abstracts remain labelled when full text is unavailable',async()=>{
  const get=async url=>{
    if(url.includes('crossref'))return {message:{title:['Experimental comparison'],abstract:'Publisher abstract'}}
    if(url.includes('openalex'))return {}
    if(url.includes('europepmc'))return {resultList:{result:[{doi:'10.1234/a',pmcid:'PMC10000'}]}}
    return [{documents:[{passages:[{infons:{section_type:'RESULTS'},text:'Hydrogen coverage changed the measured adsorption response.'}]}]}]
  }
  const result=await readPaper({doi:'10.1234/a',terms:['coverage']},undefined,get)
  assert.equal(result.access,'full_text_passages')
  assert.match(result.passages[0].text,/coverage/)
  const partial=await readPaper({doi:'10.1234/a'},undefined,url=>url.includes('ncbi.nlm')?Promise.reject(Error('unavailable')):get(url))
  assert.equal(partial.access,'abstract')
  assert.deepEqual(partial.passages,[])
})
test('generated reports are independent files and cannot write outside the chat',async t=>{
  const root=await mkdtemp(join(tmpdir(),'research-report-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const args={filename:'物相比较.md',markdown:'# 本次分析'}
  const a=await writeResearchReport(root,args),b=await writeResearchReport(root,args)
  assert.notEqual(a,b)
  assert.equal(await readFile(join(root,a),'utf8'),'# 本次分析\n')
  await assert.rejects(writeResearchReport(root,{...args,filename:'../物相比较.md'}))
})

test('full-text search relaxes an empty filter and surfaces original quantitative passages',async()=>{
  const {searchFullText}=await import('./literature.mjs')
  const calls=[]
  const get=async url=>{
    const u=new URL(url);calls.push(u)
    if(u.hostname==='www.ebi.ac.uk')return {resultList:{result:u.searchParams.get('query').includes('rare term')?[]:[{doi:'10.1234/expt',title:'Example',pmcid:'PMC123'}]}}
    return [{documents:[{passages:[{infons:{section_type:'RESULTS'},text:'In the coverage study the adsorption energy changed from 0.1 eV to 0.2 eV.'}]}]}]
  }
  const result=await searchFullText({concepts:[['material'],['coverage'],['rare term']],terms:['adsorption'],unit:'eV'},undefined,get)
  assert.equal(result.readable,1)
  assert.match(result.papers[0].passages[0].text,/0.1 eV/)
  assert.equal(calls.filter(u=>u.hostname==='www.ebi.ac.uk').length,2)
})

test('polymorph discovery preserves multiplicity of prime marks and searches chemical subscript variants',async()=>{
  const {searchPhases}=await import('./phase-literature.mjs')
  const queries=[]
  const get=async url=>{
    queries.push(new URL(url).searchParams.get('query'))
    return {resultList:{result:[
      {doi:'10.1234/single',title:'Structure measurements',abstractText:'Monolayer 1T′-XS<sub>2</sub> grown for this study.'},
      {doi:'10.1234/double',title:'Isolation of thin crystals',abstractText:'A monolayer of 1Tʹʹ-XS₂ was isolated from 1T‴ crystals.'},
      {doi:'10.1234/triple',title:'Atomic structure',abstractText:"A thick 1T''' film."}]}}
  }
  const result=await searchPhases({formula:'XS₂',phases:['1T′','1T″','1T‴'],layered:true},undefined,get)
  assert.deepEqual(result.byPhase.map(x=>x.papers.map(p=>p.doi).sort()),[['10.1234/single'],['10.1234/double'],['10.1234/double','10.1234/triple']])
  assert.ok(queries.some(q=>q.includes('"XS"')&&q.includes('"XS2"')))
})

test('supplement excerpts preserve their publisher identifier and PDF page',async t=>{
  const {cachedSupplement}=await import('./phase-literature.mjs')
  const {writeFile}=await import('node:fs/promises')
  const {createHash}=await import('node:crypto')
  const {pathToFileURL}=await import('node:url')
  const root=await mkdtemp(join(tmpdir(),'published-source-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const doi='10.1234/material',id=createHash('sha256').update(doi).digest('hex')
  const text='Figure S7. Measured spectra for each phase, with the experimental resolution reported in the caption.'
  await writeFile(join(root,id+'.json'),JSON.stringify({paper:doi,files:[{doi:doi+'.s001',pages:['Contents',text]}]}))
  const docs=await cachedSupplement(doi,['spectra'],pathToFileURL(root+'/'))
  assert.equal(docs[0].passages[0].text,text);assert.equal(docs[0].passages[0].page,2)
})

test('account paper passages are ranked on demand and isolated from other accounts',async t=>{
  const {createHash}=await import('node:crypto'),{writeFile}=await import('node:fs/promises')
  const library=await mkdtemp(join(tmpdir(),'private-research-library-'))
  t.after(()=>rm(library,{recursive:true,force:true}))
  const doi='10.1234/private',name=createHash('sha256').update(doi).digest('hex')+'.json'
  const source='Site-specific binding was quantified at the basal plane of this sample.'
  await writeFile(join(library,name),JSON.stringify({doi,passages:[{infons:{section_type:'Original PDF · p3'},text:source}]}))
  const get=async url=>url.includes('crossref')?{message:{title:['Comparative study'],abstract:'Public abstract'}}:url.includes('europepmc')?{resultList:{result:[]}}:{}
  const args={doi,terms:['basal plane']}
  const found=await readPaper(args,undefined,get,library)
  assert.equal(found.access,'full_text_passages')
  assert.equal(found.passages[0].text,source)
  assert.match(found.passages[0].section,/p3$/)
  const other=await readPaper(args,undefined,get,join(library,'other-owner'))
  assert.equal(other.access,'abstract')
  assert.deepEqual(other.passages,[])
})
