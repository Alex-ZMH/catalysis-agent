(() => {
  "use strict";

  const kindLabel = { adsorption: "VASP 吸附能", kinetics: "动力学拟合", md: "LAMMPS 轨迹", equipment: "VTU 场与线剖面" };
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
    if (rawKind(run.kind)) {
      const science = element("div", null, "ca-a5-result");
      science.id = `analysis-${run.kind}-result`;
      const compared = run.kind === "md"
        ? (run.details?.frame_checks ?? []).some(check => Number.isFinite(check.max_abs_error))
        : (result.line_profiles ?? []).some(profile => profile.reference);
      const referenceNote = run.details?.reference_comparison;
      const comparison = element("p", referenceNote?.error || run.details?.reference_error
        || (compared ? "已与独立参考比较" : "已读取原始输出"), "ca-origin");
      comparison.id = "analysis-a5-comparison";
      science.append(comparison);
      if (run.kind === "md") renderMD(run, science);
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
      const label = artifact.id === run.raw_id ? "原始上传"
        : artifact.id === run.reference_id ? "独立参考证据" : translate(artifact.role);
      if (artifact.id === run.reference_id) row.id = "analysis-a5-reference-artifact";
      row.append(
        downloadLink(artifact.url, artifact.name ?? artifact.id),
        element("small", `${label} · ${artifact.size_bytes} 字节 · ${artifact.id}`),
        element("code", `SHA-256 ${artifact.sha256}`),
      );
      if (artifact.parents?.length) row.append(element("small", `上游工件：${artifact.parents.join("、")}`));
      artifacts.append(row);
    }
    if (artifacts.childElementCount) target.append(artifacts);
  }


  function mountPlans(find, panel, request, signal) {
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
      const schedulerUnavailable = record?.spec.mode === "slurm-synthetic" && !syntheticSubmission;
      for (const button of [confirm, retry, reconcile]) button.disabled = !!recovery || busy || !ready || schedulerUnavailable;
      if (!record) return;
      const spec = record.spec;
      find("#a6-spec").replaceChildren(metrics([
        ["计划编号", record.id], ["计划摘要", record.digest], ["源运行", spec.run_id],
        ["来源", originLabel[spec.origin] ?? spec.origin], ["源文件", spec.source_name ?? runs.get(spec.run_id)?.filename],
        ["流程", spec.workflow],
        ["CPU / GPU / 分钟", `${spec.cpus} / ${spec.gpus} / ${spec.minutes}`],
      ]));
      confirm.textContent = spec.mode === "slurm-synthetic" ? "确认并提交合成作业" : "确认计划";
      const mode = spec.mode === "slurm-synthetic"
        ? (syntheticSubmission && spec.origin === "synthetic" ? "人工确认后由 Slurm 调度合成 V100 作业" : "当前服务未启用此计划的合成作业提交")
        : "仅记录计划";
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

    function updatePlans(data) {
      syntheticSubmission = data.synthetic_submission === true;
      recovery = data.recovery ?? null;
      receiptPlans = new Set(data.receipt_plan_ids ?? []);
      records = new Map(data.plans.map(record => [record.id, record]));
      renderPlans(plans.value);
      ready = true;
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
      records.set(record.id, record);
      renderPlans(record.id);
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
    return refreshPlans;
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
            <option value="md">LAMMPS 轨迹</option><option value="equipment">VTU 场与线剖面</option>
          </select></label>
          <label>数据来源<select id="analysis-origin" name="origin">
            <option value="synthetic" selected>合成数据</option><option value="research">研究数据</option>
          </select></label>
        </div>
        <label>上传文件<input id="analysis-upload" name="file" type="file" required></label>
        <p id="analysis-file-hint" class="ca-muted"></p>
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
        <summary>LAMMPS 作业配置</summary>
        <form id="md-job-form">
          <p id="md-job-source" class="ca-muted">上传结构，或从 VASP 结果选择结构。</p>
          <label>独立结构<input id="md-job-file" type="file"></label>
          <label>作业配置 JSON<textarea id="md-job-config" rows="9" required></textarea></label>
          <label>EAM 势函数文件<input id="md-job-potential" type="file"></label>
          <p class="ca-muted">支持显式 LJ 参数和 EAM/alloy 文件。输入步长、温度、系综与三轴边界，下载作业包后在 V100 运行。</p>
          <a href="/guide/md-job" target="_blank" rel="noopener">配置字段与运行命令</a>
          <button id="md-job-submit" class="ca-primary" type="submit">生成 LAMMPS 作业包</button>
          <p id="md-job-status" role="status"></p>
        </form>
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
    find("#md-handoff").hidden = find("#md-job").hidden = allowed.get(project) === "viewer";
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

  function mountMdJob(find, signal) {
    const section = find("#md-job");
    const form = find("#md-job-form");
    const file = find("#md-job-file");
    const status = find("#md-job-status");
    const source = find("#md-job-source");
    let selected;
    find("#analysis-results").addEventListener("click", event => {
      const button = event.target.closest("button[data-md-run]");
      if (!button || section.hidden) return;
      selected = { run_id: button.dataset.mdRun, artifact_id: button.dataset.mdArtifact };
      file.value = "";
      source.textContent = button.dataset.mdLabel;
      section.open = true;
      section.scrollIntoView({ block: "start" });
      find("#md-job-config").focus({ preventScroll: true });
    });
    file.addEventListener("change", () => {
      if (file.files[0]) {
        selected = undefined;
        source.textContent = file.files[0].name;
      }
    });
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const submit = find("#md-job-submit");
      submit.disabled = true;
      setStatus(status, "正在生成 LAMMPS 作业包…");
      try {
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
        body.set("options", find("#md-job-config").value);
        await exportZip("/api/md-job", body, signal, "lammps-md-job.zip");
        setStatus(status, "已生成 LAMMPS 作业包。");
      } catch (error) {
        if (!signal?.aborted) setStatus(status, error.message, true);
      } finally {
        submit.disabled = false;
      }
    });
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
    mountMdJob(find, signal);
    const refreshPlans = mountPlans(find, panel, request, signal);
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

    function syncKind() {
      const kind = fields.kind.value;
      const kinetics = kind === "kinetics";
      const raw = rawKind(kind);
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
      upload.accept = { adsorption: ".zip", kinetics: ".csv,.xlsx", md: ".lammpstrj,.dump,.lammpsdump,.lammps,.traj,.txt", equipment: ".vtu" }[kind];
      find("#analysis-file-hint").textContent = {
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
      fields.sheet.disabled = !/\.xlsx$/i.test(upload.files[0]?.name ?? "");
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

    function runOptions() {
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
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const submit = find("#analysis-submit");
      if (submit.disabled) return;
      let options;
      try {
        options = runOptions();
      } catch (error) {
        setStatus(status, error.message, true);
        return;
      }
      const body = new FormData();
      body.set("file", upload.files[0]);
      body.set("kind", fields.kind.value);
      body.set("origin", fields.origin.value);
      body.set("options", JSON.stringify(options));
      if (rawKind(fields.kind.value) && reference.files[0]) body.set("reference", reference.files[0]);
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
