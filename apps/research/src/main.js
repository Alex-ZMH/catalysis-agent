import './style.css';
import './studio-theme.css';
import {renderChatWorkbench, examplePrompt} from './chat-workbench.js';
import {createChatHistory} from './chat-history.js';
import './artifact-panel.css';
import {createArtifactPanel} from './artifact-panel.js';
import {renderMarkdown} from './markdown.js';
import '../../web/electrochem/rich-text.css';
import {startServiceStatusRefresh} from './service-status-refresh.js';
import {canStartSubmission, cursorFromRun, hasSubmittedPair, recoverableRun, restorePromptAfterAuth} from './chat-state.js';

const paths={clip:'m8 14 7-7a2.2 2.2 0 0 1 3 3l-8 8a4 4 0 0 1-6-6l9-9a5.7 5.7 0 0 1 8 8l-9 9',arrow:'M5 12h14m-6-6 6 6-6 6',diagonal:'M6 18 18 6M6 6h12v12',layers:'m12 3 10 5-10 5L2 8l10-5Zm-10 9 10 5 10-5M2 16l10 5 10-5',plus:'M12 5v14M5 12h14',close:'m6 6 12 12M6 18 18 6',send:'m4 12 16-8-8 16-1-7-7-1Zm7 1 9-9',menu:'M4 6h16M4 12h16M4 18h16',check:'m5 12 4 4 10-10',chip:'M7 7h10v10H7zM9 2v5m6-5v5M9 17v5m6-5v5M2 9h5m-5 6h5m10-6h5m-5 6h5',spark:'m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5L12 2Z',stop:'M6 6h12v12H6z',book:'M12 5v16M3 3l9 2 9-2v16l-9 2-9-2z',info:'M12 11v6m0-10v.1M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',download:'M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4'};
const icon=(name,cls='')=>`<svg class="icon ${cls}" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name]||paths.spark}"/></svg>`;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const mark=`<span class="brand-mark">${icon('layers')}</span>`;
let state={authenticated:false,user:null,ownerId:'',chats:[],chatId:null,messages:[],serverStatus:'checking',activeRun:null,submitInFlight:false,pollTimer:null,after:0,pollFailures:0};
let localStorageRef;
try { localStorageRef=window.localStorage; } catch {}
const history=createChatHistory(localStorageRef);
let sendAfterLogin=false;
let authMode='login';

document.querySelector('#app').innerHTML=`
${renderChatWorkbench({icon,mark})}
<dialog id="login-dialog" class="modal"><form id="login-form"><div class="modal-top"><span class="eyebrow">电催化 STUDIO</span><button type="button" data-close class="icon-button" aria-label="关闭登录">${icon('close')}</button></div>${mark}<h2 id="auth-title">登录 电催化</h2><p id="auth-description">登录独立电催化研究服务，继续你的对话。</p><label id="auth-name-label" for="auth-name" hidden>姓名</label><input id="auth-name" name="name" type="text" autocomplete="name" maxlength="80" placeholder="输入姓名" hidden><label for="login-contact">邮箱或手机号</label><input id="login-contact" name="contact" type="text" autocomplete="username" required placeholder="输入登录账号"><label for="login-password">密码</label><input id="login-password" name="password" type="password" autocomplete="current-password" required minlength="10" placeholder="至少 10 位密码"><label id="invite-code-label" for="invite-code" hidden>邀请码</label><input id="invite-code" name="inviteCode" type="text" autocomplete="off" maxlength="120" placeholder="输入管理员提供的邀请码" hidden><p id="login-error" class="form-error" role="alert" hidden></p><button type="submit" class="button primary full-width" id="login-submit">登录并继续 ${icon('arrow')}</button><p class="auth-switch"><span id="auth-switch-text">还没有独立账号？</span> <button id="auth-toggle" type="button" class="text-link">使用邀请码注册</button></p><small id="auth-note">电催化 使用独立账号、对话记录和 V100 研究服务。密码至少 10 位；注册需要邀请码。</small></form></dialog>
<dialog id="artifact-dialog" class="artifact-panel" aria-label="研究结果预览"><div id="artifact-preview-root"></div></dialog>
<div id="toast" class="toast" role="status" hidden></div>`;

