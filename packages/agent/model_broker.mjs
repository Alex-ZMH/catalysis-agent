// Isolated MLCC model bridge, launched before the workbench network filter.
import readline from 'node:readline';
import {completeChat} from '/home/v100/mlcc-independent/bin/model-client.mjs';
const env=process.env;
const tool={type:'function',function:{name:'fit_kinetics',description:'对用户选中的项目实验表执行动力学拟合',parameters:{type:'object',properties:{model:{type:'string',enum:['arrhenius_known_k','initial_rate_power_law']}},required:['model'],additionalProperties:false}}};
for await (const line of readline.createInterface({input:process.stdin,crlfDelay:Infinity})) {
 try {
  const request=JSON.parse(line);
  const result=await completeChat({apiFormat:env.MLCC_MODEL_API_FORMAT,baseUrl:env.MLCC_MODEL_BASE_URL,apiKey:env.MLCC_MODEL_API_KEY,model:env.MLCC_MODEL,signal:new AbortController().signal,
   messages:[{role:'system',content:'你是研究工作台智能体。用户要求动力学拟合时请调用工具，所选表格由本地工具读取。已知的历史拟合模型仅供参考；不得臆造列和单位。'},
    {role:'user',content:JSON.stringify(request)}],tools:[tool]});
  const call=result.tool_calls?.find(item=>item.function?.name==='fit_kinetics');
  if (!call) throw new Error('模型没有调用动力学拟合工具');
  const args=JSON.parse(call.function.arguments);
  if (!['arrhenius_known_k','initial_rate_power_law'].includes(args.model)) throw new Error('模型请求的拟合模型不支持');
  console.log(JSON.stringify({ok:true,model:env.MLCC_MODEL,tool:'fit_kinetics',arguments:args,call_id:call.id}));
 } catch(e) { console.log(JSON.stringify({ok:false,error:String(e.message||'模型请求失败').slice(0,500)})); }
}
