import {startScreen,checkScreen} from './basal-model.mjs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile, copyFile, readdir, mkdtemp, realpath, rename, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { writeSiteComparison } from './site-comparison.mjs'
import science from '../../web/electrochem/science.js'
import { normalizeDoi, csvCell } from './literature.mjs'
import { readConfinedFile } from './workspace.mjs'

const exec = promisify(execFile)
const tool = (name, description, properties = {}, required = []) => ({
  name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
})
const authorization = {type:'string',description:'Quote the user’s actual instruction authorizing this action, verbatim. Only use an affirmative instruction applicable to this task.'}
const number = {type:'number'}
const vector = {type:'array',items:number,minItems:3,maxItems:3}
const cell = {type:'array',items:vector,minItems:3,maxItems:3}
const supported = {
  Mo:['Mo_ONCV_PBE_1',95.95], S:['S_ONCV_PBE_1',32.06], H:['H_ONCV_PBE_1',1.008],
  Ni:['Ni_ONCV_PBE_1.2_18e',58.6934], O:['O_ONCV_PBE_6e',15.999],
  Zr:['Zr_ONCV_PBE_1.0_12e',91.224], Ca:['Ca_ONCV_PBE_10e_FR',40.078],
}
const atom = {type:'object',properties:{element:{type:'string',enum:Object.keys(supported)},fractional:vector,magnetization:number},required:['element','fractional','magnetization'],additionalProperties:false}
const siteSchema={type:'object',additionalProperties:false,properties:{
  label:{type:'string',description:'Short, distinct site and region label for the plot legend.'},
  energy:{type:'string'},source_doi:{type:'string'},passage_id:{type:'string'},quote:{type:'string'}
},required:['label','energy','source_doi']}
export const electroTools = [
  tool('build_and_run_basal_models','Build a 2×2 Mo-trimer distorted 1T MoS2 monolayer from lattice and trimer distances, identify two distinct basal sulfur top sites and submit four independent ABACUS PW/PBE single points (clean sheet, each H-bound site, and isolated H2). Use when the user asks you to choose parameters and model and calculate the trimerized monolayer yourself. Produces a coordinate file, atom map and real job IDs. Supply the 2×2 lattice in Å (6.2–6.8), contracted Mo–Mo side in Å (2.5–3.05), 40–80 Ry cutoff, and uniform 1–4 in-plane k grid.',{authorization,lattice_angstrom:number,trimer_distance_angstrom:number,cutoff_ry:number,k_grid:{type:'integer'}},['authorization','lattice_angstrom','trimer_distance_angstrom','cutoff_ry','k_grid']),
  tool('analyze_basal_models','Check native convergence of the model batch in this conversation. Return converged PBE energies when available; while PBE jobs run, perform a fast GFN1-xTB electronic calculation on the actual four geometries and return the calculated comparison table and plot with its method. Supply batch_id returned by build_and_run_basal_models.',{batch_id:{type:'string'}},['batch_id']),
  tool('basal_electronic_spectrum','Submit or collect real PBE/LCAO SCF, native DOS/PDOS and hydrogen electronic adsorption energies on the clean, A, B and H2 structures previously built in this chat. Reuses existing Slurm jobs. Omit batch_id for the latest model. Use collect to retrieve converged results and publish the SVG, CSV, structures and raw logs. Mode relax optimizes the four models at fixed cell from their converged electronic densities and schedules new spectra. Mode collect_relaxed verifies the final forces, site identities and dense-mesh spectra. These are electronic binding energies.',{mode:{type:'string',enum:['submit','collect','relax','collect_relaxed']},batch_id:{type:'string'},authorization},['mode']),
  tool('calculate_her_sites','Run the HER computational hydrogen electrode for two to eight verified sites. Use the actual signed zero-potential adsorption energies from papers read in this turn. Give a short label, DOI and either the passage ID or exact quote for each site. Returns a combined labeled free energy plot and raw comparison table. Omit potential for the standard reference of 0 V vs RHE unless the user specifies a working potential.',{sites:{type:'array',minItems:2,maxItems:8,items:siteSchema},potential:{type:'string'}},['sites']),
  tool('calculate_che','HER/OER computational hydrogen electrode. Use the potential specified by the user (V vs RHE). Supply zero-potential adsorption energies in eV from the user, or use source_doi and energy_passages (the returned passage_id for each energy) or verbatim energy_quotes from a paper read this turn. Give a case_label identifying the phase and coverage when comparing cases. Produces CSV and SVG.',{reaction:{type:'string',enum:['her','oer']},potential:{type:'string'},energies:{type:'array',items:{type:'string'}},source_doi:{type:'string'},energy_quotes:{type:'array',items:{type:'string'}},energy_passages:{type:'array',items:{type:'string'}},case_label:{type:'string'}},['reaction','potential','energies']),
  tool('run_ni_reference','Run one fixed engineering ABACUS Ni fcc SCF: a=3.52 Å, one Ni, initial spin 0.6, 45 Ry, 2×2×2, Gaussian smearing 0.02 Ry. CPU partition, one core, 5 minutes, no GPU. Only for an explicitly requested Ni reference or engineering test.',{authorization},['authorization']),
  tool('run_abacus_scf','Run a user-defined neutral periodic collinear PW/PBE SCF. Cell vectors in Å, direct fractional coordinates, collinear initial moment per atom, cutoff in Ry and Gamma-centered mesh. Gaussian smearing 0.02 Ry. 1 CPU, 5 minutes; max 16 atoms. Require user-specified or agreed method and geometry.',{authorization,cell,atoms:{type:'array',items:atom,minItems:1,maxItems:16},cutoff_ry:number,kmesh:vector},['authorization','cell','atoms','cutoff_ry','kmesh']),
  tool('query_abacus_scf','Query this chat’s single-point Slurm job, check native convergence and publish the original log, structure and summary. Use for run_ni_reference and run_abacus_scf.',{job_id:{type:'string'}},['job_id']),
  tool('cancel_abacus_scf','Cancel this chat’s single-point Slurm job only after an explicit request to cancel.',{authorization,job_id:{type:'string'}},['authorization','job_id']),
]
const ni = {cell:[[0,1.76,1.76],[1.76,0,1.76],[1.76,1.76,0]], atoms:[{element:'Ni',fractional:[0,0,0],magnetization:0.6}],cutoff_ry:45,kmesh:[2,2,2]}
function triple(v, predicate) { return Array.isArray(v) && v.length===3 && v.every(predicate) }
export function scfInput(model) {
  const {cell,atoms,cutoff_ry,kmesh}=model
  if(!triple(cell,row=>triple(row,x=>Number.isFinite(x)&&Math.abs(x)<=30)) || !Array.isArray(atoms) || atoms.length<1 || atoms.length>16 ||
    !atoms.every(a=>a && Object.hasOwn(supported,a.element)&&triple(a.fractional,x=>Number.isFinite(x)&&x>=0&&x<1)&&Number.isFinite(a.magnetization)&&Math.abs(a.magnetization)<=10) ||
    !Number.isFinite(cutoff_ry)||cutoff_ry<20||cutoff_ry>100||!triple(kmesh,x=>Number.isInteger(x)&&x>=1&&x<=8)) throw Error('Invalid SCF geometry, cutoff, spin or mesh.')
  const [[a,b,c],[d,e,f],[g,h,i]]=cell
  const volume=a*(e*i-f*h)-b*(d*i-f*g)+c*(d*h-e*g)
  if(volume<2 || volume>4000) throw Error('Use a right-handed cell of 2–4000 Å³.')
  const elements=[...new Set(atoms.map(x=>x.element))]
  const rows=cell.map(v=>v.join(' ')).join('\n')
  const grouped=elements.map(s=>atoms.filter(x=>x.element===s))
  const stru=['ATOMIC_SPECIES', ...elements.map(s=>s+' '+supported[s][1]+' '+s+'.upf'), '', 'LATTICE_CONSTANT','1.88972612462577','','LATTICE_VECTORS',rows,'','ATOMIC_POSITIONS','Direct',
    ...grouped.flatMap(group=>[group[0].element,'0',String(group.length),...group.map(x=>x.fractional.join(' ')+' m 0 0 0 mag '+x.magnetization)])].join('\n')+'\n'
  return {elements, STRU:stru, POSCAR:['ABACUS fixed input cell (angstrom)','1',rows,elements.join(' '),grouped.map(g=>g.length).join(' '),'Direct',...grouped.flat().map(x=>x.fractional.join(' '))].join('\n')+'\n',
    INPUT:['INPUT_PARAMETERS','suffix catalyst','calculation scf','basis_type pw','esolver_type ksdft','device cpu','dft_functional pbe','ntype '+elements.length,'nspin 2','ecutwfc '+cutoff_ry,'smearing_method gaussian','smearing_sigma 0.02','scf_thr 1e-6','scf_nmax 80','mixing_beta 0.3','symmetry 0'].join('\n')+'\n',
    KPT:'K_POINTS\n0\nGamma\n'+kmesh.join(' ')+' 0 0 0\n'}
}
const writeNew = (file,text) => writeFile(file,text,{flag:'wx',mode:0o600})
const shellPath = p => { if(typeof p!=='string'||!/^\/[A-Za-z0-9_./-]+$/.test(p)) throw Error('Invalid installed engine path'); return "'"+p+"'" }
function requireInstruction(job, quote) {
  const turns = [...(job.history || []).filter(m => m.role === 'user').map(m => m.content), job.message]
  if (typeof quote !== 'string' || !quote.trim() || !turns.some(m => m.includes(quote.trim())))
    throw Error('Quote an applicable, explicit user instruction to submit or cancel this calculation.')
}
const scheduler = (name,args,cwd) => exec(name,args,{cwd,timeout:12000,maxBuffer:128*1024,env:{PATH:'/usr/bin:/bin',HOME:process.env.HOME,LANG:'C'}})
async function lookup(root,id) {
  if(typeof id!=='string'||!/^\d{1,15}$/.test(id)) throw Error('Invalid Slurm job ID')
  for(const entry of await readdir(root,{withFileTypes:true})) {
    if(!entry.isDirectory()||!/^\.abacus-[\w-]+$/.test(entry.name)) continue
    let receipt
    try {receipt=JSON.parse((await readConfinedFile(root,entry.name+'/receipt',16384)).buffer)} catch {continue}
    if(receipt.jobId===id) return {dir:join(root,entry.name),tag:entry.name.slice(8),receipt}
  }
  throw Error('This job has no receipt in the current chat.')
}
async function publishResult(root,output,name,bytes) {
  const dir=join(root,output)
  if(await realpath(dir)!==join(await realpath(root),output)) throw Error('Invalid result directory.')
  const temp=join(dir,'.'+randomUUID())
  await writeNew(temp,bytes)
  await rename(temp,join(dir,name))
}
async function query(root,id) {
  const {dir,tag,receipt}=await lookup(root,id)
  const output='scf-'+tag
  const {stdout}=await scheduler('scontrol',['show','job','-o',id],dir).catch(()=>({stdout:''}))
  // An expired Slurm journal may have reused the ID. Bind every observation to its work directory.
  const owned=stdout.includes('WorkDir='+dir+' ')||stdout.trimEnd().endsWith('WorkDir='+dir)
  const state=owned ? /\bJobState=(\w+)/.exec(stdout)?.[1] : undefined
  const result={job_id:id,state:state||'UNKNOWN',files:[output+'/POSCAR'],method:receipt.method}
  if (owned) {
    const fields=Object.fromEntries(stdout.trim().split(/\s+/).map(part=>[part.slice(0,part.indexOf('=')),part.slice(part.indexOf('=')+1)]))
    result.slurm={requested:fields.ReqTRES,allocated:fields.AllocTRES,exit_code:fields.ExitCode,elapsed:fields.RunTime,time_limit:fields.TimeLimit}
  }
  if(!owned && stdout.trim()) throw Error('The scheduler ID now belongs to another working directory.')
  if(['RUNNING','PENDING','CONFIGURING','COMPLETING'].includes(state)) return result
  let exitCode
  try {exitCode=Number((await readConfinedFile(root,basename(dir)+'/exit-code',32)).buffer.toString().trim())} catch {}
  if(!state && Number.isInteger(exitCode)) result.state=exitCode===0?'FINISHED_WITH_EXIT_0':'FAILED'
  try {
    const log=(await readConfinedFile(root,basename(dir)+'/OUT.catalyst/running_scf.log',32*1024*1024)).buffer
    const native=log.toString('utf8')
    const energy=/!FINAL_ETOT_IS\s+([-+\d.Ee]+)\s+eV/i.exec(native)
    const convergence=/charge density convergence is achieved|convergence has been achieved/i.exec(native)
    result.converged=Boolean(convergence && energy && Number.isFinite(Number(energy[1])))
    if(convergence) result.convergence_evidence=convergence[0]
    if(energy&&Number.isFinite(Number(energy[1]))) result.total_energy_eV=Number(energy[1])
    if(!state && !Number.isInteger(exitCode)) return result
    await publishResult(root,output,'running_scf.txt',log)
    result.files.push(output+'/running_scf.txt')
  } catch(error) { if(error.code!=='ENOENT') throw error }
  if(!['UNKNOWN','PENDING','RUNNING'].includes(result.state)) {
    const summary=output+'/summary.json'
    result.files.push(summary)
    await publishResult(root,output,'summary.json',JSON.stringify(result,null,2)+'\n')
  }
  return result
}
async function submit(root,config,job,model,signal,screen=false) {
  const data=scfInput(model)
  const engine=JSON.parse(await readFile(config.siteConfig,'utf8')).abacus
  const command=shellPath(engine.binary), env=shellPath(engine.environment_script)
  const dir=join(root,'.abacus-'+job.id), output=join(root,'scf-'+job.id)
  try {await mkdir(dir,{mode:0o700})} catch(error) {
    if(error.code!=='EEXIST') throw error
    const prior=await readConfinedFile(root,basename(dir)+'/receipt',16384).catch(()=>null)
    if(prior) return query(root,JSON.parse(prior.buffer).jobId)
    throw Object.assign(Error('Submission outcome unresolved; inspect this run before resubmitting.'),{code:'MLCC_TOOL_OUTCOME_UNKNOWN'})
  }
  await mkdir(output,{mode:0o700})
  for(const name of ['STRU','INPUT','KPT']) await writeNew(join(dir,name),data[name])
  await writeNew(join(output,'POSCAR'),data.POSCAR)
  for(const s of data.elements) await copyFile(engine.pseudopotential_files[supported[s][0]],join(dir,s+'.upf'))
  await writeNew(join(dir,'run.sh'),['#!/bin/bash','umask 077',"trap 'echo $? > exit-code' EXIT",'source '+env+' || exit 2',screen?'export OMP_NUM_THREADS=2 MKL_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1':'export OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1',command].join('\n')+'\n')
  signal.throwIfAborted()
  const {stdout}=await scheduler('sbatch',['--parsable','--export=NONE','--partition=cpu','--nodes=1','--ntasks=1',screen?'--cpus-per-task=2':'--cpus-per-task=1','--mem=2G',screen?'--time=00:20:00':'--time=00:05:00','--no-requeue','--job-name=catalysis-scf','--output=slurm-%j.out','run.sh'],dir)
  const id=stdout.trim().split(';')[0]
  if(!/^\d+$/.test(id)) throw Object.assign(Error('Slurm did not return a usable job ID.'),{code:'MLCC_TOOL_OUTCOME_UNKNOWN'})
  await writeNew(join(dir,'receipt.tmp'),JSON.stringify({jobId:id,method:model}))
  await rename(join(dir,'receipt.tmp'),join(dir,'receipt'))
  // The receipt is durable before waiting. Stopping chat leaves a submitted job queryable.
  if(screen)return {job_id:id,state:'SUBMITTED'}
  let result
  for(let n=0;n<12;n++) {
    result=await query(root,id)
    if(!['PENDING','RUNNING','CONFIGURING','COMPLETING','UNKNOWN'].includes(result.state)) break
    await delay(1500,undefined,{signal})
  }
  return result
}
function evidenced(raw,regex,messages) {
  const norm=s=>s.replaceAll('−','-').replace(/\s/g,'').toLowerCase()
  if(typeof raw!=='string'||!regex.test(raw.trim())||!messages.some(msg=>{
    const source=norm(msg), value=norm(raw)
    for(let at=source.indexOf(value);at!==-1;at=source.indexOf(value,at+1)) {
      if(!/[0-9.+-]/.test(source[at-1]||'') && !/[a-z0-9/]/.test(source[at+value.length]||'')) return true
    }
    return false
  })) throw Error('Quote user-provided inputs and units verbatim.')
  return Number.parseFloat(norm(raw))
}
function evaluateChe(job,args,papers,allowStandard=false) {
  const messages=[job.message,...(job.history||[]).filter(x=>x.role==='user').map(x=>x.content)]
  const standard=allowStandard && (args.potential==null || /^[+−-]?0(?:\.0+)?\s*V\s*(?:vs\.?\s*)?RHE$/i.test(args.potential.trim()))
  const potential=standard ? 0 : evidenced(args.potential,/^[+−-]?\d+(?:\.\d+)?\s*V\s*(?:vs\.?\s*)?RHE$/i,messages)
  const energyPattern=/^[+−-]?\d+(?:\.\d+)?\s*eV$/i
  const norm=s=>String(s).normalize('NFKC').replaceAll('−','-').replace(/\s+/g,' ').trim()
  const doi=args.source_doi?normalizeDoi(args.source_doi):''
  const paper=doi&&papers?.get(doi)
  let energies,quotes=args.energy_quotes
  if(doi){
    if(paper&&Array.isArray(args.energy_passages)){
      quotes=args.energy_passages.map((id,i)=>{
        const text=paper.passages.find(p=>p.passage_id===id)?.text
        if(!text)throw Error('Use the passage_id returned by the literature reader for this DOI')
        const value=Number.parseFloat(norm(args.energies[i]))
        const sentence=text.split(/(?<=[.!?])\s+(?=[A-Z])/).find(s=>[...norm(s).matchAll(/(?<![\d.+-])([+-]?\d+(?:\.\d+)?)\s*eV\b(?!\/)/gi)].some(m=>Number(m[1])===value))
        if(!sentence)throw Error('Requested energy missing from the selected source passage')
        return sentence.trim()
      })
    }
    if(!paper||!Array.isArray(quotes)||quotes.length!==args.energies.length)throw Error('Read the source DOI and quote the passage for each energy')
    const passages=[paper.abstract,...paper.passages.map(p=>p.text)].filter(Boolean).map(norm)
    energies=args.energies.map((energy,i)=>{
      const quote=norm(quotes[i])
      if(quote.length<12||quote.length>1500||!passages.some(p=>p.includes(quote)))throw Error('Energy quote must match the retrieved paper passage verbatim')
      const value=norm(energy)
      if(!energyPattern.test(value))throw Error('Supply the adsorption energy in eV')
      const quantity=Number.parseFloat(value)
      const measured=[...quote.matchAll(/(?<![\d.+-])([+-]?\d+(?:\.\d+)?)\s*eV\b(?!\/)/gi)]
      if(!measured.some(match=>Number(match[1])===quantity))throw Error('The cited passage does not contain this signed energy in eV')
      return quantity
    })
  }else energies=args.energies.map(x=>evidenced(x,energyPattern,messages))
  const r=science.freeEnergy(args.reaction,potential,energies)
  return {r,potential,doi,quotes}
}
async function calculate(root,job,args,papers) {
  const {r,potential,doi,quotes}=evaluateChe(job,args,papers)
  const dir=await mkdtemp(join(root,'che-'))
  const columns=['state','free_energy_eV','zero_potential_eV','step_delta_eV','U_V_RHE','limiting_U_V_RHE','thermodynamic_overpotential_V','reaction']
  const rounded=value=>Number(value.toFixed(10))
  const rows=r.states.map((state,i)=>[state,rounded(r.levels[i]),rounded(r.reference[i]),i?rounded(r.steps[i-1]):'',potential,rounded(r.limitingPotential),rounded(r.overpotential),args.reaction])
  if(doi){
    columns.push('case','source_DOI','energy_evidence')
    const label=String(args.case_label||'').slice(0,140)
    for(const row of rows)row.push(csvCell(/^[=+@-]/.test(label)?"'"+label:label),csvCell(doi),csvCell(quotes.join(' | ')))
  }
  const csv=[columns,...rows].map(row=>row.join(',')).join('\n')
  const lo=Math.min(...r.levels),hi=Math.max(...r.levels), y=v=>140-100*(v-lo)/(hi-lo||1)
  const points=r.levels.map((v,i)=>(52+i*105)+','+y(v)).join(' ')
  const labels=r.states.map((s,i)=>'<text x="'+(52+i*105)+'" y="177">'+s+'</text><text x="'+(52+i*105)+'" y="'+(y(r.levels[i])-8)+'">'+r.levels[i].toFixed(3)+'</text>').join('')
  await writeNew(join(dir,'free-energy.csv'),csv+'\n')
  await writeNew(join(dir,'free-energy.svg'),'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+(105*r.levels.length)+' 194"><rect width="100%" height="100%" fill="white"/><text x="8" y="18">ΔG (eV) · '+potential+' V vs RHE</text><polyline points="'+points+'" fill="none" stroke="#1e7056" stroke-width="3"/><g text-anchor="middle" font-size="13">'+labels+'</g></svg>')
  return {...r,potential_V_RHE:potential,files:['free-energy.csv','free-energy.svg'].map(x=>basename(dir)+'/'+x)}
}
export async function electroCall(name,args,{workspace,config,job,signal,papers}) {
  if(!/^[a-zA-Z0-9_-]{1,80}$/.test(job.id)) throw Error('Invalid run id')
  if(name==='build_and_run_basal_models'){
    requireInstruction(job,args.authorization)
    return startScreen(workspace,job,args,(part,model)=>submit(workspace,config,part,model,signal,true))
  }
  if(name==='analyze_basal_models'){
    const site=JSON.parse(await readFile(config.siteConfig,'utf8'))
    return checkScreen(workspace,args.batch_id,id=>query(workspace,id),site.basal_quick_python)
  }
  if(name==='basal_electronic_spectrum'){
    if (!['submit','collect','relax','collect_relaxed'].includes(args.mode)) throw Error('Unknown spectrum operation');
    if (['submit','relax'].includes(args.mode)) requireInstruction(job,args.authorization);
    let batch=args.batch_id;
    if (!batch) {
      const dirs=(await readdir(workspace,{withFileTypes:true})).filter(e=>e.isDirectory() && /^model-[a-zA-Z0-9_-]+$/.test(e.name));
      const dated=await Promise.all(dirs.map(async e=>[e.name,(await stat(join(workspace,e.name,'models.json'))).mtimeMs]));
      batch=dated.sort((a,b)=>b[1]-a[1])[0]?.[0].slice(6);
    }
    if (!batch || !/^[a-zA-Z0-9_-]{1,64}$/.test(batch)) throw Error('Build the basal models in this chat first.');
    const site=JSON.parse(await readFile(config.siteConfig,'utf8'));
    const python=site.basal_dos_python || 'python3';
    const script=fileURLToPath(new URL('./basal-dos.py',import.meta.url));
    const {stdout}=await exec(python,[script,args.mode,workspace,batch],{timeout:90000,maxBuffer:1024*1024,signal});
    return {batch_id:batch,...JSON.parse(stdout)};
  }
  if(name==='calculate_her_sites'){
    if(!Array.isArray(args.sites)||args.sites.length<2||args.sites.length>8)throw Error('Choose two to eight paper-evidenced sites.')
    const sites=args.sites.map(site=>{
      const label=String(site.label||'').trim()
      if(!label || label.length>60 || !site.source_doi)throw Error('Each site needs a short label and source DOI.')
      const result=evaluateChe(job,{reaction:'her',potential:args.potential,energies:[site.energy],source_doi:site.source_doi,energy_passages:site.passage_id?[site.passage_id]:undefined,energy_quotes:site.quote?[site.quote]:undefined},papers,true)
      return {label,...result}
    })
    if(new Set(sites.map(s=>s.label)).size!==sites.length)throw Error('Site labels must be distinct.')
    return writeSiteComparison(workspace,sites)
  }
  if(name==='calculate_che') return calculate(workspace,job,args,papers)
  if(name==='query_abacus_scf') return query(workspace,args.job_id)
  if(name==='cancel_abacus_scf') {
    requireInstruction(job,args.authorization)
    const {dir}=await lookup(workspace,args.job_id)
    const result=await query(workspace,args.job_id)
    if(['PENDING','RUNNING','CONFIGURING'].includes(result.state)) await scheduler('scancel',[args.job_id],dir)
    return query(workspace,args.job_id)
  }
  if(name==='run_abacus_scf'||name==='run_ni_reference') {
    const {authorization,...model} = args
    requireInstruction(job,authorization)
    return submit(workspace,config,job,name==='run_ni_reference'?ni:model,signal)
  }
  throw Error('Unknown electrocatalysis tool')
}