const $=s=>document.querySelector(s);
document.body.classList.add('studio-open');
$('#studio').hidden=false;
const baseUrl=import.meta.env.BASE_URL;
const apiUrl=path=>`${baseUrl}api${path}`;
const artifactPanel=createArtifactPanel({dialog:$('#artifact-dialog'),apiBase:apiUrl(''),getScope:()=>`${state.ownerId}:${state.chatId}`,getArtifacts:()=>state.messages.flatMap(message=>message.artifacts||[]),onAuthExpired:()=>{expireSession();$('#login-dialog').showModal();}});
$('#sidebar-toggle').addEventListener('click',()=>setSidebar(!$('#studio').classList.contains('sidebar-open')));
function setSidebar(open){$('#studio').classList.toggle('sidebar-open',open);$('#sidebar-toggle').setAttribute('aria-expanded',String(open));$('#sidebar-toggle').setAttribute('aria-label',open?'收起对话导航':'展开对话导航');}
window.addEventListener('keydown',e=>{if(e.key==='Escape'){setSidebar(false);if($('#artifact-dialog').open&&!$('#artifact-dialog').matches(':modal'))artifactPanel.hide();}});
function fillPrompt(prompt){$('#message-input').value=prompt;resizeComposer();saveDraft();$('#message-input').focus();}
document.querySelectorAll('[data-example]').forEach(button=>button.addEventListener('click',()=>{fillPrompt(examplePrompt(button.dataset.example));$('#message-form').scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'center'});}));
for(const dialog of document.querySelectorAll('dialog')){dialog.querySelector('[data-close]')?.addEventListener('click',()=>dialog.close());dialog.addEventListener('click',e=>{if(e.target===dialog)dialog.close();});}
window.addEventListener('hashchange',()=>{if(location.hash!=='#studio')closeArtifactPreview();});

