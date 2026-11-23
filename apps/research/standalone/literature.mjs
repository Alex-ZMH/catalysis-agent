import {articleText,searchPhases,cachedSupplement} from './phase-literature.mjs'
import {createHash} from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const exec=promisify(execFile)
const field={type:'string'}
const schema=(name,description,properties,required)=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false}})
export const literatureTools=[
  schema('search_phase_evidence','Search title and abstract records for each requested crystal phase separately, across polymorph studies and newer publications. Use for any phase comparison. Supply the material formula and the actual candidate phase designations; aliases may include English material or constituent element names. Set layered for monolayer or 2D materials. Read the best-matched experimental papers and their supporting information before screening.',{formula:field,phases:{type:'array',items:field},aliases:{type:'array',items:field},layered:{type:'boolean'}},['formula','phases']),
  schema('search_papers','Search live Crossref and OpenAlex for scientific papers. Use focused English keywords or a paper title. Results are bibliographic leads. Read primary sources before drawing conclusions.',{query:field},['query']),
  schema('find_her_coverage_data','Search open primary papers for adsorption free energies at multiple hydrogen coverages for the supplied material, even when phase-specific keyword searches are sparse. Verify site, phase, reference and coverage in the returned passages; use the DOI and passage_id as evidence for each CHE calculation.',{formula:field,aliases:{type:'array',items:field,maxItems:3}},['formula']),
  schema('search_full_text','Find numerical evidence inside open primary papers. Supply 2–4 short English concepts (arrays of synonyms, broad material FIRST and the variable second); do not include whole questions. E.g. one concept may contain names for a material, another names for the independent variable. Use terms for passage ranking, and unit when looking for measured or computed quantities. Returns original passages that can be used as cited inputs.',{concepts:{type:'array',minItems:2,maxItems:4,items:{type:'array',minItems:1,maxItems:4,items:field}},terms:{type:'array',items:field,maxItems:8},unit:field},['concepts','terms']),
  schema('read_paper','Retrieve a DOI and matching original passages from the account’s paper library, PubMed Central and publisher supplements. Terms are English phrases or units used to rank passages. Try alternate terms or a different paper when evidence is insufficient.',{doi:field,terms:{type:'array',items:field,maxItems:8}},['doi']),
  schema('write_research_report','Create a new downloadable Markdown report authored in this turn. Supply the actual analysis, evidence tables, citations and limitations appropriate to the question. Use this for requested summaries or screening matrices.',{filename:field,markdown:field},['filename','markdown']),
]
const clean=articleText
export const searchPhaseEvidence=(args,signal)=>searchPhases(args,signal,jsonGet)
export function normalizeDoi(raw){
  const doi=String(raw??'').trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i,'').toLowerCase()
  if(!/^10\.\d{4,9}\/[a-z0-9._();:/+-]{1,180}$/i.test(doi))throw Error('Supply a valid journal DOI')
  return doi
}
async function jsonGet(address,signal){
  const {stdout}=await exec('curl',['-q','--fail','--silent','--show-error','--max-time','15','--compressed','--',address],{maxBuffer:8*1024*1024,timeout:16500,signal})
  return JSON.parse(stdout)
}
function searchHits(settled){
  return settled.flatMap(r=>r.status==='fulfilled'?r.value:[])
}
export async function searchPapers({query},signal,get=jsonGet){
  if(typeof query!=='string'||!query.trim()||query.length>320)throw Error('Use a brief paper title or search terms')
  const q=encodeURIComponent(query.trim())
  const [cr,oa]=await Promise.allSettled([
    get('https://api.crossref.org/works?rows=6&filter=type:journal-article&query.bibliographic='+q,signal).then(d=>d.message.items.map(x=>({title:clean(x.title?.[0]),doi:x.DOI,year:x.published?.['date-parts']?.[0]?.[0],journal:x['container-title']?.[0]}))),
    get('https://api.openalex.org/works?per_page=6&search='+q,signal).then(d=>d.results.filter(x=>x.doi).map(x=>({title:x.display_name,doi:x.doi,year:x.publication_year,journal:x.primary_location?.source?.display_name}))),
  ])
  if(cr.status==='rejected'&&oa.status==='rejected')throw Error('Bibliographic indexes unavailable. Retry or use a known DOI.')
  const seen=new Set(),hits=searchHits([cr,oa]).filter(x=>{
    try{x.doi=normalizeDoi(x.doi)}catch{return false}
    if(seen.has(x.doi))return false
    seen.add(x.doi);return true
  })
  return {query,indexes:[cr.status==='fulfilled'?'Crossref':'',oa.status==='fulfilled'?'OpenAlex':''].filter(Boolean),papers:hits}
}
export function rememberPaper(store,paper){
  for(const p of paper.passages)p.passage_id=createHash('sha256').update(p.text).digest('hex').slice(0,16)
  const prior=store.get(paper.doi)
  const passages=new Map([...(prior?.passages||[]),...paper.passages].map(p=>[p.passage_id,p]))
  store.set(paper.doi,{...paper,abstract:paper.abstract||prior?.abstract,passages:[...passages.values()]})
}
function abstractFromIndex(index){
  if(!index)return ''
  const words=[]
  for(const [word,positions] of Object.entries(index))for(const at of positions)if(at>=0&&at<2000)words[at]=word
  return words.join(' ').trim()
}
export function rankPassages(passages,terms=[]){
  const needles=terms.filter(x=>typeof x==='string'&&x.trim()).slice(0,8).map(s=>s.trim().toLowerCase())
  const eligible=passages.filter(p=>p.text?.length>35&&!['REF','AUTH_CONT','COMP_INT','SUPPL','ACK_FUND'].includes(p.infons?.section_type))
  const ranked=eligible.map((p,i)=>{
    const t=p.text.toLowerCase()
    const score=needles.reduce((n,k)=>n+(t.includes(k)?1:0),0)
    return {section:p.infons?.section_type||'Article',text:p.text,score,i}
  }).sort((a,b)=>b.score-a.score||a.i-b.i)
  return ranked.slice(0,7).map(({section,text})=>({section,text:text.slice(0,4700)}))
}
export async function readPaper({doi:raw,terms=[]},signal,get=jsonGet,library){
  const doi=normalizeDoi(raw),id=encodeURIComponent(doi)
  const [cross,alex,europe]=await Promise.allSettled([
    get('https://api.crossref.org/works/'+id,signal).then(d=>d.message),
    get('https://api.openalex.org/works/https://doi.org/'+id,signal),
    get('https://www.ebi.ac.uk/europepmc/webservices/rest/search?format=json&resultType=core&pageSize=2&query='+encodeURIComponent('DOI:"'+doi+'"'),signal).then(d=>d.resultList.result.find(x=>x.doi?.toLowerCase()===doi)),
  ])
  const c=cross.value||{},a=alex.value||{},e=europe.value||{}
  const title=clean(c.title?.[0]||a.display_name||e.title)
  if(!title)throw Error('No bibliographic record found for this DOI')
  const abstract=clean(c.abstract||e.abstractText||abstractFromIndex(a.abstract_inverted_index)).slice(0,6000)
  const pmcid=String(e.pmcid||a.ids?.pmcid||'').match(/PMC\d+$/i)?.[0]?.toUpperCase()
  const result={doi,title,url:'https://doi.org/'+doi,year:c.published?.['date-parts']?.[0]?.[0]||a.publication_year,access:abstract?'abstract':'metadata',abstract,passages:[]}
  if(pmcid){
    try {
      const article=await get('https://www.ncbi.nlm.nih.gov/research/bionlp/RESTful/pmcoa.cgi/BioC_json/'+pmcid+'/unicode',signal)
      const passages=article.flatMap(d=>d.documents||[]).flatMap(d=>d.passages||[])
      result.passages=rankPassages(passages,terms)
      if(result.passages.length){result.access='full_text_passages';result.fullTextUrl='https://pmc.ncbi.nlm.nih.gov/articles/'+pmcid+'/'}
    } catch(error){if(signal?.aborted)throw error;result.fullTextStatus='Full text unavailable from PMC'}
  }
  if(library){
    const key=createHash('sha256').update(doi).digest('hex')
    let article
    try{article=JSON.parse(await readFile(join(library,key+'.json'),'utf8'))}catch(error){if(error.code!=='ENOENT')throw error}
    if(article?.doi===doi && Array.isArray(article.passages)){
      const matches=rankPassages(article.passages,terms)
      if(matches.length){
        result.passages.unshift(...matches)
        result.access='full_text_passages'
        result.fullTextOrigin='account paper library · original PDF'
      }
    }
  }
  const supplements=await cachedSupplement(doi,terms)
  if(supplements.length){
    result.supplements=supplements.map(({passages,...meta})=>meta)
    result.passages.push(...supplements.flatMap(s=>s.passages).slice(0,12))
  }
  return result
}
export async function searchFullText({concepts,terms=[],unit=''},signal,get=jsonGet){
  if(!Array.isArray(concepts)||concepts.length<2||concepts.length>4)throw Error('Provide two to four groups of short search phrases')
  const groups=concepts.map(group=>{
    if(!Array.isArray(group)||!group.length||group.length>4)throw Error('Use one to four synonyms per concept')
    return group.map(t=>{
      if(typeof t!=='string'||!t.trim()||t.length>90||/["\\]/.test(t))throw Error('Use a short literal search term')
      return t.trim()
    })
  })
  const filters=groups.map(group=>'('+group.map(t=>'"'+t+'"').join(' OR ')+')')
  let candidates=[],query=''
  for(let count=filters.length;count>=2;count--){
    query=filters.slice(0,count).join(' AND ')+' AND OPEN_ACCESS:Y NOT PUB_TYPE:"Review"'
    const page=await get('https://www.ebi.ac.uk/europepmc/webservices/rest/search?'+new URLSearchParams({format:'json',query,sort:'CITED desc',pageSize:'20'}),signal)
    candidates=page.resultList.result.filter(r=>/^PMC\d+$/.test(r.pmcid)&&r.doi)
    if(candidates.length>=3||count===2)break
  }
  const needles=[...new Set([...terms,...groups.flat()].filter(x=>typeof x==='string'&&x.trim()).map(x=>x.toLowerCase().trim()))]
  const measure=String(unit).trim().toLowerCase()
  const collected=[]
  for(let i=0;i<candidates.length;i+=5){
    const batch=await Promise.allSettled(candidates.slice(i,i+5).map(async r=>{
      const article=await get('https://www.ncbi.nlm.nih.gov/research/bionlp/RESTful/pmcoa.cgi/BioC_json/'+r.pmcid+'/unicode',signal)
      const items=article.flatMap(d=>d.documents||[]).flatMap(d=>d.passages||[])
      const numeric=text=>(text.match(/[+−-]?\d+(?:\.\d+)?\s*[a-zµμ%]+/gi)||[]).filter(m=>measure&&m.toLowerCase().endsWith(measure)).length
      const passages=items.filter(p=>p.text?.length>45&&!['REF','AUTH_CONT','INTRO','COMP_INT','ACK_FUND'].includes(p.infons?.section_type)).map(p=>{
        const text=p.text.toLowerCase(),numbers=numeric(text)
        const matches=needles.filter(term=>text.includes(term)).length
        const score=matches+Math.min(3,numbers)*2+(['RESULTS','DISCUSS','FIG'].includes(p.infons?.section_type)?1:0)
        return {section:p.infons?.section_type||'Article',text:p.text.slice(0,5500),score}
      }).filter(p=>p.score>1).sort((a,b)=>b.score-a.score).slice(0,2)
      if(!passages.length)return null
      const doi=normalizeDoi(r.doi)
      return {doi,title:clean(r.title),access:'full_text_passages',url:'https://doi.org/'+doi,fullTextUrl:'https://pmc.ncbi.nlm.nih.gov/articles/'+r.pmcid+'/',passages}
    }))
    if(signal?.aborted)throw signal.reason
    collected.push(...batch.filter(x=>x.status==='fulfilled'&&x.value).map(x=>x.value))
  }
  const papers=collected.sort((a,b)=>b.passages[0].score-a.passages[0].score).slice(0,5)
  return {query,index:'Europe PMC / PMC BioC',candidates:candidates.length,readable:collected.length,papers}
}

export async function findHerCoverageData({formula,aliases=[]},signal,get=jsonGet){
  if(typeof formula!=='string'||!formula.trim()||!Array.isArray(aliases))throw Error('Supply a material formula')
  const materials=[formula.normalize('NFKC'),...aliases.slice(0,3)]
  const result=await searchFullText({concepts:[materials,['hydrogen coverage','H coverage']],terms:['coverage','adsorption','free energy'],unit:'eV'},signal,get)
  for(const paper of result.papers){
    for(const p of paper.passages){
      p.energies_eV=[...new Set([...p.text.normalize('NFKC').replaceAll('−','-').matchAll(/(?<![\d.+-])([+-]?\d+(?:\.\d+)?)\s*eV\b(?!\/)/gi)].map(m=>Number(m[1])))]
    }
  }
  return result
}
export async function writeResearchReport(workspace,{filename,markdown}){
  if(typeof filename!=='string'||!/^\p{L}[\p{L}\p{N} _().·′″‴-]{0,75}\.md$/u.test(filename))throw Error('Choose a short Markdown filename without a path')
  if(typeof markdown!=='string'||!markdown.trim()||Buffer.byteLength(markdown)>40000)throw Error('Report must contain 1–40000 bytes of Markdown')
  const dir=await mkdtemp(join(workspace,'report-'))
  await writeFile(join(dir,filename),markdown.trim()+'\n',{flag:'wx',mode:0o600})
  return dir.slice(workspace.length+1)+'/'+filename
}

export function csvCell(value){
  const s=String(value??'')
  return '"'+s.replaceAll('"','""')+'"'
}
export async function saveSearchRecord(workspace,entries){
  if(!entries.length)return
  const dir=await mkdtemp(join(workspace,'sources-'))
  const rows=[['utc','operation','query_or_terms','doi','title','access_or_indexes'],...entries]
  await writeFile(join(dir,'文献检索记录.csv'),rows.map(row=>row.map(v=>csvCell(/^[=+@-]/.test(v)?"'"+v:v)).join(',')).join('\n')+'\n',{flag:'wx',mode:0o600})
}
