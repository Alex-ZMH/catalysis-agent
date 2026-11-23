import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {completeChat} from './model-client.mjs'

test('model response preserves Chinese characters across network chunk boundaries',async t=>{
  const server=createServer((req,res)=>{req.resume();req.on('end',()=>{res.setHeader('Content-Type','application/json');const data=Buffer.from(JSON.stringify({choices:[{message:{role:'assistant',content:'极化畴与电场'},finish_reason:'stop'}]}));let i=0;const timer=setInterval(()=>{if(i>=data.length){clearInterval(timer);res.end()}else res.write(data.subarray(i,i+=1))},1)})})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
  const result=await completeChat({baseUrl:`http://127.0.0.1:${server.address().port}`,apiKey:'test',model:'fixture',messages:[],tools:[],signal:new AbortController().signal})
  assert.equal(result.content,'极化畴与电场')
})

test('model provider errors expose bounded code and message without request identifiers',async t=>{
  const server=createServer((req,res)=>{req.resume();req.on('end',()=>{res.statusCode=400;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:{message:'Access denied; account overdue.',type:'Arrearage',code:'Arrearage'},request_id:'provider-request-secret'}))})})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
  await assert.rejects(
    completeChat({baseUrl:`http://127.0.0.1:${server.address().port}`,apiKey:'test',model:'fixture',messages:[],tools:[],signal:new AbortController().signal}),
    error=>{assert.equal(error.name,'ModelServiceError');assert.equal(error.status,400);assert.equal(error.providerCode,'Arrearage');assert.match(error.message,/HTTP 400/);assert.match(error.message,/账户欠费或额度状态异常/);assert.doesNotMatch(error.message,/provider-request-secret/);return true},
  )
})


test('unexpected provider error messages redact the configured credential',async t=>{
  const server=createServer((req,res)=>{req.resume();req.on('end',()=>{res.statusCode=401;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:{message:'Invalid credential private-key-fixture',type:'InvalidApiKey'},request_id:'hidden-request'}))})})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
  await assert.rejects(completeChat({baseUrl:`http://127.0.0.1:${server.address().port}`,apiKey:'private-key-fixture',model:'fixture',messages:[],tools:[],signal:new AbortController().signal}),error=>{assert.match(error.message,/InvalidApiKey/);assert.match(error.message,/redacted/);assert.doesNotMatch(error.message,/private-key-fixture|hidden-request/);return true})
})

test('gpt-6-astra omits enable_thinking while Qwen keeps it false',async t=>{
  const requests=[]
  const server=createServer((req,res)=>{
    let raw=''
    req.setEncoding('utf8')
    req.on('data',chunk=>{raw+=chunk})
    req.on('end',()=>{
      requests.push(JSON.parse(raw))
      res.setHeader('Content-Type','application/json')
      res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'ok'},finish_reason:'stop'}]}))
    })
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
  const baseUrl=`http://127.0.0.1:${server.address().port}`
  const request={baseUrl,apiKey:'test',messages:[],tools:[],signal:new AbortController().signal}
  await completeChat({...request,model:'gpt-6-astra'})
  await completeChat({...request,model:'qwen3.8-max'})
  assert.equal(Object.hasOwn(requests[0],'enable_thinking'),false)
  assert.equal(requests[1].enable_thinking,false)
})