function clearNoticeActions(){document.querySelectorAll('#studio-notice button').forEach(button=>button.remove());}
function notice(text){clearNoticeActions();$('#studio-notice').textContent=text;$('#studio-notice').hidden=!text;}
function appendNoticeAction(id,text,handler){const button=document.createElement('button');button.id=id;button.type='button';button.className='text-link';button.textContent=text;button.addEventListener('click',handler);$('#studio-notice').append(' ',button);}
function showRetryNotice(text,handler){notice(text);appendNoticeAction('status-retry','重新检查服务',handler);}
function toast(text){$('#toast').textContent=text;$('#toast').hidden=false;setTimeout(()=>$('#toast').hidden=true,3500);}
class ApiError extends Error{constructor(status,message,{ambiguous=false,code=''}={}){super(message);this.name='ApiError';this.status=status;this.ambiguous=ambiguous;this.code=code;}}
function expireSession(){if(!state.authenticated)return;closeArtifactPreview();state.authenticated=false;state.user=null;updateConnection();running(Boolean(state.activeRun));}
async function api(path,options={}){
  let response;
  try{response=await fetch(apiUrl(path),{credentials:'same-origin',...options,headers:{'content-type':'application/json',...options.headers}});}
  catch{throw new ApiError(0,'连接电催化服务不可用，请稍后重试。',{ambiguous:true});}
  let data;
  try{data=await response.json();}catch{throw new ApiError(response.status,'服务暂不可用，请稍后重试。',{ambiguous:response.status===0||response.status>=500});}
  if(!response.ok){
    if(response.status===401)expireSession();
    const error=data?.error||{};
    const errors={401:'登录已失效，请重新登录后继续。',403:'当前账号没有此操作权限。',409:'请求与服务器中的未完成任务冲突，请核对本次提交。',429:'请求较多，请稍候再试。',503:'电催化 计算服务当前离线，请稍后重试。'};
    const message=error.message||errors[response.status]||'请求未完成，请重试。';
    throw new ApiError(response.status,message,{ambiguous:response.status===0||response.status>=500||response.status===408||response.status===503,code:error.code});
  }
  return data;
}
function statusText(status){return status==='online'?'电催化 在线':status==='busy'?'电催化 计算中':status==='offline'?'电催化 离线':status==='checking'?'正在检查服务':'暂未获取服务状态';}
function updateServiceStatus(){const status=$('#service-status');const label=$('#service-status-label');status.classList.remove('online','busy','offline');if(state.serverStatus==='online'||state.serverStatus==='busy')status.classList.add(state.serverStatus);label.textContent=statusText(state.serverStatus);}
function updateConnection(){const ready=state.authenticated&&(state.serverStatus==='online'||state.serverStatus==='busy');const label=!state.authenticated?'登录后即可对话':state.serverStatus==='offline'?'电催化 服务离线':state.serverStatus==='busy'?'电催化 计算中':state.serverStatus==='online'?'已就绪':state.serverStatus==='checking'?'正在检查电催化服务':'暂未获取服务状态';$('#connection-state').classList.toggle('online',ready);$('#connection-state').innerHTML=`<i></i>${label}`;$('#connect-button').textContent=state.authenticated?`${state.user?.name||state.user?.displayName||'账号'} · 退出`:'登录';$('#composer-mode').textContent=state.activeRun?'电催化助手正在处理你的问题':'一个助手，贯穿电催化研究';updateServiceStatus();}
function resizeComposer(){const input=$('#message-input');input.style.height='auto';input.style.height=Math.min(input.scrollHeight,180)+'px';}
function draftKey(){return state.chatId||'new';}
function saveDraft(){if(!state.ownerId)return;const saved=history.saveDraft(state.ownerId,draftKey(),$('#message-input').value);$('#history-storage-state').textContent=saved?'服务器保存':'草稿未保存';$('#history-storage-state').title=saved?'对话记录由电催化服务保存，草稿仅作为当前账号的恢复提示。':'本机无法保存草稿；对话记录仍以电催化服务为准。';}
function clearLocalDraft(chatId=draftKey()){if(state.ownerId)history.clearDraft(state.ownerId,chatId);}
function clearPending(chatId=state.chatId){if(state.ownerId&&chatId)history.clearPending(state.ownerId,chatId);}
function acceptUser(user){
  const owner=String(user?.id||'');
  if(!owner)throw new ApiError(200,'登录响应缺少账号标识，请重试。');
  if(state.ownerId&&state.ownerId!==owner){closeArtifactPreview();clearTimeout(state.pollTimer);state.activeRun=null;state.submitInFlight=false;state.chatId=null;state.messages=[];state.chats=[];state.after=0;$('#message-input').value='';resizeComposer();renderMessages();running(false);}
  state.authenticated=true;state.user=user;state.ownerId=owner;
}
function clearReconcileAction(){document.querySelector('#reconcile-submit')?.remove();}
function showReconcileAction(){clearReconcileAction();const button=document.createElement('button');button.id='reconcile-submit';button.type='button';button.className='text-link';button.textContent='核对本次提交';button.addEventListener('click',()=>{button.remove();void reconcileActiveRun();});$('#studio-notice').append(' ',button);}
function resetClient(){chatLoad++;closeArtifactPreview();clearTimeout(state.pollTimer);state.authenticated=false;state.user=null;state.ownerId='';state.chats=[];state.chatId=null;state.messages=[];state.activeRun=null;state.submitInFlight=false;state.after=0;state.pollFailures=0;$('#message-input').value='';resizeComposer();renderMessages();renderHistory();running(false);updateConnection();}

