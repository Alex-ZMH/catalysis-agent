// Isolated MLCC model bridge, launched before the workbench network filter.
import readline from 'node:readline';
import {completeChat} from './model-client.mjs';
import chat from '../../apps/web/electrochem/chat.js';
const env=process.env;
const prefix=Object.keys(env).some(key=>key==='CATALYSIS_MODEL'||key.startsWith('CATALYSIS_MODEL_'))?'CATALYSIS_MODEL':'MLCC_MODEL';
const model=env[prefix], baseUrl=env[`${prefix}_BASE_URL`], apiKey=env[`${prefix}_API_KEY`];
const tool={type:'function',function:{name:'fit_kinetics',description:'对用户选中的项目实验表执行动力学拟合',parameters:{type:'object',properties:{model:{type:'string',enum:['arrhenius_known_k','initial_rate_power_law']}},required:['model'],additionalProperties:false}}};
const destinations=['her','oer','structure','unsupported'];
const planner={type:'function',function:{name:'select_electrochem_tool',description:'选择工作台工具，不运行计算',parameters:{type:'object',properties:{tool:{type:'string',enum:destinations}},required:['tool'],additionalProperties:false}}};
const controllers = new Map();
const calculator = {type:'function', function:{name:'calculate_che', description:'用户要求计算且已提供完整数据时运行 CHE；每个值必须原样引用用户给出的带单位数值，不猜测、不填默认值。',parameters:{
  type:'object',properties:{reaction:{type:'string',enum:['her','oer']},
    potential:{type:'string',description:'从用户消息逐字摘录电位，例如 1.23 V vs RHE'},
    energies:{type:'array',items:{type:'string'},description:'逐字摘录 0 V 下的形成自由能（含 eV），HER 为 H*，OER 按 OH*、O*、OOH* 顺序'}},
  required:['reaction','potential','energies'],additionalProperties:false}}};
function fromEvidence(value, pattern, messages) {
  if (typeof value !== 'string') return NaN;
  const match = pattern.exec(value);
  if (!match) return NaN;
  const valid = messages.some(text => {
    for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + 1)) {
      if (!/[\d.+\-−]/.test(text[at-1] || '') && !/[a-zA-Z0-9/]/.test(text[at+value.length] || '')) return true;
    }
    return false;
  });
  return valid ? Number(match[1].replace('−','-')) : NaN;
}
async function converse(request, signal) {
  const turns = request.previous ? [{ reply: request.previous }] : [];
  const local = chat.localReply(request.question, turns);
  if (local.plot) return local;
  const instructions = '你是电催化研究助手，直接用中文回答问题并结合对话上下文。普通机理问题直接作答。用户要求算 HER/OER 且给齐带单位的电位和自由能时，必须调用 calculate_che，逐字引用输入，由工具计算和绘图；不要自行给出未执行的结果。只有想打开查看器或缺少输入时才用 select_electrochem_tool。不虚构文件或数据，不提交集群作业。';
  const response = await completeChat({apiFormat:env[prefix+'_API_FORMAT'], baseUrl, apiKey, model, signal,
    messages:[{role:'system',content:instructions},...request.messages,{role:'user',content:request.question}],tools:[planner,calculator]});
  const calculate = response.tool_calls?.find(item=>item.function?.name==='calculate_che');
  if (calculate) {
    const args = JSON.parse(calculate.function.arguments);
    const sources = [...request.messages.filter(message => message.role==='user').map(message => message.content), request.question];
    const potential = fromEvidence(args.potential, /^([+\-−]?\d+(?:\.\d+)?)\s*V\s*(?:vs\.?\s*)?RHE$/i, sources);
    const energies = Array.isArray(args.energies) ? args.energies.map(value =>
      fromEvidence(value, /^([+\-−]?\d+(?:\.\d+)?)\s*eV$/i, sources)) : [];
    if (!['her','oer'].includes(args.reaction) || energies.length !== (args.reaction === 'her' ? 1 : 3)
        || ![potential,...energies].every(value=>Number.isFinite(value) && Math.abs(value)<=1000))
      return {mode:'model',model,text:'未运行：请明确电位及其 RHE 参照，并给出每个中间体在 0 V 下的形成自由能（eV）。',tool:null};
    return {...chat.calculated(args.reaction,[potential,...energies],false),mode:'model',model,invokedTool:'calculate_che'};
  }
  const call = response.tool_calls?.find(item=>item.function?.name==='select_electrochem_tool');
  const choice = call && JSON.parse(call.function.arguments)?.tool;
  const tool = ['her','oer','structure'].includes(choice) ? choice : null;
  const text = response.content?.trim() || (tool && chat.localReply({her:'析氢',oer:'析氧',structure:'XYZ'}[tool], []).text);
  if (!text) throw new Error('模型没有返回可显示的回复。');
  return {mode:'model', model, text:text.slice(0,19000), tool};
}
async function dispatch(request) {
 try {
  if (!model || !baseUrl || !apiKey) throw new Error('模型配置缺少模型名、服务地址或凭据。');
  if (request.mode === 'info') {
    console.log(JSON.stringify({ok:true,model,format:env[prefix+'_API_FORMAT'] || 'chat-completions'}));
    return;
  }
  if (request.mode === 'chat') {
    const controller = new AbortController();
    controllers.set(request.token, controller);
    try { console.log(JSON.stringify({ok:true,reply:await converse(request, controller.signal)})); }
    finally { controllers.delete(request.token); }
    return;
  }
  const planning=request.mode==='electrochem';
  const action=planning?planner:tool;
  const instructions=planning?'你是电催化研究助手。只选择一个工具：her 或 oer 用于单电子步 CHE 热力学自由能与理论过电位；structure 用于单帧 XYZ 原子坐标预览。涉及能垒、动力学、选择性、材料推荐或不确定时选 unsupported。不要提供数值或猜测输入。':'你是电催化研究助手。用户要求动力学拟合时请调用工具，所选表格由本地工具读取。已知的历史拟合模型仅供参考；不得臆造列、单位或实验结果。';
  const result=await completeChat({apiFormat:env[`${prefix}_API_FORMAT`],baseUrl,apiKey,model,signal:new AbortController().signal,
   messages:[{role:'system',content:instructions},
    {role:'user',content:planning?request.instruction:JSON.stringify(request)}],tools:[action]});
  const call=result.tool_calls?.find(item=>item.function?.name===action.function.name);
  if (!call) throw new Error('模型未返回所需的工具调用');
  const args=JSON.parse(call.function.arguments);
  if (planning ? !destinations.includes(args?.tool) : !['arrhenius_known_k','initial_rate_power_law'].includes(args?.model)) throw new Error('不支持模型请求的工具参数');
  console.log(JSON.stringify({ok:true,model,tool:action.function.name,arguments:planning?{tool:args.tool}:{model:args.model},call_id:call.id}));
 } catch(e) { console.log(JSON.stringify({ok:false,error:String(e.message||'模型请求失败').slice(0,500)})); }
}
for await (const line of readline.createInterface({input:process.stdin,crlfDelay:Infinity})) {
  const request = JSON.parse(line);
  if (request.mode === 'cancel') controllers.get(request.token)?.abort();
  else void dispatch(request);
}
