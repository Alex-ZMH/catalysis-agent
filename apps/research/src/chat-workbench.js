const examples = [
  '如何计算 HER 的氢吸附自由能？',
  '电位与覆盖度怎样影响 OER？',
  '怎样构建镍表面的吸附模型？',
  '确认提交 Ni 参考单点计算，给我原始日志。',
];

export function renderChatWorkbench({icon, mark}) {
  return `<div id="studio" hidden>
    <aside class="studio-sidebar" id="chat-sidebar" aria-label="对话导航">
      <a class="brand" href="./lab/index.html">${mark}<strong>电催化<span>STUDIO</span></strong></a>
      <button id="new-thread" class="new-thread">${icon('plus')} 新对话</button>
      <div class="chat-history-heading"><span>最近对话</span><span id="history-storage-state" title="对话由 电催化 服务保存">服务器保存</span></div>
      <nav id="chat-history" class="chat-history" aria-label="最近对话"></nav>
      <div class="sidebar-bottom">
        <div id="service-status" class="service-status" aria-live="polite"><span class="service-status-dot" aria-hidden="true"></span><span id="service-status-label">正在检查服务</span></div>
        <a href="./lab/index.html">${icon('layers')} 探索电催化展示 ${icon('diagonal')}</a>
      </div>
    </aside>
    <main class="studio-main">
      <header class="studio-header"><div><button id="sidebar-toggle" class="icon-button" aria-label="展开对话导航" aria-controls="chat-sidebar" aria-expanded="false">${icon('menu')}</button><strong>电催化</strong><span class="chat-identity">研究助手</span></div><div><button type="button" class="button small" id="open-results" aria-controls="artifact-dialog" hidden>研究结果</button><span id="connection-state" class="connection-state"><i></i>登录后即可对话</span><button id="connect-button" class="button small">登录</button></div></header>
      <div id="studio-notice" class="studio-notice" role="status" hidden></div>
      <div class="chat-stage">
        <div class="conversation-scroll" id="conversation-scroll">
          <div class="studio-welcome" id="studio-welcome"><div class="welcome-mark">${icon('layers')}</div><h1>今天，想研究什么？</h1><p>从表面机理到自由能计算，直接和电催化助手聊聊。</p></div>
          <div id="messages" class="messages" aria-live="polite" aria-relevant="additions text"></div>
        </div>
        <div class="composer-wrap"><div class="composer"><form id="message-form"><label for="message-input" class="sr-only">给 电催化 发消息</label><textarea id="message-input" rows="2" maxlength="19000" placeholder="向 电催化 提问，或描述你想完成的研究…"></textarea><div class="composer-bottom"><span>${icon('layers')}<span id="composer-mode">一个助手，贯穿电催化研究</span></span><button id="stop-button" type="button" class="stop-button" hidden>${icon('stop')} 停止</button><button id="send-button" type="submit" aria-label="发送消息">${icon('arrow')}</button></div></form></div><p class="composer-note">电催化助手可能会出错，请核实重要信息。科学结论需结合实际输入与验证。</p></div>
        <section id="chat-suggestions" class="chat-suggestions" aria-label="示例问题"><div class="question-grid">${examples.map((question,i)=>`<button class="question-suggestion" type="button" data-example="${i}">${question}</button>`).join('')}</div></section>
      </div>
    </main>
  </div>`;
}
export function examplePrompt(index) { return examples[Number(index)]; }