function displayRunStatus(value){return ({completed:'已完成',running:'处理中',queued:'等待处理',failed:'未完成',cancelled:'已停止',pending:'等待处理'})[value]||value;}
function normalizeArtifact(value){if(!value||typeof value!=='object')return null;const id=value.id||value.artifactId;if(!id)return null;return {id:String(id),name:String(value.name||'研究产物'),path:typeof value.path==='string'?value.path:undefined,mimeType:String(value.mimeType||'application/octet-stream'),size:Number.isFinite(value.size)?value.size:undefined};}
function normalizeMessage(value){if(!value||typeof value!=='object')return null;const role=value.role==='user'?'user':'assistant';const message={id:value.id?String(value.id):undefined,role,text:String(value.text??''),status:value.status?String(value.status):undefined};if(Array.isArray(value.tools))message.tools=value.tools.map(tool=>tool&&{id:String(tool.id||''),name:String(tool.name||'研究步骤'),status:String(tool.status||'进行中')}).filter(tool=>tool.id);if(Array.isArray(value.artifacts))message.artifacts=value.artifacts.map(normalizeArtifact).filter(Boolean);return message;}
function renderArtifact(artifact){if(!artifact?.id)return '';const name=artifact.name||'研究产物';const href=apiUrl(`/artifacts/${encodeURIComponent(artifact.id)}`);return `<div class="artifact-card"><button type="button" class="artifact-open" data-artifact-id="${esc(artifact.id)}" aria-label="查看 ${esc(name)}">${icon('clip')}<strong title="${esc(name)}">${esc(name)}</strong></button><a class="artifact-download" href="${esc(href)}" download="${esc(name)}" aria-label="下载 ${esc(name)}">${icon('download')}</a></div>`;}
function closeArtifactPreview(){artifactPanel.reset();}
function openArtifactPreview(artifact){artifactPanel.open(artifact);}
function preferredResult(files) {
  return files.findLast(file => file.name === '弛豫-基面电子态密度.svg') || files.findLast(file => file.name === '基面电子态密度.svg') || files.at(-1);
}
$('#open-results').addEventListener('click', () => {
  const file = preferredResult(state.messages.flatMap(message => message.artifacts || []));
  if (file) openArtifactPreview(file);
});
$('#messages').addEventListener('click',event=>{const button=event.target.closest('[data-artifact-id]');if(!button)return;const artifact=state.messages.flatMap(message=>message.artifacts||[]).find(item=>item.id===button.dataset.artifactId);if(artifact)void openArtifactPreview(artifact);});
function renderMessage(message, files) {
  const assistant = message.role === 'assistant';
  const text = message.text || '正在思考…';
  const status = message.status ? `<span class="message-status">${esc(displayRunStatus(message.status))}</span>` : '';
  const progress = message.tools?.length ? `<details class="tool-list"><summary>查看研究过程 · ${message.tools.length} 项</summary>${message.tools.map(tool => `<span>${esc(tool.name)} · ${esc(displayRunStatus(tool.status))}</span>`).join('')}</details>` : '';
  const attachments = message.artifacts?.length ? `<div class="artifact-list">${message.artifacts.map(renderArtifact).join('')}</div>` : '';
  const body = assistant ? renderMarkdown(text, files, message.artifacts || []) : esc(text);
  return `<article class="message ${message.role}"><div class="message-avatar">${assistant ? icon('layers') : '你'}</div><div class="message-body"><div class="message-author">${assistant ? '电催化' : '你'}${status}</div><div class="message-text${assistant ? ' rich-text' : ''}">${body}</div>${progress}${attachments}</div></article>`;
}
function renderMessages() {
  const scroll = $('#conversation-scroll');
  const follow = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100;
  const has = state.messages.length > 0;
  $('#studio').classList.toggle('has-messages', has);
  $('#studio-welcome').hidden = has;
  $('#chat-suggestions').hidden = has;
  const files = state.messages.flatMap(message => message.artifacts || []);
  $('#messages').innerHTML = state.messages.map(message => renderMessage(message, files)).join('');
  $('#open-results').hidden = !files.length;
  artifactPanel.refresh();
  if (follow) scroll.scrollTop = scroll.scrollHeight;
}
function renderHistory(){const chats=state.chats;$('#chat-history').innerHTML=chats.length?chats.map(chat=>`<button type="button" data-chat-id="${esc(chat.id)}" class="${chat.id===state.chatId?'selected':''}" ${state.activeRun?'disabled':''} ${chat.id===state.chatId?'aria-current="true"':''}>${esc(chat.title||'新对话')}</button>`).join(''):'<p>从一个问题开始，<br>服务器会保存你的对话。</p>';}
function running(active){$('#send-button').hidden=active;$('#send-button').disabled=active||state.submitInFlight;$('#stop-button').hidden=!active;$('#stop-button').disabled=active&&(!state.activeRun?.id||!state.authenticated);$('#new-thread').disabled=active||state.submitInFlight;$('#connect-button').disabled=active&&state.authenticated;updateConnection();renderHistory();}

