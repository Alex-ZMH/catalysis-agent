import test from 'node:test'
import assert from 'node:assert/strict'
import {McpClient} from './mcp-client.mjs'

const fixture=`const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(!m.id)return;let result;if(m.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};if(m.method==='tools/list')result={tools:[{name:'read_only',inputSchema:{type:'object'}}]};if(m.method==='tools/call')result={content:[{type:'text',text:JSON.stringify(m.params)}]};if(result)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')})`

test('MCP client negotiates JSON-lines protocol and returns actual tool result',async()=>{
  const client=new McpClient({command:process.execPath,args:['-e',fixture],env:{}})
  try{assert.equal((await client.initialize())[0].name,'read_only');const result=await client.call('read_only',{question:'极化'});assert.match(result.content[0].text,/极化/)}finally{client.close()}
})

test('cancellation ends a waiting MCP request without replaying it',async()=>{
  const controller=new AbortController();const client=new McpClient({command:process.execPath,args:['-e',fixture],env:{},signal:controller.signal})
  try{await client.initialize();const pending=client.request('blocked');controller.abort();await assert.rejects(pending,/aborted/);assert.equal(client.closed,true)}finally{client.close()}
})

test('a broken MCP input pipe rejects the pending operation without crashing the worker',async()=>{
  const client=new McpClient({command:process.execPath,args:['-e',fixture],env:{}})
  try{
    await client.initialize()
    const pending=client.request('blocked')
    client.child.stdin.emit('error',Object.assign(new Error('broken pipe'),{code:'EPIPE'}))
    await assert.rejects(pending,/input failed/)
    assert.equal(client.closed,true)
  }finally{client.close()}
})
