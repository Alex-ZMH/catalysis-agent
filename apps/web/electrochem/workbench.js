(() => {
  'use strict';
  const mounted = new WeakMap();
  const storageKey = 'electrochem:offline-chats:v1';
  const suggestions = ['运行 OER 示例', 'HER 的限制电位由什么决定？', '查看电极表面 XYZ 结构'];
  const uid = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  function button(label, click) {
    const node = document.createElement('button');
    node.type = 'button';
    node.textContent = label;
    node.addEventListener('click', click);
    return node;
  }

  function mount(root) {
    if (mounted.has(root)) return mounted.get(root);
    root.innerHTML = `
      <aside class="wb-sidebar" id="wb-sidebar" aria-label="对话导航">
        <a class="wb-brand" href="#home">电催化 <span>STUDIO</span></a>
        <button type="button" class="wb-new">＋ 新对话</button><h2>最近对话 <small class="wb-storage"></small></h2>
        <nav class="wb-history" aria-label="最近对话"></nav>
        <p class="wb-service" role="status"></p>
        <a class="wb-back" href="#home">← 返回研究展示</a></aside>
      <button type="button" class="wb-scrim" aria-label="关闭对话导航" hidden></button>
      <main class="wb-main"><header class="wb-header">
        <button type="button" class="wb-menu" aria-label="展开对话导航" aria-controls="wb-sidebar" aria-expanded="false">☰</button>
        <strong>电催化研究助手</strong><span class="wb-mode"></span><button type="button" class="wb-auth" hidden>登录</button></header>
      <div class="wb-stage"><div class="wb-content"><div class="wb-welcome">
        <span class="wb-mark" aria-hidden="true"></span><h1>今天，想研究什么？</h1>
        <p>从反应机理到自由能路径，直接和电催化助手聊聊。</p></div>
        <section class="wb-messages" role="log" aria-live="polite" aria-label="对话消息"></section>
        <form class="wb-composer"><textarea rows="2" maxlength="2000" aria-label="研究问题" placeholder="向电催化助手提问，或描述你想完成的研究…"></textarea>
          <div class="wb-actions"><p role="status" class="wb-status"></p>
          <button type="button" class="wb-stop" hidden>停止</button><button type="submit" class="wb-route" aria-label="发送消息">发送 ↑</button></div></form>
        <p class="wb-note">Enter 发送 · Shift+Enter 换行。请核实科学结论及适用条件。</p>
        <section class="wb-suggestions" aria-label="示例问题"></section>
        <details class="wb-lab"><summary>打开电催化分析工具</summary><div class="wb-tools"></div></details>
      </div></div></main>`;
    const find = selector => root.querySelector(selector);
    const field = find('textarea'), form = find('.wb-composer'), log = find('.wb-messages');
    const send = find('.wb-route'), stop = find('.wb-stop'), status = find('.wb-status'), sidebar = find('.wb-sidebar');
    const lab = find('.wb-lab'), labRoot = find('.wb-tools');
    let selectTool = window.CatalysisViewers.mount(labRoot);
    const mobile = window.matchMedia('(max-width: 800px)');
    const servicePage = Boolean(document.querySelector('meta[name=catalysis-service]'));
    let ready = !servicePage, writable = ready, remote = null, active = uid(), turns = [], index = [], local = {};
    let pending = null, generation = 0, drawer = false, historyVersion = 0;
    const note = value => { status.textContent = value; };
    function setDrawer(open) {
      drawer = mobile.matches && open;
      sidebar.inert = mobile.matches && !drawer;
      find('.wb-main').inert = drawer;
      find('.wb-scrim').hidden = !drawer;
      root.classList.toggle('wb-drawer-open', drawer);
      find('.wb-menu').setAttribute('aria-expanded', String(drawer));
    }
    function controls() {
      send.disabled = !writable || !ready || Boolean(pending) || !field.value.trim();
      send.hidden = Boolean(pending);
      stop.hidden = !pending;
      find('.wb-new').disabled = Boolean(pending);
      field.readOnly = Boolean(pending) || !writable;
    }
    function openTool(tool) {
      lab.open = true;
      selectTool(tool);
    }
    function message(role, text, reply) {
      const block = document.createElement('article');
      block.className = 'wb-message ' + role;
      const label = document.createElement('strong'), body = document.createElement(role === 'assistant' ? 'div' : 'p');
      label.textContent = role === 'user' ? '你' : '电催化助手 · ' + (reply.mode === 'model' ? reply.model : '本地分析');
      if (role === 'assistant') {
        body.className = 'rich-text';
        body.innerHTML = window.CatalysisMarkdown.renderMarkdown(text);
      } else body.textContent = text;
      block.append(label, body);
      if (reply?.plot) block.append(window.CatalysisViewers.chatPlot(reply.plot));
      if (['her','oer','structure'].includes(reply?.tool))
        block.append(button(reply.tool === 'structure' ? '查看位点结构' : '打开 ' + reply.tool.toUpperCase() + ' 分析工具', () => openTool(reply.tool)));
      log.append(block);
    }
    function render() {
      log.replaceChildren();
      turns.forEach(turn => { message('user', turn.question); message('assistant', turn.reply.text, turn.reply); });
      if (pending) message('user', pending.question);
      log.scrollTop = log.scrollHeight;
      find('.wb-welcome').hidden = find('.wb-suggestions').hidden = Boolean(turns.length || pending);
      controls();
    }
    function entries() {
      const nav = find('.wb-history');
      nav.replaceChildren();
      if (!index.length) nav.textContent = '尚无对话记录';
      for (const item of index) {
        const node = button(item.title, () => load(item.id));
        if (item.id === active) node.setAttribute('aria-current','true');
        node.disabled = Boolean(pending);
        nav.append(node);
      }
    }
    async function refresh() {
      const version = ++historyVersion;
      const list = remote ? (await remote('/api/chats')).chats : Object.entries(local).reverse().map(([id, data]) => ({id, title:data[0].question}));
      if (version === historyVersion) { index = list; entries(); }
    }
    function resetLab() {
      lab.open = false;
      selectTool = window.CatalysisViewers.mount(labRoot);
    }
    async function load(id) {
      if (pending) return;
      const version = ++generation;
      ready = false;
      controls();
      try {
        const data = remote ? (await remote('/api/chats/' + id)).turns : local[id];
        if (version !== generation) return;
        active = id; turns = data; field.value = ''; note(''); setDrawer(false); resetLab();
      } catch (error) { if (version === generation) note(error.message); }
      finally { if (version === generation) { ready = true; render(); entries(); } }
    }
    function prefill(text) {
      if (pending) return;
      field.value = text; controls(); field.focus();
    }
    function fresh() {
      if (pending) return;
      generation++; ready = !servicePage || Boolean(remote);
      active = uid(); turns = []; field.value = ''; note(''); resetLab();
      render(); entries(); setDrawer(false); field.focus();
    }
    function connect(call, model, canWrite, signal) {
      remote = call; ready = true; writable = canWrite;
      find('.wb-mode').textContent = model ? '模型对话' : '本地分析';
      find('.wb-service').textContent = model ? '模型通道已配置 · 发送时包含近期对话' : '本地工具就绪 · 未配置语言模型';
      find('.wb-storage').textContent = '服务器保存';
      note(canWrite ? '' : '当前项目为只读，无法发送消息。');
      controls(); refresh().catch(error => note(error.message));
      signal.addEventListener('abort', () => {
        ++generation; ++historyVersion; pending?.controller.abort(); pending = null;
        remote = null; ready = writable = false; turns = []; index = []; field.value = '';
        resetLab(); render(); entries();
      }, {once:true});
    }
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const question = field.value.trim();
      if (!ready || !writable || !question || pending) return;
      if (turns.length >= 100) { note('已达 100 轮，请新建对话。'); return; }
      const current = {id:uid(), question, controller:new AbortController()};
      const version = ++generation;
      pending = current; field.value = ''; note('正在回答…'); render(); entries();
      try {
        if (remote) {
          const data = await remote('/api/chats/' + active + '/send', {id:current.id, expected:turns.length, question}, current.controller.signal);
          if (version !== generation) return;
          turns = data.turns;
        } else {
          const reply = window.CatalysisChat.localReply(question, turns);
          turns = [...turns, {id:current.id, question, reply}]; local[active] = turns;
          try { localStorage.setItem(storageKey, JSON.stringify(local)); }
          catch { current.warning = '浏览器未能保存记录，本次对话仍可继续。'; }
        }
        note(current.warning || '');
        await refresh();
      } catch (error) {
        if (version === generation) { field.value = question; note(error.message); }
      } finally {
        if (version === generation) {
          pending = null; render(); entries(); field.focus({preventScroll:true});
          form.scrollIntoView({block:'nearest'});
        }
      }
    });
    stop.onclick = async () => {
      if (!pending || !remote) return;
      const current = pending, version = ++generation;
      stop.disabled = true;
      try {
        const data = await remote('/api/chats/' + active + '/stop', {id:current.id});
        if (version !== generation) return;
        current.controller.abort(); turns = data.turns;
        if (!turns.some(turn => turn.id === current.id)) field.value = current.question;
        note('已停止。'); await refresh();
      } catch (error) { if (version === generation) note(error.message); }
      finally { stop.disabled = false; if (version === generation) { pending = null; render(); entries(); } }
    };
    field.addEventListener('input', controls);
    field.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault(); if (!send.disabled) form.requestSubmit();
      }
    });
    find('.wb-new').onclick = fresh;
    find('.wb-menu').onclick = () => { setDrawer(true); find('.wb-new').focus(); };
    find('.wb-scrim').onclick = () => { setDrawer(false); find('.wb-menu').focus(); };
    root.addEventListener('keydown', event => { if (event.key === 'Escape' && drawer) find('.wb-scrim').click(); });
    mobile.addEventListener('change', () => setDrawer(false));
    suggestions.forEach(text => find('.wb-suggestions').append(button(text, () => prefill(text))));
    if (!servicePage) {
      try { local = JSON.parse(localStorage.getItem(storageKey) || '{}') || {}; } catch { local = {}; }
      find('.wb-mode').textContent = '本地分析';
      find('.wb-service').textContent = '离线工具就绪 · 未连接语言模型';
      find('.wb-storage').textContent = '此浏览器';
      refresh().catch(() => note('无法读取本地记录。'));
    } else {
      find('.wb-mode').textContent = '连接中';
      note('正在连接项目会话…');
    }
    setDrawer(false); render();
    const api = { prefill, connect, notice:note,
      auth(label, action) {
        const auth = find('.wb-auth');
        auth.hidden = false; auth.textContent = label; auth.onclick = action;
        if (!remote) find('.wb-mode').textContent = '等待登录';
      },
      enter() { root.hidden = false; setDrawer(false); field.focus({preventScroll:true}); },
      leave() { root.hidden = true; setDrawer(false); } };
    mounted.set(root,api);
    return api;
  }
  window.CatalysisWorkbench = {mount};
})();