test('Responses preserves reasoning and function calls across a two-round tool turn',async t=>{
  const requests=[]
  const firstOutput=[
    {type:'reasoning',id:'reasoning_1',encrypted_content:'reasoning-secret',summary:[]},
    {type:'message',id:'message_1',role:'assistant',status:'completed',content:[{type:'output_text',text:'I will inspect.'}]},
    {type:'function_call',id:'function_1',call_id:'call_1',name:'mlcc_describe_scales',arguments:'{}',status:'completed'},
  ]
  const server=createServer((req,res)=>{
    let raw=''
    req.setEncoding('utf8')
    req.on('data',chunk=>{raw+=chunk})
    req.on('end',()=>{
      requests.push({url:req.url,body:JSON.parse(raw)})
      res.setHeader('Content-Type','application/json')
      const output=requests.length===1
        ? firstOutput
        : [{type:'message',id:'message_2',role:'assistant',status:'completed',content:[{type:'output_text',text:'CONNECTION_OK'}]}]
      res.end(JSON.stringify({id:`response_${requests.length}`,status:'completed',output}))
    })
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
  const baseUrl=`http://127.0.0.1:${server.address().port}`
  const tools=[{type:'function',function:{name:'mlcc_describe_scales',description:'Describe scales',parameters:{type:'object',properties:{},additionalProperties:false}}}]
  const first=await completeChat({apiFormat:'responses',baseUrl,apiKey:'test',model:'gpt-6-astra',messages:[{role:'system',content:'system'},{role:'user',content:'inspect'}],tools,signal:new AbortController().signal})
  assert.equal(requests[0].url,'/responses')
  assert.equal(requests[0].body.store,false)
  assert.equal(requests[0].body.stream,false)
  assert.equal(requests[0].body.max_output_tokens,4096)
  assert.deepEqual(requests[0].body.include,['reasoning.encrypted_content'])
  assert.equal(Object.hasOwn(requests[0].body,'reasoning_effort'),false)
  assert.equal(Object.hasOwn(requests[0].body,'enable_thinking'),false)
  assert.deepEqual(requests[0].body.tools,[{type:'function',name:'mlcc_describe_scales',description:'Describe scales',parameters:{type:'object',properties:{},additionalProperties:false},strict:false}])
  assert.equal(first.content,'I will inspect.')
  assert.deepEqual(first.tool_calls,[{id:'call_1',type:'function',function:{name:'mlcc_describe_scales',arguments:'{}'}}])
  assert.equal(first.responsesOutput[0].encrypted_content,'reasoning-secret')
  const second=await completeChat({apiFormat:'responses',baseUrl,apiKey:'test',model:'gpt-6-astra',messages:[
    {role:'system',content:'system'},
    {role:'user',content:'inspect'},
    {role:'assistant',content:first.content,tool_calls:first.tool_calls,responsesOutput:first.responsesOutput},
    {role:'tool',tool_call_id:'call_1',content:'{"ok":true}'},
  ],tools,signal:new AbortController().signal})
  assert.deepEqual(requests[1].body.input,[
    {role:'system',content:'system'},
    {role:'user',content:'inspect'},
    ...firstOutput,
    {type:'function_call_output',call_id:'call_1',output:'{"ok":true}'},
  ])
  assert.equal(second.content,'CONNECTION_OK')
})

test('Responses converts legacy assistant tool calls and tool history',async t=>{
  let request
  const server=createServer((req,res)=>{
    let raw=''
    req.setEncoding('utf8')
    req.on('data',chunk=>{raw+=chunk})
    req.on('end',()=>{
      request=JSON.parse(raw)
      res.setHeader('Content-Type','application/json')
      res.end(JSON.stringify({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'ok'}]}]}))
    })
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
  await completeChat({apiFormat:'responses',baseUrl:`http://127.0.0.1:${server.address().port}`,apiKey:'test',model:'gpt-6-astra',messages:[
    {role:'system',content:'system'},
    {role:'user',content:'inspect'},
    {role:'assistant',content:'',tool_calls:[{id:'legacy_call',type:'function',function:{name:'mlcc_describe_scales',arguments:'{"scale":"atomic"}'}}]},
    {role:'tool',tool_call_id:'legacy_call',content:'done'},
  ],tools:[],signal:new AbortController().signal})
  assert.deepEqual(request.input,[
    {role:'system',content:'system'},
    {role:'user',content:'inspect'},
    {type:'function_call',call_id:'legacy_call',name:'mlcc_describe_scales',arguments:'{"scale":"atomic"}'},
    {type:'function_call_output',call_id:'legacy_call',output:'done'},
  ])
})

test('Responses rejects incomplete output before exposing tool calls',async t=>{
  const server=createServer((req,res)=>{req.resume();req.on('end',()=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output:[{type:'function_call',call_id:'unsafe_call',name:'mlcc_submit_calculation',arguments:'{}'}]}))})})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
  await assert.rejects(
    completeChat({apiFormat:'responses',baseUrl:`http://127.0.0.1:${server.address().port}`,apiKey:'test',model:'gpt-6-astra',messages:[],tools:[],signal:new AbortController().signal}),
    /Model response incomplete.*max_output_tokens/,
  )
})

test('Responses rejects every non-completed status before exposing tool calls',async t=>{
  const statuses=['queued','in_progress','cancelled',undefined]
  let index=0
  const server=createServer((req,res)=>{req.resume();req.on('end',()=>{const status=statuses[index++];res.setHeader('Content-Type','application/json');res.end(JSON.stringify({...(status===undefined?{}:{status}),output:[{type:'function_call',call_id:'unsafe_call',name:'mlcc_submit_calculation',arguments:'{}'}]}))})})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
  for(const status of statuses) {
    await assert.rejects(
      completeChat({apiFormat:'responses',baseUrl:`http://127.0.0.1:${server.address().port}`,apiKey:'test',model:'gpt-6-astra',messages:[],tools:[],signal:new AbortController().signal}),
      /Model response status .*completed/,
      status,
    )
  }
})

test('model client rejects an unknown API format',async()=>{
  await assert.rejects(
    completeChat({apiFormat:'xml',baseUrl:'http://127.0.0.1:1',apiKey:'test',model:'fixture',messages:[],tools:[],signal:new AbortController().signal}),
    /MLCC_MODEL_API_FORMAT/,
  )
})

test('Responses delivers text before completion and preserves the terminal tool call',async t=>{
  let unlock
  const seen=new Promise(resolve=>{unlock=resolve})
  const server=createServer(async(req,res)=>{
    for await(const _ of req){}
    res.writeHead(200,{'Content-Type':'text/event-stream'})
    const frame=data=>'data: '+JSON.stringify(data)+'\r\n\r\n'
    const first=Buffer.from(frame({type:'response.output_text.delta',delta:'氢'}))
    const split=first.indexOf(Buffer.from('氢'))+1
    res.write(first.subarray(0,split))
    res.write(first.subarray(split))
    await seen
    const output=[{type:'message',content:[{type:'output_text',text:'氢'}]},{type:'function_call',call_id:'c1',name:'calculate_che',arguments:'{}'}]
    res.end(frame({type:'response.completed',response:{status:'completed',output}}))
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(()=>new Promise(resolve=>server.close(resolve)))
  const chunks=[]
  const result=await completeChat({baseUrl:'http://127.0.0.1:'+server.address().port,apiKey:'test',apiFormat:'responses',model:'fixture',messages:[],tools:[],signal:AbortSignal.timeout(5000),onTextDelta:text=>{chunks.push(text);unlock()}})
  assert.deepEqual(chunks,['氢'])
  assert.equal(result.tool_calls[0].function.name,'calculate_che')
})
