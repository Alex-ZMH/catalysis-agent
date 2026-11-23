// The independent worker calls the configured model supplier directly. No
// platform token, catalog, provider session or MatterAI/Zeus model proxy participates.
const MAX_RESPONSE_BYTES=2*1024*1024
const MAX_PROVIDER_ERROR_BYTES=64*1024

export class ModelServiceError extends Error {
  constructor(status,message,providerCode='') {
    super(message)
    this.name='ModelServiceError'
    this.status=status
    this.providerCode=providerCode
  }
}

function safeProviderText(value,apiKey='') {
  let text=typeof value==='string'?value:''
  if(apiKey)text=text.split(apiKey).join('[redacted]')
  return text.replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,500)
}

function providerErrorDetails(raw,apiKey) {
  let data
  try { data=JSON.parse(raw) } catch { return {code:'',message:''} }
  const detail=data?.error&&typeof data.error==='object'?data.error:data
  const code=safeProviderText(detail?.code||detail?.type,apiKey)
  const message=safeProviderText(detail?.message||detail?.detail,apiKey)
  return {code,message}
}

function modelApiFormat(value) {
  const format=value||'chat-completions'
  if(format!=='chat-completions'&&format!=='responses')throw new Error('MLCC_MODEL_API_FORMAT must be responses or chat-completions')
  return format
}

function responseTool(tool) {
  const fn=tool?.function||tool||{}
  return {
    type:'function',
    name:fn.name,
    description:fn.description||fn.name,
    parameters:fn.parameters,
    strict:false,
  }
}

function responseContent(value) {
  if(typeof value==='string')return value
  if(value===undefined||value===null)return ''
  return JSON.stringify(value)
}

export function responsesInputFromMessages(messages=[]) {
  const input=[]
  for(const message of messages) {
    if(!message||typeof message!=='object')continue
    if(Array.isArray(message.responsesOutput)) {
      input.push(...message.responsesOutput)
      continue
    }
    if(message.role==='tool') {
      input.push({type:'function_call_output',call_id:message.tool_call_id,output:responseContent(message.content)})
      continue
    }
    if(message.role==='assistant'&&Array.isArray(message.tool_calls)&&message.tool_calls.length) {
      if(message.content!==undefined&&message.content!==null&&message.content!=='')input.push({role:'assistant',content:message.content})
      for(const call of message.tool_calls) {
        const fn=call?.function||call||{}
        const callId=call?.id||call?.call_id
        input.push({
          type:'function_call',
          ...(callId?{call_id:callId}:{}),
          name:fn.name,
          arguments:responseContent(fn.arguments),
        })
      }
      continue
    }
    if(typeof message.role!=='string')continue
    input.push({role:message.role,content:message.content??''})
  }
  return input
}

function responseOutputMessage(data) {
  const output=Array.isArray(data.output)?data.output:[]
  const text=[]
  const toolCalls=[]
  for(const item of output) {
    if(item?.type==='message') {
      const content=Array.isArray(item.content)?item.content:[]
      for(const part of content) {
        if(part?.type==='output_text'&&typeof part.text==='string')text.push(part.text)
        else if(part?.type==='refusal'&&typeof part.refusal==='string')text.push(part.refusal)
      }
      if(typeof item.content==='string')text.push(item.content)
    } else if(item?.type==='function_call') {
      const id=item.call_id||item.id||''
      toolCalls.push({id,type:'function',function:{name:item.name,arguments:responseContent(item.arguments)}})
    }
  }
  const content=text.length?text.join(''):(typeof data.output_text==='string'?data.output_text:'')
  return {role:'assistant',content:content||null,tool_calls:toolCalls,responsesOutput:output}
}

async function readResponseText(response,maximumBytes) {
  if(!response.body)return {raw:'',truncated:false}
  let raw='',bytes=0
  let truncated=false
  const decoder=new TextDecoder()
  for await(const chunk of response.body) {
    const size=chunk.byteLength??chunk.length??0
    const remaining=maximumBytes-bytes
    if(remaining<=0){truncated=true;break}
    const selected=size>remaining?chunk.subarray(0,remaining):chunk
    bytes+=selected.byteLength??selected.length??0
    raw+=decoder.decode(selected,{stream:true})
    if(size>remaining){truncated=true;break}
  }
  return {raw:raw+decoder.decode(),truncated}
}

async function* serverSentData(body) {
  const decoder=new TextDecoder()
  let buffer='', bytes=0
  const lines=[]
  function dataLine(line) {
    if(line.endsWith('\r'))line=line.slice(0,-1)
    if(line==='')return lines.splice(0).join('\n')
    if(line.startsWith('data:'))lines.push(line.slice(5).replace(/^ /,''))
  }
  for await(const chunk of body) {
    bytes+=chunk.byteLength
    if(bytes>MAX_RESPONSE_BYTES*8)throw new Error('Model stream exceeded limit')
    buffer+=decoder.decode(chunk,{stream:true})
    let end
    while((end=buffer.indexOf('\n'))!==-1) {
      const data=dataLine(buffer.slice(0,end))
      buffer=buffer.slice(end+1)
      if(data)yield data
    }
  }
  dataLine(buffer+decoder.decode())
  const last=dataLine('')
  if(last)yield last
}

