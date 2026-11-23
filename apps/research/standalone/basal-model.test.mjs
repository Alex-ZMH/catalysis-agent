import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {buildBasalModels,startScreen,checkScreen} from './basal-model.mjs'

const settings={lattice_angstrom:6.5,trimer_distance_angstrom:2.8,k_grid:3,cutoff_ry:60}
test('constructed slab has the requested Mo trimer and two distinct outward S–H geometries',()=>{
  const m=buildBasalModels(settings),c=m.clean.cell
  const xyz=f=>[0,1,2].map(i=>f.reduce((s,v,j)=>s+v*c[j][i],0))
  const pos=m.clean.atoms.slice(0,3).map(a=>xyz(a.fractional))
  for(const [i,j] of [[0,1],[1,2],[2,0]])assert.ok(Math.abs(Math.hypot(...pos[i].map((v,k)=>v-pos[j][k]))-2.8)<1e-6)
  assert.equal(m.clean.atoms.length,12)
  for(const [site,s] of [['A',4],['B',5]]){
    const a=m[site].atoms.at(-1),base=m.clean.atoms[s]
    assert.equal(a.element,'H');assert.deepEqual(a.fractional.slice(0,2),base.fractional.slice(0,2))
    assert.ok(Math.abs((a.fractional[2]-base.fractional[2])*22-1.35)<1e-6)
  }
  assert.notDeepEqual(m.A.atoms.at(-1),m.B.atoms.at(-1))
})
test('site comparison uses four converged total energies from the same batch',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mos2-screen-'));t.after(()=>rm(dir,{recursive:true,force:true}))
  let n=0;await startScreen(dir,{id:'study'},settings,async()=>({job_id:String(++n),state:'SUBMITTED'}))
  const energies=[-100,-115,-115.8,-30]
  const running=await checkScreen(dir,'study',async()=>({state:'RUNNING'}));assert.equal(running.complete,false);assert.deepEqual(running.files,[])
  const result=await checkScreen(dir,'study',async id=>({state:'COMPLETED',converged:true,total_energy_eV:energies[Number(id)-1]}))
  assert.deepEqual(result.sites,[{site:'A',adsorption_eV:0},{site:'B',adsorption_eV:-.8}]);assert.equal(result.method,'PBE')
  for(const file of result.files)assert.ok((await readFile(join(dir,file))).length)
})
