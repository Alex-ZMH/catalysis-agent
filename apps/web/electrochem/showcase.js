(() => {
  'use strict';

  const scales = [
    {id: 'overview', title: '电化学全景', english: 'Electrochemistry atlas', image: 'panorama.webp', alt: '电化学全景：位点电荷重排、阴极析氢、阳极析氧与 PEM 膜电极。'},
    {
      id: 'site', caseId: 'site', title: '位点与电子', english: 'Interfacial charge',
      image: 'focus-site.webp', alt: '表面吸附分子与金属位点之间的青色和琥珀色差分电荷密度等值面示意。', method: '表面 DFT / 差分电荷密度', note: '位点 / 电荷重排',
      caption: '反应物结合金属位点时，吸附键两侧的电子密度怎样变化？',
      detail: '在同一吸附几何、晶胞和网格下比较组合体系与两个片段的电子密度。净转移量还需给出电荷分区方法。', legend: '青色与琥珀色分别示意电子积累和耗尽',
      draft: '比较两种电极位点上的氢吸附。请从体相弛豫、切面、裸表面和吸附构型开始，说明差分电荷密度、吸附自由能与电荷分区各需要哪些参考态和收敛证据。'
    },
    {
      id: 'reaction', caseId: 'reaction', title: '阴极析氢', english: 'Hydrogen evolution',
      image: 'focus-her.webp', alt: '银灰色阴极表面有吸附氢，脱附的双原子氢分子位于表面上方。', method: 'HER / 质子耦合电子转移', note: '吸附 / 析氢',
      caption: '在酸性阴极，一个质子接受电子后形成吸附氢。第二次质子与电子转移释放氢气。',
      detail: '沿 Volmer–Heyrovsky 路径，对每个基元步分别比较初态、过渡态和终态的自由能。', legend: 'H* 为表面吸附氢，H₂ 为脱附产物',
      draft: '在酸性阴极比较 Volmer 和 Heyrovsky 两个析氢步骤。在相同电位、覆盖度与溶剂条件下，分别列出反应自由能、活化自由能及过渡态验证方法。'
    },
    {
      id: 'transport', caseId: 'transport', title: '阳极析氧', english: 'Oxygen evolution',
      image: 'focus-oer.webp', alt: '氧化物阳极表面的含氧中间体及上方释放的氧分子。', method: 'OER / 吸附物演化机理', note: '成键 / 析氧',
      caption: '沿单中心吸附物路径，从表面羟基和吸附氧追踪到氧氧键形成，直至 O₂ 释放。',
      detail: '在指定电位下区分热力学上坡步和动力学势垒。直接接触海水的阳极，还要考虑氯离子氧化。', legend: '*OH、*O、*OOH 为表面中间体',
      draft: '在给定参比电极、电位和 pH 下比较析氧四步的自由能，规划关键过渡态验证。如果阳极直接接触含氯海水，增加析氯竞争与产物选择性对照。'
    },
    {
      id: 'equipment', caseId: 'equipment', title: 'PEM 膜电极', english: 'PEM electrolyzer',
      image: 'focus-pem.webp', alt: 'PEM 膜电极的独立分层结构，包括流场板、多孔传输层和中央质子交换膜。', method: '质子交换膜 / 电荷传输', note: '跨膜 / 外电路',
      caption: '水在阳极氧化，质子穿过交换膜，直流电源经外电路向阴极供给电子。',
      detail: '此处展示海水经淡化、纯化后供给 PEM 阳极的路线。阴极收集 H₂，阳极收集 O₂。', legend: '层叠结构展示流场板、催化层和质子交换膜',
      draft: '请设计海水淡化、纯化后供水的 PEM 电解槽研究方案。标出质子跨膜与外电路电子路径，并说明如何通过电荷收支和双侧气体产量核对析氢与析氧。'
    }
  ];
  const arrow = '<span aria-hidden="true">→</span>';
  const diagonal = '<span aria-hidden="true">↗</span>';
  const brand = '电化学研究 <span>STUDIO</span>';
  const mark = '<svg class="cs-brand-mark" aria-hidden="true" width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m12 2 10 6-10 6L2 8zM2 12l10 6 10-6M2 16l10 6 10-6"/></svg>';

  function mount(root, {openDraft, selectCase} = {}) {
    root.innerHTML = `
      <header id="home" class="cs-header">
        <a class="cs-brand" href="#home" aria-label="电化学研究 STUDIO 首页">${mark}<strong>${brand}</strong></a>
        <nav id="cs-navigation" aria-label="主导航">
          <a href="#explore">多尺度图景</a><a href="#cases">研究示范</a><a href="#workflow">开始研究</a><a href="general/">通用催化图景</a>
        </nav>
        <a class="cs-entry" href="#studio">进入工作台 ${diagonal}</a>
        <button class="cs-menu" type="button" aria-expanded="false" aria-controls="cs-navigation" aria-label="展开导航"><span aria-hidden="true">☰</span></button>
      </header>
      <main id="main" tabindex="-1">
        <section class="cs-hero" aria-labelledby="cs-title">
          <div class="cs-shell cs-intro">
            <h1 id="cs-title"><span>从电子转移，</span><span>到海水电解。</span></h1>
            <p>界面电荷 · 阴极析氢 · 阳极析氧 · PEM 膜电极</p>
            <div class="cs-hero-actions">
              <a class="cs-primary" href="#studio">开始研究 ${arrow}</a>
              <a href="#cases">查看研究示范 ${diagonal}</a>
            </div>
          </div>
          <div id="explore" class="cs-shell cs-explorer" data-scale="overview">
            <div class="cs-toolbar">
              <p><span>ELECTROCHEMISTRY ATLAS</span> 电化学反应图景</p>
              <button class="cs-reset" type="button" disabled><span aria-hidden="true">↺</span> 返回全景</button>
            </div>
            <div class="cs-stage" id="cs-focus" role="tabpanel" aria-labelledby="cs-tab-overview" tabindex="0">
              <div class="cs-copy" hidden>
                <span class="cs-method"></span><h2></h2><p class="cs-caption"></p><p class="cs-detail"></p>
                <div class="cs-key"><span class="cs-colorbar" aria-hidden="true"></span><span class="cs-legend"></span></div>
                <div class="cs-focus-actions">
                  <button class="cs-draft" type="button">从这个尺度开始 ${arrow}</button>
                  <a class="cs-case" href="#cases">查看研究示范 ${diagonal}</a>
                </div>
              </div>
              <div class="cs-picture">
                <img src="public/scenes/${scales[0].image}" alt="${scales[0].alt}" fetchpriority="high">
              </div>
              <div class="cs-overview-note" aria-hidden="true">${scales.slice(1).map(scale => `<span>${scale.note}</span>`).join('')}</div>
            </div>
            <div class="cs-stops" role="tablist" aria-label="选择观察尺度">${scales.map((scale, index) => `
              <button id="cs-tab-${scale.id}" type="button" role="tab" aria-controls="cs-focus" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}">
                <span><strong>${scale.title}</strong><small>${scale.english}</small></span><span class="cs-stop-icon" aria-hidden="true">${index === 0 ? '▤' : '+'}</span>
              </button>`).join('')}
            </div>
          </div>
        </section>
        <div id="cases"></div>
        <div id="parameters"></div>
        <section id="workflow" class="cs-shell cs-workflow">
          <div><h2>让下一个问题，<br>成为研究的起点。</h2><p>带上研究目标与已有条件，进入电化学研究工作台。</p></div>
          <a href="#studio" class="cs-primary">进入研究工作台 ${diagonal}</a>
        </section>
      </main>
      <footer class="cs-shell cs-footer">
        <div class="cs-wordmark" aria-hidden="true">${brand}</div>
        <div class="cs-footer-bottom">
          <a href="#home">从电极界面到膜电极。</a>
          <button class="cs-about" type="button">图示与来源 ${diagonal}</button><span>© 2026 电化学研究 STUDIO</span>
        </div>
      </footer>
      <dialog class="cs-sources" aria-labelledby="cs-sources-title">
        <h2 id="cs-sources-title">图示与来源</h2>
        <p>全景和专题图展示反应机理。自由能与速率曲线使用示例参数。</p>
        <p>析氢采用酸性 Volmer–Heyrovsky 路径，析氧采用单中心吸附物演化路径。PEM 示范以纯化水供给阳极。</p>
        <p>装置原理见<a href="https://www.energy.gov/cmei/fuels/hydrogen-production-electrolysis" target="_blank" rel="noopener">美国能源部的 PEM 水电解说明</a>。直接海水电解的界面化学可参阅<a href="https://doi.org/10.1038/s41560-023-01195-x" target="_blank" rel="noopener">《Nature Energy》研究论文</a>。</p>
        <form method="dialog"><button class="cs-primary">关闭</button></form>
      </dialog>`;

    const query = selector => root.querySelector(selector);
    const explorer = query('.cs-explorer');
    const stage = query('.cs-stage');
    const picture = query('.cs-picture');
    const copy = query('.cs-copy');
    const reset = query('.cs-reset');
    const tabs = [...root.querySelectorAll('.cs-stops button')];
    let current = scales[0];

    function choose(index, focus = false) {
      current = scales[index];
      const focused = index !== 0;
      explorer.dataset.scale = current.id;
      tabs.forEach((tab, position) => {
        tab.setAttribute('aria-selected', String(position === index));
        tab.tabIndex = position === index ? 0 : -1;
      });
      stage.setAttribute('aria-labelledby', tabs[index].id);
      reset.disabled = !focused;
      copy.hidden = !focused;
      const src = 'public/scenes/' + current.image;
      if (picture.firstElementChild.getAttribute('src') !== src) {
        const image = new Image();
        image.alt = current.alt;
        image.src = src;
        picture.replaceChildren(image);
      }
      if (focused) {
        query('.cs-method').textContent = current.method;
        query('.cs-copy h2').textContent = current.title;
        query('.cs-caption').textContent = current.caption;
        query('.cs-detail').textContent = current.detail;
        query('.cs-legend').textContent = current.legend;
        selectCase?.(current.caseId);
      }
      if (focus) tabs[index].focus({preventScroll: true});
    }

    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => {
        choose(index);
        if (window.matchMedia('(max-width: 680px)').matches) {
          const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
          stage.scrollIntoView({behavior: reduced ? 'instant' : 'smooth', block: 'start'});
        }
      });
      tab.addEventListener('keydown', event => {
        const positions = {Home: 0, End: tabs.length - 1,
          ArrowLeft: (index + tabs.length - 1) % tabs.length, ArrowRight: (index + 1) % tabs.length};
        if (!Object.hasOwn(positions, event.key)) return;
        event.preventDefault();
        choose(positions[event.key], true);
      });
    });
    reset.addEventListener('click', () => choose(0, true));
    query('.cs-case').addEventListener('click', () => selectCase?.(current.caseId, true));
    query('.cs-draft').addEventListener('click', () => openDraft?.(current.draft));

    const menu = query('.cs-menu');
    const header = query('.cs-header');
    function setMenu(expanded) {
      menu.setAttribute('aria-expanded', String(expanded));
      menu.setAttribute('aria-label', expanded ? '关闭导航' : '展开导航');
      header.classList.toggle('cs-menu-open', expanded);
    }
    menu.addEventListener('click', () => setMenu(menu.getAttribute('aria-expanded') !== 'true'));
    header.addEventListener('click', event => {
      if (event.target.closest('a')) setMenu(false);
    });
    header.addEventListener('keydown', event => {
      if (event.key === 'Escape' && menu.getAttribute('aria-expanded') === 'true') {
        setMenu(false);
        menu.focus();
      }
    });
    query('.cs-about').addEventListener('click', () => query('.cs-sources').showModal());
  }

  window.CatalysisShowcase = {mount};
})();
