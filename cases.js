(() => {
  "use strict";

  const duration = 8000;
  const methods = [
    {
      id: "site", scale: "位点与电子", english: "Active sites & electrons",
      question: "如何比较两个候选位点？",
      steps: [
        ["校核体相", "先弛豫无真空的体相，记录电子自洽与结构收敛证据。"],
        ["切面并建立位点", "从收敛体相切面，记录终止、原子映射与固定层，检查厚度、真空及周期镜像，按需弛豫裸表面。"],
        ["比较吸附构型", "弛豫候选构型并比较吸附能。统一泛函、赝势、截断能、K 点采样标准、磁性和 DFT+U 设置。"]
      ],
      input: "体相结构、晶面和终止、候选位点、覆盖度、气相参考与收敛阈值。",
      output: "裸表面与吸附构型、收敛记录、差分电荷密度与统一参考下的吸附能对照表。",
      boundary: "位点排序取决于终止、覆盖度和参考态。电子积累与耗尽图用于定位电荷重排，由一致条件下的能量比较检验稳定性。",
      formulas: [
        ["吸附能", "E_ads = E(表面+吸附物) − E(裸表面) − E(气相吸附物)", "此式以单个气相分子为参考，三项须有一致的组成账目和计算精度。负值表示在该参考下吸附放能。"],
        ["差分电荷密度", "Δρ = ρ(表面+吸附物) − ρ(表面) − ρ(吸附物)", "各片段取吸附构型中的几何，统一晶胞与密度网格。跨位点比较时使用同一正负等值面阈值。"]
      ]
    },
    {
      id: "reaction", scale: "吸附与反应", english: "Adsorption & reaction",
      question: "如何判断催化循环的瓶颈？",
      steps: [
        ["定义状态与参考", "锁定原子映射、表面位点、化学计量及温度、压力或活度。"],
        ["搜索路径与过渡态", "用 NEB 等方法搜索候选路径，检查端点相连、力收敛及过渡态的虚频方向。"],
        ["检验速控环节", "统一参考并补充热力学校正，再用给定工况下的覆盖度与速率敏感性检验瓶颈。"]
      ],
      input: "收敛端点、候选中间体、路径初猜、温度与参考态。涉及电化学时补充电位、活度与电子数。",
      output: "路径结构、驻点及频率证据、自由能剖面、分步能垒与适用条件。",
      boundary: "同一横轴表示反应坐标，阶段间距没有物理尺度。端点自由能差描述热力学，能垒须以过渡态为参考求差。",
      formulas: [
        ["反应自由能与能垒", "ΔG_rxn = G_final − G_initial；ΔG‡ = G_TS − G_intermediate", "正向分步能垒以该步的起始中间体为参考。吸附或解吸是否存在独立过渡态须由路径证据确定。"],
        ["阿伦尼乌斯方程", "k = A exp(−Eₐ / RT)", "适用于机理和拟合参数在考察温区近似稳定的速率常数。Eₐ 由温度依赖性拟合，与自由能剖面的 ΔG‡ 分别定义。"],
        ["能斯特方程", "E_eq = E° − (RT/nF) ln Q", "仅当涉及可逆电化学平衡时使用。按所写氧化还原反应定义电子数 n 和基于活度的 Q，统一电位参考。"]
      ]
    },
    {
      id: "transport", scale: "分子与界面输运", english: "Molecular transport",
      question: "如何区分本征反应慢与输运慢？",
      steps: [
        ["生成可重复的 MD 轨迹", "定义力场、界面、温度与系综。平衡后记录位置、速度、能量与应力，设置取样面和时间窗。"],
        ["从轨迹提取输运量", "展开周期坐标求均方位移，按取样面统计能量交换，累积剪切应力自相关以估算黏度。"],
        ["对照本征与输运时间尺度", "用有依据的输运长度 L 和扩散系数估算 L²/D，与同工况本征动力学时间对照，再通过改变输运长度或流动条件验证。"]
      ],
      input: "力场、界面结构、系综、轨迹时长与采样频率、取样面和本征动力学参考。",
      output: "轨迹、均方位移与拟合区间、取样面热通量、应力相关与黏度、分块误差及时间尺度对照。",
      boundary: "输运与反应时间必须对应同工况及实测或合理估计的长度。MD 自扩散系数用于工程传质前须核对物理定义与尺度。",
      formulas: [
        ["自扩散系数", "D = (1/2d) d⟨|Δr(t)|²⟩/dt，取长时间扩散区", "d 为跟踪方向数。展开周期坐标，剔除整体漂移。界面平行与法向分别取样，核对扩散区与误差。"],
        ["穿面热通量", "J_q = ΔE / (A Δt)", "ΔE 为统计窗内沿指定法向交换的净热量，A 为取样面积。有净质量流时按热流定义扣除对流焓输运。"],
        ["剪切黏度", "η = V/(k_B T) ∫₀^∞ ⟨δP_xy(0)δP_xy(t)⟩ dt", "平衡、均匀体相的 Green–Kubo 形式。分块检查相关积分平台，并核对取样长度、应力定义及有限尺寸影响。"]
      ]
    },
    {
      id: "equipment", scale: "设备与工程场", english: "Equipment fields",
      question: "如何评估设备放大后的风险？",
      steps: [
        ["选设备与控制体", "标出进出口、相界面、壁面与换热面，列出基准尺度和放大后工况。"],
        ["选择流动与传热闭合", "结合搅拌、气固流化或管壳两侧流动，确定旋转、多相或共轭传热模型。"],
        ["核对收支与放大敏感性", "按同一取样方式比较局部场和进出口收支，检查网格、时间步和闭合敏感性。"]
      ],
      input: "设备几何、基准与放大工况、入口流量和温度、出口条件、物性、壁面与相间闭合。",
      output: "带取样线的场图、温度或速度剖面、进出口收支与放大敏感性记录。",
      boundary: "示意场与曲线共用人工解析场及归一化范围。放大风险评估需用实际边界、物性、闭合及验证数据。",
      formulas: [
        ["连续性与雷诺数", "∂ρ/∂t + ∇·(ρu) = 0；Re = ρUL/μ", "连续性式假设无质量源。常密度时 ∇·u = 0。Re 的特征速度 U、长度 L 和判据须与几何及流态相配。"],
        ["Navier–Stokes 方程", "ρ(∂u/∂t + u·∇u) = −∇p + μ∇²u + ρg", "此形式针对不可压、常黏度牛顿流体；湍流平均、多相与变物性需要相应闭合。"],
        ["组分与能量", "∂c/∂t + u·∇c = D∇²c + S_c；ρcₚ(∂T/∂t + u·∇T) = λ∇²T + q̇", "示例采用常物性、稀溶质 Fick 扩散和 Fourier 导热，忽略压缩功与黏性耗散。源项按组分体积生成率及体积热源计。"],
        ["伯努利关系", "p + ½ρ|u|² + ρgz = 常数", "用于稳态、不可压、沿同一流线且黏性损失与轴功可忽略的区段。设备整体压降须计入损失、轴功或相间作用。"],
        ["控制体能量收支", "Σ_out ṁh − Σ_in ṁh = Q̇ − Ẇ_s", "稳态、忽略动能及势能差时适用。热流入为正，轴功输出为正，反应时须统一物种焓基准。"]
      ]
    }
  ];

  const phases = [
    ["吸附", "气相 R 接近空位 *，形成吸附态 R*，图中自由能下降至第一个局部最低点。"],
    ["表面反应", "R* 经过示意过渡态 ‡ 形成 P*。峰顶至 R* 的竖向差为该正向步骤的 ΔG‡。"],
    ["解吸", "P* 释放为气相 P 并再生空位。示意图中分离态高于 P*，未假设独立解吸峰。"]
  ];
  const transport = [
    ["组分 · D", "均方位移", "轨迹滞后时间 →", "短时运动后进入示意线性扩散区，冰蓝线的长时斜率用于估算 D。", "M54 150 Q86 150 126 124 L420 37"],
    ["热量 · 热通量", "净穿面热量", "取样时间 →", "在虚线取样面统计净能量交换。冰蓝线示意累积量，取稳态窗内斜率并除以面积。", "M54 150 L88 148 102 137 142 137 160 127 197 125 219 108 252 107 272 89 306 87 332 71 368 70 393 55 420 50"],
    ["动量 · 黏度", "应力自相关积分", "轨迹滞后时间 →", "动量交换可由应力张量表征。冰蓝线示意自相关累积积分，由稳定平台估算黏度。", "M54 150 C96 80 125 56 190 56 Q300 63 420 57"]
  ];
  const equipment = [
    { name: "搅拌釜", key: "stirred", image: "reactor", position: "釜内水平截线" },
    { name: "流化床", key: "bed", image: "fluidized", position: "从分布板向上的中心线" },
    { name: "换热器", key: "exchanger", image: "exchanger", position: "上通道沿流向的中心线" }
  ];

  function buttons(labels, active, action) {
    return labels.map((label, index) => `<button type="button" data-${action}="${index}" aria-pressed="${index === active}">${label}</button>`).join("");
  }

  function plot(y, x, body, label) {
    return `<svg class="methods-plot" viewBox="0 0 460 200" role="img" aria-label="${label}">
      <path class="methods-grid" d="M54 36H436 M54 93H436"/>
      <path class="methods-axis" d="M54 28v122h382m-5-5 5 5-5 5M49 33l5-5 5 5"/>
      <text x="18" y="20">${y}</text><text x="436" y="185" text-anchor="end">${x}</text>
      ${body}
    </svg>`;
  }

  function curve(path) {
    return `<path class="methods-line" d="${path}"/>`;
  }

  function reactionPlate(active) {
    const segments = [
      "M64 88 C98 88 110 127 149 127",
      "M149 127 C188 127 193 47 230 47 S273 135 309 135",
      "M309 135 C344 135 371 112 419 112"
    ];
    const states = [[64, 88, "R + *", -10], [149, 127, "R*", -10], [230, 47, "‡", -10], [309, 135, "P*", -10], [419, 112, "P + *", -10]];
    const graph = segments.map((path, index) => `<path class="methods-line${index === active ? " is-active" : ""}" d="${path}"/>`).join("")
      + states.map(([x, y, label, offset]) => `<circle cx="${x}" cy="${y}" r="3.5"/><text x="${x}" y="${y + offset}" text-anchor="middle">${label}</text>`).join("")
      + (active === 1 ? '<path class="methods-marker" d="M220 47H202V127H153 M198 52l4-5 4 5 M198 122l4 5 4-5"/><text x="168" y="80">ΔG‡</text>' : "");
    const panels = phases.map(([label], index) => {
      const [before, after] = [["R + *", "R*"], ["R*", "P*"], ["P*", "P + *"]][index];
      return `<button type="button" data-view="${index}" aria-pressed="${index === active}">
        <strong>${label}</strong>
        <svg viewBox="0 0 120 54" aria-hidden="true">
          <path class="methods-axis" d="M8 45h41m22 0h41 M52 24h16m-5-4 5 4-5 4"/>
          <path class="methods-axis" d="${index === 0 ? "" : "M29 37v5"} ${index === 2 ? "" : "M92 37v5"}"/>
          <circle class="methods-site" cx="29" cy="45" r="4"/><circle class="methods-site" cx="92" cy="45" r="4"/>
          <circle class="methods-species" cx="29" cy="${index === 0 ? 12 : 33}" r="6"/>
          <circle class="methods-species ${index ? "is-product" : ""}" cx="92" cy="${index === 2 ? 12 : 33}" r="6"/>
        </svg>
        <span>${before} → ${after}</span>
      </button>`;
    }).join("");
    return `<div class="methods-triptych" role="group" aria-label="反应阶段">${panels}</div>
      ${plot("相对自由能 G", "反应坐标 →", graph, "定性自由能图：分离反应物降至吸附态 R*，越过过渡态后降至 P*，解吸后升至分离产物")}
      <figcaption>${phases[active][1]} 冰蓝圆为反应物 R，浅紫圆为产物 P，短横线为空间示意中的表面，空心圆为位点 *，‡ 为过渡态，金线为当前步骤。</figcaption>`;
  }

  function plate(id, view, field) {
    if (id === "site") {
      return `<img src="public/scenes/dft.svg" alt="固体表面差分电荷密度示意，分别标出电子积累与电子耗尽">
        <figcaption>冰蓝为电子积累，暖橙为电子耗尽。比较两个位点时，用同一等值面阈值和观察方向读取界面重排的位置与范围。</figcaption>`;
    }
    if (id === "reaction") return reactionPlate(view);
    if (id === "transport") {
      const [, axis, position, description, path] = transport[view];
      return `<div class="methods-options" role="group" aria-label="传递量">${buttons(transport.map(([name]) => name), view, "view")}</div>
        <div class="methods-md-map">
          <img src="public/scenes/md.svg" alt="分子运动及取样面，标出组分、热量和动量通量">
          <svg viewBox="0 0 800 400" aria-hidden="true">
            <rect x="586" y="${[187, 130, 244][view]}" width="161" height="39" rx="5"/>
            ${view === 0 ? '<path d="M91 168l18-11 19 15 17-25 22 7 16-8 17 12"/>' : ""}
          </svg>
        </div>
        ${plot(axis, position, curve(path), description)}
        <figcaption>${description} 金框标出所选输运量。${view === 0 ? "金色虚线示意分子轨迹。" : ""} 粒子运动、通量箭头与曲线均为取样方法示意。</figcaption>`;
    }
    const item = equipment[view];
    const mode = field === 0 ? "temperature" : "velocity";
    const quantity = field === 0 ? "温度" : "速度幅值";
    const values = window.CatalysisProfiles?.[item.key]?.[mode];
    const profile = values?.length > 1
      ? plot(`归一化${quantity}`, "取样线 A → B",
        '<text x="39" y="40">1</text><text x="39" y="150">0</text>' +
        curve(values.map((value, i) => `${i ? "L" : "M"}${54 + 366 * i / (values.length - 1)} ${150 - 114 * value}`).join(" ")),
        `${item.name}沿取样线 A 到 B 的归一化${quantity}`)
      : '<p>取样线数据未载入。</p>';
    return `<div class="methods-options" role="group" aria-label="设备">${buttons(equipment.map(({ name }) => name), view, "view")}</div>
      <div class="methods-options" role="group" aria-label="剖面变量">${buttons(["温度", "速度"], field, "field")}</div>
      <img src="public/scenes/field-${item.key}-${mode}.svg" alt="${item.name}的归一化${quantity}场，标出取样线 A 到 B">
      ${profile}
      <details><summary>设备结构参照</summary><img loading="lazy" src="public/scenes/${item.image}.svg" alt="${item.name}结构剖面"></details>
      <figcaption>色标表示归一化${quantity}。冰蓝曲线取自同一人工解析场中的 A → B 线，即${item.position}。</figcaption>`;
  }

  function mount(root, { openDraft } = {}) {
    const doc = root.ownerDocument;
    const win = doc.defaultView;
    const motion = win.matchMedia("(prefers-reduced-motion: reduce)");
    let index = 0, view = 0, field = 0;
    let frame = null, lastTime = null, elapsed = 0;
    let paused = false, hovered = false, focused = false, swiping = null;
    let visible = !win.IntersectionObserver, suppressClickUntil = 0;

    root.classList.add("methods-carousel");
    root.setAttribute("aria-labelledby", "methods-title");
    root.innerHTML = `<header class="methods-head">
      <div><p class="methods-eyebrow">CATALYSIS / RESEARCH STUDIES</p><h2 id="methods-title">不同尺度，可以这样研究。</h2>
      <p class="methods-intro">从位点比较到设备放大，每个示范都对应一个可带入工作台的研究问题。</p></div>
      <div class="methods-controls" role="group" aria-label="轮播控制">
        <span class="methods-count"></span>
        <button type="button" data-action="previous" aria-label="上一项">←</button>
        <button type="button" data-action="next" aria-label="下一项">→</button>
        <button type="button" data-action="pause" aria-pressed="false">暂停轮播</button>
      </div>
    </header>
    <progress class="methods-progress" max="${duration}" value="0" aria-label="当前章节自动翻页进度"></progress>
    <div class="methods-scales" role="group" aria-label="研究尺度">${buttons(methods.map(({ scale, english }, i) => `<span class="methods-scale-number">0${i + 1}</span><span><strong>${scale}</strong><small lang="en">${english}</small></span>`), 0, "scale")}</div>
    <p class="methods-status" aria-live="polite" aria-atomic="true"></p>
    <div class="methods-body"></div>`;

    const body = root.querySelector(".methods-body");
    const tabs = [...root.querySelectorAll("[data-scale]")];
    const progress = root.querySelector("progress");
    const pause = root.querySelector('[data-action="pause"]');
    const count = root.querySelector(".methods-count");
    const status = root.querySelector(".methods-status");
    const pad = (number) => String(number).padStart(2, "0");

    function paintFigure(selector) {
      const figure = body.querySelector("figure");
      figure.innerHTML = plate(methods[index].id, view, field);
      if (selector) figure.querySelector(selector)?.focus({ preventScroll: true });
    }

    function selectIndex(target, announce = true) {
      const restoreFocus = body.contains(doc.activeElement);
      index = (target + methods.length) % methods.length;
      view = 0;
      field = 0;
      elapsed = 0;
      lastTime = null;
      progress.value = 0;
      const item = methods[index];
      root.dataset.method = item.id;
      count.textContent = `${pad(index + 1)} / ${pad(methods.length)}`;
      tabs.forEach((tab, position) => tab.setAttribute("aria-pressed", String(position === index)));
      if (restoreFocus) tabs[index].focus({ preventScroll: true });
      if (announce) status.textContent = `${item.scale}，${item.question}`;
      body.innerHTML = `<article class="methods-question">
        <h3>${item.question}</h3>
        <ol>${item.steps.map(([title, detail]) => `<li><strong>${title}</strong><p>${detail}</p></li>`).join("")}</ol>
        <button type="button" class="methods-draft" data-action="draft">用这个问题开始研究 <span aria-hidden="true">↗</span></button>
        <details><summary>公式与使用条件</summary>
          ${item.formulas.map(([name, formula, condition]) => `<div class="methods-equation"><strong>${name}</strong><code>${formula}</code><p>${condition}</p></div>`).join("")}
        </details>
      </article>
      <div class="methods-readout">
        <div class="methods-plate-head"><h4>方法图谱</h4><span>定性示意</span></div>
        <figure></figure>
        <dl><div><dt>输入</dt><dd>${item.input}</dd></div><div><dt>可查产物</dt><dd>${item.output}</dd></div></dl>
        <p class="methods-boundary"><strong>使用边界</strong> ${item.boundary}</p>
      </div>`;
      paintFigure();
    }

    function tick(time) {
      frame = null;
      if (lastTime !== null) elapsed += time - lastTime;
      lastTime = time;
      if (elapsed >= duration) selectIndex(index + 1, false);
      progress.value = elapsed;
      frame = win.requestAnimationFrame(tick);
    }

    function sync() {
      pause.disabled = motion.matches;
      pause.textContent = motion.matches ? "已关闭自动轮播" : paused ? "继续轮播" : "暂停轮播";
      pause.setAttribute("aria-pressed", String(paused || motion.matches));
      if (visible && !doc.hidden && !paused && !motion.matches && !hovered && !focused && !swiping) {
        if (frame === null) frame = win.requestAnimationFrame(tick);
      } else {
        if (frame !== null) win.cancelAnimationFrame(frame);
        frame = null;
        lastTime = null;
      }
    }

    root.addEventListener("click", (event) => {
      if (event.detail && win.performance.now() < suppressClickUntil) return;
      const button = event.target.closest("button");
      if (!button || !root.contains(button)) return;
      const data = button.dataset;
      if (data.scale !== undefined) selectIndex(Number(data.scale));
      if (data.view !== undefined) {
        view = Number(data.view);
        paintFigure(`[data-view="${view}"]`);
      }
      if (data.field !== undefined) {
        field = Number(data.field);
        paintFigure(`[data-field="${field}"]`);
      }
      if (data.action === "previous") selectIndex(index - 1);
      if (data.action === "next") selectIndex(index + 1);
      if (data.action === "pause") {
        paused = !paused;
        sync();
      }
      if (data.action === "draft") {
        const item = methods[index];
        const focus = { reaction: phases[view][0], transport: transport[view][0], equipment: `${equipment[view].name} · ${field === 0 ? "温度" : "速度"}` }[item.id];
        openDraft?.([
          `研究问题：${item.question}`,
          ...(focus ? [`当前图谱视角：${focus}`] : []),
          `输入：${item.input}`,
          `可查产物：${item.output}`,
          `使用边界：${item.boundary}`,
          "请先确认缺失输入，再给出可编辑的研究方案、核验步骤和使用条件。仅做规划。"
        ].join("\n"));
      }
    });

    root.addEventListener("keydown", (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: methods.length - 1 }[event.key];
      if (!Number.isInteger(target)) return;
      event.preventDefault();
      const fromScale = tabs.includes(event.target);
      selectIndex(target);
      if (fromScale) tabs[index].focus({ preventScroll: true });
    });
    root.addEventListener("focusin", () => { focused = true; sync(); });
    root.addEventListener("focusout", (event) => {
      focused = root.contains(event.relatedTarget);
      sync();
    });
    root.addEventListener("pointerenter", (event) => {
      if (event.pointerType === "touch") return;
      hovered = true;
      sync();
    });
    root.addEventListener("pointerleave", (event) => {
      if (event.pointerType === "touch") return;
      hovered = false;
      sync();
    });
    body.addEventListener("pointerdown", (event) => {
      if (event.pointerType !== "touch" || !event.isPrimary) return;
      swiping = { id: event.pointerId, x: event.clientX, y: event.clientY };
      sync();
    });
    function endSwipe(event) {
      if (swiping?.id !== event.pointerId) return;
      const dx = event.clientX - swiping.x;
      const dy = event.clientY - swiping.y;
      swiping = null;
      if (event.type === "pointerup" && Math.abs(dx) >= 48 && Math.abs(dx) > 1.15 * Math.abs(dy)) {
        suppressClickUntil = win.performance.now() + 500;
        selectIndex(index + (dx < 0 ? 1 : -1));
      }
      sync();
    }
    win.addEventListener("pointerup", endSwipe);
    win.addEventListener("pointercancel", endSwipe);
    doc.addEventListener("visibilitychange", sync);
    motion.addEventListener("change", sync);
    if (win.IntersectionObserver) {
      new win.IntersectionObserver(([entry]) => {
        visible = entry.isIntersecting;
        sync();
      }).observe(body);
    }
    selectIndex(0, false);
    sync();

    return {
      select(id) {
        const canonical = id === "surface" ? "reaction" : id === "md" ? "transport" : id;
        const target = methods.findIndex((item) => item.id === canonical);
        if (target < 0) return false;
        selectIndex(target);
        return true;
      }
    };
  }

  window.CatalysisCases = { mount };
})();
