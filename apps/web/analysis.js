(() => {
  "use strict";

  const kindLabel = { adsorption: "VASP 吸附能", kinetics: "动力学拟合" };
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

  function downloadLink(url, label) {
    const link = element("a", label);
    try {
      if (!url) return link;
      const target = new URL(url, location.href);
      if (target.origin === location.origin && /^https?:$/.test(target.protocol)) {
        link.href = target.href;
        link.download = "";
      }
    } catch {
      // Malformed artifact URLs remain plain text.
    }
    return link;
  }

  async function request(path, body) {
    const response = await fetch(path, body ? { method: "POST", body } : {});
    const data = await response.json().catch(() => null);
    if (!response.ok || !data) {
      throw new Error(data?.error || `服务返回异常响应（HTTP ${response.status}）`);
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

  function renderAdsorption(run, target) {
    const details = run.details ?? {};
    const structures = new Map();
    for (const structure of details.runs ?? []) {
      for (const key of [structure.structure_id, structure.logical_id, structure.blob_id]) {
        if (key) structures.set(key, structure);
      }
    }
    const configurations = run.result?.results ?? [];
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
      const description = item.status === "comparable"
        ? `${item.adsorption_energy} ${item.unit ?? "eV"} / 吸附物`
        : (item.reasons ?? []).map(translate).join("、");
      const row = element("li", `${label} · ${translate(item.status)} · ${description}`);
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
    if (run.quality) target.append(element("p", `质量状态：${translate(run.quality)}`));
    if (run.quality_flags?.length) target.append(element("p", run.quality_flags.map(translate).join("、"), "ca-warning"));
    if (run.kind === "adsorption") renderAdsorption(run, target);
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
    target.append(details("完整科学结果", result), details("规范化输入与分析详情", { input: run.input, details: run.details }));
    target.append(element("h4", "来源与下载"));
    if (run.manifest_url) target.append(downloadLink(run.manifest_url, "下载运行清单"));
    const artifacts = element("ul", null, "ca-artifacts");
    for (const artifact of run.artifacts ?? []) {
      const row = element("li");
      row.append(
        downloadLink(artifact.url, artifact.name ?? artifact.id),
        element("small", `${artifact.id === run.raw_id ? "原始上传" : translate(artifact.role)} · ${artifact.size_bytes} 字节 · ${artifact.id}`),
        element("code", `SHA-256 ${artifact.sha256}`),
      );
      if (artifact.parents?.length) row.append(element("small", `上游工件：${artifact.parents.join("、")}`));
      artifacts.append(row);
    }
    if (artifacts.childElementCount) target.append(artifacts);
  }

  function mount() {
    const content = document.querySelector("#studio .wb-content");
    if (!content || document.querySelector("#analysis-panel")) return;
    const panel = element("details", null, "ca-panel");
    panel.id = "analysis-panel";
    // Only static interface markup is assigned here. API data is rendered as text.
    panel.innerHTML = `
      <summary id="analysis-panel-toggle">科学分析与晶胞工具</summary>
      <nav class="ca-guides" aria-label="科学分析指南">
        <a href="/guide/vasp" target="_blank" rel="noopener">VASP 吸附指南</a>
        <a href="/guide/kinetics" target="_blank" rel="noopener">动力学指南</a>
        <a href="/guide/cell" target="_blank" rel="noopener">晶胞指南</a>
      </nav>
      <form id="analysis-form">
        <h2>上传分析数据</h2>
        <div class="ca-grid">
          <label>分析类型<select id="analysis-kind" name="kind">
            <option value="adsorption">VASP 吸附能</option><option value="kinetics">动力学拟合</option>
          </select></label>
          <label>数据来源<select id="analysis-origin" name="origin">
            <option value="synthetic" selected>合成数据</option><option value="research">研究数据</option>
          </select></label>
        </div>
        <label>上传文件<input id="analysis-upload" name="file" type="file" required></label>
        <p id="analysis-file-hint" class="ca-muted"></p>
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
        <details>
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
      </details>`;
    content.append(panel);

    const find = selector => panel.querySelector(selector);
    const header = content.closest(".wb-main").querySelector(".wb-header");
    if (header) {
      const nav = element("button", "科学分析");
      nav.id = "analysis-nav";
      nav.type = "button";
      nav.setAttribute("aria-controls", panel.id);
      nav.setAttribute("aria-expanded", "false");
      nav.addEventListener("click", () => {
        panel.open = true;
        find("#analysis-panel-toggle").focus({ preventScroll: true });
        panel.scrollIntoView({ block: "start" });
      });
      panel.addEventListener("toggle", () => nav.setAttribute("aria-expanded", String(panel.open)));
      header.append(nav);
    }
    const form = find("#analysis-form");
    const fields = form.elements;
    const results = find("#analysis-results");
    const status = find("#analysis-status");
    const upload = find("#analysis-upload");
    let viewVersion = 0;
    let manifestVersion = 0;

    function setStatus(node, message, error = false) {
      node.textContent = message;
      node.classList.toggle("ca-warning", error);
    }

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
      const kinetics = fields.kind.value === "kinetics";
      const section = find("#analysis-kinetics");
      section.hidden = section.disabled = !kinetics;
      const vasp = find("#analysis-vasp");
      vasp.hidden = vasp.disabled = kinetics;
      upload.accept = kinetics ? ".csv,.xlsx" : ".zip";
      find("#analysis-file-hint").textContent = kinetics ? "支持 CSV 或 XLSX。" : "上传含 study.json 和 vasprun.xml 的 VASP ZIP。";
      find("#analysis-options").placeholder = kinetics
        ? '{"acceptance":{"max_train_log_rmse":0.2,"max_holdout_log_rmse":0.3}}'
        : '{"cell_limits_A":[50,50,50]}';
      syncSheet();
    }

    function syncSheet() {
      fields.sheet.disabled = !/\.xlsx$/i.test(upload.files[0]?.name ?? "");
    }

    function jsonObject(value, label) {
      let parsed;
      try {
        parsed = JSON.parse(value);
      } catch {
        throw new Error(`${label}必须是有效的 JSON 对象。`);
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${label}必须是 JSON 对象。`);
      }
      return parsed;
    }

    function runOptions() {
      const advanced = find("#analysis-options").value.trim();
      const options = {};
      if (fields.kind.value === "adsorption") {
        options.cell_limits_A = ["a", "b", "c"].map(axis => fields[`vasp_limit_${axis}`].valueAsNumber);
      } else {
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
      }
      return { ...options, ...(advanced ? jsonObject(advanced, "高级配置") : {}) };
    }

    async function openRun(id, button) {
      const version = ++viewVersion;
      results.setAttribute("aria-busy", "true");
      setStatus(status, "正在读取历史运行…");
      try {
        const run = await request(`/api/runs/${encodeURIComponent(id)}`);
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
          button.addEventListener("click", () => openRun(run.id, button));
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
    upload.addEventListener("change", syncSheet);
    syncModel();
    syncKind();
    panel.addEventListener("toggle", () => { if (panel.open) void loadHistory(); });
    find("#analysis-refresh").addEventListener("click", loadHistory);
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
      const version = ++viewVersion;
      submit.disabled = true;
      results.replaceChildren();
      results.hidden = true;
      results.setAttribute("aria-busy", "true");
      setStatus(status, `正在分析${originLabel[fields.origin.value]}…`);
      try {
        const run = await request("/api/runs", body);
        if (version === viewVersion) {
          renderRun(run, results);
          results.hidden = false;
          find("#analysis-history-list [aria-current]")?.removeAttribute("aria-current");
          setStatus(status, "分析完成。");
        }
        void loadHistory();
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
