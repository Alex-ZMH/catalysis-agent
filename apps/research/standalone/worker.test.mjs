import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('worker module provides an independent model + MCP runtime', async () => {
  const module = await import('./worker.mjs').catch(() => ({}))
  assert.equal(typeof module.executeJob, 'function')
})

test('MCP child environment excludes model, worker and inherited credentials', async () => {
  const { childEnvironment } = await import('./mcp-client.mjs')
  const env = childEnvironment({workspaceRoot:'/jobs',siteConfig:'/site.json'}, {PATH:'/usr/bin',HOME:'/user',MLCC_MODEL_API_KEY:'private',MLCC_WORKER_TOKEN:'private',OPENAI_API_KEY:'private',SSH_AUTH_SOCK:'private'})
  assert.equal(env.PYTHONDONTWRITEBYTECODE,'1')
  assert.equal(env.MLCC_WORKSPACE_ROOT,'/jobs')
  assert.deepEqual(Object.keys(env).filter(k=>/KEY|TOKEN|SSH/.test(k)),[])
})

test('artifact publishing rejects traversal, configuration and symlink paths', async t => {
  const { readArtifact } = await import('./worker.mjs')
  const root=await mkdtemp(join(tmpdir(),'mlcc-artifact-'));t.after(()=>rm(root,{recursive:true,force:true}))
  await mkdir(join(root,'results'));await mkdir(join(root,'configs'))
  await writeFile(join(root,'results','report.txt'),'real result')
  await writeFile(join(root,'configs','site.json'),'secret');await symlink(join(root,'configs'),join(root,'alias'))
  assert.equal((await readArtifact(root,'results/report.txt')).base64,Buffer.from('real result').toString('base64'))
  await assert.rejects(readArtifact(root,'../outside.txt'))
  await assert.rejects(readArtifact(root,'configs/site.json'))
  await assert.rejects(readArtifact(root,'alias/site.json'))
})

