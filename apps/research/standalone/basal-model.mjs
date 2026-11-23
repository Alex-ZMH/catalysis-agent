import {execFile} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {mkdir,readFile,writeFile} from 'node:fs/promises'

export const cases=['clean','A','B','H2']
const names={clean:'洁净单层',A:'位点 A',B:'位点 B',H2:'氢分子'}
const r=x=>Number(x.toFixed(8))
function inRange(x,a,b){return Number.isFinite(x)&&x>=a&&x<=b}
export function buildBasalModels({lattice_angstrom:a,trimer_distance_angstrom:d,cutoff_ry:cutoff,k_grid:n}){
  if(!inRange(a,6.2,6.8)||!inRange(d,2.5,3.05)||d>=a/2||!inRange(cutoff,40,80)||!Number.isInteger(n)||n<1||n>4)throw Error('Use a 6.2–6.8 Å supercell, 2.5–3.05 Å trimer side, 40–80 Ry and a 1–4 in-plane mesh.')
  const z=22,cell=[[a,0,0],[a/2,r(a*Math.sqrt(3)/2),0],[0,0,z]],ratio=2*d/a
  const mo=[],top=[],bottom=[]
  const atom=(element,xyz,m=0)=>({element,magnetization:m,fractional:xyz.map(v=>r((v%1+1)%1))})
  for(const [i,j] of [[0,0],[1,0],[0,1],[1,1]]){
    const shift=[i,j].map(v=>i+j===2?v:(v-1/3)*ratio+1/3)
    mo.push(atom('Mo',[shift[0]/2,shift[1]/2,.5]))
    top.push(atom('S',[(i+1/3)/2,(j+1/3)/2,.5+1.56/z]))
    bottom.push(atom('S',[(i+2/3)/2,(j+2/3)/2,.5-1.56/z]))
  }
  const bare={cell,atoms:[...mo,...top,...bottom],cutoff_ry:cutoff,kmesh:[n,n,1]}
  const bind=s=>({...bare,atoms:[...bare.atoms,atom('H',[s.fractional[0],s.fractional[1],s.fractional[2]+1.35/z],1)]})
  return {clean:bare,A:bind(top[0]),B:bind(top[1]),H2:{cell:[[14,0,0],[0,14,0],[0,0,14]],atoms:[-.37,.37].map(v=>atom('H',[.5,.5,.5+v/14])),cutoff_ry:cutoff,kmesh:[1,1,1]}}
}
export function structurePicture(model){
  const ball={Mo:['#c1d4ee','#536e93','#273b58',7.7],S:['#ffe7a0','#d8a446','#916124',6.6],H:['#aeffe7','#37be9b','#137963',5.5]}
  const atoms=[],targets=[]
  for(let j=-1;j<=1;j++)for(let i=-1;i<=1;i++)for(const [idx,at] of model.atoms.entries()){
    const [a,b,c]=at.fractional,x=(a+i-0.35)*model.cell[0][0]+(b+j-.45)*model.cell[1][0],y=(b+j-.45)*model.cell[1][1],z=(c-.5)*22
    const row={e:at.element,x,y,z,px:356+20*x+6*y,py:177-9*y-15*z,depth:z-y}
    atoms.push(row);if(i===0&&j===0&&(idx===4||idx===5))targets.push(row)
  }
  atoms.sort((a,b)=>a.depth-b.depth)
  const defs=Object.entries(ball).map(([e,[hi,mid,low]])=>`<radialGradient id="g${e}" cx="32%" cy="24%" r="80%"><stop offset="0" stop-color="${hi}"/><stop offset=".52" stop-color="${mid}"/><stop offset="1" stop-color="${low}"/></radialGradient>`).join('')
  const bonds=[]
  for(const a of atoms.filter(v=>v.e==='Mo'))for(const b of atoms.filter(v=>v.e==='S')){
    const l=Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)
    if(l<2.85)bonds.push(`<line x1="${r(a.px)}" y1="${r(a.py)}" x2="${r(b.px)}" y2="${r(b.py)}" stroke="#aebbbf" stroke-width="2.4"/>`)
  }
  const centers=atoms.map(a=>`<circle cx="${r(a.px)}" cy="${r(a.py)}" r="${ball[a.e][3]}" fill="url(#g${a.e})"/>`).join('')
  const labels=targets.map((a,i)=>{const x=a.px+(i?58:-50),y=a.py-(i?38:58);return `<circle cx="${a.px}" cy="${a.py}" r="10" fill="none" stroke="#007966" stroke-width="2"/><line x1="${a.px}" y1="${a.py-9}" x2="${x}" y2="${y}" stroke="#007966"/><circle cx="${x}" cy="${y}" r="12" fill="#007966"/><text x="${x}" y="${y+4}" text-anchor="middle" font-size="13" fill="white">${i?'B':'A'}</text>`}).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 338"><defs>${defs}</defs><rect width="720" height="338" fill="#f6f9f8"/><g font-family="sans-serif"><text x="24" y="32" fill="#173737" font-size="20">单层 1T″-MoS₂</text><text x="24" y="55" fill="#57716e" font-size="12">Mo 三聚化  ·  基面 S 顶位</text>${bonds.join('')}${centers}${labels}<rect x="0" y="306" width="720" height="32" fill="#f6f9f8"/><text x="24" y="327" font-size="13" fill="#4d6564">A　三聚体中心上方　　B　相邻硫位点</text><circle cx="579" cy="322" r="6" fill="url(#gMo)"/><text x="591" y="327" font-size="13" fill="#4d6564">Mo</text><circle cx="644" cy="322" r="6" fill="url(#gS)"/><text x="656" y="327" font-size="13" fill="#4d6564">S</text></g></svg>`
}
export async function startScreen(root,job,args,submit){
  const models=buildBasalModels(args),folder='model-'+job.id,dir=join(root,folder)
  await mkdir(dir,{recursive:true,mode:0o700})
  const meta={geometry:'1T-derived 2×2 Mo trimer start, fixed-coordinate PBE single points',lattice_angstrom:args.lattice_angstrom,trimer_distance_angstrom:args.trimer_distance_angstrom,models}
  const metaFile=join(dir,'models.json')
  try{await writeFile(metaFile,JSON.stringify(meta,null,1),{flag:'wx',mode:0o600})}catch(e){if(e.code!=='EEXIST')throw e;if((await readFile(metaFile,'utf8'))!==JSON.stringify(meta,null,1))throw Error('This batch already has different coordinates.')}
  await writeFile(join(dir,'基面原子模型.svg'),structurePicture(models.clean))
  const runs=[]
  for(const key of cases){
    const receipt=await submit({...job,id:job.id+'-'+key},models[key])
    runs.push({case:key,job_id:receipt.job_id,state:receipt.state})
    await writeFile(join(dir,'jobs.json'),JSON.stringify(runs,null,2))
  }
  return {batch_id:job.id,runs,model_method:meta.geometry,sites:{A:'S above the center of a contracted Mo triangle',B:'adjacent S on the same face'},files:[folder+'/基面原子模型.svg',folder+'/models.json',folder+'/jobs.json']}
}
function bindingFigure(values,method){
  const all=values.map(v=>v.adsorption_eV),low=Math.min(0,...all),high=Math.max(0,...all),spread=Math.max(.15,high-low)
  const x=v=>Math.round(116+394*(v-low+.08*spread)/(high-low+.16*spread))
  const rows=values.map(({site,adsorption_eV},i)=>{
    const y=120+i*62,col=i?'#bf8738':'#087e71',dot=x(adsorption_eV)
    return `<text x="24" y="${y+5}" font-size="17">位点 ${site}</text><line x1="${x(0)}" x2="${dot}" y1="${y}" y2="${y}" stroke="${col}" stroke-width="7"/><circle cx="${dot}" cy="${y}" r="7" fill="${col}"/><text x="570" y="${y+5}" text-anchor="end" font-size="18">${adsorption_eV.toFixed(3)}</text>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 242"><rect width="600" height="242" fill="#f8faf9"/><g font-family="sans-serif" fill="#203d3e"><text x="24" y="37" font-size="23">氢更倾向结合在哪个位点？</text><text x="24" y="65" font-size="13">固定几何 ${method} 单点　·　电子吸附能 (eV)</text><line x1="${x(0)}" x2="${x(0)}" y1="88" y2="200" stroke="#849a94" stroke-dasharray="3 3"/>${rows}<text x="24" y="223" font-size="13">以洁净单层和半个氢分子为参考，数值越低，结合越强。</text></g></svg>`
}
async function rapidEnergies(python,models){
  const file=fileURLToPath(new URL('./basal-quick.py',import.meta.url))
  const stdout=await new Promise((resolve,reject)=>{
    const child=execFile(python,[file],{timeout:65000,maxBuffer:512*1024,env:{...process.env,OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1',MKL_NUM_THREADS:'1'}},(error,out,err)=>error?reject(Error('Electronic screen: '+err.slice(-500))):resolve(out))
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(models))
  })
  const values=JSON.parse(stdout)
  if(!cases.every(k=>Number.isFinite(values[k])))throw Error('Missing converged site energy.')
  return values
}
export async function checkScreen(root,id,query,quickPython){
  if(!/^[\w-]{1,64}$/.test(id))throw Error('Invalid model batch')
  const folder='model-'+id,dir=join(root,folder)
  const jobs=JSON.parse(await readFile(join(dir,'jobs.json'),'utf8')),results=[],energies={}
  for(const j of jobs){const result=await query(j.job_id);results.push({case:j.case,job_id:j.job_id,state:result.state,converged:result.converged??false,total_eV:result.total_energy_eV})
    if(result.converged&&['COMPLETED','FINISHED_WITH_EXIT_0'].includes(result.state))energies[j.case]=result.total_energy_eV}
  const complete=cases.every(k=>Number.isFinite(energies[k])),files=[]
  let method='PBE',active=energies
  if(!complete && quickPython){
    const meta=JSON.parse(await readFile(join(dir,'models.json'),'utf8'))
    active=await rapidEnergies(quickPython,meta.models);method='GFN1-xTB'
  }
  if(complete || quickPython){
    const values=['A','B'].map(k=>({site:k,adsorption_eV:r(active[k]-active.clean-active.H2/2)}))
    const csv=['模型,计算方法,总能_eV,电子吸附能_eV,复核作业号',...results.map(j=>[names[j.case],method,active[j.case],values.find(v=>v.site===j.case)?.adsorption_eV??'',j.job_id].join(','))].join('\n')+'\n'
    const table=method+'-基面位点计算.csv',plot=method+'-氢吸附位点对比.svg'
    await writeFile(join(dir,table),csv)
    await writeFile(join(dir,plot),bindingFigure(values,method))
    files.push(folder+'/'+table,folder+'/'+plot)
    return {complete,results,method,total_energies_eV:active,sites:values,energy_definition:'E(slab+H) − E(clean slab) − ½E(H₂), fixed coordinates, eV',files}

  }
  return {complete,results,files}
}