let statusRefreshPending;
async function refreshStatus(){if(statusRefreshPending)return statusRefreshPending;statusRefreshPending=(async()=>{try{const data=await api('/status',{signal:AbortSignal.timeout(10000)});state.serverStatus=data?.mode==='independent'&&['online','busy','offline'].includes(data.status)?data.status:'unknown';if(['online','busy'].includes(state.serverStatus)&&$('#studio-notice').textContent.startsWith('电催化 计算服务暂时离线，当前无法接收新问题。'))notice('');return state.serverStatus;}catch(error){state.serverStatus='unknown';throw error;}finally{updateConnection();}})();try{return await statusRefreshPending;}finally{statusRefreshPending=null;}}
async function loadChats(){const data=await api('/chats');state.chats=Array.isArray(data?.chats)?data.chats.filter(chat=>chat&&chat.id).map(chat=>({id:String(chat.id),title:String(chat.title||'新对话'),createdAt:chat.createdAt,updatedAt:chat.updatedAt,activeRunId:chat.activeRunId?String(chat.activeRunId):null})):[];renderHistory();}
async function loadWorkspace({openLatest=true}={}){
  if(!state.authenticated)return;
  notice('正在连接电催化独立服务…');
  try{
    const [status]=await Promise.all([refreshStatus(),loadChats()]);
    const pendingChat=state.chats.find(chat=>history.loadPending(state.ownerId,chat.id));
    const query = new URLSearchParams(location.search);
    const linked = state.chats.find(chat => chat.id === query.get('chat'));
    if (openLatest && linked && !state.chatId) {
      await openChat(linked.id, {silent:true});
      const files = state.messages.flatMap(message => message.artifacts || []);
      const result = query.get('result');
      const artifact = result === 'dos' ? files.find(file => file.name === '基面电子态密度.svg') : files.find(file => file.id === result);
      if (artifact) openArtifactPreview(artifact);
    }
    const resumable=state.chats.find(chat=>chat.activeRunId)||pendingChat||state.chats[0];
    if(openLatest&&!state.chatId&&resumable&&(resumable.activeRunId||pendingChat||!$('#message-input').value.trim()))await openChat(resumable.id,{silent:true});
    if(status==='offline'&&!state.activeRun)showRetryNotice('电催化 计算服务暂时离线，当前无法接收新问题。',()=>{document.querySelector('#status-retry')?.remove();void loadWorkspace();});
    else if(!state.activeRun)notice('');
    updateConnection();
  }catch(error){updateConnection();showRetryNotice(error.message,()=>{document.querySelector('#status-retry')?.remove();void loadWorkspace();});}
}
let chatLoad = 0;
async function openChat(id,{silent=false}={}){
  if(state.activeRun&&state.chatId!==id)return;
  const request = ++chatLoad;
  const openingHistory = state.chatId !== id;
  if(openingHistory)closeArtifactPreview();
  try{
    const data=await api(`/chats/${encodeURIComponent(id)}`);if(request !== chatLoad)return;const chat=data?.chat;if(!chat?.id)throw new ApiError(200,'对话响应不完整。');
    state.chatId=String(chat.id);state.messages=Array.isArray(data.messages)?data.messages.map(normalizeMessage).filter(Boolean):[];
    const pending=history.loadPending(state.ownerId,state.chatId);state.activeRun=recoverableRun({chatId:state.chatId,serverRun:data.activeRun,pending});state.after=state.activeRun?.after??0;
    $('#message-input').value=history.loadDraft(state.ownerId,state.chatId);resizeComposer();renderMessages();renderHistory();running(Boolean(state.activeRun));setSidebar(false);
    $('#conversation-scroll').scrollTop=$('#conversation-scroll').scrollHeight;
    if(state.activeRun?.id){notice('正在恢复回答…');void pollEvents();}else if(state.activeRun){notice('上次提交结果待确认，请核对后继续。');showReconcileAction();}else if(!silent)notice('');
  }catch(error){if(request === chatLoad && !silent)notice(error.message);}
}
async function reconcileActiveRun(){const active=state.activeRun;if(!active){notice('本次提交已结束，无需继续核对。');return;}if(!state.authenticated){$('#login-dialog').showModal();return;}notice('正在核对本次提交…');if(active.id){state.pollFailures=0;void pollEvents();return;}await submitRun(active);}

