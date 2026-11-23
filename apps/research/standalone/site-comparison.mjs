import {mkdtemp,writeFile} from 'node:fs/promises'
import {join,basename} from 'node:path'
import {csvCell} from './literature.mjs'

const xml=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
const num=v=>Number(v.toFixed(6))
const signed=v=>(v>0?'+':'')+num(v).toFixed(3).replace('-','−')
const colors=['#167568','#ad531d','#355c94','#865084','#4f6f23','#9e4563','#306e89','#795c3b']
const cell=s=>csvCell(/^[=+@-]/.test(s)?"'"+s:s)

export async function writeSiteComparison(root,sites){
  const u=sites[0].potential
  const rows=[['位点','U_V_RHE','ΔG_H_0_eV','吸氢步骤_eV','产氢步骤_eV','限制电位_V_RHE','来源_DOI','输入依据']]
  const results=sites.map(({label,r,doi,quotes})=>{
    const adsorption=num(r.steps[0]), evolution=num(r.steps[1]), input=num(r.reference[1])
    rows.push([cell(label),u,input,adsorption,evolution,num(r.limitingPotential),cell(doi),cell(quotes[0])])
    return {site:label,adsorption_eV:adsorption,evolution_eV:evolution,reference_adsorption_eV:input,limiting_U_V_RHE:num(r.limitingPotential),source_doi:doi}
  })
  const levels=sites.flatMap(s=>s.r.levels)
  const min=Math.min(0,...levels),max=Math.max(0,...levels),span=Math.max(.05,max-min)
  const lo=min-.15*span,hi=max+.15*span
  const y=v=>Math.round(254-(v-lo)/(hi-lo)*146)
  const h=342+sites.length*24
  const parts=[`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 ${h}"><rect width="640" height="${h}" fill="white"/><g font-family="sans-serif" fill="#203b3e"><text x="30" y="35" font-size="22">不同位点的 HER 自由能</text><text x="30" y="63" font-size="14">计算氢电极模型　 U = ${num(u)} V vs RHE</text><text x="30" y="91" font-size="13">累积自由能 (eV)</text>`]
  for(const e of [...new Set([min,0,max].map(num))].sort((a,b)=>a-b)){
    parts.push(`<line x1="76" x2="607" y1="${y(e)}" y2="${y(e)}" stroke="#d8e3df"/><text x="69" y="${y(e)+4}" font-size="12" text-anchor="end">${signed(e)}</text>`)
  }
  for(const [i,{r,label}] of sites.entries()){
    const [a,b,c]=r.levels.map(y),color=colors[i]
    parts.push(`<polyline points="139,${a} 292,${b} 360,${b} 513,${c}" fill="none" stroke="${color}" stroke-width="2.5"/><line x1="292" x2="360" y1="${b}" y2="${b}" stroke="${color}" stroke-width="5"/><line x1="31" x2="53" y1="${315+i*24}" y2="${315+i*24}" stroke="${color}" stroke-width="4"/><text x="63" y="${320+i*24}" font-size="14">${xml(label)}　 ΔG(H*) = ${signed(r.reference[1])} eV（0 V）</text>`)
  }
  for(const [x,e,t] of [[106,0,'空位 *'],[326,null,'吸附氢 H*'],[546,2*u,'产物 * + H₂']]){
    if(e!==null)parts.push(`<line x1="${x-33}" x2="${x+33}" y1="${y(e)}" y2="${y(e)}" stroke="#263f43" stroke-width="4"/>`)
    parts.push(`<text x="${x}" y="281" text-anchor="middle" font-size="14">${t}</text>`)
  }
  parts.push(`<text x="30" y="${h-12}" font-size="12" fill="#58696c">平台高度表示热力学状态；连线不代表动力学势垒。</text></g></svg>`)
  const dir=await mkdtemp(join(root,'her-sites-'))
  const names=['HER位点自由能.svg','HER位点计算.csv']
  await Promise.all([writeFile(join(dir,names[0]),parts.join(''),{flag:'wx',mode:0o600}),writeFile(join(dir,names[1]),rows.map(r=>r.join(',')).join('\n')+'\n',{flag:'wx',mode:0o600})])
  return {potential_V_RHE:u,results,files:names.map(n=>basename(dir)+'/'+n)}
}