async function readStream(response,format,onTextDelta,apiKey) {
  let content='',finish=null
  const calls=[]
  for await(const raw of serverSentData(response.body)) {
    if(raw==='[DONE]')break
    const event=JSON.parse(raw)
    if(event.type==='error'||event.error)throw new ModelServiceError(response.status,safeProviderText(event.error?.message||event.message,apiKey)||'Model stream failed')
    if(format==='responses') {
      if(event.type==='response.output_text.delta'||event.type==='response.refusal.delta')await onTextDelta(event.delta||'')
      if(['response.completed','response.failed','response.incomplete'].includes(event.type))return event.response
    } else {
      const choice=event.choices?.[0]
      if(!choice)continue
      const delta=choice.delta||{}
      const text=delta.content||delta.refusal||''
      if(text){content+=text;await onTextDelta(text)}
      for(const item of delta.tool_calls||[]) {
        const call=calls[item.index]??={id:'',type:'function',function:{name:'',arguments:''}}
        call.id+=item.id||''
        call.function.name+=item.function?.name||''
        call.function.arguments+=item.function?.arguments||''
      }
      if(choice.finish_reason)finish=choice.finish_reason
    }
  }
  if(format==='chat-completions'&&finish)return {choices:[{message:{role:'assistant',content,tool_calls:calls},finish_reason:finish}]}
  throw new Error('Model stream ended before completion')
}

export async function completeChat({apiFormat='chat-completions',baseUrl, apiKey, model, messages, tools, signal, onTextDelta}) {
  const format=modelApiFormat(apiFormat)
  const requestBody=format==='responses'
    ? {model,input:responsesInputFromMessages(messages),tools:tools.length?tools.map(responseTool):undefined,store:false,stream:Boolean(onTextDelta),max_output_tokens:4096,include:['reasoning.encrypted_content']}
    : {model,messages,tools:tools.length?tools:undefined,stream:Boolean(onTextDelta),max_tokens:4096}
  if(format==='chat-completions'&&typeof model==='string'&&/^qwen/i.test(model))requestBody.enable_thinking=false
  const response = await fetch(baseUrl.replace(/\/$/,'')+(format==='responses'?'/responses':'/chat/completions'), {
    method:'POST',headers:{'Authorization':`Bearer ${apiKey}`,'Content-Type':'application/json'},
    body:JSON.stringify(requestBody),
    signal:AbortSignal.any([signal,AbortSignal.timeout(120_000)])
  })
  if (!response.ok) {
    const {raw}=await readResponseText(response,MAX_PROVIDER_ERROR_BYTES)
    const detail=providerErrorDetails(raw,apiKey)
    if(detail.code.toLowerCase()==='arrearage')throw new ModelServiceError(response.status,`当前模型账户欠费或额度状态异常，请恢复额度后重试。（Arrearage；HTTP ${response.status}）`,detail.code)
    const code=detail.code?` (${detail.code})`:''
    const message=detail.message?`: ${detail.message}`:''
    throw new ModelServiceError(response.status,`Model service returned HTTP ${response.status}${code}${message}`,detail.code)
  }
  let data
  if(onTextDelta&&response.headers.get('content-type')?.includes('text/event-stream')) {
    data=await readStream(response,format,onTextDelta,apiKey)
  } else {
    const {raw,truncated}=await readResponseText(response,MAX_RESPONSE_BYTES)
    if(truncated)throw new Error('Model response exceeded limit')
    data=JSON.parse(raw)
  }
  const choice=data.choices?.[0]
  if(format==='responses') {
    if(data.status==='failed') {
      const detail=safeProviderText(data.error?.message||data.error?.code,apiKey)
      throw new ModelServiceError(response.status,`Model response failed${detail?`: ${detail}`:''}`,safeProviderText(data.error?.code,apiKey))
    }
    if(data.status==='incomplete') {
      const detail=safeProviderText(data.incomplete_details?.reason||data.error?.message,apiKey)
      throw new ModelServiceError(response.status,`Model response incomplete${detail?`: ${detail}`:''}`)
    }
    if(data.status!=='completed') {
      const status=safeProviderText(data.status,apiKey)||'missing'
      throw new ModelServiceError(response.status,`Model response status ${status} is not completed`)
    }
    const message=responseOutputMessage(data)
    if(!message.content&&!message.tool_calls.length)throw new Error('Model service returned no answer')
    return message
  }
  if (!choice?.message) throw new Error('Model service returned no answer')
  if (choice.finish_reason==='length') throw new Error('Model answer reached its output limit; narrow the question and retry')
  return {
    role:choice.message.role||'assistant',
    content:typeof choice.message.content==='string'?choice.message.content:(typeof choice.message.refusal==='string'?choice.message.refusal:null),
    tool_calls:Array.isArray(choice.message.tool_calls)?choice.message.tool_calls:[],
  }
}