async function createChat(message){const data=await api('/chats',{method:'POST',body:JSON.stringify({title:message.slice(0,80)})});if(!data?.chat?.id)throw new ApiError(200,'新对话创建响应不完整，请核对后重试。',{ambiguous:true});const chat={id:String(data.chat.id),title:String(data.chat.title||message.slice(0,80)),createdAt:data.chat.createdAt,updatedAt:data.chat.updatedAt,activeRunId:null};history.moveDraft(state.ownerId,'new',chat.id);state.chats=[chat,...state.chats.filter(item=>item.id!==chat.id)];state.chatId=chat.id;state.messages=[];state.after=0;renderHistory();return chat;}
function ensureAssistantMessage(){let message=state.messages.at(-1);if(!message||message.role!=='assistant'){message={role:'assistant',text:'',status:'正在处理',tools:[],artifacts:[]};state.messages.push(message);}message.tools ||= [];message.artifacts ||= [];return message;}
function appendSubmittedMessage(message){if(hasSubmittedPair(state.messages,message))return;state.messages.push({role:'user',text:message},{role:'assistant',text:'',status:'已提交 · 等待响应',tools:[],artifacts:[]});}
async function submitRun(active){
  if(state.activeRun!==active||active.inFlight)return;
  if(!state.authenticated){notice('请重新登录，再核对本次提交。');showReconcileAction();$('#login-dialog').showModal();return;}
  active.inFlight=true;running(true);
  try{
    const data=await api(`/chats/${encodeURIComponent(active.chatId)}/runs`,{method:'POST',body:JSON.stringify({clientRequestId:active.clientRequestId,message:active.message})});
    if(state.activeRun!==active)return;
    if(!data?.run?.id)throw new ApiError(200,'提交响应不完整，需核对本次提交。',{ambiguous:true});
    active.id=String(data.run.id);active.status=String(data.run.status||'queued');state.after=cursorFromRun(data.run);active.after=state.after;state.pollFailures=0;
    if(terminalStatus(active.status)){
      clearPending(active.chatId);clearLocalDraft(active.chatId);state.activeRun=null;if(state.chatId===active.chatId)$('#message-input').value='';resizeComposer();running(false);await loadChats();await openChat(active.chatId,{silent:true});return;
    }
    appendSubmittedMessage(active.message);clearLocalDraft(active.chatId);$('#message-input').value='';resizeComposer();notice('');renderMessages();$('#conversation-scroll').scrollTop=$('#conversation-scroll').scrollHeight;running(true);void pollEvents();
  }catch(error){
    if(state.activeRun!==active)return;
    if(error.status===409){notice('服务器已收到相同请求，正在读取对话状态…');await openChat(active.chatId,{silent:true});if(state.activeRun?.id)void pollEvents();else{state.activeRun=active;showReconcileAction();running(true);}return;}
    if(error.status===401){notice('登录已失效，请重新登录后核对本次提交。');showReconcileAction();$('#login-dialog').showModal();running(true);return;}
    if(error.ambiguous){notice(`${error.message} 提交结果尚未确认，请勿重复发送。`);showReconcileAction();running(true);return;}
    clearPending(active.chatId);state.activeRun=null;running(false);notice(`${error.message} 草稿已保留。`);
  }finally{active.inFlight=false;saveDraft();}
}
function terminalStatus(status){return ['completed','complete','succeeded','failed','cancelled','canceled','interrupted'].includes(String(status||'').toLowerCase());}
function finishRun(){const chatId=state.chatId;state.activeRun=null;clearPending(chatId);running(false);notice('');void (async()=>{try{await loadChats();if(chatId===state.chatId)await openChat(chatId,{silent:true});}catch{}})();}
async function pollEvents(){
  const active=state.activeRun;if(!active?.id)return;
  try{
    const data=await api(`/runs/${encodeURIComponent(active.id)}/events?after=${state.after}`);if(state.activeRun!==active)return;const target=ensureAssistantMessage();let terminal=false;
    for(const event of data.events||[]){if(Number.isFinite(event.sequence)&&event.sequence<=state.after)continue;if(Number.isFinite(event.sequence))state.after=event.sequence;const type=event.type;
      if(type==='run.started'){target.status='研究服务已开始';active.status='running';}
      else if(type==='assistant.delta'){target.text+=String(event.text||'');target.status='正在回答';}
      else if(type==='assistant.progress'){target.status=String(event.text||'正在处理');}
      else if(type==='tool.status'){const toolId=String(event.toolCallId||'');const found=target.tools.find(tool=>tool.id===toolId);if(found){found.name=String(event.name||found.name);found.status=String(event.status||found.status);}else if(toolId)target.tools.push({id:toolId,name:String(event.name||'研究步骤'),status:String(event.status||'进行中')});}
      else if(type==='artifact.created'){const artifact=normalizeArtifact(event.artifact||event);if(artifact&&!target.artifacts.some(item=>item.id===artifact.id))target.artifacts.push(artifact);}
      else if(type==='run.completed'){if(!target.text)target.text=String(event.summary||'研究服务已完成本轮对话。');target.status='已完成';terminal=true;}
      else if(type==='run.failed'){target.status='未完成';target.text+=(target.text?'\n\n':'')+String(event.message||'研究服务未完成，请检查输入和运行日志。');terminal=true;}
      else if(type==='run.cancelled'){target.status='已停止';if(!target.text)target.text='本轮对话已停止。';terminal=true;}
    }
    if(!terminal&&terminalStatus(data.run?.status)){const status=String(data.run.status).toLowerCase();if(status==='completed'||status==='complete'||status==='succeeded'){if(!target.text)target.text='研究服务已完成本轮对话。';target.status='已完成';}else if(status==='cancelled'||status==='canceled'){target.status='已停止';if(!target.text)target.text='本轮对话已停止。';}else{target.status='未完成';if(!target.text)target.text='研究服务未完成，请检查输入和运行日志。';}terminal=true;}
    state.pollFailures=0;active.after=state.after;if(terminal||data.events?.length)renderMessages();if(terminal)finishRun();else state.pollTimer=setTimeout(pollEvents,data.events?.length?320:720);
  }catch(error){
    if(state.activeRun!==active)return;state.pollFailures++;if(error.status===401){notice('登录已失效，回答仍在服务器中。请重新登录后继续读取。');$('#login-dialog').showModal();return;}notice(`${error.message} 回答状态尚未确认。请勿重复提交。`);if(state.pollFailures<4)state.pollTimer=setTimeout(pollEvents,3500);else showReconcileAction();
  }
}

