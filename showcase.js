(() => {
  'use strict';

  const scales = [
    {id: 'overview', title: '多尺度全景', english: 'Simulation atlas'},
    {
      id: 'site', caseId: 'site', title: '位点与电子', english: 'Active sites & electrons',
      x: .12, edges: [0, .25], method: '分子建模 / DFT', note: '位点 / 电子分布',
      caption: '比较反应物接近不同位点时的几何构型与界面电荷重排。',
      detail: '在统一参考态下比较结合强弱；电子积累与耗尽不等于净转移电荷数。',
      legend: '双色等值面 · 局部电子积累与耗尽示意',
      draft: '请为两个候选催化位点设计一组电子结构对照：如何定义相同参考态、统一计算设置，并通过结合能和差分电荷密度检验位点环境的影响？请列出输入与验证条件，仅做研究规划。'
    },
    {
      id: 'reaction', caseId: 'reaction', title: '吸附与反应', english: 'Adsorption & reaction',
      x: .38, edges: [.25, .50], method: '表面 DFT / 反应路径', note: '吸附 / 反应 / 解吸',
      caption: '沿同一晶面追踪吸附物占位、中间体形成与产物解吸。',
      detail: '比较吸附构型、差分电荷密度与吸附能，再定位过渡态求取势垒。',
      legend: '表面网格示意晶面 · 路径标记表示反应步骤',
      draft: '我想研究一个周期性固体表面的吸附与反应。请帮我确定所需输入，并规划从体相弛豫、晶面切割和裸表面弛豫，到吸附构型比较和过渡态搜索的计算流程。'
    },
    {
      id: 'transport', caseId: 'transport', title: '分子与界面输运', english: 'Molecular transport',
      x: .62, edges: [.50, .75], method: '分子动力学 / 三传', note: '扩散 / 热流 / 动量',
      caption: '从分子轨迹观察扩散、能量传递和动量输运，再检查界面附近的变化。',
      detail: '用力场、系综和采样窗定义模型，估算可供工程模型校准的输运系数。',
      legend: '轨迹示意分子运动 · 箭头示意输运方向',
      draft: '请设计用分子动力学评估扩散系数、导热系数和黏度的方案，并列出力场、系综、轨迹采样与不确定度检查。'
    },
    {
      id: 'equipment', caseId: 'equipment', title: '设备与工程场', english: 'Equipment fields',
      x: .87, edges: [.75, 1], method: '有限元 / 流动与换热', note: '设备剖面 / 工程场',
      caption: '从设备几何与运行条件出发，观察局部流动、温度和物质分布。',
      detail: '定义几何、物性、边界条件与源项，安排网格收敛和守恒检查。',
      legend: '色带示意相对温度 · 流线示意流动方向',
      draft: '请帮我拟定一份设备流动与传热模拟方案，列出所需几何、物性、边界条件和源项，并说明如何检查网格收敛与守恒。'
    }
  ];
  const arrow = '<span aria-hidden="true">→</span>';
  const diagonal = '<span aria-hidden="true">↗</span>';
  const brand = '催化研究 <span>STUDIO</span>';
  const mark = '<svg class="cs-brand-mark" aria-hidden="true" width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m12 2 10 6-10 6L2 8zM2 12l10 6 10-6M2 16l10 6 10-6"/></svg>';

  function mount(root, {openDraft, selectCase} = {}) {
    root.innerHTML = `
      <header id="home" class="cs-header">
        <a class="cs-brand" href="#home" aria-label="催化研究 STUDIO 首页">${mark}<strong>${brand}</strong></a>
        <nav id="cs-navigation" aria-label="主导航">
          <a href="#explore">多尺度图景</a><a href="#cases">研究示范</a><a href="#workflow">开始研究</a>
        </nav>
        <a class="cs-entry" href="#studio">进入工作台 ${diagonal}</a>
        <button class="cs-menu" type="button" aria-expanded="false" aria-controls="cs-navigation" aria-label="展开导航"><span aria-hidden="true">☰</span></button>
      </header>
      <main id="main" tabindex="-1">
        <section class="cs-hero" aria-labelledby="cs-title">
          <div class="cs-shell cs-intro">
            <h1 id="cs-title"><span>从催化位点，</span><span>到工程设备。</span></h1>
            <p>位点与电子 · 吸附与反应 · 分子输运 · 设备工程场</p>
            <div class="cs-hero-actions">
              <a class="cs-primary" href="#studio">开始研究 ${arrow}</a>
              <a href="#cases">查看研究示范 ${diagonal}</a>
            </div>
          </div>
          <div id="explore" class="cs-shell cs-explorer" data-scale="overview">
            <div class="cs-toolbar">
              <p><span>SIMULATION ATLAS</span> 多尺度模拟视图</p>
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
                <img src="public/scenes/panorama.webp" alt="催化研究多尺度全景概念图，依次展示催化位点与电子、吸附与反应、分子与界面输运、设备与工程场。" fetchpriority="high">
              </div>
              <div class="cs-overview-note" aria-hidden="true">${scales.slice(1).map(scale => `<span>${scale.note}</span>`).join('')}</div>
            </div>
            <div class="cs-stops" role="tablist" aria-label="选择观察尺度">${scales.map((scale, index) => `
              <button id="cs-tab-${scale.id}" type="button" role="tab" aria-controls="cs-focus" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}">
                <span><strong>${scale.title}</strong><small>${scale.english}</small></span><span class="cs-stop-icon" aria-hidden="true">${index === 0 ? '▤' : '+'}</span>
              </button>`).join('')}
            </div>
            <p class="cs-footnote">全景为 AI 生成的概念示意。色场、网格与轨迹均为定性表达。</p>
          </div>
        </section>
        <div id="cases"></div>
        <div id="parameters"></div>
        <section id="workflow" class="cs-shell cs-workflow">
          <div><h2>让下一个问题，<br>成为研究的起点。</h2><p>带上研究目标与已有条件，进入催化研究工作台。</p></div>
          <a href="#studio" class="cs-primary">进入研究工作台 ${diagonal}</a>
        </section>
      </main>
      <footer class="cs-shell cs-footer">
        <div class="cs-wordmark" aria-hidden="true">${brand}</div>
        <div class="cs-footer-bottom">
          <a href="#home">多尺度的视角，可追溯的研究。</a>
          <button class="cs-about" type="button">能力与来源 ${diagonal}</button><span>© 2026 催化研究 STUDIO</span>
        </div>
      </footer>
      <dialog class="cs-sources" aria-labelledby="cs-sources-title">
        <h2 id="cs-sources-title">能力与来源</h2>
        <p>全景图由 AI 生成，用于定位研究尺度。图中的结构、电子分布、流线与色场为概念示意。</p>
        <p>研究示范覆盖位点、反应、输运与设备尺度。具体图表的来源、模型假设和适用条件随各示范提供。</p>
        <p>工作台支持编辑研究问题。建模时请提供体系、条件与已有数据，并按各尺度的方法核查输入和收敛。</p>
        <form method="dialog"><button class="cs-primary">关闭</button></form>
      </dialog>`;

    const query = selector => root.querySelector(selector);
    const explorer = query('.cs-explorer');
    const stage = query('.cs-stage');
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
      if (focused) {
        const [left, right] = current.edges;
        stage.style.setProperty('--cs-x', `${current.x * 100}%`);
        stage.style.setProperty('--cs-left', `${left * 100}%`);
        stage.style.setProperty('--cs-right', `${(1 - right) * 100}%`);
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
