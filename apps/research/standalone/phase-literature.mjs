import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'

export function articleText(value){
  return String(value??'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&')
    .replace(/<\/?(?:sub|sup|i|b|italic|bold)>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim()
}
export function normalizedPhase(value){
  return articleText(value).normalize('NFKC').toLowerCase().replace(/[′’ʹ‘]/g,"'").replace(/[“”"]/g,"''").replace(/[‐‑–—]/g,'-')
}
const literal=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
function phaseExpression(label){
  return new RegExp('(?<![a-z0-9])'+literal(normalizedPhase(label))+"(?![a-z0-9'])",'g')
}
function materialTerms(formula,aliases){
  const compact=formula.normalize('NFKC').trim()
  const terms=[compact,compact.replace(/\d+$/,''),...(aliases||[])]
  return [...new Set(terms.filter(s=>typeof s==='string'&&/^[\p{L}\p{N} -]{2,70}$/u.test(s)))]
}
export async function searchPhases({formula,phases,aliases=[],layered=false},signal,get){
  if(typeof formula!=='string'||!Array.isArray(aliases)||aliases.length>4||!Array.isArray(phases)||!phases.length||phases.length>12||phases.some(p=>typeof p!=='string'||!p.trim()||p.length>24))throw Error('Supply the chemical formula and one to twelve distinct phase designations')
  const terms=materialTerms(formula,aliases)
  if(!terms.length)throw Error('Supply a chemical formula')
  const material='('+terms.map(t=>'TITLE_ABS:"'+t+'"').join(' OR ')+')'
  const layer=layered?' AND (TITLE_ABS:monolayer OR TITLE_ABS:"single layer" OR TITLE_ABS:"two-dimensional")':''
  const roots=[...new Set(phases.map(p=>normalizedPhase(p).replace(/'+$/,'')).filter(s=>/^[a-z0-9-]{2,20}$/i.test(s)))]
  const families=['(TITLE_ABS:metastable OR TITLE_ABS:polymorph* OR TITLE_ABS:distorted OR TITLE_ABS:polytype*)',...roots.map(r=>'TITLE_ABS:"'+r+'"')]
  const queries=families.map(f=>material+' AND '+f+layer+' NOT PUB_TYPE:"Review"')
  const sets=await Promise.allSettled(queries.map(async query=>{
    const works=new Map()
    for(const sort of ['','FIRST_PDATE_D desc']){
      const params=new URLSearchParams({query,resultType:'core',format:'json',pageSize:'100'})
      if(sort)params.set('sort',sort)
      try{
        const data=await get('https://www.ebi.ac.uk/europepmc/webservices/rest/search?'+params,signal)
        for(const item of data.resultList.result)if(item.doi)works.set(item.doi.toLowerCase(),item)
      }catch(error){if(signal?.aborted||!sort)throw error}
    }
    return {query,works:[...works.values()]}
  }))
  if(signal?.aborted)throw signal.reason
  const successful=sets.filter(s=>s.status==='fulfilled').map(s=>s.value)
  if(!successful.length)throw Error('The phase literature index did not respond')
  const pool=new Map(successful.flatMap(s=>s.works.map(w=>[w.doi.toLowerCase(),w])))
  const byPhase=phases.map(phase=>{
    const pattern=phaseExpression(phase)
    const matches=[]
    for(const [doi,item] of pool){
      const title=articleText(item.title),abstract=articleText(item.abstractText),a=normalizedPhase(abstract)
      const hits=[...a.matchAll(pattern)],titleHits=[...normalizedPhase(title).matchAll(pattern)]
      if(!hits.length&&!titleHits.length)continue
      const pos=hits[0]?.index||0
      matches.push({doi,title,year:item.pubYear,excerpt:abstract.slice(Math.max(0,pos-100),pos+480),score:3*titleHits.length+Math.min(6,hits.length)+(layered&&/monolayer|single.layer/i.test(title)?2:0)})
    }
    matches.sort((a,b)=>b.score-a.score||Number(b.year)-Number(a.year))
    return {phase,total:matches.length,papers:matches.slice(0,7).map(({score,...item})=>item)}
  })
  return {queries:successful.map(s=>s.query),index:'Europe PMC · title/abstract · relevance and recent',candidates:pool.size,byPhase}
}

export async function cachedSupplement(doi,terms=[],library=new URL('./publisher-library/',import.meta.url)){
  const key=createHash('sha256').update(doi).digest('hex')
  let data
  try{data=JSON.parse(await readFile(new URL(key+'.json',library),'utf8'))}catch(error){if(error.code==='ENOENT')return [];throw error}
  if(data.paper!==doi)return []
  const needles=[...new Set(terms.map(x=>normalizedPhase(x)).filter(Boolean))]
  const found=[]
  for(const file of data.files){
    const sections=file.pages.flatMap((page,index)=>{
      const sections=page.trim().split(/\n\s*\n/).map(s=>s.trim()).filter(s=>s.length>=60)
      return sections.map(section=>{
        const text=section.replace(/\s*\n\s*/g,' '),match=normalizedPhase(text)
        const score=needles.reduce((n,t)=>n+(match.includes(t)?1:0),0)
        return {section:'Supporting information, PDF page '+(index+1),text:text.slice(0,5500),score,page:index+1,sourceDoi:file.doi}
      })
    }).sort((a,b)=>b.score-a.score||a.page-b.page)
    found.push({doi:file.doi,url:file.url,filename:file.filename,sha256:file.sha256,passages:sections.slice(0,9).map(({score,...p})=>p)})
  }
  return found
}