function newChat(){if(state.activeRun||state.submitInFlight)return;chatLoad++;closeArtifactPreview();clearTimeout(state.pollTimer);state.chatId=null;state.messages=[];state.after=0;state.activeRun=null;clearLocalDraft('new');$('#message-input').value='';resizeComposer();renderMessages();renderHistory();notice('');setSidebar(false);$('#message-input').focus();}
$('#new-thread').addEventListener('click',newChat);
$('#chat-history').addEventListener('click',event=>{const button=event.target.closest('[data-chat-id]');if(button&&!state.activeRun)void openChat(button.dataset.chatId);});
$('#message-input').addEventListener('input',()=>{resizeComposer();saveDraft();});
$('#message-input').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();$('#message-form').requestSubmit();}});
$('#message-form').addEventListener('submit',async event=>{
  event.preventDefault();if(!canStartSubmission(state))return;const message=$('#message-input').value.trim();if(!message){$('#message-input').focus();return;}
  if(!state.authenticated){sendAfterLogin=true;$('#login-error').hidden=true;$('#login-dialog').showModal();return;}
  if(state.serverStatus==='offline'){showRetryNotice('电催化 计算服务暂时离线，当前无法接收新问题。',()=>{document.querySelector('#status-retry')?.remove();void loadWorkspace({openLatest:false});});return;}
  state.submitInFlight=true;running(false);
  try{
    if(!state.chatId)await createChat(message);
    const pending=history.loadPending(state.ownerId,state.chatId);if(pending&&pending.message!==message){state.activeRun=recoverableRun({chatId:state.chatId,serverRun:null,pending});notice('本对话有一次提交结果尚未确认，请先核对本次提交。');showReconcileAction();running(true);return;}
    const request=pending||{clientRequestId:crypto.randomUUID(),message};history.savePending(state.ownerId,state.chatId,request);state.activeRun={chatId:state.chatId,id:null,status:'submitting',clientRequestId:request.clientRequestId,message:request.message,inFlight:false};notice('');running(true);await submitRun(state.activeRun);
  }catch(error){notice(`${error.message} 草稿已保留。`);saveDraft();}
  finally{state.submitInFlight=false;running(Boolean(state.activeRun));}
});
$('#stop-button').addEventListener('click',async()=>{const active=state.activeRun;if(!active?.id){toast('正在确认本次提交状态，请稍候。');return;}$('#stop-button').disabled=true;try{const data=await api(`/runs/${encodeURIComponent(active.id)}/cancel`,{method:'POST',body:'{}'});if(data?.run?.status)active.status=String(data.run.status);clearTimeout(state.pollTimer);await pollEvents();}catch(error){notice(`${error.message} 停止状态尚未确认。`);showReconcileAction();}finally{running(Boolean(state.activeRun));}});

