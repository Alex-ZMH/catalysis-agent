import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { electroCall, scfInput } from './electrocatalysis.mjs'

test('custom Ni/O cell preserves fractional positions, initial moments, mesh and cutoff',()=>{
  const model={cell:[[4,0,0],[0,4,0],[0,0,4]],cutoff_ry:56,kmesh:[2,2,1],
    atoms:[{element:'Ni',magnetization:1,fractional:[0,0,0]},{element:'O',magnetization:0,fractional:[.25,.5,.75]}]}
  const data=scfInput(model)
  assert.deepEqual(data.elements,['Ni','O'])
  assert.match(data.STRU,/0.25 0.5 0.75 m 0 0 0 mag 0/)
  assert.match(data.POSCAR,/Ni O\n1 1\nDirect/)
  assert.match(data.KPT,/2 2 1 0 0 0/)
  assert.match(data.INPUT,/ecutwfc 56/)
  assert.throws(()=>scfInput({...model,cell:[[0,0,0],[0,0,0],[0,0,0]]}))
})
test('CHE requires user-evidenced quantities, writes the actual curve and table',async t=>{
  const workspace=await mkdtemp(join(tmpdir(),'catalysis-che-'))
  t.after(()=>rm(workspace,{recursive:true,force:true}))
  const job={id:'test',message:'HER at −0.08 V vs RHE, with 0.21 eV.'}
  const args={reaction:'her',potential:'-0.08 V vs RHE',energies:['0.21 eV']}
  await assert.rejects(electroCall('calculate_che',{...args,potential:'0.08 V vs RHE'},{workspace,job}),/Quote/)
  const result=await electroCall('calculate_che',args,{workspace,job})
  assert.ok(Math.abs(result.steps[0]-.13)<1e-12)
  assert.ok(Math.abs(result.steps[1]+.29)<1e-12)
  const table=await readFile(join(workspace,result.files[0]),'utf8')
  assert.match(table,/state,free_energy_eV,zero_potential_eV,step_delta_eV,U_V_RHE/)
  assert.match(table,/H\*,0.13,0.21,0.13,-0.08/)
  assert.match(await readFile(join(workspace,result.files[1]),'utf8'),/<polyline/)
})
test('invented authorization cannot start a scheduler command',async()=>{
  const job={id:'test',message:'How would an SCF job work?'}
  await assert.rejects(electroCall('run_ni_reference',{authorization:'run it'},{job}),/explicit user instruction/)
})

test('literature CHE binds signed energies to passages retrieved for this turn',async t=>{
  const workspace=await mkdtemp(join(tmpdir(),'catalysis-source-'))
  t.after(()=>rm(workspace,{recursive:true,force:true}))
  const text='Free energy is −0.13 eV at the first coverage and 0.25 eV at the second.'
  const doi='10.1234/paper'
  const papers=new Map([[doi,{abstract:'',passages:[{text}]}]])
  const job={id:'source-test',message:'请算 -0.15 V vs RHE 下的两步自由能。'}
  const args={reaction:'her',potential:'-0.15 V vs RHE',energies:['-0.13 eV'],source_doi:doi,energy_quotes:[text],case_label:'low coverage'}
  const result=await electroCall('calculate_che',args,{workspace,job,papers})
  assert.match(await readFile(join(workspace,result.files[0]),'utf8'),/10.1234\/paper/)
  await assert.rejects(electroCall('calculate_che',{...args,energies:['+0.13 eV']},{workspace,job,papers}),/signed energy/)
  await assert.rejects(electroCall('calculate_che',{...args,energy_quotes:['This invented text says -0.13 eV.']},{workspace,job,papers}),/verbatim/)
  await assert.rejects(electroCall('calculate_che',args,{workspace,job}),/Read the source/)
})

test('retrieved passage IDs survive a later read of the same DOI and retain the original numerical evidence',async t=>{
  const {rememberPaper}=await import('./literature.mjs')
  const workspace=await mkdtemp(join(tmpdir(),'che-passages-'));t.after(()=>rm(workspace,{recursive:true,force:true}))
  const doi='10.1234/example',papers=new Map(),paper={doi,abstract:'',passages:[{text:'At this coverage the adsorption free energy was −0.14 eV.'}]}
  rememberPaper(papers,paper)
  rememberPaper(papers,{doi,abstract:'',passages:[{text:'Another part of the same article describes the method.'}]})
  const job={id:'passage-test',message:'请算 -0.15 V vs RHE 的自由能。'}
  const args={reaction:'her',potential:'-0.15 V vs RHE',energies:['-0.14 eV'],source_doi:doi,energy_passages:[paper.passages[0].passage_id]}
  const result=await electroCall('calculate_che',args,{workspace,job,papers})
  assert.match(await readFile(join(workspace,result.files[0]),'utf8'),/At this coverage the adsorption free energy was −0.14 eV/)
  await assert.rejects(electroCall('calculate_che',{...args,energies:['0.14 eV']},{workspace,job,papers}),/missing/)
})

test('site comparison uses the standard reference, preserves signed steps and reports only verified inputs',async t=>{
  const workspace=await mkdtemp(join(tmpdir(),'her-sites-'))
  t.after(()=>rm(workspace,{recursive:true,force:true}))
  const doi='10.1234/site-study'
  const quote='The adsorption energy is −0.32 eV at the first site and 0.27 eV at the second site.'
  const context={workspace,job:{id:'sites',message:'比较并画出位点自由能。'},papers:new Map([[doi,{passages:[{text:quote,passage_id:'test-passage'}]}]])}
  const sites=[{label:'A < 1',energy:'-0.32 eV',source_doi:doi,passage_id:'test-passage'},{label:'B',energy:'0.27 eV',source_doi:doi,quote}]
  const run=await electroCall('calculate_her_sites',{sites},context)
  assert.equal(run.potential_V_RHE,0)
  assert.deepEqual(run.results.map(r=>[r.adsorption_eV,r.evolution_eV]),[[-.32,.32],[.27,-.27]])
  const [svg,table]=await Promise.all(run.files.map(f=>readFile(join(workspace,f),'utf8')))
  assert.match(svg,/A &lt; 1/)
  assert.match(table,/来源_DOI,输入依据/)
  assert.match(table,/"B",0,0.27,0.27,-0.27/)
  await assert.rejects(electroCall('calculate_her_sites',{sites,potential:'-0.2 V vs RHE'},context),/Quote/)
  await assert.rejects(electroCall('calculate_her_sites',{sites:[sites[0],{...sites[1],energy:'-0.27 eV'}]},context),/signed energy/)
})
