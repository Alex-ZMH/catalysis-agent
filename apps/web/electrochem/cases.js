(() => {
  "use strict";

  const duration = 8000;
  const methods = [
    {
      id: "site",
      scale: "位点与电子",
      english: "Active sites & electrons",
      question: "如何比较海水电解中的候选活性位？",
      steps: [
        [
          "弛豫体相",
          "弛豫无真空的体相结构，记录磁性设置和收敛结果。",
        ],
        [
          "建立表面位点",
          "从收敛体相切出目标晶面，记录终止、原子映射、固定层、表面厚度与真空层。",
        ],
        [
          "读取电子重排",
          "在同一等值面阈值下比较位点附近的差分电荷密度，再用统一参考态的吸附能检验排序。",
        ],
      ],
      input:
        "体相结构、晶面与终止、Pt/IrO₂ 候选位点、覆盖度、气相参考与收敛阈值。",
      output:
        "表面结构、差分电荷密度、Bader/积分电荷对照、位点吸附构型与统一参考下的吸附能。",
      formulas: [
        [
          "差分电荷密度",
          "Δρ = ρ(slab+adsorbate) − ρ(slab) − ρ(adsorbate)",
          "三个密度使用吸附构型中的几何、同一晶胞和同一网格。跨位点比较时锁定正负等值面。",
        ],
        [
          "吸附能",
          "E_ads = E(slab+X) − E(slab) − E(X,g)",
          "统一电子结构方法，并核对吸附前后的原子数与参考物种。负值表示在该气相参考下吸附放能。",
        ],
      ],
    },
    {
      id: "reaction",
      scale: "阴极析氢 HER",
      english: "Hydrogen evolution",
      question: "如何判断 HER 的电子转移与速控基元步？",
      steps: [
        ["Volmer · 形成 H*", "质子与阴极电子在 Pt 位点耦合，生成吸附氢 H*。"],
        [
          "Heyrovsky · 释放 H₂",
          "H* 与另一个质子、电子结合，形成 H₂ 并再生空位。",
        ],
        [
          "比较能垒",
          "搜索过渡态。它与初态的自由能差为 ΔG‡，终态与初态的自由能差为 ΔG。",
        ],
      ],
      input: "弛豫后的 Pt 表面、H⁺ 活度、电位、溶剂模型、反应端点与路径初猜。",
      output:
        "H* 构型、差分电荷密度、电子转移方向、自由能剖面、分步 ΔG‡ 与适用条件。",
      formulas: [
        [
          "Volmer 步",
          "* + H⁺ + e⁻ → H*",
          "酸性界面写法。电位和质子活度进入自由能修正。",
        ],
        [
          "Heyrovsky 步",
          "H* + H⁺ + e⁻ → H₂ + *",
          "H₂ 为气相参考时需固定压力与标准态。",
        ],
        [
          "反应能垒",
          "ΔG‡ = G_TS − G_initial；ΔG = G_final − G_initial",
          "ΔG 表示反应自由能，ΔG‡ 表示活化自由能。",
        ],
      ],
    },
    {
      id: "transport",
      scale: "阳极析氧 OER",
      english: "Oxygen evolution",
      question: "如何沿 OER 吸附物演化路径定位高能步骤？",
      steps: [
        ["形成 *OH", "水在 IrO₂ 位点活化并释放质子与电子，得到 *OH。"],
        ["形成 *O", "*OH 脱氢并留下吸附氧 *O，电子沿阳极外电路离开。"],
        ["形成 *OOH", "水分子进攻表面氧，形成 O–O 键前体 *OOH。"],
        ["释放 O₂", "*OOH 脱去质子与电子，释放 O₂ 并再生空位，完整 OER 循环释放四个电子。"],
      ],
      input: "弛豫后的 IrO₂ 表面、*OH/*O/*OOH 端点、电位、pH、溶剂与氧气参考。",
      output:
        "吸附物演化结构、O–O 键形成路径、阳极电子抽取方向、分步 ΔG‡ 与选择性边界。",
      formulas: [
        [
          "吸附物演化",
          "* + H₂O → *OH → *O → *OOH → O₂ + *",
          "每个箭头对应一个含质子/电子的电化学基元步。",
        ],
        [
          "电子与质子",
          "2H₂O → O₂ + 4H⁺ + 4e⁻",
          "酸性总半反应。质子经 PEM，电子经外电路。",
        ],
        [
          "析氯竞争",
          "2Cl⁻ → Cl₂ + 2e⁻",
          "直接接触含氯海水时，需根据局部电位、pH 和界面选择性评估。",
        ],
      ],
    },
    {
      id: "equipment",
      scale: "PEM 装置与边界",
      english: "PEM cell & boundary",
      question: "如何把微观电子转移映射到 PEM 电解装置？",
      steps: [
        ["阳极进水与析氧", "纯化水进入 IrO₂ 阳极，水氧化产生 O₂、H⁺ 和电子。"],
        [
          "质子穿过 PEM",
          "H⁺ 通过质子交换膜到达阴极，膜隔开两侧产物和含氯进料。",
        ],
        [
          "外电路供给电子",
          "电子经直流电源流向 Pt 阴极，与 H⁺ 形成 H₂；直接海水路线需标出析氯竞争。",
        ],
      ],
      input:
        "膜电极组件、纯化水流量、阳/阴极催化层、电位、电流密度和含氯海水边界。",
      output: "PEM 剖面、H⁺ 与 e⁻ 两条传递路径、H₂/O₂ 产物侧与析氯风险说明。",
      formulas: [
        [
          "阳极半反应",
          "2H₂O → O₂ + 4H⁺ + 4e⁻",
          "酸性 PEM 水电解的配平阳极反应。",
        ],
        ["阴极半反应", "4H⁺ + 4e⁻ → 2H₂", "质子和外电路电子在阴极结合。"],
        [
          "竞争路径",
          "2Cl⁻ → Cl₂ + 2e⁻",
          "直接海水电解时，用氧气与活性氯选择性共同评估。",
        ],
      ],
    },
  ];
  const reactionSteps = [
    {
      label: "Volmer",
      image: "her-h.webp",
      alt: "铂表面的吸附氢 H*",
      formula: "* + H⁺ + e⁻ → H*",
      barrier: 0.38,
      delta: -0.12,
      copy: "界面质子与阴极电子在 Pt 位点耦合，生成吸附氢 H*。",
    },
    {
      label: "Heyrovsky",
      image: "her.webp",
      alt: "铂表面形成的氢分子脱附",
      formula: "H* + H⁺ + e⁻ → H₂ + *",
      barrier: 0.46,
      delta: -0.08,
      copy: "第二个电子参与还原，H* 与质子结合形成 H₂，并再生空位。",
    },
  ];
  const oerSteps = [
    {
      label: "羟基形成",
      image: "oer-oh.webp",
      alt: "氧化铱表面吸附羟基 *OH",
      formula: "* + H₂O → *OH + H⁺ + e⁻",
      barrier: 0.52,
      delta: 0.11,
      copy: "水在 IrO₂ 位点活化，吸附羟基保留在阳极表面。",
    },
    {
      label: "羟基脱氢",
      image: "oer-o.webp",
      alt: "氧化铱表面的吸附氧 *O",
      formula: "*OH → *O + H⁺ + e⁻",
      barrier: 0.61,
      delta: 0.16,
      copy: "吸附羟基脱氢，表面留下吸附氧 *O。",
    },
    {
      label: "氧氧成键",
      image: "oer-ooh.webp",
      alt: "表面 *OOH 中的氧氧键",
      formula: "*O + H₂O → *OOH + H⁺ + e⁻",
      barrier: 0.78,
      delta: 0.23,
      copy: "水分子进攻表面氧，形成 O–O 键前体 *OOH。",
    },
    {
      label: "氧气释放",
      image: "oer.webp",
      alt: "*OOH 氧化并释放氧气的示意",
      formula: "*OOH → O₂ + * + H⁺ + e⁻",
      barrier: 0.44,
      delta: -0.17,
      copy: "氧分子脱附并再生空位，完整循环共释放四个电子。",
    },
  ];
  const pemSteps = [
    {
      label: "阳极进水",
      formula: "2H₂O → O₂ + 4H⁺ + 4e⁻",
      copy: "纯化水进入 IrO₂ 阳极，生成氧气、质子和电子。",
    },
    {
      label: "质子过膜",
      formula: "H⁺ : anode → cathode",
      copy: "质子穿过 PEM，膜将两侧催化层和产物空间分开。",
    },
    {
      label: "阴极产氢",
      formula: "4H⁺ + 4e⁻ → 2H₂",
      copy: "外电路将电子送到 Pt 阴极，质子与电子结合形成氢气。",
    },
  ];
  const buttons = (labels, active, action) =>
    labels
      .map(
        (label, index) =>
          `<button type="button" data-${action}="${index}" aria-pressed="${index === active}">${label}</button>`,
      )
      .join("");
  const plot = (y, x, body, label) =>
    `<svg class="methods-plot" viewBox="0 0 460 200" role="img" aria-label="${label}"><path class="methods-grid" d="M54 36H436 M54 93H436"/><path class="methods-axis" d="M54 28v122h382m-5-5 5 5-5 5M49 33l5-5 5 5"/><text x="18" y="20">${y}</text><text x="436" y="185" text-anchor="end">${x}</text>${body}</svg>`;

  function energyPath(step) {
    // All six illustrative steps share a range from −0.20 to +0.90 eV.
    const y = energy => 149 - (energy + 0.2) * 106;
    const start = y(0);
    const peak = y(step.barrier);
    const finish = y(step.delta);
    const line = `M90 ${start} C137 ${start} 158 ${peak} 230 ${peak} S326 ${finish} 405 ${finish}`;
    const points = [[90, start, '初态'], [230, peak, '过渡态'], [405, finish, '终态']];
    const marks = points.map(([x, height, name]) =>
      `<circle cx="${x}" cy="${height}" r="4"/><text x="${x}" y="${height-10}" text-anchor="middle">${name}</text>`
    ).join('');
    return `<path class="methods-line is-active" d="${line}"/>${marks}
      <path class="methods-marker" d="M230 ${peak+4}V${start}H90"/>
      <text x="240" y="${(peak+start)/2+5}">ΔG‡ ${step.barrier.toFixed(2)} eV</text>`;
  }

  function reactionFigure(steps, active, electrode) {
    const state = steps[active];
    const cards = steps.map((item, index) =>
      `<button type="button" data-view="${index}" aria-pressed="${index === active}">
         <strong>${item.label}</strong><small>${item.formula}</small>
         <span>ΔG‡ ${item.barrier.toFixed(2)} eV · ΔG ${item.delta > 0 ? '+' : '−'}${Math.abs(item.delta).toFixed(2)} eV</span>
       </button>`
    ).join('');
    return `<div class="ec-visual"><img src="public/scenes/${state.image}" alt="${state.alt}"><div class="ec-visual-tag">${electrode} · ${state.label}</div></div>
      <div class="ec-step-grid" role="group" aria-label="${electrode} 基元步骤">${cards}</div>
      ${plot('相对自由能 G / eV', '反应坐标 →', energyPath(state), state.label + '，初态、过渡态和终态的示例自由能剖面')}
      <figcaption>${state.copy} 示例曲线以本步初态的自由能为零点。</figcaption>`;
  }
  function pemPlate(active) {
    const state = pemSteps[active];
    const cards = pemSteps
      .map(
        (item, index) =>
          `<button type="button" data-view="${index}" aria-pressed="${index === active}"><strong>${item.label}</strong><small>${item.formula}</small></button>`,
      )
      .join("");
    return `<div class="ec-visual ec-visual--device"><img src="public/scenes/pem.webp" alt="PEM 膜电极剖面，显示阳极、质子交换膜、阴极和外电路"><div class="ec-visual-tag">PEM / ${state.label}</div></div><div class="ec-step-grid ec-step-grid--pem" role="group" aria-label="PEM 传递步骤">${cards}</div><div class="ec-pem-note"><strong>${state.label}</strong><p>${state.copy}</p><span>边界条件 · 纯化水进阳极；直接含氯海水时并行记录 2Cl⁻ → Cl₂ + 2e⁻。</span></div><figcaption>质子穿过膜，电子经外电路到达阴极。</figcaption>`;
  }
  function sitePlate() {
    return `<div class="ec-visual"><img src="public/scenes/site.webp" alt="催化剂表面活性位与差分电荷密度示意"><div class="ec-visual-tag">SURFACE / Δρ · charge rearrangement</div></div><div class="ec-charge-legend"><span><i class="is-positive"></i>电子积累</span><span><i class="is-negative"></i>电子耗尽</span><span><i class="is-site"></i>候选位点</span></div><figcaption>冰蓝与暖橙分别标出电子积累和电子耗尽。等值面显示电荷重排的位置，分区积分给出转移电荷量。</figcaption>`;
  }
  function plate(id, view) {
    if (id === "site") return sitePlate();
    if (id === "reaction") return reactionFigure(reactionSteps, view, "HER / Pt");
    if (id === "transport") return reactionFigure(oerSteps, view, "OER / IrO₂");
    return pemPlate(view);
  }
  function mount(root, { openDraft } = {}) {
    const doc = root.ownerDocument,
      win = doc.defaultView,
      motion = win.matchMedia("(prefers-reduced-motion: reduce)");
    let index = 0,
      view = 0,
      frame = null,
      lastTime = null,
      elapsed = 0,
      paused = false,
      hovered = false,
      focused = false,
      swiping = null,
      visible = !win.IntersectionObserver,
      suppressClickUntil = 0;
    root.classList.add("methods-carousel");
    root.setAttribute("aria-labelledby", "methods-title");
    root.innerHTML = `<header class="methods-head"><div><p class="methods-eyebrow">ELECTROCHEMISTRY / RESEARCH STUDIES</p><h2 id="methods-title">不同尺度，可以这样研究。</h2><p class="methods-intro">从活性位电子重排，到 HER、OER 和 PEM 装置边界，每个示范都对应一个可带入研究方案的问题。</p></div><div class="methods-controls" role="group" aria-label="轮播控制"><span class="methods-count"></span><button type="button" data-action="previous" aria-label="上一项">←</button><button type="button" data-action="next" aria-label="下一项">→</button><button type="button" data-action="pause" aria-pressed="false">暂停轮播</button></div></header><progress class="methods-progress" max="${duration}" value="0" aria-label="当前章节自动翻页进度"></progress><div class="methods-scales" role="group" aria-label="研究尺度">${buttons(
      methods.map(
        ({ scale, english }, i) =>
          `<span class="methods-scale-number">0${i + 1}</span><span><strong>${scale}</strong><small lang="en">${english}</small></span>`,
      ),
      0,
      "scale",
    )}</div><p class="methods-status" aria-live="polite" aria-atomic="true"></p><div class="methods-body"></div>`;
    const body = root.querySelector(".methods-body"),
      tabs = [...root.querySelectorAll("[data-scale]")],
      progress = root.querySelector("progress"),
      pause = root.querySelector('[data-action="pause"]'),
      count = root.querySelector(".methods-count"),
      status = root.querySelector(".methods-status"),
      pad = (number) => String(number).padStart(2, "0");
    function paintFigure(selector) {
      const figure = body.querySelector("figure");
      figure.innerHTML = plate(methods[index].id, view);
      if (selector)
        figure.querySelector(selector)?.focus({ preventScroll: true });
    }
    function selectIndex(target, announce = true) {
      const restoreFocus = body.contains(doc.activeElement);
      index = (target + methods.length) % methods.length;
      view = 0;
      elapsed = 0;
      lastTime = null;
      progress.value = 0;
      const item = methods[index];
      root.dataset.method = item.id;
      count.textContent = `${pad(index + 1)} / ${pad(methods.length)}`;
      tabs.forEach((tab, position) =>
        tab.setAttribute("aria-pressed", String(position === index)),
      );
      if (restoreFocus) tabs[index].focus({ preventScroll: true });
      if (announce) status.textContent = `${item.scale}，${item.question}`;
      body.innerHTML = `<article class="methods-question"><h3>${item.question}</h3><ol>${item.steps.map(([title, detail]) => `<li><strong>${title}</strong><p>${detail}</p></li>`).join("")}</ol><button type="button" class="methods-draft" data-action="draft">用这个问题开始研究 <span aria-hidden="true">↗</span></button><details><summary>公式与使用条件</summary>${item.formulas.map(([name, formula, condition]) => `<div class="methods-equation"><strong>${name}</strong><code>${formula}</code><p>${condition}</p></div>`).join("")}</details></article><div class="methods-readout"><div class="methods-plate-head"><h4>方法图谱</h4><span>定性示意</span></div><figure></figure><dl><div><dt>输入</dt><dd>${item.input}</dd></div><div><dt>输出</dt><dd>${item.output}</dd></div></dl></div>`;
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
      pause.textContent = motion.matches
        ? "已关闭自动轮播"
        : paused
          ? "继续轮播"
          : "暂停轮播";
      pause.setAttribute("aria-pressed", String(paused || motion.matches));
      if (
        visible &&
        !doc.hidden &&
        !paused &&
        !motion.matches &&
        !hovered &&
        !focused &&
        !swiping
      ) {
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
      if (data.action === "previous") selectIndex(index - 1);
      if (data.action === "next") selectIndex(index + 1);
      if (data.action === "pause") {
        paused = !paused;
        sync();
      }
      if (data.action === "draft") {
        const item = methods[index],
          focus =
            item.id === "reaction"
              ? reactionSteps[view].label
              : item.id === "transport"
                ? oerSteps[view].label
                : item.id === "equipment"
                  ? pemSteps[view].label
                  : "候选位点";
        openDraft?.(
          [
            `研究问题：${item.question}`,
            `当前图谱视角：${focus}`,
            `输入：${item.input}`,
            `输出：${item.output}`,
            "请列出研究步骤和所需输入。",
          ].join("\n"),
        );
      }
    });
    root.addEventListener("keydown", (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
        return;
      const target = {
        ArrowLeft: index - 1,
        ArrowRight: index + 1,
        Home: 0,
        End: methods.length - 1,
      }[event.key];
      if (!Number.isInteger(target)) return;
      event.preventDefault();
      const fromScale = tabs.includes(event.target);
      selectIndex(target);
      if (fromScale) tabs[index].focus({ preventScroll: true });
    });
    root.addEventListener("focusin", () => {
      focused = true;
      sync();
    });
    root.addEventListener("focusout", (event) => {
      focused = root.contains(event.relatedTarget);
      sync();
    });
    root.addEventListener("pointerenter", (event) => {
      if (event.pointerType !== "touch") {
        hovered = true;
        sync();
      }
    });
    root.addEventListener("pointerleave", (event) => {
      if (event.pointerType !== "touch") {
        hovered = false;
        sync();
      }
    });
    body.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "touch" && event.isPrimary) {
        swiping = { id: event.pointerId, x: event.clientX, y: event.clientY };
        sync();
      }
    });
    const endSwipe = (event) => {
      if (swiping?.id !== event.pointerId) return;
      const dx = event.clientX - swiping.x,
        dy = event.clientY - swiping.y;
      swiping = null;
      if (
        event.type === "pointerup" &&
        Math.abs(dx) >= 48 &&
        Math.abs(dx) > 1.15 * Math.abs(dy)
      ) {
        suppressClickUntil = win.performance.now() + 500;
        selectIndex(index + (dx < 0 ? 1 : -1));
      }
      sync();
    };
    win.addEventListener("pointerup", endSwipe);
    win.addEventListener("pointercancel", endSwipe);
    doc.addEventListener("visibilitychange", sync);
    motion.addEventListener("change", sync);
    if (win.IntersectionObserver)
      new win.IntersectionObserver(([entry]) => {
        visible = entry.isIntersecting;
        sync();
      }).observe(body);
    selectIndex(0, false);
    sync();
    return {
      select(id) {
        const target = methods.findIndex(
          (item) =>
            item.id ===
            (id === "surface" ? "site" : id === "md" ? "transport" : id),
        );
        if (target < 0) return false;
        selectIndex(target);
        return true;
      },
    };
  }
  window.CatalysisCases = { mount };
})();