function updateAuthMode(){const register=authMode==='register';$('#auth-title').textContent=register?'注册电催化':'登录电催化';$('#auth-description').textContent=register?'创建独立电催化研究账号，开始保存你的研究对话。':'登录独立电催化研究服务，继续你的对话。';$('#auth-name-label').hidden=!register;$('#auth-name').hidden=!register;$('#auth-name').required=register;$('#invite-code-label').hidden=!register;$('#invite-code').hidden=!register;$('#invite-code').required=register;$('#login-submit').innerHTML=`${register?'注册并继续':'登录并继续'} ${icon('arrow')}`;$('#auth-switch-text').textContent=register?'已有独立账号？':'还没有独立账号？';$('#auth-toggle').textContent=register?'返回登录':'使用邀请码注册';$('#auth-note').textContent=register?'电催化 使用独立账号、对话记录和 V100 研究服务。密码至少 10 位，邀请码由管理员提供。':'电催化 使用独立账号、对话记录和 V100 研究服务。密码至少 10 位。';}
$('#auth-toggle').addEventListener('click',()=>{authMode=authMode==='login'?'register':'login';$('#login-error').hidden=true;updateAuthMode();});
$('#connect-button').addEventListener('click',async()=>{if(!state.authenticated){sendAfterLogin=false;authMode='login';$('#login-error').hidden=true;updateAuthMode();$('#login-dialog').showModal();return;}if(state.activeRun){toast('请先停止当前回答，再退出账号。');return;}try{await api('/logout',{method:'POST',body:'{}'});history.clear(state.ownerId);resetClient();notice('');}catch(error){notice(`${error.message} 退出未完成，请重试。`);appendNoticeAction('logout-retry','重试退出',()=>{$('#logout-retry')?.remove();$('#connect-button').click();});}});
$('#login-form').addEventListener('submit',async event=>{
  event.preventDefault();const submit=$('#login-submit');submit.disabled=true;$('#login-error').hidden=true;const register=authMode==='register';const typedPrompt=$('#message-input').value;const hadActiveRun=Boolean(state.activeRun);
  try{
    const payload=register?{contact:$('#login-contact').value.trim(),password:$('#login-password').value,name:$('#auth-name').value.trim(),inviteCode:$('#invite-code').value.trim()}:{contact:$('#login-contact').value.trim(),password:$('#login-password').value};
    const data=await api(register?'/register':'/login',{method:'POST',body:JSON.stringify(payload)});acceptUser(data.user);$('#login-password').value='';$('#login-dialog').close();
    const prompt=hadActiveRun?typedPrompt:restorePromptAfterAuth({sendAfterLogin,prompt:typedPrompt,savedDraft:history.loadDraft(state.ownerId,'new')});$('#message-input').value=prompt;resizeComposer();saveDraft();updateConnection();await loadWorkspace({openLatest:!sendAfterLogin&&!hadActiveRun});
    if(sendAfterLogin){sendAfterLogin=false;$('#message-form').requestSubmit();}else if(state.activeRun){running(true);if(state.activeRun.id){notice('已重新连接，正在读取原对话状态。');void pollEvents();}else{notice('已重新连接，请核对本次提交。');showReconcileAction();}}
  }catch(error){$('#login-error').textContent=error.message;$('#login-error').hidden=false;}
  finally{submit.disabled=false;}
});

window.addEventListener('beforeunload',event=>{if(state.activeRun){event.preventDefault();event.returnValue='';}});
renderHistory();updateAuthMode();updateConnection();
void refreshStatus().catch(()=>{});
startServiceStatusRefresh({refresh:refreshStatus,document,window});
async function initializeSession(){
  const token = /^#desktop=([a-f0-9]{64})$/.exec(location.hash)?.[1];
  if(token){
    window.history.replaceState(null,'','/#studio');
    return api('/desktop-session',{method:'POST',body:JSON.stringify({token})});
  }
  return api('/session');
}
initializeSession().then(async data=>{if(data.authenticated===true){acceptUser(data.user);$('#message-input').value=history.loadDraft(state.ownerId,'new');resizeComposer();await loadWorkspace();}else updateConnection();const prefill=sessionStorage.getItem('catalysis-prefill');if(prefill){sessionStorage.removeItem('catalysis-prefill');fillPrompt(prefill);}}).catch(error=>{updateConnection();if(error.status!==401)notice('暂时无法连接电催化对话服务，请稍后刷新。');});