test('publishes all inherited scientific and image formats with their exact MIME', async t => {
  const {readArtifact}=await import('./worker.mjs')
  const root=await mkdtemp(join(tmpdir(),'mlcc-format-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const formats={POSCAR:'chemical/x-vasp-poscar',CONTCAR:'chemical/x-vasp-poscar','crystal.cif':'chemical/x-cif','molecule.pdb':'chemical/x-pdb','molecule.sdf':'chemical/x-mdl-sdfile','trajectory.extxyz':'chemical/x-xyz',XDATCAR:'chemical/x-vasp-xdatcar','trajectory.lammpstrj':'application/x-lammps-dump','density.cube':'chemical/x-cube',CHGCAR:'chemical/x-vasp-chgcar',ELFCAR:'chemical/x-vasp-elfcar',EIGENVAL:'chemical/x-vasp-eigenval',DOSCAR:'chemical/x-vasp-doscar','preview.gif':'image/gif','preview.webp':'image/webp','preview.jpeg':'image/jpeg','preview.avif':'image/avif','preview.htm':'text/html','preview.markdown':'text/markdown'}
  for(const [name,mimeType] of Object.entries(formats)){
    await writeFile(join(root,name),'format classification fixture')
    assert.equal((await readArtifact(root,name)).mimeType,mimeType,name)
  }
})

test('model tool calls run through allowlist and real results enter subsequent context', async () => {
  const { agentTurn }=await import('./worker.mjs')
  let turns=0;const calls=[];const events=[]
  const result=await agentTurn({messages:[{role:'user',content:'describe'}],tools:[{name:'mlcc_describe_operations',inputSchema:{type:'object'}}],
    complete:async ({messages})=>{turns++;if(turns===1)return {content:'',tool_calls:[{id:'tool1',type:'function',function:{name:'mlcc_describe_operations',arguments:'{}'}}]};assert.equal(messages.at(-1).role,'tool');assert.match(messages.at(-1).content,/actual/);return {content:'A real answer'}} ,
    callTool:async(name,args)=>{calls.push([name,args]);return {actual:true}},emit:async e=>events.push(e),signal:new AbortController().signal})
  assert.equal(result,'A real answer');assert.equal(calls.length,1);assert.ok(events.some(e=>e.type==='assistant.delta'))
})

test('unadvertised tool is rejected without execution', async()=>{
  const {agentTurn}=await import('./worker.mjs');let called=false
  await assert.rejects(agentTurn({messages:[],tools:[],complete:async()=>({tool_calls:[{id:'x',function:{name:'shell',arguments:'{}'}}]}),callTool:async()=>{called=true},emit:async()=>{},signal:new AbortController().signal}),/unavailable tool/i)
  assert.equal(called,false)
})

test('already cancelled turn makes no model or tool call',async()=>{
  const {agentTurn}=await import('./worker.mjs');const c=new AbortController();c.abort();let called=false
  await assert.rejects(agentTurn({messages:[],tools:[],complete:async()=>{called=true},callTool:async()=>{},emit:async()=>{},signal:c.signal}),/abort/i);assert.equal(called,false)
})

test('structured input creation stays in inputs and never overwrites existing files',async t=>{
  const {writeInput}=await import('./worker.mjs');assert.equal(typeof writeInput,'function')
  const root=await mkdtemp(join(tmpdir(),'mlcc-input-'));t.after(()=>rm(root,{recursive:true,force:true}))
  assert.equal((await writeInput(root,'circuit.json',{capacitance_F:1e-6})).path,'inputs/circuit.json')
  await assert.rejects(writeInput(root,'../site.json',{}));await assert.rejects(writeInput(root,'script.py',{}))
  await assert.rejects(writeInput(root,'circuit.json',{}))
})

test('artifact upload retries and repeated publication retain one stable file version id',async t=>{
  const {publishArtifact}=await import('./worker.mjs')
  const root=await mkdtemp(join(tmpdir(),'mlcc-publish-'));t.after(()=>rm(root,{recursive:true,force:true}))
  await writeFile(join(root,'report.txt'),'real bytes')
  const calls=[];let attempts=0
  const api=async()=>{throw new Error('legacy JSON artifact transport must not be used')}
  api.uploadArtifactStream=async({descriptor})=>{calls.push(descriptor);if(++attempts===1)throw new Error('response lost after server commit');return {artifact:{id:'saved'},relativePath:descriptor.relativePath,artifactId:descriptor.artifactId}}
  const job={id:'run1',leaseToken:'lease'}
  await publishArtifact(root,'report.txt',job,api,new AbortController().signal,0)
  await publishArtifact(root,'report.txt',job,api,new AbortController().signal,0)
  assert.equal(calls.length,3);assert.equal(new Set(calls.map(c=>c.artifactId)).size,1)
  assert.equal(calls[0].relativePath,'report.txt');assert.equal(calls[0].contentLength,10);assert.equal(typeof calls[0].contentSha256,'string');assert.equal('base64' in calls[0],false)
  await writeFile(join(root,'report.txt'),'new bytes')
  await publishArtifact(root,'report.txt',job,api,new AbortController().signal,0)
  assert.notEqual(calls.at(-1).artifactId,calls[0].artifactId)
})

test('stream transport sends raw bounded bytes with lease, size, sha and relative-path headers',async t=>{
  const {describeConfinedArtifact,uploadArtifactStream}=await import('./worker-artifact-transport.mjs')
  const root=await mkdtemp(join(tmpdir(),'mlcc-stream-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const contents=Buffer.alloc(140_000);for(let index=0;index<contents.length;index++)contents[index]=index%251
  const relativePath='100% calc result.markdown'
  await writeFile(join(root,relativePath),contents)
  const descriptor=await describeConfinedArtifact(root,relativePath);descriptor.artifactId='artifact-id'
  const originalFetch=global.fetch;let request
  t.after(()=>{global.fetch=originalFetch})
  global.fetch=async(url,options)=>{
    request={url,options,chunks:[]}
    for await(const chunk of options.body)request.chunks.push(Buffer.from(chunk))
    return new Response(JSON.stringify({artifact:{id:'saved'}}),{status:201,headers:{'content-type':'application/json'}})
  }
  const result=await uploadArtifactStream({apiOrigin:'https://worker.test',token:'worker-token'},{id:'run1',leaseToken:'lease-token'},root,descriptor,new AbortController().signal)
  assert.equal(request.url,'https://worker.test/worker/runs/run1/artifacts/stream')
  assert.equal(request.options.headers['Content-Length'],String(contents.byteLength))
  assert.equal(request.options.headers['X-MLCC-Artifact-SHA256'],descriptor.contentSha256)
  assert.equal(request.options.headers['X-MLCC-Artifact-Id'],'artifact-id')
  assert.equal(request.options.headers['X-MLCC-Artifact-Name'],encodeURIComponent(relativePath))
  assert.equal(request.options.headers['X-MLCC-Artifact-Path'],encodeURIComponent(relativePath))
  assert.equal(request.options.headers['X-MLCC-Artifact-Mime'],'text/markdown')
  assert.deepEqual(Buffer.concat(request.chunks),contents)
  assert.equal(result.relativePath,relativePath)
})

test('harvest publishes answer references first, deduplicates explicit files and never harvests failed or cancelled turns',async t=>{
  const {captureResultFileSnapshot}=await import('./artifact-harvest.mjs')
  const {harvestAndPublishArtifacts}=await import('./worker.mjs')
  const root=await mkdtemp(join(tmpdir(),'mlcc-harvest-worker-'));t.after(()=>rm(root,{recursive:true,force:true}))
  await mkdir(join(root,'outputs'))
  await writeFile(join(root,'outputs','already.svg'),'<svg>already published</svg>')
  const before=await captureResultFileSnapshot(root)
  await writeFile(join(root,'outputs','answer.svg'),'<svg>answer</svg>')
  for(let index=0;index<30;index++)await writeFile(join(root,'outputs',`changed-${String(index).padStart(2,'0')}.csv`),String(index))
  const calls=[]
  const api=async()=>{throw new Error('JSON transport must not be used')}
  api.uploadArtifactStream=async({descriptor})=>{calls.push(descriptor.relativePath);return {relativePath:descriptor.relativePath,artifactId:descriptor.artifactId}}
  const job={id:'run-harvest',leaseToken:'lease'}
  const completed=await harvestAndPublishArtifacts({root,job,api,signal:new AbortController().signal,before,assistantText:'结果见 outputs/answer.svg',excludedPaths:new Set(['outputs/already.svg'])})
  assert.equal(completed.skipped,false)
  assert.equal(calls[0],'outputs/answer.svg')
  assert.equal(calls.includes('outputs/already.svg'),false)
  assert.equal(calls.length,23) // one explicit result was already published; cap is 24 total
  assert.deepEqual(await harvestAndPublishArtifacts({root,job,api,signal:new AbortController().signal,before,status:'cancelled'}),{published:[],referenced:[],changed:[],skipped:true})
  assert.deepEqual(await harvestAndPublishArtifacts({root,job,api,signal:new AbortController().signal,before,status:'failed'}),{published:[],referenced:[],changed:[],skipped:true})
})

test('unknown scientific tool outcome ends the turn before the model can submit another job',async()=>{
  const {agentTurn}=await import('./worker.mjs');let turns=0,calls=0
  await assert.rejects(agentTurn({messages:[],tools:[{name:'mlcc_submit_calculation',inputSchema:{type:'object'}}],
    complete:async()=>{turns++;return {tool_calls:[{id:'s1',function:{name:'mlcc_submit_calculation',arguments:'{"task_id":"job1"}'}}]}},
    callTool:async()=>{calls++;throw Object.assign(new Error('Task job1 outcome unknown'),{code:'MLCC_TOOL_OUTCOME_UNKNOWN'})},emit:async()=>{},signal:new AbortController().signal}),/outcome unknown/)
  assert.equal(turns,1);assert.equal(calls,1)
})

test('agentTurn retains Responses output items for the next tool round without emitting reasoning',async()=>{
  const {agentTurn}=await import('./worker.mjs')
  const responsesOutput=[
    {type:'reasoning',id:'reasoning_1',encrypted_content:'reasoning-secret',summary:[]},
    {type:'message',id:'message_1',role:'assistant',content:[{type:'output_text',text:'I will inspect.'}]},
    {type:'function_call',id:'function_1',call_id:'call_1',name:'mlcc_describe_scales',arguments:'{}'},
  ]
  const calls=[];const events=[];let rounds=0
  const answer=await agentTurn({messages:[{role:'system',content:'system'},{role:'user',content:'inspect'}],tools:[{name:'mlcc_describe_scales',inputSchema:{type:'object'}}],
    complete:async({messages})=>{
      rounds++
      if(rounds===1)return {role:'assistant',content:'I will inspect.',tool_calls:[{id:'call_1',type:'function',function:{name:'mlcc_describe_scales',arguments:'{}'}}],responsesOutput}
      assert.deepEqual(messages.at(-2).responsesOutput,responsesOutput)
      assert.deepEqual(messages.at(-1),{role:'tool',tool_call_id:'call_1',content:'{"ok":true}'})
      return {role:'assistant',content:'CONNECTION_OK'}
    },
    callTool:async(name,args)=>{calls.push([name,args]);return {ok:true}},emit:async event=>events.push(event),signal:new AbortController().signal})
  assert.equal(answer,'I will inspect.\n\nCONNECTION_OK')
  assert.equal(rounds,2);assert.deepEqual(calls,[['mlcc_describe_scales',{}]])
  assert.doesNotMatch(JSON.stringify(events),/reasoning-secret/)
})

function validWorkerEnvironment(overrides={}) {
  return {
    MLCC_API_ORIGIN:'https://api.example.test/mlcc/api',
    MLCC_WORKER_TOKEN:'worker-token',
    MLCC_WORKSPACE_ROOT:'/srv/mlcc/workspaces',
    MLCC_BUNDLE_ROOT:'/srv/mlcc/runtime/mlcc-agent',
    MLCC_SITE_CONFIG:'/srv/mlcc/config/site.json',
    MLCC_PYTHON:'/srv/mlcc/runtime/bin/python',
    MLCC_MODEL_BASE_URL:'https://provider.example.test/v1',
    MLCC_MODEL:'gpt-6-astra',
    MLCC_MODEL_API_KEY:'model-key',
    ...overrides,
  }
}

test('workerConfig defaults and validates the explicit model API format',async()=>{
  const {workerConfig}=await import('./worker.mjs')
  assert.equal(workerConfig(validWorkerEnvironment()).apiFormat,'chat-completions')
  assert.equal(workerConfig(validWorkerEnvironment({MLCC_MODEL_API_FORMAT:'responses'})).apiFormat,'responses')
  assert.throws(()=>workerConfig(validWorkerEnvironment({MLCC_MODEL_API_FORMAT:'xml'})),/MLCC_MODEL_API_FORMAT/)
})

test('agentTurn stores partial text and never repeats streamed text on completion',async()=>{
  const {agentTurn}=await import('./worker.mjs')
  const events=[]
  let round=0
  const options={messages:[],tools:[{name:'inspect',inputSchema:{type:'object'}}],signal:new AbortController().signal,emit:async event=>events.push(event),callTool:async()=>({ok:true})}
  const answer=await agentTurn({...options,complete:async({onTextDelta})=>{
    if(++round===1){await onTextDelta('检查');return {content:'检查。',tool_calls:[{id:'x',function:{name:'inspect',arguments:'{}'}}]}}
    await onTextDelta('已');await onTextDelta('完成')
    return {content:'已完成'}
  }})
  assert.equal(answer,'检查。\n\n已完成')
  assert.equal(events.filter(e=>e.type==='assistant.delta').map(e=>e.text).join(''),answer)
  events.length=0
  await assert.rejects(agentTurn({...options,complete:async({onTextDelta})=>{
    await onTextDelta('收到');await onTextDelta('部分输出');throw Error('disconnected')
  }}),/disconnected/)
  assert.equal(events.map(e=>e.text).join(''),'收到部分输出')
})
