(() => {
  "use strict";

  const kindLabel = { md_transport: "MD 热、质与动量传递", md_thermo: "LAMMPS 热力学曲线", md_msd: "原子组 MSD 与扩散", adsorption: "VASP 吸附能", kinetics: "动力学拟合", md: "LAMMPS 轨迹", equipment: "VTU 场与线剖面" };
  const transportModes = {
    conductivity: { name: "热传递 · 热导率", field: "温度", flux: "热通量", coefficient: "热导率" },
    diffusivity: { name: "质量传递 · 扩散系数", field: "浓度", flux: "质量通量", coefficient: "扩散系数" },
    viscosity: { name: "动量传递 · 动力黏度", field: "流向速度", flux: "剪切分量", coefficient: "动力黏度" },
  };
  const transportAssumptions = new Map([
    ["The coordinate, field and signed flux or stress describe the same selected component and samples.",
      "位置坐标、场量和带符号的通量或应力须对应同一选定分量和同一批样本。"],
    ["Ordinary least squares fits field versus mean sampled position with an intercept and equal weight per occupied position or bin.",
      "采用含截距的普通最小二乘法，拟合场量与平均采样位置的关系。每个有采样的位置或分箱权重相同。"],
    ["Each selected source row contributes equally to mean flux or stress, including samples at repeated positions. Time selects rows and supplies no additional weight.",
      "计算平均通量或应力时，入选数据行等权，包括同一位置的重复采样。时间只用于筛选数据行。"],
    ["The selected samples represent a linear transport regime. The input flux or stress is already intensive and normalized for the intended geometry and transport direction.",
      "假定入选样本处于线性输运区间。输入的通量或应力应为强度量，并已按所选几何和输运方向完成归一化。"],
    ["The driving option records what the experiment imposed. The fit and mean use the observed columns in either case.",
      "驱动条件仅记录实验施加的是梯度还是通量。两种情况下，拟合和求平均均使用所选观测列。"],
  ]);
  const transportUnitExamples = {
    position: ["m", "nm", "angstrom"],
    time: ["s", "ns", "ps", "fs", "step"],
    conductivity: { field: ["K"], flux: ["W/m^2", "eV/(angstrom^2*ps)"] },
    diffusivity: { field: ["kg/m^3", "mol/m^3", "1/m^3"], flux: ["kg/(m^2*s)", "mol/(m^2*s)", "1/(m^2*s)"] },
    viscosity: { field: ["m/s", "angstrom/ps"], flux: ["Pa", "bar", "atm"] },
  };
  const rawKind = kind => kind === "md" || kind === "equipment";
  const originLabel = { synthetic: "合成数据", research: "研究数据" };
  const modelLabel = { arrhenius_known_k: "Arrhenius（已测速率常数）", initial_rate_power_law: "初始速率幂律" };
  const units = {
    arrhenius_known_k: ["s^-1", "mol/L/s", "L/mol/s", "L^2/mol^2/s"],
    initial_rate_power_law: ["mol/L/s", "mol/(kg_cat*s)", "mol/(m2_cat*s)"],
  };
  const columnKeys = ["temperature", "value", "batch_id", "condition_id", "partition",
    "observation_id", "relative_uncertainty", "conversion_fraction"];
  const terms = new Map(Object.entries({
    comparable: "可比较", noncomparable: "不可比较", unconverged: "未收敛",
    converged: "已收敛", uncertain: "收敛状态待定", cell_size_exceeded: "超过尺寸参考值",
    lattice_mismatch: "晶格与裸表面不同", scf_limit_ambiguous: "达到电子迭代上限",
    finite_size: "有限尺寸证据不足", slab_protocol: "表面模型设置不一致",
    electronic_method: "电子结构方法不一致", reference_protocol: "参考态设置不一致",
    reference_stoichiometry: "参考态计量不一致", charge_balance: "电荷不平衡",
    training_only: "仅训练集", independent_batch_repeatability: "独立批次重复性",
    independent_batch_new_conditions: "独立批次新工况",
    independent_batch_mixed_conditions: "独立批次含重复工况和新工况",
    single_training_batch: "仅一个训练批次", no_holdout: "未设置留出集",
    no_condition_residual_dof: "工况层面无残差自由度",
    raw: "原始输入", input: "输入", source: "来源", result: "结果",
    output: "输出", config: "配置", evidence: "证据",
    accepted: "通过", review: "待复核", blocked: "受阻",
  }));
  const translate = value => terms.get(value) ?? value;

  function element(tag, value, className) {
    const node = document.createElement(tag);
    if (value != null) node.textContent = value;
    if (className) node.className = className;
    return node;
  }

  function setStatus(node, message, error = false) {
    node.textContent = message;
    node.classList.toggle("ca-warning", error);
  }

  let projectPrefix = "";

  function projectPath(path) {
    if (!projectPrefix || !path.startsWith("/api/")) return path;
    if (path.startsWith("/api/projects/")) {
      if (!path.startsWith(projectPrefix + "/")) throw new Error("下载链接不属于当前项目。");
      return path;
    }
    return projectPrefix + path.slice(4);
  }

  function downloadLink(url, label) {
    const link = element("a", label);
    try {
      if (!url) return link;
      const target = new URL(url, location.href);
      if (target.origin === location.origin && /^https?:$/.test(target.protocol)) {
        target.pathname = projectPath(target.pathname);
        link.href = target.href;
        link.download = "";
      }
    } catch {
      // Malformed artifact URLs remain plain text.
    }
    return link;
  }

  const integerIdentifiers = new Set(["id", "timestep", "step_origin"]);

  function preserveIdentifier(key, value, context) {
    if (integerIdentifiers.has(key) && Number.isInteger(value) && !Number.isSafeInteger(value)
        && /^-?\d+$/.test(context?.source ?? "")) {
      return context.source;
    }
    return value;
  }

  async function request(path, body, kind, headers, signal) {
    const options = { cache: "no-store", signal };
    const response = await fetch(path, body ? { ...options, method: "POST", body, headers } : options);
    if (response.ok && (path === "/api/login" || path === "/api/logout")) return;
    const payload = kind === "md"
      ? response.text().then(source => JSON.parse(source, preserveIdentifier))
      : response.json();
    const data = await payload.catch(() => null);
    if (!response.ok || !data) {
      const error = new Error(data?.error || `服务返回异常响应（HTTP ${response.status}）`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function details(title, value) {
    const section = element("details");
    section.append(element("summary", title), element("pre", JSON.stringify(value, null, 2)));
    return section;
  }

  function metrics(entries) {
    const list = element("dl", null, "ca-metrics");
    for (const [label, value] of entries) {
      const item = element("div");
      item.append(element("dt", label), element("dd", value ?? "未报告"));
      list.append(item);
    }
    return list;
  }

  const formatNumber = value => Number.isFinite(value) ? String(Number(value.toPrecision(9))) : "—";
  const vector = values => values?.map(formatNumber).join(", ") ?? "—";
  const exactIdentifier = value => typeof value === "string" || Number.isSafeInteger(value) ? String(value) : null;
  const identifierLabel = value => exactIdentifier(value) ?? "超出浏览器整数精度";

  function frameTime(frame, time) {
    if (time?.mode !== "constant_dt") return frame.time;
    const step = exactIdentifier(frame.timestep);
    const origin = exactIdentifier(time.step_origin);
    if (step === null || origin === null) return null;
    return time.time_origin + Number(BigInt(step) - BigInt(origin)) * time.dt;
  }

  function pager(id, label, count, pageSize, render) {
    const container = element("div", null, "ca-a5-pages");
    container.id = id;
    const bar = element("div", null, "ca-a5-bar");
    const body = element("div");
    const pages = Math.max(1, Math.ceil(count / pageSize));
    const back = element("button", "上一页");
    const next = element("button", "下一页");
    back.type = next.type = "button";
    const page = element("input");
    page.type = "number";
    page.min = 1;
    page.max = pages;
    const caption = element("label", label);
    caption.append(page);
    const status = element("span");
    status.setAttribute("role", "status");
    let current = 0;
    function show(index) {
      current = Math.min(pages - 1, Math.max(0, index));
      const start = current * pageSize;
      page.value = current + 1;
      back.disabled = current === 0;
      next.disabled = current + 1 === pages;
      status.textContent = `${current + 1} / ${pages} 页 · ${count} 条`;
      body.replaceChildren();
      render(body, start, Math.min(start + pageSize, count));
    }
    back.addEventListener("click", () => show(current - 1));
    next.addEventListener("click", () => show(current + 1));
    page.addEventListener("change", () => show(Number.isInteger(page.valueAsNumber) ? page.valueAsNumber - 1 : current));
    bar.append(back, caption, next, status);
    if (pages > 1) container.append(bar);
    container.append(body);
    show(0);
    return { container, show };
  }

  function dataTable(caption, headers, rows) {
    const wrapper = element("div", null, "ca-a5-scroll");
    const table = element("table");
    const head = element("thead");
    const headings = element("tr");
    for (const title of headers) {
      const cell = element("th", title);
      cell.scope = "col";
      headings.append(cell);
    }
    head.append(headings);
    const body = element("tbody");
    for (const row of rows) {
      const tr = element("tr");
      for (const value of row) tr.append(element("td", value));
      body.append(tr);
    }
    table.append(element("caption", caption), head, body);
    wrapper.append(table);
    return wrapper;
  }

function lineChart(title, series, xLabel, yLabel) {
    const wrap = element("figure", null, "ca-md-chart");
    wrap.append(element("figcaption", title));
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 620 245");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", title + "；" + xLabel + "；" + yLabel);
    const points = series.flatMap(s => s.points).filter(p => p.every(Number.isFinite));
    if (!points.length) { wrap.append(element("p", "该列没有数值输出。")); return wrap; }
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    for (const [x,y] of points) { xmin=Math.min(xmin,x); xmax=Math.max(xmax,x); ymin=Math.min(ymin,y); ymax=Math.max(ymax,y); }
    if (xmin === xmax) { xmin -= 0.5; xmax += 0.5; }
    const pad = (ymax - ymin) * 0.08 || Math.abs(ymax) * 0.02 || 1;
    ymin -= pad; ymax += pad;
    const px = x => 104 + (x-xmin)/(xmax-xmin)*488;
    const py = y => 192 - (y-ymin)/(ymax-ymin)*158;
    const node = (tag, attrs, text) => {
      const n = document.createElementNS(ns, tag);
      for (const [k,v] of Object.entries(attrs)) n.setAttribute(k,v);
      if (text != null) n.textContent = text;
      svg.append(n); return n;
    };
    const tick = (n, span) => {
      const precision = Math.min(13, Math.max(4, Math.ceil(Math.log10(Math.max(Math.abs(n), span)/span))+3));
      return String(Number(n.toPrecision(precision)));
    };
    for (let i=0;i<=4;i++) {
      const x = xmin+(xmax-xmin)*i/4, y=ymin+(ymax-ymin)*i/4;
      node("line",{x1:104,y1:py(y),x2:592,y2:py(y),stroke:"currentColor",opacity:0.13});
      node("text",{x:96,y:py(y)+4,"text-anchor":"end",fill:"currentColor","font-size":16},tick(y,ymax-ymin));
      node("text",{x:px(x),y:211,"text-anchor":"middle",fill:"currentColor","font-size":16},tick(x,xmax-xmin));
    }
    node("text",{x:337,y:237,"text-anchor":"middle",fill:"currentColor","font-size":17},xLabel);
    node("text",{x:104,y:17,fill:"currentColor","font-size":17},yLabel);
    const colors = ["#69d9c0","#ffbe78","#7cafff","#e7a3dd"];
    series.forEach((s,i) => {
      const color=s.color||colors[i%colors.length];
      const valid=s.points.filter(p=>p.every(Number.isFinite));
      const attrs={points:valid.map(([x,y])=>px(x)+","+py(y)).join(" "),fill:"none",stroke:color,"stroke-width":2};
      if(s.dashed) attrs["stroke-dasharray"]="6 4";
      node("polyline",attrs);
      for(const [x,y] of valid) {
        const dot=node("circle",{cx:px(x),cy:py(y),r:3,fill:color});
        const tip=document.createElementNS(ns,"title"); tip.textContent=s.label+": "+formatNumber(x)+", "+formatNumber(y); dot.append(tip);
      }
    });
    wrap.append(svg);
    const legend=element("div",null,"ca-md-legend");
    series.forEach((s,i)=>{const item=element("span",s.label); item.style.color=s.color||colors[i%colors.length];legend.append(item);});
    wrap.append(legend); return wrap;
  }

function renderMdAnalysis(run, target) {
    const r=run.result;
    const section=element("section");
    section.id="analysis-"+run.kind+"-result";
    const job=run.details?.source_job_id;
    if(job) section.append(element("p","来源作业号："+job+" · "+run.filename,"ca-origin"));
    if(run.kind==="md_thermo") {
      section.append(metrics([["原始采样点",r.rows.length],["LAMMPS 单位制",r.unit_style]]));
      const timeKey=r.columns.find(k=>k.toLowerCase()==="time");
      const stepKey=r.columns.find(k=>k.toLowerCase()==="step");
      const dt=run.details?.parameters?.timestep_ps;
      const physical=!!timeKey || (Number.isFinite(dt) && !!stepKey);
      const xLabel=physical?"时间（ps）":"时间步（step）";
      const timeScale=r.unit_style==="real"?0.001:1;
      const x=row=>timeKey?row[timeKey]*timeScale:physical?row[stepKey]*dt:row[stepKey];
      const available=r.columns.filter(k=>!["time","step"].includes(k.toLowerCase()));
      const labels={Temp:"温度",Press:"压力",PotEng:"势能",KinEng:"动能",TotEng:"总能"};
      const seriesFor=key=>{
        const blocks=r.blocks?.length?r.blocks:[{start_row:0,end_row:r.rows.length}];
        return blocks.map((block,index)=>({
          label:(labels[key]||key)+(blocks.length>1?" · 段 "+(index+1):""),
          points:r.rows.slice(block.start_row,block.end_row).map(row=>[x(row),row[key]]),
        }));
      };
      const grid=element("div",null,"ca-md-charts");
      for(const key of ["Temp","Press","PotEng","TotEng"].filter(k=>available.includes(k))) {
        grid.append(lineChart(labels[key]+" · "+key,seriesFor(key),xLabel,r.units[key]??"原始单位未标注"));
      }
      section.append(grid);
      const control=element("label","查看输出列");
      const select=element("select");select.id="analysis-thermo-column";
      available.forEach(key=>select.append(new Option(key+" · "+(r.units[key]??"单位未标注"),key)));
      control.append(select);
      const chosen=element("div",null,"ca-md-primary");
      const draw=()=>chosen.replaceChildren(lineChart(labels[select.value]||select.value,seriesFor(select.value),xLabel,r.units[select.value]??"单位未标注"));
      select.addEventListener("change",draw); if(available.length) draw();
      const more=element("details");more.append(element("summary","其他输出列与原始数值"),control,chosen,
        pager("analysis-thermo-table","采样数据",r.rows.length,50,(body,start,end)=>{
          body.append(dataTable("原始 thermo 输出",r.columns.map(k=>k+(r.units[k]?"（"+r.units[k]+"）":"")),
            r.rows.slice(start,end).map(row=>r.columns.map(k=>formatNumber(row[k])))));
        }).container);
      section.append(more);
    } else {
      const f=r.fit, selection=r.selection;
      const drift=r.remove_drift?(r.drift_weighting==="equal"?"扣除所选组等权平均位移":"扣除所选组质心位移"):"保留原始位移";
      section.append(metrics([
        ["所选原子数",selection.atom_count],["方向 / 维数",r.axes+" / "+r.dimension],
        ["原子 ID", (selection.selected_atom_ids||selection.atom_ids)?.join(", ")||"按类型 / 全部"],
        ["原子类型",selection.atom_types?.join(", ")||"全部类型"],
        ["时间参考","首帧 · step "+r.time_origin.step],["漂移处理",drift],
        ["拟合区间",formatNumber(f.start_ps)+"–"+formatNumber(f.end_ps)+" ps · "+f.n_points+" 点"],
        ["扩散系数 D",formatNumber(f.diffusion_m2_per_s)+" m²/s"],
        ["D（Å²/ps）",formatNumber(f.diffusion_a2_per_ps)],
        ["斜率 / 截距",formatNumber(f.slope_a2_per_ps)+" Å²/ps / "+formatNumber(f.intercept_a2)+" Å²"],
      ]));
      const curves=element("div",null,"ca-md-primary");
      const fitTimes=r.rows.map(row=>row.time_ps).filter(t=>t>=f.start_ps&&t<=f.end_ps);
      const lo=Math.min(...fitTimes),hi=Math.max(...fitTimes);
      curves.append(lineChart("所选原子组 · MSD 与线性拟合",[
        {label:"原始位移计算的 MSD",points:r.rows.map(row=>[row.time_ps,row.msd_a2])},
        {label:"所选区间拟合",dashed:true,points:[lo,hi].map(t=>[t,f.slope_a2_per_ps*t+f.intercept_a2])},
      ],"相对首帧时间（ps）","MSD（Å²）"));
      section.append(curves,element("p","单一起点 MSD；D = slope / (2d)。以上为当前时间窗口的计算值。","ca-muted"),
        pager("analysis-msd-table","MSD 采样点",r.rows.length,50,(body,start,end)=>{
          body.append(dataTable("逐帧 MSD",["Step","相对时间（ps）","MSD（Å²）"],
            r.rows.slice(start,end).map(row=>[identifierLabel(row.step),formatNumber(row.time_ps),formatNumber(row.msd_a2)])));
        }).container);
    }
    target.append(section);
  }

  function renderTransportDriving(run, section) {
    const result = run.result ?? {};
    const runDetails = run.details ?? {};
    const candidates = [
      result.transport_driving,
      result.driving_metadata,
      runDetails.driving,
      runDetails.transport?.driving,
      runDetails.transport?.metadata?.driving,
      runDetails.parameters?.driving,
      runDetails.parameters?.transport_driving,
      run.transport,
      run.driving,
    ];
    const driving = candidates.find(value => value && typeof value === "object"
      && !Array.isArray(value) && (value.requested || value.measured || value.injection));
    if (!driving) return;
    const requested = driving.requested ?? {};
    const modeLabels = {
      temperature: "温度边界（热/冷 thermostat slab）",
      concentration: "浓度边界（半大正则 atom/swap）",
      shear: "剪切边界（移动壁）",
    };
    const activeModes = Object.keys(modeLabels).filter(key => requested[key]);
    const panel = element("section", null, "ca-transport-driving-result");
    panel.append(element("h5", "外部驱动：请求、测得梯度与注入"));
    panel.append(metrics([
      ["请求法向轴", requested.axis],
      ["请求边界控制", activeModes.map(key => modeLabels[key]).join("、") || "未报告"],
    ]));
    panel.append(element("p",
      "下表中的梯度由采样剖面拟合得到。",
      "ca-physical-note"));
    panel.append(details("请求的外部驱动 JSON", requested));

    const measured = driving.measured ?? {};
    const gradients = measured.gradients ?? {};
    const gradientLabels = {
      temperature: "温度梯度",
      concentration: "浓度梯度",
      velocity: "速度梯度",
      momentum_flux: "平均动量通量分量",
    };
    const gradientRows = Object.entries(gradients).map(([key, value]) => {
      const item = value && typeof value === "object" && !Array.isArray(value) ? value : { value };
      const selectedGradient = { conductivity: "temperature", diffusivity: "concentration", viscosity: "velocity" }[result.mode] === key;
      const selectedFlux = result.mode === "viscosity" && key === "momentum_flux";
      const computed = selectedGradient ? result.gradient : selectedFlux ? result.mean_flux : null;
      const observedValue = item.value == null ? computed : item.value;
      const units = item.value == null && computed != null
        ? (selectedGradient ? result.units?.gradient : result.units?.flux) : item.unit;
      const measuredValue = observedValue == null ? "未报告"
        : Number.isFinite(observedValue) ? [formatNumber(observedValue), units].filter(Boolean).join(" ")
          : String(observedValue);
      const source = [item.source_file, item.source_column].filter(Boolean).join(" · ");
      return [gradientLabels[key] ?? key, [measuredValue, source].filter(Boolean).join(" · ")];
    });
    panel.append(element("h6", "原生输出中的测得梯度"));
    panel.append(metrics(gradientRows.length ? gradientRows : [["测得梯度", "未报告"]]));
    if (measured.status) panel.append(element("p", measured.status, "ca-muted"));
    if (measured.initial_composition_is_not_a_maintained_gradient) {
      panel.append(element("p", "初始组成记录在起始剖面中。", "ca-muted"));
    }

    const injection = driving.injection ?? {};
    const energy = injection.energy ?? {};
    const momentum = injection.momentum ?? {};
    const swaps = injection.swap_statistics ?? {};
    const injectionRows = [];
    if (Object.keys(energy).length) {
      injectionRows.push(["能量交换", [energy.thermo_columns?.join("、"), energy.units].filter(Boolean).join(" · ") || "已配置"]);
      if (energy.interpretation) injectionRows.push(["能量解释", energy.interpretation]);
    }
    if (Object.keys(momentum).length) {
      injectionRows.push(["动量/应力来源", [momentum.stress_source, momentum.convention].filter(Boolean).join(" · ") || "未报告"]);
      injectionRows.push(["偏置速度修正", momentum.peculiar_velocity_correction === false ? "未使用" : "未报告"]);
    }
    if (Object.keys(swaps).length) {
      injectionRows.push(["交换统计", swaps.thermo_columns?.join("、") || "已配置"]);
      if (swaps.interpretation) injectionRows.push(["交换解释", swaps.interpretation]);
    }
    panel.append(element("h6", "能量、动量与交换注入/回执"));
    panel.append(metrics(injectionRows.length ? injectionRows : [["注入回执", "未报告"]]));
    panel.append(details("完整驱动回执", {
      measured,
      injection,
      limitations: driving.limitations,
    }));
    section.append(panel);
  }

  function renderTransport(run, target) {
    const result = run.result;
    if (!result) return;
    const mode = transportModes[result.mode];
    if (!mode) return;
    const section = element("section", null, "ca-transport-result");
    section.id = "analysis-md_transport-result";
    section.append(element("h4", mode.name));
    const source = result.source ?? {};
    const execution = run.execution ?? source;
    if (execution.plan_id || execution.job_id) {
    const verification = execution.verified === true ? "已核验"
      : `未核验${execution.verification_reason ? `：${execution.verification_reason}` : ""}`;
    const originVerification = execution.origin_verified === true ? "计划记录"
      : execution.origin_source === "user" ? "用户声明（计划未记录）" : "未核验";
      section.append(metrics([["来源 plan ID", execution.plan_id], ["来源 Slurm job ID", execution.job_id],
      ["服务端来源核验", verification],
      ["项目数据来源", `${run.origin ?? "未指定"} · ${originVerification}`],
        ["原始来源文件", execution.source_files?.join(" · ")]]));
    }
    const unit = result.units ?? {};
    const quantity = (value, units) => Number.isFinite(value)
      ? [formatNumber(value), units].filter(Boolean).join(" ") : "未报告";

    const coefficient = element("div", null, "ca-transport-coefficient");
    coefficient.append(element("span", mode.coefficient, "ca-muted"),
      element("strong", quantity(result.coefficient, result.coefficient_unit)));
    if (result.formula) {
      const formula = result.mode === "viscosity"
        ? (result.stress_convention === "momentum_flux" ? "η = −mean(P) / 速度梯度" : "η = +mean(τ) / 速度梯度")
        : result.formula;
      coefficient.append(element("small", formula));
    }
    section.append(coefficient, metrics([
      ["场量梯度", quantity(result.gradient, result.gradient_unit ?? unit.gradient)],
      ["平均" + mode.flux, quantity(result.mean_flux, unit.flux)],
      ["输入行数", source.rows?.length],
      ["入选样本数", result.selection?.selected_count],
      ["输出位置数", result.profile?.length],
    ]));
    renderTransportDriving(run, section);

    const driving = result.driving ?? run.details?.parameters?.driving;
    const drivingLabels = { gradient_imposed: "施加梯度", flux_imposed: "施加通量" };
    if (Object.hasOwn(drivingLabels, driving)) {
      section.append(element("p", "驱动条件 · " + drivingLabels[driving], "ca-muted"));
    }
    const stress = result.selection?.stress_convention ?? result.stress_convention
      ?? run.details?.parameters?.stress_convention;
    if (stress) {
      const label = { momentum_flux: "动量通量 P（负号）", cauchy_stress: "柯西应力 τ（正号）" };
      section.append(element("p", "剪切分量约定 · " + (label[stress] ?? stress), "ca-muted"));
    }
    const entries = [
      ["位置", "position"], [mode.field, "field"], [mode.flux, "flux"], ["时间", "time"],
    ].filter(([, key]) => source.columns?.[key]);
    if (entries.length) {
      section.append(metrics(entries.map(([label, key]) => [
        label + "输入列", [source.columns[key], source.units?.[key]].filter(Boolean).join(" · "),
      ])));
    }
    if (result.selection) {
      const range = axis => {
        const min = result.selection[axis + "_min"];
        const max = result.selection[axis + "_max"];
        return min == null && max == null ? "全部范围"
          : (min ?? "无下限") + " — " + (max ?? "无上限") + " " + (source.units?.[axis] ?? "");
      };
      section.append(metrics([
        ["位置窗口", range("position")],
        ...(source.columns?.time ? [["时间窗口", range("time")]] : []),
        ["空间分箱宽度", result.selection.bin_width == null ? "原始位置"
          : quantity(result.selection.bin_width, source.units?.position)],
      ]));
    }
    if (Array.isArray(result.assumptions) && result.assumptions.length) {
      const notes = element("ul", null, "ca-transport-notes");
      for (const note of result.assumptions) notes.append(element("li", transportAssumptions.get(note) ?? note));
      section.append(notes);
    }

    const rows = result.profile ?? [];
    if (rows.length) {
      const label = (name, key) => unit[key] ? name + "（" + unit[key] + "）" : name;
      const charts = element("div", null, "ca-md-charts");
      const stride = Math.max(1, Math.ceil(rows.length / 1200));
      const plotted = rows.filter((_, index) => index % stride === 0 || index === rows.length - 1);
      for (const [key, name] of [["field", mode.field], ["flux", mode.flux]]) {
        const series = [{ label: name, points: plotted.map(row => [row.position, row[key]]) }];
        if (key === "field" && Number.isFinite(result.gradient) && Number.isFinite(result.intercept)) {
          series.push({ label: "线性拟合", dashed: true,
            points: [plotted[0].position, plotted.at(-1).position].map(position =>
              [position, result.gradient * position + result.intercept]) });
        }
        charts.append(lineChart(name + "剖面", series, label("位置", "position"), label(name, key)));
      }
      section.append(charts);
      if (stride > 1) section.append(element("p", "图中抽取部分位置，完整数值见下表。", "ca-muted"));
      section.append(pager("analysis-transport-table", "剖面数据", rows.length, 40, (body, start, end) => {
        body.append(dataTable("位置剖面", [label("位置", "position"), label(mode.field, "field"),
          label(mode.flux, "flux"), "样本数"], rows.slice(start, end).map(row =>
          [row.position, row.field, row.flux, row.count].map(formatNumber))));
      }).container);
    }
    target.append(section);
  }

  function renderMD(run, target) {
    const dump = run.result?.dump;
    if (!dump) return;
    const frames = dump.frames;
    const checks = run.details?.frame_checks ?? [];
    let compared = 0;
    let maxError = 0;
    for (const check of checks) {
      if (Number.isFinite(check.max_abs_error)) {
        compared++;
        maxError = Math.max(maxError, check.max_abs_error);
      }
    }
    const time = dump.time;
    target.append(metrics([
      ["轨迹帧数", frames.length],
      ["坐标单位", dump.length_unit],
      ["坐标表示", dump.coordinate_mode === "wrapped" ? "周期镜像坐标（wrapped）" : "展开坐标（unwrapped）"],
      ["时间模式", time?.mode === "constant_dt" ? `固定步长 ${time.dt} ${time.unit}`
        : time?.mode === "explicit" ? `显式时间（${time.unit}）` : "未指定物理时间"],
      ["参考比较帧数", `${compared} / ${frames.length}`],
      ["全帧最大绝对误差", compared ? `${formatNumber(maxError)} ${dump.length_unit}` : "未评估"],
    ]));
    const stepForm = element("form", null, "ca-a5-bar");
    stepForm.id = "analysis-md-step-form";
    const step = element("input");
    step.id = "analysis-md-step";
    step.type = "text";
    step.inputMode = "numeric";
    step.required = true;
    const stepLabel = element("label", "按时间步定位");
    stepLabel.append(step);
    const go = element("button", "查看帧");
    go.type = "submit";
    const stepStatus = element("span");
    stepStatus.setAttribute("role", "status");
    stepForm.append(stepLabel, go, stepStatus);
    const frameView = pager("analysis-md-frames", "帧序号", frames.length, 1, (body, index) => {
      const frame = frames[index];
      if (!frame) return;
      step.value = exactIdentifier(frame.timestep) ?? "";
      stepStatus.textContent = "";
      const physicalTime = frameTime(frame, time);
      body.append(element("h4", `时间步 ${identifierLabel(frame.timestep)}`), metrics([
        ["原子数", frame.atoms.length],
        ["物理时间", Number.isFinite(physicalTime) ? `${formatNumber(physicalTime)} ${time.unit}` : "未报告"],
        [`盒原点（${dump.length_unit}）`, vector(frame.cell.origin)],
        ["周期边界 a / b / c", frame.cell.periodic.map(flag => flag ? "周期" : "非周期").join(" / ")],
        ...frame.cell.vectors.map((value, i) => [`盒矢量 ${"abc"[i]}（${dump.length_unit}）`, vector(value)]),
      ]));
      const atoms = pager("analysis-md-atoms", "坐标页", frame.atoms.length, 50, (output, start, end) => {
        output.append(dataTable("原子坐标", ["原子 ID", ...["X", "Y", "Z"].map(axis => `${axis}（${dump.length_unit}）`)],
          frame.atoms.slice(start, end).map(atom => [identifierLabel(atom.id), ...atom.position.map(formatNumber)])));
      });
      body.append(atoms.container);
    });
    stepForm.addEventListener("submit", event => {
      event.preventDefault();
      const query = step.value.trim().replace(/^0+(?=\d)/, "");
      const index = /^\d+$/.test(query) ? frames.findIndex(frame => exactIdentifier(frame.timestep) === query) : -1;
      if (index < 0) stepStatus.textContent = frames.some(frame => exactIdentifier(frame.timestep) === null)
        ? "未找到可精确匹配的时间步。部分步号超出浏览器整数精度，可按帧序号浏览。"
        : "轨迹中没有该时间步。";
      else frameView.show(index);
    });
    target.append(stepForm, frameView.container);
    if (checks.length) target.append(pager("analysis-md-frame-checks", "比较结果页", checks.length, 50, (body, start, end) => {
      body.append(dataTable("逐帧参考比较", ["时间步", "原子数", `最大绝对误差（${dump.length_unit}）`],
        checks.slice(start, end).map(check => [identifierLabel(check.timestep), check.atom_count, formatNumber(check.max_abs_error)])));
    }).container);
  }

  function renderEquipment(run, target) {
    const result = run.result ?? {};
    const fields = result.fields ?? [];
    const profiles = result.line_profiles ?? [];
    const association = value => ({ point: "点数据（point）", cell: "单元数据（cell）" })[value] ?? value;
    target.append(metrics([
      ["网格长度单位", result.length_unit], ["网格点数", result.points?.length],
      ["网格单元数", result.cells?.length], ["字段数", fields.length], ["线剖面数", profiles.length],
    ]));
    if (fields.length) target.append(pager("analysis-equipment-fields", "字段页", fields.length, 30, (body, start, end) => {
      body.append(dataTable("网格字段", ["位置", "字段", "分量数", "单位"],
        fields.slice(start, end).map(field => [association(field.association), field.name, field.components, field.unit])));
    }).container);
    if (!profiles.length) {
      target.append(element("p", "本次运行没有线剖面。"));
      return;
    }
    target.append(pager("analysis-equipment-profiles", "剖面序号", profiles.length, 1, (body, index) => {
      const profile = profiles[index];
      const { field, reference, samples } = profile;
      const artifact = reference && run.artifacts?.find(item => item.id === reference.reference_artifact_id);
      const selection = field.selection.kind === "magnitude" ? "向量模长" : `分量 ${field.selection.index}`;
      body.append(element("h4", `线剖面 ${index + 1}`), metrics([
        ["位置", association(field.association)], ["字段", field.name], ["取值方式", selection], ["字段单位", profile.unit],
        [`A（${result.length_unit}）`, vector(profile.a)], [`B（${result.length_unit}）`, vector(profile.b)],
        ["参考比较", reference ? "独立参考" : "未提供参考"],
        ...(reference ? [
          ["绝对容差", `${formatNumber(reference.absolute_tolerance)} ${reference.unit}`],
          ["相对容差", formatNumber(reference.relative_tolerance ?? 0)],
        ] : []),
      ]));
      if (artifact) body.append(downloadLink(artifact.url, "下载该剖面的参考证据"));
      body.append(pager("analysis-equipment-samples", "采样页", samples.length, 50, (output, start, end) => {
        output.append(dataTable("沿线采样", [
          "样本", "沿线分数", `值（${profile.unit}）`, `参考值（${profile.unit}）`, `绝对误差（${profile.unit}）`, "缺失掩码",
        ], samples.slice(start, end).map(({ fraction, value }, i) => {
          const ref = reference?.values[start + i];
          const error = Number.isFinite(value) && Number.isFinite(ref) ? Math.abs(value - ref) : null;
          return [start + i + 1, formatNumber(fraction), formatNumber(value), formatNumber(ref), formatNumber(error),
            value == null ? "缺失" : "有效"];
        })));
      }).container);
    }).container);
  }

  function renderDftHandoff(run, target) {
    const artifacts = new Map(run.artifacts.map(artifact => [artifact.id, artifact]));
    const roles = { bulk: "体相", clean_slab: "裸表面", configurations: "吸附构型", gas_references: "气相参考" };
    const list = element("ul", null, "ca-artifacts");
    for (const structure of run.details?.runs ?? []) {
      const artifact = artifacts.get(structure.blob_id);
      if (!artifact) continue;
      const label = [roles[structure.role], structure.site || structure.logical_id || structure.file].filter(Boolean).join(" · ");
      const row = element("li");
      row.append(downloadLink(artifact.url + "/md-data", label + " · 下载 LAMMPS 结构包"));
      if (target.closest("#a1-workspace")?.dataset.role !== "viewer") {
        const plan = element("button", "配置 MD 作业");
        plan.type = "button";
        plan.dataset.mdRun = run.id;
        plan.dataset.mdArtifact = artifact.id;
        plan.dataset.mdLabel = label;
        row.append(plan);
      }
      list.append(row);
    }
    if (list.childElementCount) target.append(element("h4", "DFT → MD 结构交接"), list);
  }

  function renderAdsorption(run, target) {
    const details = run.details ?? {};
    const structures = new Map();
    for (const structure of details.runs ?? []) {
      for (const key of [structure.structure_id, structure.logical_id, structure.blob_id]) {
        if (key) structures.set(key, structure);
      }
    }
    const configurations = run.result?.observed_adsorption ?? details.observed_adsorption ?? run.result?.results ?? [];
    const labels = new Map();
    const list = element("ul");
    const energyField = details.energy_field ?? "e_fr_energy";
    target.append(element("p", energyField === "e_fr_energy"
      ? "VASP 能量口径：最终离子步的自由能 TOTEN（e_fr_energy，eV）。吸附能以 eV / 吸附物报告。"
      : `VASP 能量字段：${energyField}（eV）。吸附能以 eV / 吸附物报告。`));
    for (const [index, item] of configurations.entries()) {
      const structure = structures.get(item.structure_id);
      const label = [structure?.site, structure?.logical_id, structure?.file]
        .find(value => typeof value === "string" && value.trim() && !/^art-[a-f0-9]{64}$/i.test(value.trim()))
        ?? `构型 ${index + 1}`;
      labels.set(item.structure_id, label);
      const flags = [...new Set([...(item.reasons ?? []), ...(item.annotations ?? [])])].map(translate);
      const energy = item.adsorption_energy_eV ?? item.adsorption_energy;
      const numeric = Number.isFinite(energy) ? `${energy} ${item.unit ?? "eV"} / 吸附物` : "暂无吸附能数值";
      const row = element("li", `${label} · ${numeric}`);
      if (flags.length) row.append(element("small", flags.join("、")));
      const check = structure?.cell_check;
      const dimensions = ["a", "b", "c"].flatMap((axis, i) => {
        const length = check?.lengths_A?.[axis] ?? check?.lengths_A?.[i];
        const limit = check?.limits_A?.[axis] ?? check?.limits_A?.[i];
        if (!Number.isFinite(length)) return [];
        const cap = Number.isFinite(limit) ? `（上限 ${limit} Å）` : "";
        return [`|${axis}| ${Number(length.toPrecision(6))} Å${cap}`];
      });
      if (dimensions.length) row.append(element("small", `晶胞尺寸：${dimensions.join(" · ")}`));
      list.append(row);
    }
    if (list.childElementCount) target.append(list);
    const totals = (details.runs ?? []).filter(row => Number.isFinite(row.energy_eV));
    if (totals.length) target.append(dataTable("各结构原始 VASP 总能（eV）",
      ["结构", "TOTEN（eV）", "收敛状态"], totals.map(row => [
        row.logical_id ?? row.file, row.energy_eV, translate(row.convergence_status ?? "—"),
      ])));
    if (details.ranking?.length) {
      const ranking = details.ranking.map((id, index) => labels.get(id) ?? `第 ${index + 1} 名构型`);
      target.append(element("p", `可比构型按吸附能升序：${ranking.join(" → ")}`));
    }
  }

  function renderRun(run, target) {
    const result = run.result ?? {};
    target.replaceChildren(
      element("h3", kindLabel[run.kind] ?? "分析结果"),
      element("strong", originLabel[run.origin] ?? run.origin, "ca-origin"),
      metrics([["运行 ID", run.id], ["源文件", run.filename], ["创建时间", run.created_at]]),
    );
    if (run.kind === "adsorption") {
      renderAdsorption(run, target);
      renderDftHandoff(run, target);
    }
    if (run.kind === "md_thermo" || run.kind === "md_msd") renderMdAnalysis(run, target);
    if (run.kind === "kinetics") {
      const summary = [
        ["模型", modelLabel[result.model] ?? result.model],
        ["训练集对数 RMSE", result.train_log_rmse],
        ["留出集对数 RMSE", result.holdout_log_rmse ?? "未评估"],
        ["验证范围", translate(result.validation_scope)],
        ["设计矩阵秩", result.design_rank],
      ];
      if (result.prefactor != null) summary.push(["指前因子", `${result.prefactor} ${result.prefactor_unit}`]);
      if (result.activation_energy != null) summary.push(["活化能", `${result.activation_energy} ${result.activation_energy_unit}`]);
      if (result.rate_at_reference != null) summary.push(["参考浓度下的速率", `${result.rate_at_reference} ${result.rate_at_reference_unit}`]);
      for (const [species, order] of Object.entries(result.orders ?? {})) summary.push([`${species} 反应级数`, order]);
      target.append(metrics(summary));
      const thresholds = run.details?.fit_diagnostics?.threshold_notes;
      if (thresholds?.length) target.append(element("p", thresholds.join(" · "), "ca-muted"));
      if (result.warnings?.length) target.append(element("p", result.warnings.map(translate).join("、"), "ca-warning"));
      const uncertainty = run.details?.measurement_uncertainty;
      if (uncertainty?.status === "partial" || uncertainty?.status === "unavailable") {
        const message = uncertainty.status === "partial"
          ? `${uncertainty.unavailable_rows} 条观测缺少测量不确定度（${uncertainty.available_rows} 条已提供）。`
          : "观测数据均未提供测量不确定度。";
        target.append(element("p", message, "ca-warning"));
      }
      if (result.parameter_uncertainty?.reason) target.append(element("p", `参数不确定性：${result.parameter_uncertainty.reason}`));
    }
    if (rawKind(run.kind) || run.kind === "md_transport") {
      const science = element("div", null, "ca-a5-result");
      science.id = `analysis-${run.kind}-result`;
      const compared = run.kind === "md"
        ? (run.details?.frame_checks ?? []).some(check => Number.isFinite(check.max_abs_error))
        : (result.line_profiles ?? []).some(profile => profile.reference);
      const referenceNote = run.details?.reference_comparison;
      const comparison = element("p", referenceNote?.error || run.details?.reference_error
        || (compared ? "已与独立参考比较"
          : run.kind === "md_transport" && run.origin === "synthetic"
            ? "合成验收输入 · 已读取原始输出（非独立参考）"
            : "已读取原始输出"), "ca-origin");
      comparison.id = "analysis-a5-comparison";
      science.append(comparison);
      if (run.kind === "md_transport") renderTransport(run, science);
      else if (run.kind === "md") renderMD(run, science);
      else renderEquipment(run, science);
      target.append(science);
    } else {
      target.append(details("完整科学结果", result), details("规范化输入与分析详情", { input: run.input, details: run.details }));
    }
    target.append(element("h4", "来源与下载"));
    if (run.manifest_url) target.append(downloadLink(run.manifest_url, "下载运行清单"));
    const artifacts = element("ul", null, "ca-artifacts");
    for (const artifact of run.artifacts ?? []) {
      const row = element("li");
      const executionSource = run.execution?.sources?.find(source => source.artifact_id === artifact.id);
      const label = executionSource ? `Slurm 原始 ${executionSource.role}`
        : artifact.id === run.raw_id ? "原始上传"
          : artifact.id === run.reference_id ? "独立参考证据" : translate(artifact.role);
      if (artifact.id === run.reference_id) row.id = "analysis-a5-reference-artifact";
      row.append(
        downloadLink(artifact.url, artifact.name ?? artifact.id),
        element("small", `${label} · ${artifact.size_bytes} 字节 · ${artifact.id}`),
      );
      if (artifact.parents?.length) row.append(element("small", `上游工件：${artifact.parents.join("、")}`));
      artifacts.append(row);
    }
    if (artifacts.childElementCount) target.append(artifacts);
  }


  function mountPlans(find, panel, request, signal, onUpdate) {
    const stateLabels = { pending: "待人工确认", confirmed: "已确认计划", retryable: "提交前检查失败，可重试",
      submitting: "已受理确认，等待调度回执", unknown: "提交结果待核对", submitted: "已关联 Slurm 作业" };
    const workflows = { adsorption: "vasp-relaxation", md: "md-simulation", equipment: "equipment-simulation" };
    const form = find("#a6-form");
    const { run_id: source, workflow, cpus, gpus, minutes } = form.elements;
    const create = find("#a6-create");
    const plans = find("#a6-plans");
    const review = find("#a6-review");
    const refresh = find("#a6-refresh");
    const status = find("#a6-status");
    const confirm = find("#a6-confirm");
    const retry = find("#a6-retry");
    const reconcile = find("#a6-reconcile");
    let runs = new Map();
    let records = new Map();
    let syntheticSubmission = false;
    let mdSubmission = false;
    let recovery = null;
    let receiptPlans = new Set();
    let ready = false;
    let busy = false;

    function syncForm() {
      const run = runs.get(source.value);
      const standard = workflows[run?.kind];
      const eligible = run?.origin === "synthetic" && syntheticSubmission;
      const selected = workflow.value;
      const options = [standard, eligible ? "synthetic-v100" : null].filter(Boolean);
      workflow.replaceChildren(...options.map(value => new Option(value, value)));
      workflow.value = options.includes(selected) ? selected : (options[0] ?? "");
      workflow.disabled = busy || !options.length;
      const synthetic = workflow.value === "synthetic-v100";
      cpus.max = synthetic ? 2 : 256;
      gpus.min = synthetic ? 1 : 0;
      gpus.max = synthetic ? 1 : 8;
      minutes.max = synthetic ? 2 : 10080;
      if (synthetic) {
        if (cpus.valueAsNumber > 2) cpus.value = 2;
        gpus.value = 1;
        if (minutes.valueAsNumber > 2) minutes.value = 2;
      }
      form.hidden = !!recovery;
      create.disabled = !!recovery || busy || !ready || !workflow.value;
      find("#a6-preview").textContent = run
        ? `${originLabel[run.origin] ?? run.origin} · ${synthetic ? "确认后将尝试提交 v100 合成作业" : "确认仅记录计划"}`
        : "";
    }

    function renderPlan() {
      const record = records.get(plans.value);
      const state = record?.state;
      review.hidden = !record;
      refresh.disabled = busy;
      plans.disabled = busy || !records.size;
      confirm.hidden = state !== "pending";
      retry.hidden = state !== "retryable";
      reconcile.hidden = !["submitting", "unknown"].includes(state);
      const notice = find("#a7-recovery");
      notice.hidden = !recovery;
      notice.textContent = recovery ? `恢复副本 · 审批记录只读 · 备份 SHA-256 ${recovery.archive_sha256}` : "";
      const receipt = find("#a7-receipt");
      receipt.hidden = !receiptPlans.has(record?.id);
      if (receipt.hidden) receipt.removeAttribute("href");
      else receipt.href = projectPath(`/api/plans/${encodeURIComponent(record.id)}/receipt`);
      const md = record?.spec.mode === "slurm-md";
      find("#a6-md-status").hidden = !md || !["submitting", "unknown", "submitted"].includes(state);
      const schedulerUnavailable = (record?.spec.mode === "slurm-synthetic" && !syntheticSubmission)
        || (md && (!mdSubmission || find("#md-job-form").hidden));
      for (const button of [confirm, retry, reconcile]) button.disabled = !!recovery || busy || !ready || schedulerUnavailable;
      if (!record) return;
      const spec = record.spec;
      find("#a6-spec").replaceChildren(metrics([
        ["计划编号", record.id], ["计划摘要", record.digest], ["源运行", spec.run_id],
        ["来源", originLabel[spec.origin] ?? spec.origin], ["源文件", spec.source_name ?? runs.get(spec.run_id)?.filename],
        ["流程", spec.workflow],
        ["CPU / GPU / 分钟", `${spec.cpus} / ${spec.gpus} / ${spec.minutes}`],
      ]));
      find("#a6-source-sha").closest("div").hidden = md;
      confirm.textContent = md ? "确认并提交 LAMMPS 作业"
        : spec.mode === "slurm-synthetic" ? "确认并提交合成作业" : "确认计划";
      const mode = spec.mode === "slurm-synthetic"
        ? (syntheticSubmission && spec.origin === "synthetic" ? "人工确认后由 Slurm 调度合成 V100 作业" : "当前服务未启用此计划的合成作业提交")
        : md ? "人工确认后由 Slurm 调度 LAMMPS" : "仅记录计划";
      for (const [key, value] of Object.entries({
        "source-sha": spec.source_sha256, mode: recovery ? "查看归档审批" : mode, state: stateLabels[state] ?? state,
        attempts: record.attempts, "job-id": record.job_id ?? "—",
      })) find(`#a6-${key}`).textContent = value;
      find("#a6-events").replaceChildren(...(record.events ?? []).map(event => {
        const row = element("li", `${event.time} · ${event.operator} · ${stateLabels[event.state] ?? event.state}`);
        row.append(element("small", event.message));
        return row;
      }));
    }

    function renderPlans(selected) {
      plans.replaceChildren(new Option("选择计划", ""), ...Array.from(records.values(), record =>
        new Option(`${stateLabels[record.state] ?? record.state} · ${record.spec.workflow} · ${record.id}`, record.id)));
      plans.value = records.has(selected) ? selected : "";
    }

    function publishPlans() {
      onUpdate({ records, enabled: mdSubmission, recovery });
    }

    function updatePlans(data) {
      mdSubmission = data.md_submission === true;
      syntheticSubmission = data.synthetic_submission === true;
      recovery = data.recovery ?? null;
      receiptPlans = new Set(data.receipt_plan_ids ?? []);
      records = new Map(data.plans.map(record => [record.id, record]));
      renderPlans(plans.value);
      ready = true;
      publishPlans();
    }

    async function perform(task, recover = false) {
      if (busy) return;
      busy = true;
      syncForm();
      renderPlan();
      setStatus(status, "正在读取或更新计划…");
      try {
        await task();
        setStatus(status, "");
      } catch (error) {
        ready = false;
        if (recover) {
          try {
            updatePlans(await request("/api/plans"));
          } catch {
            // Keep actions disabled until the next successful refresh.
          }
        }
        if (!ready) {
          mdSubmission = false;
          publishPlans();
        }
        setStatus(status, error.message, true);
      } finally {
        busy = false;
        syncForm();
        renderPlan();
      }
    }

    function refreshPlans() {
      return perform(async () => {
        const [{ runs: history }, data] = await Promise.all([request("/api/runs"), request("/api/plans")]);
        const selected = source.value;
        runs = new Map(history.filter(run => Object.hasOwn(workflows, run.kind) || (run.origin === "synthetic" && data.synthetic_submission === true)).map(run => [run.id, run]));
        source.replaceChildren(new Option("选择已有运行", ""), ...Array.from(runs.values(), run =>
          new Option(`${run.filename} · ${kindLabel[run.kind]} · ${originLabel[run.origin] ?? run.origin} · ${run.id}`, run.id)));
        source.value = runs.has(selected) ? selected : "";
        updatePlans(data);
      });
    }

    async function postPlan(path, body) {
      const record = await request(path, JSON.stringify(body), undefined, { "Content-Type": "application/json" });
      selectPlan(record);
    }

    function selectPlan(record, reveal = false, preferCurrent = false) {
      records.set(record.id, preferCurrent ? records.get(record.id) ?? record : record);
      renderPlans(record.id);
      renderPlan();
      publishPlans();
      if (reveal) {
        review.scrollIntoView({ block: "start" });
        (confirm.hidden || confirm.disabled ? plans : confirm).focus({ preventScroll: true });
      }
    }

    source.addEventListener("change", () => {
      workflow.value = "";
      syncForm();
    });
    workflow.addEventListener("change", syncForm);
    plans.addEventListener("change", renderPlan);
    refresh.addEventListener("click", refreshPlans);
    find("#analysis-refresh").addEventListener("click", refreshPlans);
    panel.addEventListener("toggle", () => { if (panel.open) void refreshPlans(); }, { signal });
    form.addEventListener("submit", event => {
      event.preventDefault();
      if (create.disabled || !form.reportValidity()) return;
      const body = {
        run_id: source.value, workflow: workflow.value, cpus: cpus.valueAsNumber,
        gpus: gpus.valueAsNumber, minutes: minutes.valueAsNumber,
      };
      const existing = Array.from(records.values()).find(record =>
        Object.entries(body).every(([key, value]) => record.spec[key] === value));
      if (existing) {
        plans.value = existing.id;
        renderPlan();
        return;
      }
      void perform(() => postPlan("/api/plans", body), true);
    });

    for (const [button, endpoint] of [[confirm, "confirm"], [retry, "confirm"], [reconcile, "reconcile"]]) {
      button.addEventListener("click", () => {
        const record = records.get(plans.value);
        if (!record || button.disabled || button.hidden) return;
        const body = endpoint === "confirm" ? { digest: record.digest, confirmed: true } : {};
        void perform(() => postPlan(`/api/plans/${encodeURIComponent(record.id)}/${endpoint}`, body), true);
      });
    }

    if (panel.open) void refreshPlans();
    return { refreshPlans, selectPlan };
  }

  async function mount() {
    const content = document.querySelector("#studio .wb-content");
    if (!content || document.querySelector("#analysis-panel")) return;
    const panel = element("details", null, "ca-panel");
    panel.id = "analysis-panel";
    // Only static interface markup is assigned here. API data is rendered as text.
    panel.innerHTML = `
      <summary id="analysis-panel-toggle">科学分析与晶胞工具</summary>
      <section id="a1-session" aria-label="项目访问">
        <form id="a1-login" method="post" hidden>
          <h2>登录工作台</h2>
          <div class="ca-grid">
            <label>用户名<input id="a1-username" name="username" autocomplete="username" required></label>
            <label>密码<input id="a1-password" name="password" type="password" autocomplete="current-password" required></label>
          </div>
          <button id="a1-login-submit" class="ca-primary" type="submit">登录</button>
        </form>
        <div class="ca-heading">
          <label id="a1-project-controls" hidden>当前项目<select id="a1-project"></select></label>
          <span id="a1-actor"></span>
          <button id="a1-logout" type="button" hidden>退出登录</button>
        </div>
        <p id="a1-status" role="status">正在读取会话…</p>
      </section>
      <div id="a1-workspace" hidden>
      <nav class="ca-guides" aria-label="科学分析指南">
        <a href="/guide/vasp" target="_blank" rel="noopener">VASP 吸附指南</a>
        <a href="/guide/kinetics" target="_blank" rel="noopener">动力学指南</a>
        <a href="/guide/cell" target="_blank" rel="noopener">晶胞指南</a>
        <a href="/guide/md" target="_blank" rel="noopener">LAMMPS 指南</a>
        <a href="/guide/equipment" target="_blank" rel="noopener">VTU 指南</a>
      </nav>
      <form id="analysis-form">
        <h2>上传分析数据</h2>
        <div class="ca-grid">
          <label>分析类型<select id="analysis-kind" name="kind">
            <option value="adsorption">VASP 吸附能</option><option value="kinetics">动力学拟合</option>
            <option value="md_transport">MD 热、质与动量传递</option><option value="md_thermo">LAMMPS 热力学曲线</option><option value="md_msd">原子组 MSD 与扩散</option><option value="md">LAMMPS 轨迹</option><option value="equipment">VTU 场与线剖面</option>
          </select></label>
          <label>数据来源<select id="analysis-origin" name="origin">
            <option value="synthetic" selected>合成数据</option><option value="research">研究数据</option>
          </select></label>
        </div>
        <label>上传文件<input id="analysis-upload" name="file" type="file"></label>
        <p id="analysis-file-hint" class="ca-muted"></p>
        <fieldset id="analysis-transport" hidden disabled>
          <legend>输运数据与坐标</legend>
          <div class="ca-grid">
            <label>传递模式<select name="transport_mode">
              <option value="conductivity">热传递 · 热导率</option>
              <option value="diffusivity">质量传递 · 扩散系数</option>
              <option value="viscosity">动量传递 · 动力黏度</option>
            </select></label>
            <label>来源计划 ID（与元数据核对）<input name="transport_source_plan_id" maxlength="128"></label>
            <label>来源作业号（与元数据核对）<input name="transport_source_job_id" maxlength="128"></label>
            <div class="ca-md-actions ca-transport-import-actions">
              <button id="analysis-transport-import" type="button" disabled>从已完成授权作业带入采样</button>
              <span id="analysis-transport-import-status" class="ca-muted" role="status">选择已完成的授权作业后，可直接带入 plan/job 与 native 采样列。</span>
            </div>
            <p class="ca-physical-note">选择计划后会带入数据列和可用分量。设置拟合窗口和单位后运行分析。</p>
            <label>驱动条件<select name="transport_driving">
              <option value="unspecified">未指定</option>
              <option value="gradient_imposed">施加梯度</option>
              <option value="flux_imposed">施加通量</option>
            </select></label>
            <label id="analysis-transport-sheet" hidden>XLSX 工作表（可选）<input name="transport_sheet" disabled placeholder="留空读取默认工作表"></label>
            <label>空间剖面原始文件（可选）<input id="analysis-transport-profile" name="transport_profile" type="file" accept=".dat,.txt,.profile,.chunk,.ave"></label>
            <label>全局通量原始文件（可选）<input id="analysis-transport-global" name="transport_global" type="file" accept=".dat,.txt,.profile,.chunk,.ave"></label>
            <label>输运元数据（手动成对导入时必需）<input id="analysis-transport-metadata" name="transport_metadata" type="file" accept=".json,application/json"></label>
            <label>计划/作业证明（可选）<input id="analysis-transport-provenance" name="transport_provenance" type="file" accept=".json,application/json"></label>
            <label>速度或轨迹原始侧车（黏度可选）<input id="analysis-transport-velocity" name="transport_velocity" type="file" accept=".dat,.txt,.lammpstrj,.dump,.json"></label>
          </div>
          <p id="analysis-transport-hint" class="ca-muted"></p>
          <div class="ca-grid ca-transport-columns">
            <label>位置列<input name="transport_position_column" required></label>
            <label>位置单位<input name="transport_position_unit" list="analysis-transport-units-position" required></label>
            <label><span id="analysis-transport-field-label">场量列</span><input name="transport_field_column" required></label>
            <label><span id="analysis-transport-field-unit-label">场量单位</span><input name="transport_field_unit" list="analysis-transport-units-field" required></label>
            <label><span id="analysis-transport-flux-label">通量列</span><input name="transport_flux_column" required></label>
            <label><span id="analysis-transport-flux-unit-label">通量单位</span><input name="transport_flux_unit" list="analysis-transport-units-flux" required></label>
            <label>时间列（可选）<input name="transport_time_column"></label>
            <label>时间单位<input name="transport_time_unit" list="analysis-transport-units-time"></label>
          </div>
          ${["position", "field", "flux", "time"].map(key => `<datalist id="analysis-transport-units-${key}"></datalist>`).join("")}
          <label id="analysis-transport-stress" hidden>剪切分量约定<select name="transport_stress_convention" disabled>
            <option value="momentum_flux">动量通量 P · η = −P / 速度梯度</option>
            <option value="cauchy_stress">柯西应力 τ · η = +τ / 速度梯度</option>
          </select></label>
          <fieldset>
            <legend>空间与时间窗口（可选，含端点）</legend>
            <div class="ca-grid ca-transport-columns">
              <label>位置下限<input name="transport_position_min" type="number" step="any"></label>
              <label>位置上限<input name="transport_position_max" type="number" step="any"></label>
              <label>时间下限<input name="transport_time_min" type="number" step="any"></label>
              <label>时间上限<input name="transport_time_max" type="number" step="any"></label>
              <label>空间分箱宽度<input name="transport_bin_width" type="number" step="any" min="0"></label>
            </div>
            <p class="ca-muted">窗口和分箱使用上方输入单位。留空则保留全部范围或原始位置。</p>
          </fieldset>
        </fieldset>
        <fieldset id="analysis-md-analysis" hidden disabled>
          <legend>MD 输出分析</legend>
          <div class="ca-grid">
            <label>LAMMPS 单位制<select name="md_unit_style"><option value="">读取文件标记</option><option value="metal">metal · Å / ps / eV / bar</option><option value="real">real · Å / fs / kcal/mol / atm</option></select></label>
            <label>时间步长（ps / step）<input name="md_timestep_ps" type="number" min="0" step="any" placeholder="轨迹无 ITEM: TIME 时填写"></label>
            <label>来源作业号（可选）<input name="md_source_job_id" placeholder="例如 Slurm 作业号"></label>
          </div>
          <fieldset id="analysis-msd-config" hidden disabled>
            <legend>原子组与扩散拟合</legend>
            <div class="ca-grid">
              <label>原子 ID（逗号分隔）<input name="md_atom_ids" placeholder="留空选择全部 ID"></label>
              <label>原子类型（逗号分隔）<input name="md_atom_types" placeholder="留空选择全部类型"></label>
              <label>统计方向<select name="md_axes"><option>xyz</option><option>xy</option><option>xz</option><option>yz</option><option>x</option><option>y</option><option>z</option></select></label>
              <label>漂移处理<select name="md_remove_drift"><option value="false">保留原始位移</option><option value="true">扣除所选组漂移（有质量时按质量加权）</option></select></label>
              <label>拟合起点（相对首帧，ps）<input name="md_fit_start_ps" type="number" step="any" placeholder="留空使用全部时间"></label>
              <label>拟合终点（相对首帧，ps）<input name="md_fit_end_ps" type="number" step="any" placeholder="留空使用全部时间"></label>
            </div>
            <p class="ca-muted">同时填写 ID 和类型时取交集。使用首帧作为参考，按原子 ID 跟踪展开坐标；拟合 MSD = 2dDt + b，直接报告所选区间的斜率。</p>
          </fieldset>
        </fieldset>
        <fieldset id="analysis-a5" hidden disabled>
          <legend>原始文件配置</legend>
          <div class="ca-grid">
            <label>坐标长度单位<input id="analysis-length-unit" name="length_unit" placeholder="留空读取原文件单位"></label>
            <label>独立参考证据（可选）<input id="analysis-reference" name="reference" type="file" accept=".json,application/json"></label>
          </div>
          <p id="analysis-a5-hint" class="ca-muted"></p>
        </fieldset>
        <fieldset id="analysis-equipment-line" hidden disabled>
          <legend>VTU 单条线剖面</legend>
          <label class="ca-a5-check"><input id="analysis-equipment-line-enabled" type="checkbox">配置单条线</label>
          <fieldset id="analysis-equipment-line-fields" hidden disabled>
            <legend>采样设置</legend>
            <div class="ca-grid ca-axes">
              ${["a", "b"].flatMap(end => ["x", "y", "z"].map(axis =>
                `<label>${end.toUpperCase()} · ${axis.toUpperCase()}<input id="analysis-line-${end}-${axis}" name="line_${end}_${axis}" type="number" step="any" required></label>`
              )).join("")}
            </div>
            <div class="ca-grid">
              <label>字段位置<select id="analysis-line-association" name="line_association">
                <option value="point">点数据（point）</option><option value="cell">单元数据（cell）</option>
              </select></label>
              <label>字段名称<input id="analysis-line-field" name="line_field" required></label>
              <label>字段单位（可读取原文件）<input id="analysis-line-unit" name="line_unit"></label>
              <label>取值方式<select id="analysis-line-selection" name="line_selection">
                <option value="component">分量</option><option value="magnitude">向量模长</option>
              </select></label>
              <label id="analysis-line-component-label">分量索引（从 0 开始）<input id="analysis-line-component" name="line_component" type="number" min="0" step="1" value="0" required></label>
              <label>采样数量（含端点）<input id="analysis-line-count" name="line_count" type="number" min="2" step="1" required></label>
            </div>
          </fieldset>
        </fieldset>
        <fieldset id="analysis-vasp">
          <legend>VASP 晶胞各轴上限（Å，含真空）</legend>
          <div class="ca-grid ca-axes">
            <label>a<input name="vasp_limit_a" type="number" min="0.000001" max="50" step="any" value="50" required></label>
            <label>b<input name="vasp_limit_b" type="number" min="0.000001" max="50" step="any" value="50" required></label>
            <label>c<input name="vasp_limit_c" type="number" min="0.000001" max="50" step="any" value="50" required></label>
          </div>
        </fieldset>
        <fieldset id="analysis-kinetics" hidden disabled>
          <legend>动力学配置</legend>
          <div class="ca-grid">
            <label>模型<select name="model">
              <option value="arrhenius_known_k">Arrhenius（已测速率常数）</option>
              <option value="initial_rate_power_law">初始速率幂律</option>
            </select></label>
            <label>响应单位<select name="response_unit"></select></label>
            <label>温度单位<select name="temperature_unit"><option value="">按表头推断</option><option value="K">K</option><option value="C">°C</option></select></label>
            <label>工作表名称（XLSX）<input name="sheet" placeholder="留空使用默认工作表"></label>
          </div>
          <div class="ca-grid">
            <label>温度列<input name="column_temperature" placeholder="temperature_K"></label>
            <label>响应列<input name="column_value" placeholder="value"></label>
            <label>批次列<input name="column_batch_id" placeholder="batch_id"></label>
            <label>单批次编号<input id="analysis-single-batch" name="batch_id" placeholder="无批次列时填写"></label>
            <label>工况列<input name="column_condition_id" placeholder="condition_id"></label>
            <label>训练 / 留出列<input name="column_partition" placeholder="partition"></label>
            <label>观测编号列<input name="column_observation_id" placeholder="observation_id"></label>
            <label>相对不确定度列<input name="column_relative_uncertainty" placeholder="relative_uncertainty"></label>
          </div>
          <p class="ca-muted">列名留空时按标准表头匹配。自定义列名须与文件表头一致。</p>
          <p class="ca-muted">单批次编号仅用于训练数据。独立留出验证需要批次列和训练 / 留出列。</p>
          <div id="analysis-reactants" hidden>
            <div class="ca-grid">
              <label>浓度单位<select name="concentration_unit"><option>mol/L</option><option>mmol/L</option></select></label>
              <label>转化率列<input name="column_conversion_fraction" placeholder="conversion_fraction"></label>
              <label>转化率单位<select name="conversion_unit"><option value="fraction">小数</option><option value="%">百分数（%）</option></select></label>
              <label>转化率上限（小数）<input name="max_conversion_fraction" type="number" min="0" max="0.1" step="any" placeholder="0.1"></label>
            </div>
            <label>反应物与浓度列（JSON 对象）
              <input name="concentration_columns" placeholder='{"A":"concentration_A"}'>
            </label>
          </div>
        </fieldset>
        <details id="analysis-advanced">
          <summary>高级配置</summary>
          <label>选项 JSON<textarea id="analysis-options" rows="4" placeholder="{}"></textarea></label>
          <p class="ca-muted">同名高级选项覆盖表单值。配置字段见对应分析指南。</p>
        </details>
        <button id="analysis-submit" class="ca-primary" type="submit">运行分析</button>
        <p id="analysis-status" role="status"></p>
      </form>
      <section id="analysis-results" aria-label="分析结果" aria-busy="false" hidden></section>
      <section id="analysis-history" aria-labelledby="analysis-history-title">
        <div class="ca-heading"><h2 id="analysis-history-title">运行历史</h2><button id="analysis-refresh" type="button">刷新</button></div>
        <p id="analysis-history-status" role="status"></p>
        <ul id="analysis-history-list"></ul>
      </section>
      <section id="agent-kinetics-workbench" class="ca-agent-kinetics-workbench" aria-labelledby="agent-kinetics-title">
        <div class="ca-heading">
          <div>
            <p class="ca-kicker">第 2 项 · 项目内代理拟合</p>
            <h2 id="agent-kinetics-title">自然语言动力学拟合</h2>
          </div>
          <button id="agent-kinetics-refresh" type="button">刷新实验表</button>
        </div>
        <p class="ca-muted ca-agent-kinetics-lede">
          选择项目内的实验表，输入拟合要求。
        </p>
        <form id="agent-kinetics-form">
          <div class="ca-grid ca-agent-kinetics-source-grid">
            <label>当前项目实验表<select id="agent-kinetics-source-run" required><option value="">选择已有实验表</option></select></label>
            <label>原始表文件<select id="agent-kinetics-source-artifact" required disabled><option value="">先选择实验表</option></select></label>
            <label>工作表（可选）<input id="agent-kinetics-sheet" placeholder="留空由服务端读取默认工作表"></label>
          </div>
          <label>自然语言指令<textarea id="agent-kinetics-instruction" rows="3" required>用这份实验表做动力学拟合</textarea></label>
          <div id="agent-kinetics-source-preview" class="ca-agent-kinetics-preview" aria-live="polite">
            <p class="ca-muted">选择实验表后显示项目、文件名、工作表和可用原始文件。</p>
          </div>
          <div class="ca-md-actions">
            <button id="agent-kinetics-submit" class="ca-primary" type="submit" disabled>识别模型并拟合</button>
            <span id="agent-kinetics-status" role="status"></span>
          </div>
        </form>
        <section id="agent-kinetics-receipt" class="ca-agent-kinetics-receipt" hidden aria-labelledby="agent-kinetics-receipt-title">
          <h3 id="agent-kinetics-receipt-title">拟合任务回执</h3>
          <div id="agent-kinetics-receipt-summary"></div>
          <div id="agent-kinetics-run-details" class="ca-agent-kinetics-run-details" hidden></div>
        </section>
      </section>
      <section id="engineering-workbench" class="ca-engineering-workbench" aria-labelledby="engineering-title">
        <div class="ca-heading">
          <h2 id="engineering-title">工程工况工作台</h2>
          <div class="ca-md-actions">
            <button id="engineering-new" type="button">新建工况</button>
            <button id="engineering-refresh" type="button">刷新来源</button>
          </div>
        </div>
        <p class="ca-muted ca-engineering-lede">
          选择一项 MD 输运物性和一项动力学拟合结果，保存为工程工况。
        </p>
        <form id="engineering-form">
          <div class="ca-grid">
            <label>MD 输运物性来源
              <select id="engineering-transport-run"><option value="">选择已有 MD 输运结果</option></select>
            </label>
            <label>动力学拟合来源
              <select id="engineering-kinetics-run"><option value="">选择已有动力学结果</option></select>
            </label>
          </div>
          <div id="engineering-source-summary" class="ca-engineering-source-grid" aria-live="polite"></div>
          <fieldset>
            <legend>工程工况与拟合窗口</legend>
            <div class="ca-grid">
              <label>工况名称<input id="engineering-name" maxlength="160" placeholder="例如：入口温度 300 K · 稳态流动"></label>
              <label>工况 ID<input id="engineering-condition-id" maxlength="128" placeholder="可选：外部工况编号"></label>
            </div>
            <label>工况参数 JSON（用户确认）
              <textarea id="engineering-conditions" rows="5" placeholder='{"temperature_K":300,"pressure_bar":1,"composition":{}}'></textarea>
            </label>
            <div class="ca-grid">
              <label>输运拟合窗口 JSON（来源核验口径）
                <textarea id="engineering-transport-window" rows="4" readonly placeholder='{"position_min":null,"position_max":null,"time_min":null,"time_max":null}'></textarea>
              </label>
              <label>动力学拟合窗口 JSON（来源核验口径）
                <textarea id="engineering-kinetics-window" rows="4" readonly placeholder='{"temperature_min":null,"temperature_max":null,"partition":"train"}'></textarea>
              </label>
            </div>
          </fieldset>
          <div class="ca-md-actions">
            <button id="engineering-save" class="ca-primary" type="submit">保存工程工况</button>
            <button id="engineering-export" type="button" disabled>导出当前工况</button>
            <span id="engineering-status" class="ca-engineering-status" role="status"></span>
          </div>
        </form>
        <section id="engineering-current" class="ca-engineering-record" aria-live="polite" hidden></section>
        <section class="ca-engineering-records" aria-labelledby="engineering-records-title">
          <div class="ca-heading">
            <h3 id="engineering-records-title">已保存工程工况</h3>
            <button id="engineering-records-refresh" type="button">刷新记录</button>
          </div>
          <ul id="engineering-record-list"></ul>
        </section>
      </section>
      <section id="a6-panel" aria-labelledby="a6-title">
        <div class="ca-heading"><h2 id="a6-title">重计算计划</h2><button id="a6-refresh" type="button">刷新计划和输入</button></div>
        <p id="a7-recovery" class="ca-muted" hidden></p>
        <form id="a6-form">
          <label>已有运行<select id="a6-run" name="run_id" required><option value="">选择已有运行</option></select></label>
          <label>工作流程<select id="a6-workflow" name="workflow" required disabled></select></label>
          <div class="ca-grid ca-axes">
            <label>CPU<input id="a6-cpus" name="cpus" type="number" min="1" max="256" step="1" value="1" required></label>
            <label>GPU<input id="a6-gpus" name="gpus" type="number" min="0" max="8" step="1" value="0" required></label>
            <label>分钟<input id="a6-minutes" name="minutes" type="number" min="1" max="10080" step="1" value="1" required></label>
          </div>
          <p id="a6-preview" class="ca-muted"></p>
          <button id="a6-create" class="ca-primary" type="submit" disabled>创建计划</button>
        </form>
        <label>已创建的计划<select id="a6-plans" disabled><option value="">选择计划</option></select></label>
        <p id="a6-status" role="status"></p>
        <section id="a6-review" aria-label="计划核对" hidden>
          <h3>核对计划</h3>
          <div id="a6-spec"></div>
          <dl class="ca-metrics">
            <div><dt>源文件 SHA-256</dt><dd><code id="a6-source-sha"></code></dd></div>
            <div><dt>执行方式</dt><dd id="a6-mode"></dd></div>
            <div><dt>状态</dt><dd id="a6-state"></dd></div>
            <div><dt>尝试次数</dt><dd id="a6-attempts"></dd></div>
            <div><dt>作业号</dt><dd id="a6-job-id"></dd><dd><a id="a7-receipt" download hidden>下载作业计算回执</a></dd></div>
          </dl>
          <div class="ca-a6-actions">
            <button id="a6-confirm" type="button" hidden>确认计划</button>
            <button id="a6-retry" type="button" hidden>确认重试</button>
            <button id="a6-reconcile" type="button" hidden>查询回执</button>
            <button id="a6-md-status" type="button" hidden>查看 LAMMPS 调度状态</button>
          </div>
          <h4>计划事件</h4>
          <ol id="a6-events"></ol>
        </section>
      </section>
      <details id="analysis-cell">
        <summary>晶胞尺寸预检与构建</summary>
        <form id="cell-form">
          <label>POSCAR 文件<input id="cell-upload" name="file" type="file" required></label>
          <fieldset><legend>沿 a、b、c 轴的复制倍数</legend><div class="ca-grid ca-axes">
            <label>a<input name="repeat_a" type="number" min="1" step="1" value="1" required></label>
            <label>b<input name="repeat_b" type="number" min="1" step="1" value="1" required></label>
            <label>c<input name="repeat_c" type="number" min="1" step="1" value="1" required></label>
          </div></fieldset>
          <label>替换沿表面法向的真空厚度（Å）
            <input name="vacuum_A" type="number" step="any" placeholder="留空保留现有真空">
          </label>
          <p class="ca-muted">替换真空时，c 轴复制倍数须为 1。</p>
          <fieldset><legend>含真空的各轴长度上限（Å）</legend><div class="ca-grid ca-axes">
            <label>a<input name="limit_a" type="number" min="0.000001" max="50" step="any" value="50" required></label>
            <label>b<input name="limit_b" type="number" min="0.000001" max="50" step="any" value="50" required></label>
            <label>c<input name="limit_c" type="number" min="0.000001" max="50" step="any" value="50" required></label>
          </div></fieldset>
          <p class="ca-muted">每轴最多 50 Å，含真空。构建保留原子间距。</p>
          <label>执行方式<select id="cell-mode"><option value="preflight">仅预检</option><option value="construct">预检并生成 POSCAR</option></select></label>
          <button id="cell-submit" class="ca-primary" type="submit">检查晶胞</button>
          <p id="cell-status" role="status"></p>
        </form>
        <section id="cell-results" aria-label="晶胞检查结果" hidden></section>
      </details>
      <details class="ca-cell" id="md-handoff">
        <summary>DFT → MD 结构交接</summary>
        <form id="md-handoff-form">
          <label>VASP 结构<input id="md-handoff-file" name="file" type="file" required></label>
          <p class="ca-muted">支持 POSCAR、CONTCAR 和 vasprun.xml。导出 LAMMPS 晶胞、原子坐标和元素质量。</p>
          <button id="md-handoff-submit" type="submit" class="ca-primary">生成 LAMMPS 结构包</button>
          <p id="md-handoff-status" role="status"></p>
        </form>
      </details>
      <details class="ca-cell" id="md-job">
        <summary>LAMMPS 作业配置与调度</summary>
        <form id="md-job-form">
          <p id="md-job-source" class="ca-muted">上传结构，或从 VASP 结果选择结构。</p>
          <label>独立结构<input id="md-job-file" type="file"></label>
          <label>作业配置 JSON<textarea id="md-job-config" rows="9" required></textarea></label>
          <fieldset id="md-transport-driving" class="ca-driving-workbench">
            <legend>外部驱动工作台</legend>
            <p class="ca-muted">三类边界驱动可独立勾选；提交时写入顶层 <code>transport_driving</code>，并保留现有 <code>transport_sampling</code> 作为独立的采样配置。未启用时不改写作业 JSON。</p>
            <label class="ca-a5-check"><input id="md-driving-enabled" type="checkbox">启用外部驱动</label>
            <div id="md-driving-fields" hidden>
              <div class="ca-grid">
                <label>驱动法向轴<select id="md-driving-axis">
                  <option value="x">x</option><option value="y">y</option><option value="z">z</option>
                </select></label>
              </div>
              <div class="ca-driving-grid">
                <fieldset class="ca-driving-card">
                  <legend>温度边界 · 测得温度梯度</legend>
                  <label class="ca-a5-check"><input id="md-driving-temperature-enabled" type="checkbox">启用温度 slab 驱动</label>
                  <fieldset id="md-driving-temperature-fields" class="ca-driving-fields" hidden disabled>
                    <div class="ca-grid">
                      <label>模式<select id="md-driving-temperature-mode"><option value="thermostat_slabs">thermostat_slabs</option></select></label>
                      <label>热区目标温度（K）<input id="md-driving-temperature-hot" type="number" step="any"></label>
                      <label>冷区目标温度（K）<input id="md-driving-temperature-cold" type="number" step="any"></label>
                      <label>热区 lo（沿法向 Å）<input id="md-driving-temperature-hot-lo" type="number" step="any"></label>
                      <label>热区 hi（沿法向 Å）<input id="md-driving-temperature-hot-hi" type="number" step="any"></label>
                      <label>冷区 lo（沿法向 Å）<input id="md-driving-temperature-cold-lo" type="number" step="any"></label>
                      <label>冷区 hi（沿法向 Å）<input id="md-driving-temperature-cold-hi" type="number" step="any"></label>
                      <label>阻尼时间（ps）<input id="md-driving-temperature-damping" type="number" min="0" step="any"></label>
                      <label>基础随机种子<input id="md-driving-temperature-seed" type="number" min="1" max="900000000" step="1"></label>
                      <label>动态分组更新间隔（契约固定为 1）<input id="md-driving-temperature-groups" type="number" min="1" step="1" value="1" readonly></label>
                    </div>
                    <label class="ca-a5-check"><input id="md-driving-temperature-zero-force" type="checkbox" checked disabled>消除随机力净和（zero_random_force，固定 true）</label>
                    <p class="ca-muted">采用 NVE 积分。冷区随机种子为 seed + 1，每步按原子位置更新分组。</p>
                  </fieldset>
                </fieldset>
                <fieldset class="ca-driving-card">
                  <legend>浓度边界 · 测得浓度梯度</legend>
                  <label class="ca-a5-check"><input id="md-driving-concentration-enabled" type="checkbox">启用 atom/swap reservoir</label>
                  <fieldset id="md-driving-concentration-fields" class="ca-driving-fields" hidden disabled>
                    <label>浓度物种（逗号分隔，须匹配结构元素）<input id="md-driving-concentration-species" placeholder="元素符号，例如 H,O"></label>
                    <label>交换温度（K，可留空沿用初始温度）<input id="md-driving-concentration-temperature" type="number" step="any"></label>
                    <label>两个组分储库（JSON）<textarea id="md-driving-concentration-regions" rows="5" placeholder='[{"name":"low","lo":0,"hi":1,"every":100,"attempts":10,"seed":101,"mu_eV":{"<species_1>":0,"<species_2>":0}},{"name":"high","lo":9,"hi":10,"every":100,"attempts":10,"seed":102,"mu_eV":{"<species_1>":0,"<species_2>":0}}]'></textarea></label>
                    <label>动能处理<select id="md-driving-concentration-ke"><option value="yes">yes</option><option value="no">no</option></select></label>
                    <p class="ca-muted">两储库的化学势差驱动组分交换。semi_grand 模式按当前位置选取原子，交换时保留各原子的电荷和质量。</p>
                  </fieldset>
                </fieldset>
                <fieldset class="ca-driving-card">
                  <legend>剪切边界 · 测得速度梯度</legend>
                  <label class="ca-a5-check"><input id="md-driving-shear-enabled" type="checkbox">启用 moving walls</label>
                  <fieldset id="md-driving-shear-fields" class="ca-driving-fields" hidden disabled>
                    <div class="ca-grid">
                      <label>模式<select id="md-driving-shear-mode"><option value="moving_walls">moving_walls</option><option value="sllod" disabled>sllod（当前不支持）</option></select></label>
                      <label>切向轴<select id="md-driving-shear-tangential"><option value="x">x</option><option value="y">y</option><option value="z">z</option></select></label>
                    </div>
                    <label>两个壁面区域（JSON）<textarea id="md-driving-shear-regions" rows="5" placeholder='[{"name":"wall_low","lo":0,"hi":1,"velocity_A_per_ps":0},{"name":"wall_high","lo":9,"hi":10,"velocity_A_per_ps":0}]'></textarea></label>
                    <p class="ca-muted">采用正交晶胞和非周期法向边界。fix move 驱动壁原子，NVE 积分作用于流体组。</p>
                  </fieldset>
                </fieldset>
              </div>
              <p class="ca-physical-note">采样结果包括剖面、拟合梯度、热库交换量、组分交换统计和壁面动量。</p>
            </div>
          </fieldset>
          <label>EAM 势函数文件<input id="md-job-potential" type="file"></label>
          <p class="ca-muted">支持显式 LJ 参数和 EAM/alloy 文件。输入步长、温度、系综与三轴边界，可下载作业包，或在已启用调度的项目中发起人工确认。</p>
          <a href="/guide/md-job" target="_blank" rel="noopener">配置字段与运行命令</a>
          <fieldset id="md-slurm-resources" hidden>
            <legend>Slurm 资源</legend>
            <div class="ca-grid ca-axes">
              <label>CPU<input id="md-slurm-cpus" type="number" min="1" step="1" value="1"></label>
              <label>GPU<input id="md-slurm-gpus" type="number" min="0" max="1" step="1" value="0"></label>
              <label>时限（分钟）<input id="md-slurm-minutes" type="number" min="1" step="1" value="5"></label>
            </div>
            <label>检查点间隔（步）<input id="md-slurm-restart-every" type="number" min="1" step="1" placeholder="也可在 JSON 中填写 restart_every"></label>
          </fieldset>
          <div class="ca-md-actions">
            <button id="md-job-submit" class="ca-primary" type="submit" formnovalidate>生成 LAMMPS 作业包</button>
            <button id="md-slurm-create" type="button" hidden>创建 Slurm 待确认计划</button>
            <button id="md-slurm-new" type="button" hidden>新建另一份计划</button>
          </div>
          <p id="md-job-status" role="status"></p>
        </form>
        <section id="md-slurm" class="ca-md-queue" aria-labelledby="md-slurm-title" hidden>
          <div class="ca-heading">
            <h3 id="md-slurm-title">LAMMPS 调度与恢复</h3>
            <button id="md-slurm-refresh" type="button">刷新作业</button>
          </div>
          <label>已确认的调度计划<select id="md-slurm-jobs" disabled><option value="">选择作业</option></select></label>
          <p id="md-slurm-status" role="status"></p>
          <div id="md-slurm-detail" hidden>
            <div id="md-slurm-metrics"></div>
            <p id="md-slurm-progress" class="ca-md-progress"></p>
            <ul id="md-slurm-artifacts" class="ca-artifacts" hidden></ul>
            <div class="ca-md-actions">
              <button id="md-slurm-cancel" type="button" hidden>取消 Slurm 作业</button>
            </div>
            <form id="md-slurm-recovery" hidden>
              <h4>从检查点恢复</h4>
              <div class="ca-grid">
                <label>检查点<select id="md-slurm-checkpoint" required></select></label>
                <label>追加步数<input id="md-slurm-steps" type="number" min="1" step="1" required></label>
              </div>
              <p class="ca-muted">复用上方的 Slurm 资源设置。恢复会新建计划，仍需人工确认。</p>
              <button id="md-slurm-restart" type="submit">创建恢复计划</button>
            </form>
          </div>
        </section>
      </details>
      <section id="a1-backups" aria-labelledby="a1-backup-title" hidden>
        <div class="ca-heading"><h2 id="a1-backup-title">项目备份</h2><button id="a1-backup-refresh" type="button">刷新备份</button></div>
        <p id="a1-backup-status" role="status"></p>
        <ul id="a1-backup-list"></ul>
      </section>
      </div>`;
    content.append(panel);
    if (sessionStorage.getItem("catalysis-reopen-analysis") === "1") {
      sessionStorage.removeItem("catalysis-reopen-analysis");
      panel.open = true;
    }

    const header = content.closest(".wb-main").querySelector(".wb-header");
    if (header) {
      const nav = element("button", "科学分析");
      nav.id = "analysis-nav";
      nav.type = "button";
      nav.setAttribute("aria-controls", panel.id);
      nav.setAttribute("aria-expanded", "false");
      nav.addEventListener("click", () => {
        panel.open = true;
        panel.querySelector("#analysis-panel-toggle").focus({ preventScroll: true });
        panel.scrollIntoView({ block: "start" });
      });
      panel.addEventListener("toggle", () => nav.setAttribute("aria-expanded", String(panel.open)));
      header.append(nav);
    }

    const find = selector => panel.querySelector(selector);
    const controls = find("#a1-session");
    const login = find("#a1-login");
    const logout = find("#a1-logout");
    const picker = find("#a1-project");
    const status = find("#a1-status");
    const workbench = find("#a1-workspace");
    const controller = new AbortController();
    const jsonHeaders = { "Content-Type": "application/json" };
    const page = new URL(location.href);
    let pending = false;

    function clearProject() {
      controller.abort();
      const poscar = find("#cell-form")?.dataset.poscarUrl;
      if (poscar) URL.revokeObjectURL(poscar);
      workbench.remove();
      find("#a1-project-controls").hidden = true;
    }

    login.addEventListener("submit", async event => {
      event.preventDefault();
      if (pending) return;
      const button = find("#a1-login-submit");
      const password = find("#a1-password");
      const body = JSON.stringify({ username: find("#a1-username").value, password: password.value });
      pending = button.disabled = true;
      password.value = "";
      setStatus(status, "正在登录…");
      try {
        await request("/api/login", body, undefined, jsonHeaders);
        sessionStorage.setItem("catalysis-reopen-analysis", "1");
        location.reload();
      } catch (error) {
        pending = button.disabled = false;
        setStatus(status, `登录失败：${error.message}`, true);
        password.focus();
      }
    });

    logout.addEventListener("click", async () => {
      if (pending) return;
      pending = logout.disabled = true;
      clearProject();
      setStatus(status, "正在退出登录…");
      try {
        await request("/api/logout", "{}", undefined, jsonHeaders);
        page.searchParams.delete("project");
        sessionStorage.setItem("catalysis-reopen-analysis", "1");
        history.replaceState(history.state, "", page.href);
        location.reload();
      } catch (error) {
        pending = logout.disabled = false;
        setStatus(status, `退出失败，请重试：${error.message}`, true);
      }
    });

    let session;
    try {
      session = await request("/api/session");
    } catch (error) {
      // Legacy servers predating sessions retain their direct API routes.
      if (error.status !== 404) {
        setStatus(status, `读取会话失败：${error.message}`, true);
        return;
      }
      session = { managed: false };
    }
    if (session.managed === false) {
      controls.hidden = true;
      workbench.hidden = false;
      mountWorkspace(panel, workbench, request);
      return;
    }
    if (session.managed !== true) {
      setStatus(status, "无法识别服务的会话模式。", true);
      return;
    }
    window.addEventListener("pageshow", event => { if (event.persisted) location.reload(); });
    window.addEventListener("pagehide", clearProject, { once: true });
    setStatus(status, "");
    if (!session.actor) {
      login.hidden = false;
      return;
    }
    logout.hidden = false;
    const actor = typeof session.actor === "string" ? session.actor : session.actor.username ?? session.actor.id;
    find("#a1-actor").textContent = actor ?? "";
    const projects = Object.entries(session.projects ?? {}).filter(([id]) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(id));
    if (!projects.length) {
      setStatus(status, "当前账号没有可用项目。");
      return;
    }
    const allowed = new Map(projects);
    const requested = page.searchParams.get("project");
    const project = allowed.has(requested) ? requested : projects[0][0];
    picker.replaceChildren(...projects.map(([id, role]) => new Option(`${id} · ${role}`, id)));
    picker.value = project;
    find("#a1-project-controls").hidden = false;
    if (requested && !allowed.has(requested)) {
      setStatus(status, `所选项目不可用，已打开 ${project}。`);
    }
    picker.addEventListener("change", () => {
      if (pending || !allowed.has(picker.value) || picker.value === project) return;
      pending = true;
      const next = picker.value;
      clearProject();
      page.searchParams.set("project", next);
      sessionStorage.setItem("catalysis-reopen-analysis", "1");
      location.assign(page.href);
    });

    projectPrefix = `/api/projects/${encodeURIComponent(project)}`;
    const projectRequest = async (path, body, kind, headers) => {
      controller.signal.throwIfAborted();
      const data = await request(projectPath(path), body, kind, headers, controller.signal);
      controller.signal.throwIfAborted();
      return data;
    };
    workbench.hidden = false;
    workbench.dataset.role = allowed.get(project);
    find("#md-handoff").hidden = find("#md-job-form").hidden = allowed.get(project) === "viewer";
    mountWorkspace(panel, workbench, projectRequest, controller.signal);
    if (allowed.get(project) === "admin") {
      const backups = find("#a1-backups");
      const refresh = find("#a1-backup-refresh");
      const list = find("#a1-backup-list");
      const message = find("#a1-backup-status");
      backups.hidden = false;
      const loadBackups = async () => {
        if (refresh.disabled || controller.signal.aborted) return;
        refresh.disabled = true;
        list.replaceChildren();
        setStatus(message, "正在读取项目备份…");
        try {
          const { backups } = await projectRequest("/api/backups");
          for (const backup of backups) {
            const item = element("li");
            const link = downloadLink(`/api/backups/${encodeURIComponent(backup.id)}`, backup.id);
            link.dataset.backupId = backup.id;
            item.append(link, element("small", `${backup.size_bytes} 字节`));
            list.append(item);
          }
          setStatus(message, backups.length ? "" : "暂无项目备份。");
        } catch (error) {
          setStatus(message, `读取备份失败：${error.message}`, true);
        } finally {
          refresh.disabled = false;
        }
      };
      refresh.addEventListener("click", loadBackups);
      panel.addEventListener("toggle", () => { if (panel.open) void loadBackups(); }, { signal: controller.signal });
      if (panel.open) void loadBackups();
    }
  }

  async function exportZip(path, body, signal, filename) {
    const response = await fetch(projectPath(path), { method: "POST", body, signal });
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new Error(error?.error ?? `HTTP ${response.status}`);
    }
    const url = URL.createObjectURL(await response.blob());
    const link = element("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function mountMdJob(find, panel, request, signal, selectPlan, refreshPlans) {
    const section = find("#md-job");
    const form = find("#md-job-form");
    const file = find("#md-job-file");
    const configInput = find("#md-job-config");
    const status = find("#md-job-status");
    const source = find("#md-job-source");
    const submit = find("#md-job-submit");
    const create = find("#md-slurm-create");
    const newPlan = find("#md-slurm-new");
    const queue = find("#md-slurm");
    const jobs = find("#md-slurm-jobs");
    const jobStatus = find("#md-slurm-status");
    const refresh = find("#md-slurm-refresh");
    const cancel = find("#md-slurm-cancel");
    const recovery = find("#md-slurm-recovery");
    const checkpoints = find("#md-slurm-checkpoint");
    const steps = find("#md-slurm-steps");
    const restartEvery = find("#md-slurm-restart-every");
    const transportImport = find("#analysis-transport-import");
    const transportImportStatus = find("#analysis-transport-import-status");
    const drivingControls = {
      enabled: find("#md-driving-enabled"),
      fields: find("#md-driving-fields"),
      axis: find("#md-driving-axis"),
      temperature: {
        enabled: find("#md-driving-temperature-enabled"),
        fields: find("#md-driving-temperature-fields"),
        mode: find("#md-driving-temperature-mode"),
        hot: find("#md-driving-temperature-hot"),
        cold: find("#md-driving-temperature-cold"),
        hotLo: find("#md-driving-temperature-hot-lo"),
        hotHi: find("#md-driving-temperature-hot-hi"),
        coldLo: find("#md-driving-temperature-cold-lo"),
        coldHi: find("#md-driving-temperature-cold-hi"),
        damping: find("#md-driving-temperature-damping"),
        seed: find("#md-driving-temperature-seed"),
        groups: find("#md-driving-temperature-groups"),
        zeroRandomForce: find("#md-driving-temperature-zero-force"),
      },
      concentration: {
        enabled: find("#md-driving-concentration-enabled"),
        fields: find("#md-driving-concentration-fields"),
        species: find("#md-driving-concentration-species"),
        temperature: find("#md-driving-concentration-temperature"),
        regions: find("#md-driving-concentration-regions"),
        ke: find("#md-driving-concentration-ke"),
      },
      shear: {
        enabled: find("#md-driving-shear-enabled"),
        fields: find("#md-driving-shear-fields"),
        mode: find("#md-driving-shear-mode"),
        tangential: find("#md-driving-shear-tangential"),
        regions: find("#md-driving-shear-regions"),
      },
    };
    const resources = Object.fromEntries(["cpus", "gpus", "minutes"]
      .map(key => [key, find("#md-slurm-" + key)]));
    const json = { "Content-Type": "application/json" };
    const labels = {
      PENDING: "排队中", CONFIGURING: "分配资源中", RUNNING: "运行中", COMPLETING: "收尾中",
      COMPLETED: "已完成", CANCELLED: "已取消", FAILED: "失败", TIMEOUT: "超时",
      OUT_OF_MEMORY: "内存不足", NODE_FAIL: "节点故障", PREEMPTED: "已抢占", SUSPENDED: "已暂停",
    };
    let selected;
    let records = new Map();
    let writable = false;
    let busy = false;
    let attempt;
    let current;
    let fresh = false;
    let acting = false;
    let revision = 0;
    let timer;

    const post = (path, body) => request(path, JSON.stringify(body), undefined, json);
    const jobPath = (id, action) => `/api/plans/${encodeURIComponent(id)}/${action}`;
    const visible = () => panel.open && section.open && !queue.hidden && !document.hidden && !signal?.aborted;

    function syncCreate() {
      find("#md-slurm-resources").hidden = create.hidden = !writable;
      newPlan.hidden = !writable || !attempt;
      create.disabled = newPlan.disabled = submit.disabled = busy;
      create.textContent = attempt?.record ? "打开已有确认计划"
        : attempt ? "重试创建 Slurm 计划" : "创建 Slurm 待确认计划";
    }

    function resetAttempt() {
      attempt = undefined;
      syncCreate();
    }

    function formBody(options) {
      const body = new FormData();
      if (selected) {
        for (const [key, value] of Object.entries(selected)) body.set(key, value);
      } else if (file.files[0]) {
        body.set("file", file.files[0]);
      } else {
        throw new Error("请先选择结构。");
      }
      const potential = find("#md-job-potential").files[0];
      if (potential) body.set("potential", potential);
      body.set("options", options);
      return body;
    }

    function readResources() {
      return Object.fromEntries(Object.entries(resources).map(([key, field]) => {
        if (!field.value || !field.checkValidity() || !Number.isSafeInteger(field.valueAsNumber)) {
          field.reportValidity();
          throw new Error("请填写有效的 Slurm 资源。");
        }
        return [key, field.valueAsNumber];
      }));
    }

    function requestId() {
      if (crypto.randomUUID) return crypto.randomUUID();
      // getRandomValues is also available on the V100 intranet over HTTP.
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 15) | 64;
      bytes[8] = (bytes[8] & 63) | 128;
      const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
      return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
    }

    function drivingNumber(field, label) {
      if (!Number.isFinite(field.valueAsNumber)) throw new Error("请填写" + label + "。");
      return field.valueAsNumber;
    }

    function drivingInteger(field, label) {
      const value = field.valueAsNumber;
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(label + " 必须是正整数。");
      return value;
    }


    function orderedDrivingRegion(region, label) {
      if (!region || typeof region !== "object" || Array.isArray(region)
          || !Number.isFinite(region.lo) || !Number.isFinite(region.hi) || region.hi <= region.lo) {
        throw new Error(label + " 必须有有限数值 lo/hi 且 hi 大于 lo。");
      }
    }

    function exactDrivingRegions(field, label, keys) {
      let value;
      try {
        value = JSON.parse(field.value);
      } catch {
        throw new Error(label + " 必须是合法 JSON。");
      }
      if (!Array.isArray(value) || value.length !== 2) {
        throw new Error(label + " 必须恰好包含两个区域。");
      }
      const expected = [...keys].sort().join("|");
      value.forEach((region, index) => {
        if (!region || typeof region !== "object" || Array.isArray(region)
            || Object.keys(region).sort().join("|") !== expected) {
          throw new Error(label + " 第 " + (index + 1) + " 个区域字段不匹配契约。");
        }
        orderedDrivingRegion(region, label + " 第 " + (index + 1) + " 个区域");
        if (typeof region.name !== "string" || !region.name.trim()) {
          throw new Error(label + " 第 " + (index + 1) + " 个区域需要名称。");
        }
      });
      if (value[0].lo < value[1].hi && value[1].lo < value[0].hi) {
        throw new Error(label + " 两个区域不能重叠。");
      }
      return value;
    }

    function readDrivingConfig() {
      if (!drivingControls.enabled.checked) return null;
      const config = { enabled: true, axis: drivingControls.axis.value };
      let active = 0;
      if (drivingControls.temperature.enabled.checked) {
        active++;
        const hot = drivingNumber(drivingControls.temperature.hot, "热区目标温度");
        const cold = drivingNumber(drivingControls.temperature.cold, "冷区目标温度");
        const hotRegion = {
          lo: drivingNumber(drivingControls.temperature.hotLo, "热区 lo"),
          hi: drivingNumber(drivingControls.temperature.hotHi, "热区 hi"),
        };
        const coldRegion = {
          lo: drivingNumber(drivingControls.temperature.coldLo, "冷区 lo"),
          hi: drivingNumber(drivingControls.temperature.coldHi, "冷区 hi"),
        };
        orderedDrivingRegion(hotRegion, "热区");
        orderedDrivingRegion(coldRegion, "冷区");
        if (hot <= cold) throw new Error("热区目标温度必须高于冷区目标温度。");
        if (hotRegion.lo < coldRegion.hi && coldRegion.lo < hotRegion.hi) {
          throw new Error("温度热区与冷区不能重叠。");
        }
        config.temperature = {
          mode: drivingControls.temperature.mode.value,
          hot_K: hot,
          cold_K: cold,
          hot_region: hotRegion,
          cold_region: coldRegion,
          damping_ps: drivingNumber(drivingControls.temperature.damping, "温度阻尼时间"),
          seed: drivingInteger(drivingControls.temperature.seed, "温度随机种子"),
          group_update_every: drivingInteger(drivingControls.temperature.groups, "动态分组更新间隔"),
          zero_random_force: drivingControls.temperature.zeroRandomForce.checked,
        };
      }
      if (drivingControls.concentration.enabled.checked) {
        active++;
        const species = drivingControls.concentration.species.value.split(",")
          .map(value => value.trim()).filter(Boolean);
        if (species.length < 2 || new Set(species).size !== species.length
            || species.some(value => !/^[A-Z][a-z]?$/.test(value))) {
          throw new Error("浓度物种必须是至少两个不重复的元素符号。");
        }
        const regions = exactDrivingRegions(drivingControls.concentration.regions,
          "浓度 reservoir 区域", ["name", "lo", "hi", "every", "attempts", "seed", "mu_eV"]);
        regions.forEach((region, index) => {
          for (const key of ["every", "attempts", "seed"]) {
            if (!Number.isSafeInteger(region[key]) || region[key] < 1) {
              throw new Error("浓度 reservoir " + (index + 1) + " 的 " + key + " 必须是正整数。");
            }
          }
          if (!region.mu_eV || typeof region.mu_eV !== "object" || Array.isArray(region.mu_eV)
              || Object.keys(region.mu_eV).sort().join("|") !== [...species].sort().join("|")
              || Object.values(region.mu_eV).some(value => !Number.isFinite(value))) {
            throw new Error("浓度 reservoir " + (index + 1) + " 的 mu_eV 必须逐一对应物种。");
          }
        });
        const concentration = {
          mode: "atom_swap_reservoirs",
          species,
          regions,
          semi_grand: true,
          ke: drivingControls.concentration.ke.value,
        };
        if (drivingControls.concentration.temperature.value.trim()) {
          concentration.temperature_K = drivingNumber(drivingControls.concentration.temperature, "交换温度");
        }
        config.concentration = concentration;
      }
      if (drivingControls.shear.enabled.checked) {
        active++;
        if (drivingControls.shear.mode.value === "sllod") {
          throw new Error("SLLOD 当前不支持：请选择 moving_walls。");
        }
        if (drivingControls.shear.tangential.value === config.axis) {
          throw new Error("剪切切向轴必须不同于驱动法向轴。");
        }
        config.shear = {
          mode: "moving_walls",
          tangential_axis: drivingControls.shear.tangential.value,
          wall_regions: exactDrivingRegions(drivingControls.shear.regions,
            "shear wall 区域", ["name", "lo", "hi", "velocity_A_per_ps"]),
        };
      }
      if (!active) throw new Error("启用外部驱动后，至少勾选一种驱动类型。");
      return config;
    }

    function readJobConfig() {
      let config;
      try {
        config = JSON.parse(configInput.value);
      } catch {
        throw new Error("请填写合法的作业配置 JSON。");
      }
      if (!config || Array.isArray(config) || typeof config !== "object") {
        throw new Error("作业配置必须是 JSON 对象。");
      }
      const requestedDriving = readDrivingConfig();
      if (requestedDriving) {
        config = { ...config, transport_driving: requestedDriving };
        configInput.value = JSON.stringify(config, null, 2);
      }
      return config;
    }

    for (const control of [
      drivingControls.enabled,
      drivingControls.temperature.enabled,
      drivingControls.concentration.enabled,
      drivingControls.shear.enabled,
    ]) control.addEventListener("change", syncDrivingFields);
    function syncDrivingFields() {
      const enabled = drivingControls.enabled.checked;
      drivingControls.fields.hidden = !enabled;
      drivingControls.axis.disabled = !enabled;
      for (const group of [
        drivingControls.temperature, drivingControls.concentration, drivingControls.shear,
      ]) {
        const active = enabled && group.enabled.checked;
        group.fields.hidden = !active;
        group.fields.disabled = !active;
      }
    }
    syncDrivingFields();


    find("#analysis-results").addEventListener("click", event => {
      const button = event.target.closest("button[data-md-run]");
      if (!button || form.hidden) return;
      selected = { run_id: button.dataset.mdRun, artifact_id: button.dataset.mdArtifact };
      file.value = "";
      source.textContent = button.dataset.mdLabel;
      resetAttempt();
      section.open = true;
      section.scrollIntoView({ block: "start" });
      configInput.focus({ preventScroll: true });
    });
    file.addEventListener("change", () => {
      selected = undefined;
      source.textContent = file.files[0]?.name ?? "上传结构，或从 VASP 结果选择结构。";
    });
    form.addEventListener("input", resetAttempt);
    form.addEventListener("change", resetAttempt);
    newPlan.addEventListener("click", () => {
      resetAttempt();
      setStatus(status, "下一次创建会生成新的待确认计划。");
    });
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (busy || form.hidden || !configInput.reportValidity()) return;
      busy = true;
      syncCreate();
      setStatus(status, "正在生成 LAMMPS 作业包…");
      try {
        const config = readJobConfig();
        await exportZip("/api/md-job", formBody(JSON.stringify(config)), signal, "lammps-md-job.zip");
        setStatus(status, "已生成 LAMMPS 作业包。");
      } catch (error) {
        if (!signal?.aborted) setStatus(status, error.message, true);
      } finally {
        busy = false;
        syncCreate();
      }
    });
    create.addEventListener("click", async () => {
      if (busy || !writable) return;
      if (attempt?.record) {
        selectPlan(attempt.record, true, true);
        return;
      }
      busy = true;
      syncCreate();
      setStatus(status, "正在创建待确认计划…");
      try {
        if (!attempt) {
          const config = readJobConfig();
          if (restartEvery.value) config.restart_every = restartEvery.valueAsNumber;
          if (!Number.isSafeInteger(config.restart_every) || config.restart_every < 1) {
            throw new Error("请填写正整数检查点间隔（restart_every）。");
          }
          attempt = { body: formBody(JSON.stringify({ config, ...readResources(), request_id: requestId() })) };
        }
        const pending = attempt;
        pending.record = await request("/api/md-job/plan", pending.body);
        selectPlan(pending.record, true);
        setStatus(status, pending.record.state === "pending" ? "计划已创建。请在计划核对区人工确认。"
          : "已打开该请求的现有计划。");
      } catch (error) {
        if (!signal?.aborted) setStatus(status, error.message, true);
      } finally {
        busy = false;
        syncCreate();
      }
    });

    function transportColumnPair(field, flux) {
      if (typeof field === "string" && typeof flux === "string") return { field, flux };
      if (!field || typeof field !== "object" || Array.isArray(field)
          || !flux || typeof flux !== "object" || Array.isArray(flux)) return null;
      for (const key of Object.keys(field).sort()) {
        if (typeof field[key] === "string" && typeof flux[key] === "string") {
          return { field: field[key], flux: flux[key], component: key };
        }
      }
      return null;
    }

    function transportUnit(metadata, key, fallback = "") {
      return metadata?.units?.[key]?.lammps ?? metadata?.units?.[key]?.si ?? fallback;
    }

    function applyTransportMetadata(metadata, planId, jobId) {
      const form = find("#analysis-form");
      const elements = form?.elements;
      if (!elements) throw new Error("找不到输运分析工作台。");
      elements.transport_source_plan_id.value = planId;
      elements.transport_source_job_id.value = jobId;
      const profile = metadata?.columns?.profile ?? {};
      const position = typeof profile.position === "string" ? profile.position : "";
      const time = typeof profile.time === "string" ? profile.time : "";
      elements.transport_position_column.value = position;
      elements.transport_position_unit.value = transportUnit(metadata, "position", "angstrom");
      elements.transport_time_column.value = time;
      elements.transport_time_unit.value = transportUnit(metadata, "time", "step");
      const conductivity = transportColumnPair(profile.temperature, profile.heat_flux);
      const diffusivity = transportColumnPair(profile.concentration, profile.mass_flux);
      const velocityColumns = metadata?.columns?.velocity ?? profile.velocity;
      let viscosity = null;
      if (velocityColumns && profile.momentum_flux
          && typeof velocityColumns === "object" && !Array.isArray(velocityColumns)
          && typeof profile.momentum_flux === "object" && !Array.isArray(profile.momentum_flux)) {
        const normal = metadata.axis;
        const components = Object.keys(profile.momentum_flux).sort()
          .filter(component => /^[xyz]{2}$/.test(component)
            && component[0] !== component[1] && component.includes(normal));
        const component = components.find(value => {
          const tangential = [...value].find(axis => axis !== normal);
          return tangential && typeof velocityColumns[tangential] === "string"
            && typeof profile.momentum_flux[value] === "string";
        });
        if (component) {
          const tangential = [...component].find(axis => axis !== normal);
          viscosity = {
            field: velocityColumns[tangential], flux: profile.momentum_flux[component], component,
          };
        }
      }
      const candidates = [
        conductivity && { mode: "conductivity", pair: conductivity, fieldKey: "temperature", fluxKey: "heat_flux" },
        diffusivity && { mode: "diffusivity", pair: diffusivity, fieldKey: "concentration", fluxKey: "mass_flux" },
        viscosity && { mode: "viscosity", pair: viscosity, fieldKey: "velocity", fluxKey: "momentum_flux" },
      ].filter(Boolean);
      const candidate = candidates.find(value => value.mode === elements.transport_mode.value) ?? candidates[0];
      if (candidate) {
        elements.transport_mode.value = candidate.mode;
        elements.transport_mode.dispatchEvent(new Event("change", { bubbles: true }));
        elements.transport_field_column.value = candidate.pair.field;
        elements.transport_field_unit.value = transportUnit(metadata, candidate.fieldKey);
        elements.transport_flux_column.value = candidate.pair.flux;
        elements.transport_flux_unit.value = transportUnit(metadata, candidate.fluxKey);
      }
      const available = [
        profile.temperature && "temperature/temp",
        profile.concentration && "concentration",
        profile.heat_flux && "heat_flux",
        profile.mass_flux && "mass_flux",
        velocityColumns && "velocity",
        profile.momentum_flux && "momentum_flux",
        metadata?.columns?.global_flux && "global_flux",
      ].filter(Boolean);
      const component = candidate?.pair?.component ? "候选分量 " + candidate.pair.component + "，" : "";
      setStatus(transportImportStatus,
        "已自动带入 plan/job、位置/时间列" + (candidate ? "与 " + component + candidate.mode + " 列。" : "；可用 native 列：" + available.join("、") + "。")
        + "提交时保持主文件/sidecar 为空，服务端将从授权计划读取原始工件；尚未拟合梯度或计算传递系数，请确认模式、分量、窗口和单位后再提交。");
    }

    async function importTransport() {
      if (transportImport?.disabled) return;
      const record = records.get(jobs.value);
      const planId = current?.plan_id ?? record?.id ?? jobs.value;
      const jobId = current?.job_id ?? record?.job_id;
      if (!planId || !jobId) {
        setStatus(transportImportStatus, "请先在上方选择已授权的 MD 作业。", true);
        return;
      }
      if (!current?.terminal || current.runner_state !== "completed") {
        setStatus(transportImportStatus, "作业尚未完成，暂不带入 native 采样。", true);
        return;
      }
      transportImport.disabled = true;
      setStatus(transportImportStatus, "正在读取授权计划 metadata…");
      try {
        const metadataArtifact = (current.artifacts ?? []).find(artifact => /metadata\.json$/i.test(artifact.name ?? ""));
        const metadata = metadataArtifact ? await request(metadataArtifact.url) : null;
        const form = find("#analysis-form");
        form.elements.transport_source_plan_id.value = planId;
        form.elements.transport_source_job_id.value = jobId;
        if (metadata) {
          applyTransportMetadata(metadata, planId, jobId);
        } else {
          setStatus(transportImportStatus,
            "已带入 plan/job，但授权作业未暴露 metadata 工件；采样列仍需人工填写，未进行任何自动拟合。", true);
        }
      } catch (error) {
        setStatus(transportImportStatus, "授权采样带入失败：" + error.message, true);
      } finally {
        renderJob();
      }
    }

    transportImport?.addEventListener("click", () => void importTransport());

    function renderJob() {
      if (transportImport) {
        const ready = current?.terminal === true && current.runner_state === "completed";
        transportImport.disabled = acting || !ready;
        transportImport.title = ready ? "读取已授权 metadata 并带入候选列" : "等待作业完成后可带入 native 采样";
      }
      find("#md-slurm-detail").hidden = !current;
      jobs.disabled = acting || !records.size;
      refresh.disabled = acting;
      cancel.hidden = !(writable && current?.can_cancel);
      recovery.hidden = !(writable && current?.can_restart && current.checkpoints?.length);
      cancel.disabled = acting || !fresh;
      find("#md-slurm-restart").disabled = acting || !fresh;
      checkpoints.disabled = steps.disabled = acting || !fresh;
      if (!current) return;
      find("#md-slurm-metrics").replaceChildren(metrics([
        ["Slurm 作业号", current.job_id ?? "等待调度回执"],
        ["Slurm 状态", labels[current.scheduler_state] ?? current.scheduler_state ?? "暂无状态"],
        ["调度原因", current.reason], ["运行器状态", current.runner_state],
      ]));
      const observed = current.progress;
      const reported = [];
      if (observed?.step != null) reported.push(`已报告步数 ${observed.step}`);
      if (observed?.start_step != null && observed?.target_step != null) {
        reported.push(`计划步数 ${observed.start_step} → ${observed.target_step}`);
      }
      if (Number.isFinite(observed?.fraction) && observed.fraction >= 0 && observed.fraction <= 1) {
        reported.push(`${(observed.fraction * 100).toFixed(1)}%`);
      }
      find("#md-slurm-progress").textContent = reported.join(" · ") || "暂无热力学步数回执。";
      const artifacts = find("#md-slurm-artifacts");
      artifacts.replaceChildren(...(current.artifacts ?? []).map(artifact => {
        const row = element("li");
        row.append(downloadLink(artifact.url, artifact.name));
        return row;
      }));
      artifacts.hidden = !artifacts.childElementCount;
      const options = [new Option("选择检查点", ""), ...(current.checkpoints ?? []).map(item =>
        new Option(`步数 ${item.step} · ${item.id}`, item.id))];
      if (options.length !== checkpoints.length || options.some((option, index) =>
        option.value !== checkpoints.options[index].value || option.text !== checkpoints.options[index].text)) {
        const checkpoint = checkpoints.value;
        checkpoints.replaceChildren(...options);
        checkpoints.value = options.some(option => option.value === checkpoint) ? checkpoint : "";
      }
    }

    function schedule() {
      clearTimeout(timer);
      if (visible() && jobs.value && !acting && (!current?.terminal || !fresh)) {
        timer = setTimeout(() => void loadJob(), 5000);
      }
    }

    async function loadJob(force = false) {
      clearTimeout(timer);
      if (!jobs.value || acting || (!force && !visible())) return;
      const id = jobs.value;
      const version = ++revision;
      try {
        const result = await request(jobPath(id, "status"));
        if (version !== revision || signal?.aborted) return;
        current = result;
        fresh = true;
        setStatus(jobStatus, "");
      } catch (error) {
        if (version !== revision || signal?.aborted) return;
        fresh = false;
        setStatus(jobStatus, `读取作业状态失败，显示的回执可能过期。 ${error.message}`, true);
      } finally {
        if (version === revision && !signal?.aborted) {
          renderJob();
          schedule();
        }
      }
    }

    function pickJob(id) {
      if (acting || !records.has(id)) return;
      jobs.value = id;
      ++revision;
      current = undefined;
      fresh = false;
      checkpoints.value = steps.value = "";
      renderJob();
      setStatus(jobStatus, "正在读取 Slurm 作业状态…");
      void loadJob(true);
    }

    async function act(action, body) {
      const id = jobs.value;
      if (!id || acting || !fresh || !writable) return;
      acting = true;
      ++revision;
      clearTimeout(timer);
      renderJob();
      setStatus(jobStatus, action === "cancel" ? "正在请求取消作业…" : "正在创建恢复计划…");
      try {
        const result = await post(jobPath(id, action), body);
        if (signal?.aborted) return;
        if (action === "restart") {
          selectPlan(result, true);
          setStatus(jobStatus, result.state === "pending" ? "恢复计划已创建，等待人工确认。"
            : "已打开该检查点的现有恢复计划。");
        } else {
          current = result;
          setStatus(jobStatus, "已提交取消请求。");
        }
      } catch (error) {
        if (!signal?.aborted) {
          fresh = false;
          setStatus(jobStatus, error.message, true);
        }
      } finally {
        acting = false;
        if (!signal?.aborted) {
          renderJob();
          schedule();
        }
      }
    }

    refresh.addEventListener("click", async () => {
      await refreshPlans();
      if (jobs.value) void loadJob(true);
    });
    jobs.addEventListener("change", () => {
      if (jobs.value) pickJob(jobs.value);
      else {
        ++revision;
        clearTimeout(timer);
        current = undefined;
        fresh = false;
        renderJob();
        setStatus(jobStatus, "");
      }
    });
    find("#a6-md-status").addEventListener("click", () => {
      section.open = true;
      pickJob(find("#a6-plans").value);
      queue.scrollIntoView({ block: "start" });
      jobs.focus({ preventScroll: true });
    });
    cancel.addEventListener("click", () => {
      if (fresh && current?.can_cancel && window.confirm(`取消 Slurm 作业 ${current.job_id}？`)) {
        void act("cancel", { confirmed: true });
      }
    });
    recovery.addEventListener("submit", event => {
      event.preventDefault();
      if (!fresh || !current?.can_restart || !recovery.reportValidity()) return;
      try {
        if (!Number.isSafeInteger(steps.valueAsNumber)) throw new Error("请填写有效的追加步数。");
        void act("restart", { checkpoint: checkpoints.value, steps: steps.valueAsNumber, ...readResources() });
      } catch (error) {
        setStatus(jobStatus, error.message, true);
      }
    });
    for (const target of [panel, section]) {
      target.addEventListener("toggle", () => {
        if (visible() && jobs.value) void loadJob();
        else clearTimeout(timer);
      }, { signal });
    }
    document.addEventListener("visibilitychange", schedule, { signal });
    signal?.addEventListener("abort", () => clearTimeout(timer), { once: true });

    return data => {
      writable = data.enabled && !data.recovery && !form.hidden;
      syncCreate();
      const selectedId = jobs.value;
      records = new Map(Array.from(data.records).filter(([, record]) =>
        record.spec.mode === "slurm-md" && ["submitting", "unknown", "submitted"].includes(record.state)));
      queue.hidden = !writable && !records.size;
      section.hidden = form.hidden && queue.hidden;
      jobs.replaceChildren(new Option("选择作业", ""), ...Array.from(records.values(), record =>
        new Option(`${record.job_id ? "Slurm " + record.job_id : "等待回执"} · ${record.id}`, record.id)));
      if (records.has(selectedId)) {
        jobs.value = selectedId;
      } else {
        ++revision;
        clearTimeout(timer);
        current = undefined;
        fresh = false;
        setStatus(jobStatus, records.size ? "" : "暂无已确认的 LAMMPS 调度计划。");
      }
      renderJob();
    };
  }

  function mountEngineering(find, panel, request, signal, role, openRun) {
    const root = find("#engineering-workbench");
    if (!root) return;
    const form = find("#engineering-form");
    const transportSelect = find("#engineering-transport-run");
    const kineticsSelect = find("#engineering-kinetics-run");
    const sourceSummary = find("#engineering-source-summary");
    const nameField = find("#engineering-name");
    const conditionIdField = find("#engineering-condition-id");
    const conditionsField = find("#engineering-conditions");
    const transportWindowField = find("#engineering-transport-window");
    const kineticsWindowField = find("#engineering-kinetics-window");
    const save = find("#engineering-save");
    const exportButton = find("#engineering-export");
    const status = find("#engineering-status");
    const currentPanel = find("#engineering-current");
    const recordList = find("#engineering-record-list");
    const refreshSourcesButton = find("#engineering-refresh");
    const refreshRecordsButton = find("#engineering-records-refresh");
    const newButton = find("#engineering-new");
    const jsonHeaders = { "Content-Type": "application/json" };
    const editable = role !== "viewer";
    const state = {
      sources: [], details: new Map(), records: [], current: null,
      endpoint: true, busy: false, sourceVersion: 0,
    };

    const first = (...values) => values.find(value => value !== undefined && value !== null && value !== "");
    const runId = run => first(run?.id, run?.run_id);
    const recordData = record => record?.engineering
      ?? record?.result?.engineering ?? record?.details?.engineering ?? record ?? {};
    const recordId = record => first(record?.id, record?.record_id,
      recordData(record)?.id, recordData(record)?.record_id);
    const recordSources = (record, data = recordData(record)) =>
      data.sources ?? record?.sources ?? data.source ?? record?.source ?? {};
    const jsonText = value => value == null ? ""
      : typeof value === "string" ? value : JSON.stringify(value, null, 2);
    const valueText = value => value == null ? "未报告"
      : typeof value === "number" ? (Number.isFinite(value) ? formatNumber(value) : "未报告")
        : typeof value === "string" ? value : JSON.stringify(value);
    const sourceContainers = run => [
      run?.execution, run?.result?.source, run?.details?.transport?.provenance,
      run?.details?.provenance, run?.details, run?.result,
    ].filter(value => value && typeof value === "object");
    const sourceValue = (run, keys) => {
      for (const container of sourceContainers(run)) {
        const value = first(...keys.map(key => container[key]));
        if (value != null) return value;
      }
      return undefined;
    };
    const runJob = run => sourceValue(run, ["job_id", "scheduler_job_id", "slurm_job_id", "source_job_id"]);
    const runPlan = run => sourceValue(run, ["plan_id", "source_plan_id"]);
    const runArtifacts = run => (run?.artifacts ?? []).map(artifact => ({
      id: first(artifact.id, artifact.artifact_id),
      name: artifact.name ?? artifact.id ?? artifact.artifact_id,
      role: artifact.role,
      url: artifact.url,
    })).filter(artifact => artifact.id || artifact.url);
    const modelFormula = run => {
      const model = String(run?.result?.model ?? "").toLowerCase();
      if (model === "arrhenius_known_k" || model.includes("arrhenius")) {
        return "k(T)=A exp(-Ea/(R T))";
      }
      if (model === "initial_rate_power_law" || model.includes("power_law")
          || model.includes("power-law")) {
        const reactants = Array.isArray(run?.input?.reactants) ? run.input.reactants
          .filter(reactant => typeof reactant === "string" && reactant) : [];
        if (reactants.length) {
          return "rate = k_ref " + reactants.map(reactant =>
            "(C_" + reactant + "/C_ref_" + reactant + ")^order_" + reactant).join(" * ");
        }
      }
      return undefined;
    };
    const runFormula = run => first(run?.result?.formula, run?.result?.equation,
      run?.result?.model_formula, run?.result?.fit?.formula, run?.details?.formula,
      modelFormula(run));
    const runUnits = run => {
      const result = run?.result ?? {};
      const units = result.units ?? run?.details?.units;
      if (units) return units;
      const fallback = {
        coefficient: result.coefficient_unit,
        gradient: result.gradient_unit,
        flux: result.flux_unit,
        prefactor: result.prefactor_unit,
        activation_energy: result.activation_energy_unit,
        rate: result.rate_at_reference_unit,
      };
      return Object.fromEntries(Object.entries(fallback).filter(([, value]) => value != null));
    };
    const observationRange = (rows, getter) => {
      const values = (Array.isArray(rows) ? rows : []).map(getter)
        .filter(value => typeof value === "number" && Number.isFinite(value));
      return values.length ? { min: Math.min(...values), max: Math.max(...values) } : null;
    };
    const observationStrings = (rows, key) => [...new Set(
      (Array.isArray(rows) ? rows : []).map(row => row?.[key])
        .filter(value => typeof value === "string")
    )].sort();
    const kineticsObservationWindow = run => {
      const input = run?.input;
      const observations = input?.observations;
      if (!Array.isArray(observations) || !observations.length) return undefined;
      const partitioned = observations.filter(row => row?.partition === "train"
        || row?.partition === "holdout");
      const partitionDefaulted = partitioned.length === 0;
      const training = partitionDefaulted ? observations
        : observations.filter(row => row?.partition === "train");
      const holdout = partitionDefaulted ? []
        : observations.filter(row => row?.partition === "holdout");
      const window = {
        status: "reported",
        source: "source.input.observations",
        fit_partition: "train",
        holdout_partition: "holdout",
        partition_source: partitionDefaulted ? "default_train" : "input.partition",
        temperature_K: {
          unit: "K",
          training: observationRange(training, row => row?.temperature_K),
          all: observationRange(observations, row => row?.temperature_K),
          holdout: observationRange(holdout, row => row?.temperature_K),
        },
        batch_ids: observationStrings(observations, "batch_id"),
        partitions: observationStrings(observations, "partition"),
        training_batch_ids: observationStrings(training, "batch_id"),
        holdout_batch_ids: observationStrings(holdout, "batch_id"),
      };
      if (input.model === "initial_rate_power_law") {
        const reactants = Array.isArray(input.reactants) ? input.reactants : [];
        const unit = input.concentration_unit ?? "mol/L";
        const concentration_ranges = {};
        for (const reactant of reactants) {
          const concentrations = rows => observationRange(rows,
            row => row?.concentrations?.[reactant]);
          concentration_ranges[reactant] = {
            unit,
            training: concentrations(training),
            all: concentrations(observations),
            holdout: concentrations(holdout),
          };
        }
        window.concentration_ranges = concentration_ranges;
        window.temperature_K.source_model_temperature = input.temperature_K ?? null;
      }
      return window;
    };
    const runWindow = run => {
      const result = run?.result ?? {};
      const details = run?.details ?? {};
      if (run?.kind === "md_transport") {
        return first(result.selection, result.fit_window, result.window, details.fit_window);
      }
      if (run?.kind === "kinetics") {
        return kineticsObservationWindow(run) ?? first(result.fit_window, result.fit?.window,
          details.fit_window, details.fit_diagnostics?.window,
          { status: "unavailable_not_reported" });
      }
      return first(result.fit_window, result.fit?.window, details.fit_window,
        details.fit_diagnostics?.window, { status: "unavailable_not_reported" });
    };
    const runConditions = run => first(run?.result?.conditions, run?.result?.condition,
      run?.input?.conditions, run?.input?.condition,
      run?.details?.conditions, run?.details?.condition,
      run?.details?.parameters?.conditions);
    const runNumbers = run => {
      const result = run?.result ?? {};
      const rows = [];
      if (run?.kind === "md_transport") {
        if (result.coefficient != null) rows.push(["传递系数", [valueText(result.coefficient),
          result.coefficient_unit ?? result.units?.coefficient].filter(Boolean).join(" ")]);
        if (result.gradient != null) rows.push(["场量梯度", [valueText(result.gradient),
          result.gradient_unit ?? result.units?.gradient].filter(Boolean).join(" ")]);
        if (result.mean_flux != null) rows.push(["平均通量/应力", [valueText(result.mean_flux),
          result.units?.flux].filter(Boolean).join(" ")]);
      } else if (run?.kind === "kinetics") {
        if (result.model != null) rows.push(["模型", modelLabel[result.model] ?? result.model]);
        for (const [label, key, unitKey] of [
          ["指前因子", "prefactor", "prefactor_unit"],
          ["活化能", "activation_energy", "activation_energy_unit"],
          ["参考浓度速率", "rate_at_reference", "rate_at_reference_unit"],
          ["训练集对数 RMSE", "train_log_rmse", null],
          ["留出集对数 RMSE", "holdout_log_rmse", null],
        ]) {
          if (result[key] != null) rows.push([label, [valueText(result[key]), result[unitKey]].filter(Boolean).join(" ")]);
        }
        if (result.orders && typeof result.orders === "object") {
          rows.push(["反应级数", valueText(result.orders)]);
        }
      }
      return rows;
    };

    const rangeSummary = range => range?.min != null && range?.max != null
      ? valueText(range.min) + "–" + valueText(range.max) : "未报告";
    const windowSummary = window => {
      if (!window || window.status === "unavailable_not_reported") {
        return "未报告（来源未报告）";
      }
      if (window.selection != null) return jsonText(window.selection);
      const parts = [];
      if (window.source) parts.push("来源 " + window.source);
      if (window.fit_partition) parts.push("拟合 " + window.fit_partition);
      if (window.holdout_partition) parts.push("留出 " + window.holdout_partition);
      const temperature = window.temperature_K;
      if (temperature) {
        parts.push("train " + rangeSummary(temperature.training) + " "
          + (temperature.unit ?? "K"));
        parts.push("holdout " + rangeSummary(temperature.holdout) + " "
          + (temperature.unit ?? "K"));
      }
      if (window.training_batch_ids?.length) {
        parts.push("训练批次 " + window.training_batch_ids.join(", "));
      }
      if (window.holdout_batch_ids?.length) {
        parts.push("留出批次 " + window.holdout_batch_ids.join(", "));
      }
      return parts.length ? parts.join(" · ") : jsonText(window);
    };

    function sourceCard(label, run) {
      const card = element("article", null, "ca-engineering-source-card");
      const id = runId(run);
      const artifacts = runArtifacts(run);
      const job = runJob(run);
      const plan = runPlan(run);
      card.append(element("h4", label + " · " + (run?.filename ?? id ?? "未报告")));
      card.append(metrics([
        ["公式", valueText(runFormula(run))],
        ["单位", valueText(runUnits(run))],
        ["来源工况", valueText(runConditions(run))],
        ["拟合窗口", windowSummary(runWindow(run))],
      ]));
      card.append(metrics([
        ["运行 ID", id], ["来源", originLabel[run?.origin] ?? run?.origin],
        ["关联 plan", plan], ["关联作业号", job],
        ...runNumbers(run),
      ]));
      const links = element("div", null, "ca-engineering-links");
      const open = element("button", "打开原结果");
      open.type = "button";
      open.disabled = !id;
      open.addEventListener("click", () => openRun?.(id, run.kind, open));
      links.append(open);
      if (run?.manifest_url) links.append(downloadLink(run.manifest_url, "下载原运行清单"));
      for (const artifact of artifacts) {
        if (artifact.url && artifact.role === "source") {
          links.append(downloadLink(artifact.url, "原件 · " + artifact.name));
        }
      }
      if (links.childElementCount) card.append(links);
      const snapshot = {
        formula: runFormula(run),
        units: runUnits(run),
        conditions: runConditions(run),
        fitting_window: runWindow(run),
      };
      if (Object.values(snapshot).some(value => value != null)) {
        card.append(details("公式、单位、来源工况与拟合窗口", snapshot));
      }
      return card;
    }

    function renderSources() {
      sourceSummary.replaceChildren();
      const transport = state.details.get(transportSelect.value)
        ?? state.sources.find(run => runId(run) === transportSelect.value);
      const kinetics = state.details.get(kineticsSelect.value)
        ?? state.sources.find(run => runId(run) === kineticsSelect.value);
      if (!transport && !kinetics) {
        sourceSummary.append(element("p", "请选择已有 MD 输运物性和/或动力学拟合结果。", "ca-muted"));
        return;
      }
      if (transport) sourceSummary.append(sourceCard("MD 输运物性", transport));
      if (kinetics) sourceSummary.append(sourceCard("动力学拟合", kinetics));
    }

    function populateSourceSelect(select, kind) {
      const selected = select.value;
      const options = state.sources.filter(run => run.kind === kind);
      select.replaceChildren(new Option(kind === "md_transport"
        ? "选择已有 MD 输运结果" : "选择已有动力学结果", ""));
      for (const run of options) {
        select.append(new Option(
          (run.filename ?? "未命名") + " · " + (run.created_at ?? "时间未报告") + " · "
            + (runId(run) ?? "ID 未报告"),
          runId(run) ?? "",
        ));
      }
      select.value = options.some(run => runId(run) === selected) ? selected : "";
    }

    async function loadRun(id, kind) {
      if (!id) return null;
      if (state.details.has(id)) return state.details.get(id);
      const summary = state.sources.find(run => runId(run) === id);
      if (!summary) return null;
      const detail = await request("/api/runs/" + encodeURIComponent(id), undefined, kind);
      state.details.set(id, detail);
      return detail;
    }

    function prefillFromSources() {
      const transport = state.details.get(transportSelect.value);
      const kinetics = state.details.get(kineticsSelect.value);
      transportWindowField.value = jsonText(runWindow(transport));
      kineticsWindowField.value = jsonText(runWindow(kinetics));
      if (!conditionsField.value.trim()) {
        const condition = first(runConditions(transport), runConditions(kinetics));
        if (condition != null) conditionsField.value = jsonText(condition);
      }
    }

    async function loadSourceSelection() {
      const version = ++state.sourceVersion;
      try {
        await Promise.all([
          loadRun(transportSelect.value, "md_transport"),
          loadRun(kineticsSelect.value, "kinetics"),
        ]);
        if (version !== state.sourceVersion) return;
        prefillFromSources();
        renderSources();
      } catch (error) {
        if (version === state.sourceVersion) setStatus(status, "读取来源运行失败：" + error.message, true);
      }
    }

    function sourceRef(run) {
      if (!run) return null;
      return {
        run_id: runId(run),
        artifact_ids: runArtifacts(run).map(artifact => artifact.id).filter(Boolean),
        plan_id: runPlan(run) ?? null,
        job_id: runJob(run) ?? null,
      };
    }

    function domainSnapshot(run, domain, window, conditions) {
      if (!run) return null;
      const result = run.result ?? {};
      const snapshot = {
        source_run_id: runId(run),
        source_artifact_ids: runArtifacts(run).map(artifact => artifact.id).filter(Boolean),
        plan_id: runPlan(run) ?? null,
        job_id: runJob(run) ?? null,
        value: domain === "transport" ? result.coefficient
          : first(result.rate_at_reference, result.activation_energy),
        coefficient: domain === "transport" ? result.coefficient : null,
        formula: runFormula(run) ?? null,
        units: runUnits(run),
        window: window ?? null,
        conditions: conditions ?? null,
      };
      if (domain === "kinetics") {
        snapshot.parameters = first(result.parameters, result.orders, {
          model: result.model,
          prefactor: result.prefactor,
          activation_energy: result.activation_energy,
          rate_at_reference: result.rate_at_reference,
        });
      }
      return snapshot;
    }

    function parseJson(field, label) {
      const raw = field.value.trim();
      if (!raw) return null;
      let value;
      try {
        value = JSON.parse(raw);
      } catch {
        throw new Error(label + "必须是合法 JSON。");
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(label + "必须是 JSON 对象。");
      }
      return value;
    }

    function payloadFromForm() {
      const transport = state.details.get(transportSelect.value);
      const kinetics = state.details.get(kineticsSelect.value);
      if (!transport || !kinetics) throw new Error("请选择已有 MD 输运物性和动力学拟合结果。");
      const conditions = parseJson(conditionsField, "工况参数");
      const windows = {
        transport: parseJson(transportWindowField, "输运拟合窗口"),
        kinetics: parseJson(kineticsWindowField, "动力学拟合窗口"),
      };
      const conditionName = nameField.value.trim();
      const conditionId = conditionIdField.value.trim();
      if (!conditionName && !conditionId) throw new Error("请填写工况名称或工况 ID。");
      return {
        schema_version: 1,
        name: conditionName || null,
        condition_id: conditionId || null,
        conditions,
        windows,
        sources: {
          transport: sourceRef(transport),
          kinetics: sourceRef(kinetics),
        },
        transport: domainSnapshot(transport, "transport", windows.transport, conditions),
        kinetics: domainSnapshot(kinetics, "kinetics", windows.kinetics, conditions),
      };
    }

    function renderCurrent(record) {
      const data = recordData(record);
      const id = recordId(record);
      currentPanel.hidden = !record;
      exportButton.disabled = !id || !state.endpoint;
      if (!record) {
        currentPanel.replaceChildren();
        return;
      }
      const sources = recordSources(record, data);
      currentPanel.replaceChildren(
        element("h3", data.name ?? record.name ?? "已保存工程工况"),
        metrics([
          ["记录 ID", id], ["工况 ID", data.condition_id ?? record.condition_id],
          ["保存时间", first(record.updated_at, record.created_at, data.updated_at)],
          ["输运来源 run", data.transport?.source_run_id ?? sources.transport?.run_id
            ?? sources.transport?.source_run_id],
          ["动力学来源 run", data.kinetics?.source_run_id ?? sources.kinetics?.run_id
            ?? sources.kinetics?.source_run_id],
        ]),
        details("已保存工况、来源引用与拟合窗口", {
          conditions: data.conditions,
          windows: data.windows,
          sources,
          transport: data.transport,
          kinetics: data.kinetics,
        }),
      );
      const exportUrl = first(record.export_url, data.export_url, data.links?.export, record.links?.export, record.links?.export_url);
      if (exportUrl) currentPanel.append(downloadLink(exportUrl, "导出此工况记录"));
    }

    function renderRecords() {
      recordList.replaceChildren();
      if (!state.records.length) {
        recordList.append(element("li", "暂无已保存工程工况。", "ca-muted"));
        return;
      }
      for (const record of state.records) {
        const data = recordData(record);
        const id = recordId(record);
        const button = element("button",
          (data.name ?? record.name ?? "未命名工况") + " · " + (id ?? "ID 未报告"));
        button.type = "button";
        if (id && id === recordId(state.current)) {
          button.setAttribute("aria-current", "true");
        }
        button.append(element("small", (data.condition_id ?? record.condition_id ?? "无工况 ID")
          + " · " + first(record.updated_at, record.created_at, "时间未报告")));
        button.addEventListener("click", () => void openRecord(id, button));
        const row = element("li");
        row.append(button);
        recordList.append(row);
      }
    }

    function syncButtons() {
      save.disabled = state.busy || !editable || !state.endpoint;
      exportButton.disabled = state.busy || !recordId(state.current) || !state.endpoint;
      refreshSourcesButton.disabled = state.busy;
      refreshRecordsButton.disabled = state.busy;
      newButton.disabled = state.busy;
    }

    async function refreshSources() {
      const data = await request("/api/runs");
      state.sources = (data.runs ?? []).filter(run =>
        run.kind === "md_transport" || run.kind === "kinetics");
      populateSourceSelect(transportSelect, "md_transport");
      populateSourceSelect(kineticsSelect, "kinetics");
      await loadSourceSelection();
    }

    async function refreshRecords() {
      try {
        const data = await request("/api/engineering");
        state.records = Array.isArray(data) ? data : (data.records ?? data.items ?? []);
        state.endpoint = true;
        renderRecords();
        syncButtons();
      } catch (error) {
        state.endpoint = error.status !== 404;
        renderRecords();
        syncButtons();
        throw error;
      }
    }

    async function refreshAll() {
      if (state.busy) return;
      state.busy = true;
      syncButtons();
      setStatus(status, "正在读取项目来源与工程工况…");
      try {
        await Promise.all([refreshSources(), refreshRecords()]);
        setStatus(status, "");
      } catch (error) {
        setStatus(status, error.status === 404
          ? "工程工况 API 尚未启用；来源仍可查看。"
          : "工程工况工作台读取失败：" + error.message, error.status !== 404);
      } finally {
        state.busy = false;
        syncButtons();
      }
    }

    async function openRecord(id, button) {
      if (!id) return;
      state.busy = true;
      syncButtons();
      setStatus(status, "正在打开工程工况记录…");
      try {
        const record = await request("/api/engineering/" + encodeURIComponent(id));
        const data = recordData(record);
        state.current = record;
        nameField.value = first(data.name, record.name) ?? "";
        conditionIdField.value = first(data.condition_id, record.condition_id) ?? "";
        const sources = recordSources(record, data);
        const transportId = first(data.transport?.source_run_id, sources.transport?.run_id,
          sources.transport?.source_run_id);
        const kineticsId = first(data.kinetics?.source_run_id, sources.kinetics?.run_id,
          sources.kinetics?.source_run_id);
        transportSelect.value = transportId ?? "";
        kineticsSelect.value = kineticsId ?? "";
        conditionsField.value = jsonText(data.conditions);
        await loadSourceSelection();
        const windows = data.windows ?? {};
        if (data.transport?.window != null || windows.transport != null) {
          transportWindowField.value = jsonText(data.transport?.window ?? windows.transport);
        }
        if (data.kinetics?.window != null || windows.kinetics != null) {
          kineticsWindowField.value = jsonText(data.kinetics?.window ?? windows.kinetics);
        }
        renderCurrent(record);
        renderSources();
        renderRecords();
        recordList.querySelectorAll("button").forEach(item =>
          item.removeAttribute("aria-current"));
        button.setAttribute("aria-current", "true");
        setStatus(status, "已打开工程工况记录；来源结果保持可追溯。");
      } catch (error) {
        setStatus(status, "打开工程工况失败：" + error.message, true);
      } finally {
        state.busy = false;
        syncButtons();
      }
    }

    async function saveRecord(event) {
      event.preventDefault();
      if (save.disabled) return;
      state.busy = true;
      syncButtons();
      setStatus(status, "正在保存工程工况引用…");
      try {
        const payload = payloadFromForm();
        const record = await request("/api/engineering", JSON.stringify(payload), undefined, jsonHeaders);
        state.current = record;
        await refreshRecords();
        renderCurrent(record);
        renderSources();
        setStatus(status, "工程工况已保存，可从记录列表重开。");
      } catch (error) {
        setStatus(status, "保存工程工况失败：" + error.message, true);
      } finally {
        state.busy = false;
        syncButtons();
      }
    }

    async function exportRecord() {
      const id = recordId(state.current);
      if (!id || exportButton.disabled) return;
      state.busy = true;
      syncButtons();
      setStatus(status, "正在导出工程工况记录…");
      try {
        const data = recordData(state.current);
        const url = first(state.current.export_url, data.export_url, data.links?.export)
          ?? "/api/engineering/" + encodeURIComponent(id) + "/export";
        const response = await fetch(projectPath(url), { cache: "no-store", signal });
        if (!response.ok) {
          const error = await response.json().catch(() => null);
          throw new Error(error?.error ?? "HTTP " + response.status);
        }
        const blob = await response.blob();
        const link = element("a");
        link.href = URL.createObjectURL(blob);
        link.download = "engineering-" + id + ".json";
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 2000);
        setStatus(status, "工程工况记录已导出。");
      } catch (error) {
        if (!signal?.aborted) setStatus(status, "导出工程工况失败：" + error.message, true);
      } finally {
        state.busy = false;
        syncButtons();
      }
    }

    function clearForm() {
      state.current = null;
      form.reset();
      transportSelect.value = "";
      kineticsSelect.value = "";
      sourceSummary.replaceChildren(element("p", "请选择已有 MD 输运物性和/或动力学拟合结果。", "ca-muted"));
      renderCurrent(null);
      renderRecords();
      setStatus(status, "已准备新工程工况；请选择已有结果并确认工况窗口。");
      syncButtons();
    }

    transportSelect.addEventListener("change", () => void loadSourceSelection());
    kineticsSelect.addEventListener("change", () => void loadSourceSelection());
    form.addEventListener("submit", saveRecord);
    exportButton.addEventListener("click", () => void exportRecord());
    refreshSourcesButton.addEventListener("click", () => void refreshAll());
    refreshRecordsButton.addEventListener("click", () => void refreshRecords().catch(error =>
      setStatus(status, error.status === 404 ? "工程工况 API 尚未启用。" : error.message, error.status !== 404)));
    newButton.addEventListener("click", clearForm);
    panel.addEventListener("toggle", () => { if (panel.open) void refreshAll(); }, { signal });
    if (panel.open) void refreshAll();
    syncButtons();
  }


  function mountAgentKinetics(find, panel, request, signal, openRun) {
    const root = find("#agent-kinetics-workbench");
    if (!root) return;
    const form = find("#agent-kinetics-form");
    const sourceRun = find("#agent-kinetics-source-run");
    const sourceArtifact = find("#agent-kinetics-source-artifact");
    const sheet = find("#agent-kinetics-sheet");
    const instruction = find("#agent-kinetics-instruction");
    const refresh = find("#agent-kinetics-refresh");
    const submit = find("#agent-kinetics-submit");
    const status = find("#agent-kinetics-status");
    const preview = find("#agent-kinetics-source-preview");
    const receipt = find("#agent-kinetics-receipt");
    const receiptSummary = find("#agent-kinetics-receipt-summary");
    const runDetails = find("#agent-kinetics-run-details");
    const jsonHeaders = { "Content-Type": "application/json" };
    const state = { runs: [], detail: null, artifactCount: 0, busy: false, version: 0 };

    const runId = run => run?.id ?? run?.run_id;
    const sourceArtifacts = run => (run?.artifacts ?? [])
      .filter(artifact => artifact.role === "source");
    const display = value => value == null || value === "" ? "未报告"
      : typeof value === "object" ? JSON.stringify(value) : String(value);
    const runLabel = run => [
      run?.filename ?? "未命名实验表",
      kindLabel[run?.kind] ?? run?.kind,
      originLabel[run?.origin] ?? run?.origin,
      run?.created_at,
      runId(run),
    ].filter(Boolean).join(" · ");

    function sync() {
      const ready = Boolean(sourceRun.value && sourceArtifact.value && instruction.value.trim());
      sourceRun.disabled = state.busy;
      sourceArtifact.disabled = state.busy || !state.artifactCount || !sourceRun.value;
      sheet.disabled = instruction.disabled = state.busy;
      refresh.disabled = state.busy;
      submit.disabled = state.busy || !ready;
    }

    function clearSourceSelection(message = "选择实验表后显示项目、文件名、工作表和可用原始文件。") {
      state.detail = null;
      state.artifactCount = 0;
      sourceArtifact.replaceChildren(new Option("先选择实验表", ""));
      sourceSheetReset();
      preview.replaceChildren(element("p", message, "ca-muted"));
    }

    function sourceSheetReset() {
      sheet.value = "";
    }

    function renderSourcePreview(run, artifacts) {
      const source = run?.source ?? {};
      const selectedSheet = run?.details?.sheet ?? source.sheet
        ?? (sheet.value.trim() || run?.input?.sheet);
      const rows = [
        ["项目", source.project_id ?? run?.project_id ?? "当前项目"],
        ["文件名", source.filename ?? run?.filename],
        ["来源 run", source.run_id ?? runId(run)],
        ["工作表", selectedSheet || "未指定（提交时由服务端读取默认工作表）"],
        ["原始表工件", artifacts.map(artifact => artifact.name ?? artifact.id).join("、") || "未报告"],
      ];
      preview.replaceChildren(element("h3", "当前实验表来源"), metrics(rows));
      if (artifacts.length) {
        const list = element("ul", null, "ca-artifacts");
        for (const artifact of artifacts) {
          const row = element("li", artifact.name ?? artifact.id ?? "未命名原始工件");
          row.append(element("small", artifact.id ?? "工件 ID 未报告"));
          list.append(row);
        }
        preview.append(element("h4", "可选原始表文件"), list);
      }
    }

    function populateSources(selected) {
      sourceRun.replaceChildren(new Option("选择已有实验表", ""), ...state.runs.map(run =>
        new Option(runLabel(run), runId(run) ?? "")));
      sourceRun.value = state.runs.some(run => runId(run) === selected) ? selected : "";
    }

    async function loadSourceDetail(id) {
      const version = ++state.version;
      state.busy = true;
      clearSourceSelection("正在读取所选实验表详情…");
      sync();
      if (!id) {
        state.busy = false;
        sync();
        return;
      }
      setStatus(status, "正在读取所选实验表详情…");
      try {
        const run = await request("/api/runs/" + encodeURIComponent(id));
        if (version !== state.version) return;
        state.detail = run;
        const artifacts = sourceArtifacts(run);
        state.artifactCount = artifacts.length;
        sourceArtifact.replaceChildren(
          new Option(artifacts.length ? "选择原始表文件" : "未找到原始表文件", ""),
          ...artifacts.map(artifact => new Option(
            (artifact.name ?? artifact.id ?? "未命名原始工件") + " · " + (artifact.id ?? "ID 未报告"),
            artifact.id ?? "",
          )),
        );
        if (artifacts.length === 1) sourceArtifact.value = artifacts[0].id ?? "";
        sheet.value = run?.details?.sheet ?? run?.source?.sheet ?? run?.input?.sheet ?? "";
        renderSourcePreview(run, artifacts);
        setStatus(status, artifacts.length
          ? "已读取来源表；请选择原始文件并确认指令。"
          : "所选运行没有 role=source 的原始表工件。", !artifacts.length);
      } catch (error) {
        if (version === state.version) {
          clearSourceSelection("来源详情读取失败，请刷新后重试。");
          setStatus(status, "读取实验表失败：" + error.message, true);
        }
      } finally {
        if (version === state.version) {
          state.busy = false;
          sync();
        }
      }
    }

    async function refreshSources() {
      const selected = sourceRun.value;
      const version = ++state.version;
      state.busy = true;
      sync();
      setStatus(status, "正在读取当前项目实验表…");
      try {
        const data = await request("/api/runs");
        if (version !== state.version) return;
        const runs = Array.isArray(data) ? data : (data?.runs ?? []);
        state.runs = runs.filter(run => run?.kind === "kinetics");
        populateSources(selected);
        if (sourceRun.value) {
          await loadSourceDetail(sourceRun.value);
        } else {
          clearSourceSelection();
          setStatus(status, state.runs.length
            ? "请选择当前项目实验表。"
            : "当前项目暂无可用实验表或既有动力学记录。", !state.runs.length);
        }
      } catch (error) {
        if (version === state.version) {
          state.runs = [];
          populateSources("");
          clearSourceSelection("实验表读取失败，请刷新后重试。");
          setStatus(status, "读取实验表失败：" + error.message, true);
        }
      } finally {
        if (version === state.version) {
          state.busy = false;
          sync();
        }
      }
    }

    function renderReceipt(record, requestBody) {
      const source = record.source ?? {};
      const summary = metrics([
        ["远端模型", record.model],
        ["拟合模型", record.fitting_model],
        ["指令", record.instruction ?? requestBody.instruction],
        ["项目", source.project_id],
        ["原表文件", source.filename],
        ["工作表", source.sheet],
        ["来源 run", source.run_id ?? requestBody.source_run_id],
        ["来源工件", source.artifact_id ?? requestBody.source_artifact_id],
        ["结果 run", record.run_id],
      ]);
      const sourceRunId = source.run_id ?? requestBody.source_run_id;
      const sourceArtifactId = source.artifact_id ?? requestBody.source_artifact_id;
      const sourceLink = element("div", null, "ca-agent-kinetics-source-link");
      if (sourceRunId && sourceArtifactId) {
        sourceLink.append(downloadLink(
          "/api/runs/" + encodeURIComponent(sourceRunId) + "/artifacts/"
            + encodeURIComponent(sourceArtifactId),
          "下载项目原表"));
      } else {
        sourceLink.append(element("span", "项目原表链接未报告。", "ca-muted"));
      }
      const open = element("button", "在运行历史中打开详情");
      open.type = "button";
      open.addEventListener("click", () => openRun?.(record.run_id, "kinetics", open));
      receiptSummary.replaceChildren(summary, sourceLink, open, details("服务回执 JSON", record));
    }

    async function renderReturnedRun(record) {
      const returned = record?.result;
      if (returned && typeof returned === "object"
          && (returned.kind || returned.result || returned.id || returned.run_id)) {
        const run = {
          ...returned,
          id: returned.id ?? returned.run_id ?? record.run_id,
          kind: returned.kind ?? "kinetics",
          filename: returned.filename ?? record.source?.filename,
        };
        renderRun(run, runDetails);
        runDetails.hidden = false;
        return true;
      }
      if (!record?.run_id) return false;
      try {
        const run = await request("/api/runs/" + encodeURIComponent(record.run_id));
        renderRun(run, runDetails);
        runDetails.hidden = false;
        return true;
      } catch {
        runDetails.hidden = true;
        return false;
      }
    }

    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (submit.disabled) return;
      const requestBody = {
        instruction: instruction.value.trim(),
        source_run_id: sourceRun.value,
        source_artifact_id: sourceArtifact.value,
      };
      const sheetValue = sheet.value.trim();
      if (sheetValue) requestBody.sheet = sheetValue;
      state.busy = true;
      receipt.hidden = true;
      runDetails.hidden = true;
      sync();
      setStatus(status, "正在提交指令，由服务端识别模型并调用项目拟合…");
      try {
        const record = await request("/api/agent/kinetics", JSON.stringify(requestBody),
          undefined, jsonHeaders);
        if (!record || typeof record !== "object" || !record.run_id) {
          throw new Error("服务未返回有效的动力学 run_id。");
        }
        renderReceipt(record, requestBody);
        receipt.hidden = false;
        const rendered = await renderReturnedRun(record);
        setStatus(status, rendered
          ? "已读取拟合运行详情；模型参数和单位来自该运行结果。"
          : "任务已创建（" + record.run_id + "），详情暂不可读，可稍后从运行历史打开。");
      } catch (error) {
        receipt.hidden = false;
        setStatus(status, "动力学拟合请求失败：" + error.message, true);
      } finally {
        state.busy = false;
        sync();
      }
    });

    sourceRun.addEventListener("change", () => void loadSourceDetail(sourceRun.value));
    sourceArtifact.addEventListener("change", () => {
      const run = state.detail;
      if (run) renderSourcePreview(run, sourceArtifacts(run));
      sync();
    });
    instruction.addEventListener("input", sync);
    refresh.addEventListener("click", () => void refreshSources());
    panel.addEventListener("toggle", () => { if (panel.open) void refreshSources(); }, { signal });
    if (panel.open) void refreshSources();
    sync();
  }

  function mountWorkspace(panel, workbench, request, signal) {
    const find = selector => workbench.querySelector(selector);
    const handoff = find("#md-handoff-form");
    const handoffSubmit = find("#md-handoff-submit");
    const handoffStatus = find("#md-handoff-status");
    handoff.addEventListener("submit", async event => {
      event.preventDefault();
      handoffSubmit.disabled = true;
      setStatus(handoffStatus, "正在转换结构…");
      try {
        await exportZip("/api/md-handoff", new FormData(handoff), signal, "vasp-to-lammps.zip");
        setStatus(handoffStatus, "已生成 LAMMPS 结构包。");
      } catch (error) {
        if (!signal?.aborted) setStatus(handoffStatus, error.message, true);
      } finally {
        handoffSubmit.disabled = false;
      }
    });
    let updateMdPlans = () => {};
    const { refreshPlans, selectPlan } = mountPlans(find, panel, request, signal, data => updateMdPlans(data));
    updateMdPlans = mountMdJob(find, panel, request, signal, selectPlan, refreshPlans);
    const form = find("#analysis-form");
    const fields = form.elements;
    const results = find("#analysis-results");
    const status = find("#analysis-status");
    const upload = find("#analysis-upload");
    const reference = find("#analysis-reference");
    const advanced = find("#analysis-options");
    const line = find("#analysis-equipment-line");
    const lineEnabled = find("#analysis-equipment-line-enabled");
    const lineFields = find("#analysis-equipment-line-fields");
    const drafts = new Map();
    let activeKind = fields.kind.value;
    let transportMode = fields.transport_mode.value;
    const transportDrafts = new Map();
    let viewVersion = 0;
    let manifestVersion = 0;

    function syncModel() {
      const model = fields.model.value;
      const current = fields.response_unit.value;
      const supported = units[model].flatMap(unit => ["s", "min", "h"].flatMap(time => {
        const spelling = unit.replace("s", time);
        return spelling.startsWith("mol/") ? [spelling, `m${spelling}`] : [spelling];
      }));
      fields.response_unit.replaceChildren(...supported.map(unit => new Option(unit, unit)));
      if (supported.includes(current)) fields.response_unit.value = current;
      find("#analysis-reactants").hidden = fields.max_conversion_fraction.disabled = model !== "initial_rate_power_law";
    }

    function syncTransport() {
      const selected = fields.transport_mode.value;
      if (transportMode !== selected) {
        const keys = ["field_column", "field_unit", "flux_column", "flux_unit"];
        transportDrafts.set(transportMode, keys.map(key => fields["transport_" + key].value));
        keys.forEach((key, index) => {
          fields["transport_" + key].value = transportDrafts.get(selected)?.[index] ?? "";
        });
        transportMode = selected;
      }
      const mode = transportModes[selected];
      const viscosity = selected === "viscosity";
      find("#analysis-transport-field-label").textContent = mode.field + "列";
      find("#analysis-transport-field-unit-label").textContent = mode.field + "单位";
      find("#analysis-transport-flux-label").textContent = mode.flux + "列";
      find("#analysis-transport-flux-unit-label").textContent = mode.flux + "单位";
      find("#analysis-transport-stress").hidden = fields.transport_stress_convention.disabled = !viscosity;
      find("#analysis-transport-hint").textContent = viscosity
        ? "位置坐标沿速度梯度方向。选择与流向和梯度方向相符的剪切分量，输入已按单位面积归一的应力或动量通量。"
        : "位置坐标与带符号通量须使用同一正方向。上传已按单位面积归一的通量。";
      for (const key of ["position", "field", "flux", "time"]) {
        const examples = transportUnitExamples[key] ?? transportUnitExamples[selected][key];
        find("#analysis-transport-units-" + key).replaceChildren(...examples.map(value => new Option(value, value)));
      }
      syncTransportTime();
    }

    function syncTransportTime() {
      const hasTime = !!fields.transport_time_column.value.trim();
      fields.transport_time_unit.required = hasTime;
      fields.transport_time_unit.disabled = !hasTime;
      for (const key of ["time_min", "time_max"]) fields["transport_" + key].disabled = !hasTime;
    }

    function syncKind() {
      const kind = fields.kind.value;
      const kinetics = kind === "kinetics";
      const raw = rawKind(kind);
      const mdAnalysis = ["md_thermo", "md_msd"].includes(kind);
      const transport = find("#analysis-transport");
      transport.hidden = transport.disabled = kind !== "md_transport";
      find("#analysis-advanced").hidden = !transport.hidden;
      if (!transport.hidden) syncTransport();
      find("#analysis-md-analysis").hidden = find("#analysis-md-analysis").disabled = !mdAnalysis;
      find("#analysis-msd-config").hidden = find("#analysis-msd-config").disabled = kind !== "md_msd";
      if (activeKind !== kind) {
        drafts.set(activeKind, {
          options: advanced.value, lengthUnit: fields.length_unit.value, reference: reference.files[0],
        });
        const draft = drafts.get(kind);
        advanced.value = draft?.options ?? "";
        fields.length_unit.value = draft?.lengthUnit ?? "";
        const files = new DataTransfer();
        if (draft?.reference) files.items.add(draft.reference);
        reference.files = files.files;
        activeKind = kind;
      }
      const section = find("#analysis-kinetics");
      section.hidden = section.disabled = !kinetics;
      const vasp = find("#analysis-vasp");
      vasp.hidden = vasp.disabled = kind !== "adsorption";
      const rawSection = find("#analysis-a5");
      rawSection.hidden = rawSection.disabled = !raw;
      upload.accept = { md_transport: ".csv,.xlsx,.txt,.dat,.profile,.chunk,.ave,.out", md_thermo: ".log,.lammps,.jsonl,.txt", md_msd: ".lammpstrj,.dump,.lammpsdump,.traj,.txt", adsorption: ".zip", kinetics: ".csv,.xlsx", md: ".lammpstrj,.dump,.lammpsdump,.lammps,.traj,.txt", equipment: ".vtu" }[kind];
      upload.required = kind !== "md_transport";
      find("#analysis-file-hint").textContent = {
        md_transport: "可上传单文件 CSV/profile 走现有分析；也可只填授权 plan/job ID，由服务端直接读取该计划的 native profile/global/velocity 工件。手动成对文件仅作未核验来源保存。",
        md_thermo: "上传原始 log.lammps 或 thermo.jsonl；按原始采样点绘图，可切换输出列。",
        md_msd: "上传含展开坐标或坐标及镜像标记的 LAMMPS 轨迹。",
        adsorption: "上传含 study.json 和 vasprun.xml 的 VASP ZIP。",
        kinetics: "支持 CSV 或 XLSX。",
        md: "上传 LAMMPS 文本轨迹（如 .lammpstrj 或 .dump）。",
        equipment: "上传 VTK XML 非结构网格文件（.vtu）。",
      }[kind];
      find("#analysis-a5-hint").textContent = kind === "md"
        ? "长度单位留空时读取轨迹的 ITEM: UNITS。可在高级配置填写 dt、time_unit、step_origin 和 time_origin。"
        : "长度和字段单位可读取 VTU 的 Unit / Units。原文件缺少字段单位时，可在高级配置按 point / cell 填写 field_units。上传参考后默认按参考定义采样，高级配置 profiles 可指定多条剖面。";
      advanced.placeholder = {
        kinetics: '{"acceptance":{"max_train_log_rmse":0.2,"max_holdout_log_rmse":0.3}}',
        adsorption: '{"cell_limits_A":[50,50,50]}',
      }[kind] ?? "";
      syncLine();
      syncSheet();
    }

    function syncLine() {
      let advancedProfiles = false;
      if (fields.kind.value === "equipment" && advanced.value.trim()) {
        try {
          advancedProfiles = Object.hasOwn(jsonObject(advanced.value, "高级配置"), "profiles");
        } catch {
          // Invalid JSON is reported on submit.
        }
      }
      line.hidden = line.disabled = fields.kind.value !== "equipment" || !!reference.files[0] || advancedProfiles;
      lineFields.hidden = lineFields.disabled = line.disabled || !lineEnabled.checked;
      const component = fields.line_selection.value === "component";
      find("#analysis-line-component-label").hidden = fields.line_component.disabled = !component;
    }

    function syncSheet() {
      const xlsx = /\.xlsx$/i.test(upload.files[0]?.name ?? "");
      fields.sheet.disabled = !xlsx;
      find("#analysis-transport-sheet").hidden = fields.transport_sheet.disabled = !xlsx;
    }

    function jsonObject(value, label, reviver) {
      let parsed;
      try {
        parsed = JSON.parse(value, reviver);
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error(`${label}必须是有效的 JSON 对象。`);
        throw error;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${label}必须是 JSON 对象。`);
      }
      return parsed;
    }

    function transportOptions() {
      const mode = fields.transport_mode.value;
      const result = { mode, columns: {}, units: {} };
      for (const key of ["position", "field", "flux", "time"]) {
        const column = fields["transport_" + key + "_column"].value.trim();
        const unit = fields["transport_" + key + "_unit"].value.trim();
        if (key === "time" && !column) continue;
        if (!column || !unit) throw new Error("请同时填写对应的列名与单位。");
        result.columns[key] = column;
        result.units[key] = unit;
      }
      if (mode === "viscosity") result.stress_convention = fields.transport_stress_convention.value;
      if (fields.transport_driving.value !== "unspecified") result.driving = fields.transport_driving.value;
      const sheet = fields.transport_sheet.value.trim();
      if (!fields.transport_sheet.disabled && sheet) result.sheet = sheet;
      for (const key of ["position_min", "position_max", "time_min", "time_max", "bin_width"]) {
        const field = fields["transport_" + key];
        if (!field.disabled && field.value) result[key] = field.valueAsNumber;
      }
      for (const axis of ["position", "time"]) {
        if (result[axis + "_min"] > result[axis + "_max"]) {
          throw new Error("窗口下限不能大于上限。");
        }
      }
      if (result.bin_width === 0) throw new Error("空间分箱宽度须为正数。");
      const job = fields.transport_source_job_id.value.trim();
      if (job) result.source_job_id = job;
      const plan = fields.transport_source_plan_id.value.trim();
      if (plan) result.source_plan_id = plan;
      return result;
    }

    function runOptions() {
      if (fields.kind.value === "md_transport") return transportOptions();
      const extra = advanced.value.trim();
      const options = {};
      if (fields.kind.value === "adsorption") {
        options.cell_limits_A = ["a", "b", "c"].map(axis => fields[`vasp_limit_${axis}`].valueAsNumber);
      } else if (fields.kind.value === "kinetics") {
        for (const key of ["model", "response_unit", "temperature_unit", "sheet", "batch_id"]) {
          if (!fields[key].disabled && fields[key].value.trim()) options[key] = fields[key].value;
        }
        const columns = {};
        const power = options.model === "initial_rate_power_law";
        for (const key of columnKeys) {
          const column = fields[`column_${key}`].value;
          if (column.trim() && (power || key !== "conversion_fraction")) columns[key] = column;
        }
        if (power) {
          const concentrations = fields.concentration_columns.value.trim();
          if (concentrations) columns.concentrations = jsonObject(concentrations, "浓度列配置");
          options.concentration_unit = fields.concentration_unit.value;
          options.conversion_unit = fields.conversion_unit.value;
          if (fields.max_conversion_fraction.value) {
            options.max_conversion_fraction = fields.max_conversion_fraction.valueAsNumber;
          }
        }
        if (Object.keys(columns).length) options.columns = columns;
      } else if (["md_thermo", "md_msd"].includes(fields.kind.value)) {
        if (fields.md_unit_style.value) options.unit_style = fields.md_unit_style.value;
        if (fields.md_timestep_ps.value) options.timestep_ps = fields.md_timestep_ps.valueAsNumber;
        if (fields.md_source_job_id.value.trim()) options.source_job_id = fields.md_source_job_id.value.trim();
        if (fields.kind.value === "md_msd") {
          for (const key of ["atom_ids", "atom_types"]) {
            const value = fields["md_" + key].value.trim();
            if (value) options[key] = value.split(/[,，\s]+/).map(v => {
              if (!/^\d+$/.test(v)) throw new Error("原子 ID 和类型须为整数，使用逗号分隔。");
              return v;
            });
          }
          options.axes = fields.md_axes.value;
          options.remove_drift = fields.md_remove_drift.value === "true";
          for (const key of ["fit_start_ps", "fit_end_ps"]) {
            if (fields["md_" + key].value) options[key] = fields["md_" + key].valueAsNumber;
          }
        }
      } else if (fields.length_unit.value.trim()) {
        options.length_unit = fields.length_unit.value.trim();
      }
      const preserveStepOrigin = (key, value, context) => {
        if (key !== "step_origin" || typeof value !== "number" || Number.isSafeInteger(value)) return value;
        const exact = preserveIdentifier(key, value, context);
        if (typeof exact === "string" && typeof JSON.rawJSON === "function") return JSON.rawJSON(exact);
        throw new Error("step_origin 需要精确整数。当前浏览器无法原样提交该值。");
      };
      const config = extra ? jsonObject(extra, "高级配置", fields.kind.value === "md" ? preserveStepOrigin : undefined) : {};
      const merged = { ...options, ...config };
      if (!lineFields.disabled && !Object.hasOwn(config, "profiles")) {
        const association = fields.line_association.value;
        const name = fields.line_field.value.trim();
        if (!name) throw new Error("请填写线剖面的字段名称。");
        const kind = fields.line_selection.value;
        const coordinates = end => ["x", "y", "z"].map(axis => fields[`line_${end}_${axis}`].valueAsNumber);
        merged.profiles = [{
          a: coordinates("a"), b: coordinates("b"),
          field: { association, name, selection: kind === "component" ? { kind, index: fields.line_component.valueAsNumber } : { kind } },
          count: fields.line_count.valueAsNumber,
        }];
        const unit = fields.line_unit.value.trim();
        if (unit) {
          const fieldUnits = config.field_units ?? {};
          merged.field_units = { ...fieldUnits, [association]: { [name]: unit, ...fieldUnits[association] } };
        }
      }
      return merged;
    }

    async function openRun(id, kind, button) {
      const version = ++viewVersion;
      results.setAttribute("aria-busy", "true");
      setStatus(status, "正在读取历史运行…");
      try {
        const run = await request(`/api/runs/${encodeURIComponent(id)}`, undefined, kind);
        if (version !== viewVersion) return;
        renderRun(run, results);
        results.hidden = false;
        results.scrollIntoView({ block: "nearest" });
        button.closest("ul")?.querySelector("[aria-current]")?.removeAttribute("aria-current");
        button.setAttribute("aria-current", "true");
        setStatus(status, "已载入历史运行。");
      } catch (error) {
        if (version === viewVersion) setStatus(status, `读取运行失败：${error.message}`, true);
      } finally {
        if (version === viewVersion) results.setAttribute("aria-busy", "false");
      }
    }

    mountEngineering(find, panel, request, signal, workbench.dataset.role, openRun);
    mountAgentKinetics(find, panel, request, signal, openRun);
    async function loadHistory() {
      const version = ++manifestVersion;
      const message = find("#analysis-history-status");
      const list = find("#analysis-history-list");
      setStatus(message, "正在读取运行历史…");
      try {
        const { runs } = await request("/api/runs");
        if (version !== manifestVersion) return;
        list.replaceChildren();
        for (const run of runs) {
          const row = element("li");
          const button = element("button", `${kindLabel[run.kind] ?? run.kind} · ${run.filename}`);
          button.type = "button";
          button.dataset.runId = run.id;
          button.append(element("small", `${originLabel[run.origin] ?? run.origin} · ${run.created_at}`));
          button.addEventListener("click", () => openRun(run.id, run.kind, button));
          row.append(button);
          list.append(row);
        }
        setStatus(message, runs.length ? "" : "暂无运行记录。");
      } catch (error) {
        if (version === manifestVersion) setStatus(message, `读取历史失败：${error.message}`, true);
      }
    }

    fields.model.addEventListener("change", syncModel);
    fields.kind.addEventListener("change", syncKind);
    reference.addEventListener("change", syncLine);
    advanced.addEventListener("input", syncLine);
    lineEnabled.addEventListener("change", syncLine);
    fields.line_selection.addEventListener("change", syncLine);
    upload.addEventListener("change", syncSheet);
    syncModel();
    syncKind();
    panel.addEventListener("toggle", () => { if (panel.open) void loadHistory(); }, { signal });
    find("#analysis-refresh").addEventListener("click", loadHistory);
    if (panel.open) void loadHistory();
    fields.transport_mode.addEventListener("change", syncTransport);
    fields.transport_time_column.addEventListener("input", syncTransportTime);
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const submit = find("#analysis-submit");
      if (submit.disabled) return;
      if (!form.reportValidity()) return;
      let options;
      try {
        options = runOptions();
        if (fields.kind.value === "md_transport") {
          const sidecars = ["#analysis-transport-profile", "#analysis-transport-global",
            "#analysis-transport-metadata", "#analysis-transport-provenance", "#analysis-transport-velocity"];
          const paired = sidecars.some(selector => find(selector).files.length);
          const plan = fields.transport_source_plan_id.value.trim();
          const job = fields.transport_source_job_id.value.trim();
          if (!upload.files[0] && (!plan || !job)) {
            throw new Error("单文件导入需选择主文件；自动计划采集需同时填写 plan ID 和 job ID。" );
          }
          if (paired && !find("#analysis-transport-metadata").files[0]) {
            throw new Error("手动成对输运文件需要上传 transport metadata；自动计划采集无需手动元数据。" );
          }
        }
      } catch (error) {
        setStatus(status, error.message, true);
        return;
      }
      const body = new FormData();
      if (upload.files[0]) body.set("file", upload.files[0]);
      body.set("kind", fields.kind.value);
      body.set("origin", fields.origin.value);
      body.set("options", JSON.stringify(options));
      if (fields.kind.value === "md_transport") {
        for (const [selector, key] of [["#analysis-transport-profile", "transport_profile"],
                                        ["#analysis-transport-global", "transport_global"],
                                        ["#analysis-transport-metadata", "transport_metadata"],
                                        ["#analysis-transport-provenance", "transport_provenance"],
                                        ["#analysis-transport-velocity", "transport_velocity"]]) {
          const file = find(selector).files[0];
          if (file) body.set(key, file);
        }
        const plan = fields.transport_source_plan_id.value.trim();
        const job = fields.transport_source_job_id.value.trim();
        if (plan) body.set("transport_plan_id", plan);
        if (job) body.set("transport_job_id", job);
      } else if (rawKind(fields.kind.value) && reference.files[0]) {
        body.set("reference", reference.files[0]);
      }
      const version = ++viewVersion;
      submit.disabled = true;
      results.replaceChildren();
      results.hidden = true;
      results.setAttribute("aria-busy", "true");
      setStatus(status, `正在分析${originLabel[fields.origin.value]}…`);
      try {
        const run = await request("/api/runs", body, body.get("kind"));
        if (version === viewVersion) {
          renderRun(run, results);
          results.hidden = false;
          find("#analysis-history-list [aria-current]")?.removeAttribute("aria-current");
          setStatus(status, "分析完成。");
        }
        void loadHistory();
        void refreshPlans();
      } catch (error) {
        if (version === viewVersion) setStatus(status, `分析失败：${error.message}`, true);
      } finally {
        submit.disabled = false;
        if (version === viewVersion) results.setAttribute("aria-busy", "false");
      }
    });

    const cellForm = find("#cell-form");
    const cellMode = find("#cell-mode");
    const cellSubmit = find("#cell-submit");
    cellMode.addEventListener("change", () => {
      cellSubmit.textContent = cellMode.value === "construct" ? "检查并构建晶胞" : "检查晶胞";
    });
    cellForm.addEventListener("submit", async event => {
      event.preventDefault();
      if (cellSubmit.disabled) return;
      const message = find("#cell-status");
      const output = find("#cell-results");
      const axes = ["a", "b", "c"];
      const values = new FormData(cellForm);
      const options = {
        repeats: axes.map(axis => Number(values.get(`repeat_${axis}`))),
        limits_A: Object.fromEntries(axes.map(axis => [axis, Number(values.get(`limit_${axis}`))])),
      };
      if (Object.values(options.limits_A).some(limit => !(limit > 0 && limit <= 50))) {
        setStatus(message, "各轴上限须大于 0 Å 且不超过 50 Å。", true);
        return;
      }
      const vacuum = values.get("vacuum_A");
      if (vacuum !== "") {
        options.vacuum_A = Number(vacuum);
        if (!(options.vacuum_A > 0) || options.repeats[2] !== 1) {
          setStatus(message, "替换真空需要正的厚度，并且 c 轴复制倍数须为 1。", true);
          return;
        }
      }
      const construct = cellMode.value === "construct";
      const body = new FormData();
      body.set("file", values.get("file"));
      body.set("options", JSON.stringify(options));
      cellSubmit.disabled = true;
      if (cellForm.dataset.poscarUrl) {
        URL.revokeObjectURL(cellForm.dataset.poscarUrl);
        delete cellForm.dataset.poscarUrl;
      }
      output.replaceChildren();
      output.hidden = true;
      setStatus(message, "正在检查晶胞…");
      try {
        const plan = await request("/api/cell", body);
        output.append(metrics(axes.map((axis, index) => [
          `${axis} 轴长度 / 上限`, `${plan.lengths_A[axis] ?? plan.lengths_A[index]} / ${plan.limits_A[axis] ?? plan.limits_A[index]} Å`,
        ])));
        if (!plan.within_limit) {
          setStatus(message, `晶胞超限：${plan.exceeded_axes.join("、")}。请调整复制倍数或真空设置。`, true);
        } else if (construct && typeof plan.poscar === "string" && plan.poscar.trim()) {
          const link = element("a", "下载 POSCAR");
          const url = URL.createObjectURL(new Blob([plan.poscar], { type: "text/plain;charset=utf-8" }));
          link.href = url;
          link.download = "POSCAR";
          cellForm.dataset.poscarUrl = url;
          output.append(link);
          setStatus(message, "晶胞尺寸符合上限，POSCAR 已生成。");
        } else {
          setStatus(message, construct ? "尺寸符合上限，服务未返回 POSCAR。" : "晶胞尺寸符合上限。", construct);
        }
        output.hidden = false;
      } catch (error) {
        setStatus(message, `晶胞检查失败：${error.message}`, true);
      } finally {
        cellSubmit.disabled = false;
      }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
})();
