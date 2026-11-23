(() => {
  'use strict';
  const { reactions, freeEnergy, parseXYZ, maxXYZBytes } = window.CatalysisScience;
  const number = value => Number(value.toFixed(4)).toString();
  const colors = { Pt: '#567185', Ir: '#416399', H: '#f4fcff', O: '#ec7659', C: '#506164', N: '#5282d4', Ni: '#45a687' };
  const exampleXYZ = '5\nPt-H simplified geometry (illustration only), angstrom\nPt -1.4 -1.4 0\nPt 1.4 -1.4 0\nPt -1.4 1.4 0\nPt 1.4 1.4 0\nH 1.4 1.4 1.6';

  function svgNode(tag, attributes, text) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function drawEnergy(svg, { reference, levels, states }) {
    const low = Math.min(...reference, ...levels), high = Math.max(...reference, ...levels);
    const pad = Math.max((high - low) * 0.12, 0.1);
    const yAt = energy => 157 - 125 * (energy - low + pad) / (high - low + 2 * pad);
    const xAt = index => 83 + 408 * index / (states.length - 1);
    svg.replaceChildren(svgNode('title', {}, '反应路径累计自由能：虚线为零电位，实线为输入电位'));
    svg.append(svgNode('text', { x: 8, y: 19 }, 'G / eV'));
    for (const energy of [...new Set([high, 0, low])]) {
      if (energy !== 0 && Math.abs(yAt(energy) - yAt(0)) < 13) continue;
      const at = yAt(energy);
      svg.append(svgNode('line', { x1: 54, x2: 524, y1: at, y2: at, class: 'ec-gridline' }),
        svgNode('text', { x: 48, y: at + 4, 'text-anchor': 'end' }, number(energy)));
    }
    for (const [energies, name] of [[reference, 'ec-zero'], [levels, 'ec-applied']]) {
      const points = energies.flatMap((energy, index) => [
        `${xAt(index) - 22},${yAt(energy)}`, `${xAt(index) + 22},${yAt(energy)}`]);
      svg.append(svgNode('polyline', { points: points.join(' '), class: name }));
    }
    states.forEach((state, index) => svg.append(svgNode('text', { x: xAt(index), y: 184, 'text-anchor': 'middle' }, state)));
  }

  function mountEnergy(root) {
    const find = selector => root.querySelector(selector);
    root.innerHTML = `
      <p class="ec-hint">输入 0 V vs RHE、298.15 K 标准态下，已做热力学校正的中间体形成自由能。不要直接填入 VASP 总能或电子吸附能。</p>
      <p class="ec-hint" data-reference></p>
      <form class="ec-form"><div class="ec-fields"></div>
        <div class="ec-actions"><button type="submit" class="ec-primary">绘制自由能图</button>
        <button type="button" data-example>载入教学示例</button><button type="button" data-clear>清空输入</button></div></form>
      <p class="ec-status" role="status"></p>
      <section class="ec-result" hidden><div class="ec-figure-head"><h3>反应自由能图</h3><span data-origin></span></div>
        <div class="ec-legend">┄ 0 V 参照　 <b>━ 输入电位</b>　·　电位均相对 RHE</div>
        <svg viewBox="0 0 548 194" role="img" aria-label="反应自由能图"></svg>
        <div class="ec-metrics"></div><table><caption>逐步反应自由能（输入电位）</caption><thead><tr><th>反应步</th><th>ΔG / eV</th></tr></thead><tbody></tbody></table>
        <p class="ec-hint">单活性位、每步一个质子–电子对的 CHE 热力学模型。不包含过渡态能垒，不预测电流、速率或选择性。</p>
        <button type="button" data-export>导出输入与结果 JSON</button></section>`;
    const form = find('form'), fields = find('.ec-fields'), result = find('.ec-result'), status = find('.ec-status');
    let reaction, source, snapshot;
    const drafts = new Map();

    function invalidate(message) {
      snapshot = null;
      result.hidden = true;
      status.textContent = message;
    }

    function select(next) {
      if (next === reaction) return;
      if (reaction) drafts.set(reaction, { values: Array.from(fields.querySelectorAll('input'), input => input.value), source, drawn: Boolean(snapshot) });
      reaction = next;
      source = '手动输入';
      find('[data-reference]').textContent = next === 'her'
        ? 'Volmer–Heyrovsky 路径：ΔG(H*) 以裸位点 + ½H₂ 为参照；不包含 Tafel 重组步。'
        : '吸附物演化路径：OH*、O*、OOH* 均相对裸位点、H₂O(l) 与 H₂(g) 定义。请填累计形成自由能，而非相邻两步的能量差。';
      fields.replaceChildren();
      for (const title of ['电极电位 U / V vs RHE', ...reactions[next].inputs.map(label => label + ' / eV')]) {
        const label = document.createElement('label');
        label.textContent = title;
        const input = document.createElement('input');
        Object.assign(input, { type: 'number', step: 'any', min: '-1000', max: '1000', required: true, placeholder: '待输入' });
        label.append(input);
        fields.append(label);
      }
      invalidate('等待输入，未运行计算。也可载入带标记的示例。');
      const draft = drafts.get(next);
      if (draft) {
        fields.querySelectorAll('input').forEach((input, index) => { input.value = draft.values[index]; });
        source = draft.source;
        if (draft.drawn) compute();
      }
    }

    function compute() {
      if (!form.reportValidity()) return;
      const [potential, ...energies] = Array.from(fields.querySelectorAll('input'), input => input.valueAsNumber);
      const output = freeEnergy(reaction, potential, energies);
      snapshot = { model: 'CHE-v1', reaction, source, temperature_K: 298.15, potential_V_vs_RHE: potential,
        intermediates_eV_at_0V: Object.fromEntries(reactions[reaction].inputs.map((name, index) => [name, energies[index]])),
        energy_unit: 'eV', potential_unit: 'V vs RHE', step_index_base: 0, ...output };
      find('[data-origin]').textContent = source;
      drawEnergy(find('svg'), output);
      const stepName = index => output.states[index] + ' → ' + output.states[index + 1];
      const metrics = find('.ec-metrics');
      metrics.replaceChildren();
      for (const [name, value] of [['限制电位 / V vs RHE', number(output.limitingPotential)],
        ['理论过电位 / V', number(output.overpotential)], ['电位决定步', output.limitingSteps.map(stepName).join('；')]]) {
        const cell = document.createElement('div'), title = document.createElement('small'), data = document.createElement('strong');
        title.textContent = name;
        data.textContent = value;
        cell.append(title, data);
        metrics.append(cell);
      }
      const body = find('tbody');
      body.replaceChildren();
      output.steps.forEach((step, index) => {
        const row = body.insertRow();
        row.insertCell().textContent = stepName(index);
        row.insertCell().textContent = number(step);
      });
      status.textContent = `${reaction.toUpperCase()} · ${number(potential)} V vs RHE · ${source}`;
      result.hidden = false;
    }

    form.addEventListener('submit', event => { event.preventDefault(); compute(); });
    form.addEventListener('input', () => {
      if (source === '教学示例') source = '基于教学示例修改';
      invalidate('输入已更改，请重新绘制。');
    });
    find('[data-example]').onclick = () => {
      const values = reaction === 'her' ? [-0.1, 0.22] : [1.23, 1.1, 2.8, 4.15];
      fields.querySelectorAll('input').forEach((input, index) => { input.value = values[index]; });
      source = '教学示例';
      compute();
    };
    find('[data-clear]').onclick = () => {
      form.reset();
      source = '手动输入';
      invalidate('请输入同一参考态的电位与能量。');
      fields.querySelector('input').focus();
    };
    find('[data-export]').onclick = () => {
      if (!snapshot) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `che-${reaction}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    return select;
  }

  function mountStructure(root) {
    root.innerHTML = `<p class="ec-hint">读取单帧标准 XYZ（元素 x y z，单位 Å，最多 2000 个原子 / 256 KiB）。文件只在浏览器内处理，不上传。</p>
      <div class="ec-actions"><label>选择 XYZ 文件 <input type="file" accept=".xyz,text/plain"></label><button type="button" data-demo>查看 Pt–H 示意结构</button></div>
      <p class="ec-status" role="status">等待结构文件。</p><div class="ec-result" hidden>
      <div class="ec-figure-head"><h3>原子坐标预览</h3><span>正交投影 · Å</span></div>
      <svg viewBox="0 0 520 250" role="img" aria-label="可旋转的原子结构投影"></svg>
      <div class="ec-fields"><label>水平旋转 / °<input data-yaw type="range" min="-180" max="180" value="25"></label>
      <label>俯仰 / °<input data-pitch type="range" min="-90" max="90" value="55"></label>
      <label>原子序号<input data-atom type="number" min="1" step="1" value="1"></label></div>
      <output aria-live="polite"></output><p class="ec-hint">点选原子或输入序号查看原始坐标。大小和颜色用于辨认；不推断成键、晶胞、吸附能或催化活性。</p></div>`;
    const find = selector => root.querySelector(selector), svg = find('svg'), file = find('[type=file]');
    const yaw = find('[data-yaw]'), pitch = find('[data-pitch]'), selected = find('[data-atom]');
    const result = find('.ec-result'), status = find('[role=status]');
    let atoms = [], centered = [], radius = 1, version = 0;

    function draw() {
      const radians = degrees => Number(degrees) * Math.PI / 180;
      const horizontal = radians(yaw.value), vertical = radians(pitch.value);
      const positions = centered.map(([first, second, third], index) => {
        const along = first * Math.sin(horizontal) + second * Math.cos(horizontal);
        return { index, x: first * Math.cos(horizontal) - second * Math.sin(horizontal),
          y: third * Math.cos(vertical) - along * Math.sin(vertical), z: third * Math.sin(vertical) + along * Math.cos(vertical) };
      }).sort((left, right) => left.z - right.z);
      const active = selected.valueAsNumber - 1;
      svg.replaceChildren();
      const fragment = document.createDocumentFragment();
      for (const { index, x, y } of positions) {
        const atom = atoms[index], large = atoms.length < 100;
        const dot = svgNode('circle', { cx: 260 + 102 * x / radius, cy: 125 - 102 * y / radius,
          r: large ? atom.element === 'H' ? 6 : 11 : 3, fill: colors[atom.element] || '#9c81a5',
          stroke: index === active ? '#007b87' : '#395064', 'stroke-width': index === active ? 3 : 1, 'data-index': index });
        dot.append(svgNode('title', {}, `${index + 1} · ${atom.element}`));
        fragment.append(dot);
      }
      svg.append(fragment);
      find('output').textContent = atoms[active] ? `#${active + 1} ${atoms[active].element}　(x, y, z) = (${atoms[active].xyz.join(', ')}) Å` : '请选择有效原子序号。';
    }
    function load(text, label) {
      atoms = parseXYZ(text);
      const center = [0, 1, 2].map(axis => atoms.reduce((sum, atom) => sum + atom.xyz[axis], 0) / atoms.length);
      centered = atoms.map(atom => atom.xyz.map((value, axis) => value - center[axis]));
      radius = Math.max(...centered.map(point => Math.hypot(...point))) || 1;
      selected.value = 1;
      selected.max = atoms.length;
      yaw.value = 25;
      pitch.value = 55;
      status.textContent = `${label} · ${atoms.length} 个原子`;
      result.hidden = false;
      draw();
    }
    svg.addEventListener('click', event => {
      const dot = event.target.closest('circle[data-index]');
      if (dot) { selected.value = Number(dot.dataset.index) + 1; draw(); }
    });
    for (const control of [yaw, pitch, selected]) control.addEventListener('input', draw);
    find('[data-demo]').onclick = () => { version++; file.value = ''; load(exampleXYZ, '教学示意 · 非优化构型'); };
    file.addEventListener('change', async () => {
      const generation = ++version, source = file.files[0];
      result.hidden = true;
      if (!source) { status.textContent = '等待结构文件。'; return; }
      status.textContent = '正在读取 XYZ 坐标…';
      try {
        if (source.size > maxXYZBytes) throw new Error('XYZ 文件超过 256 KiB。');
        const text = await source.text();
        if (generation === version) load(text, source.name);
      } catch (error) { if (generation === version) status.textContent = error.message; }
    });
  }

  function mount(root) {
    root.className = 'ec-tools';
    root.innerHTML = `<div class="ec-heading"><p>LOCAL LAB　/　01–03</p><h2>电催化分析台</h2></div>
      <div class="ec-switch" role="group" aria-label="本地分析工具"><button type="button" data-tool="her">HER · 析氢</button>
      <button type="button" data-tool="oer">OER · 析氧</button><button type="button" data-tool="structure">位点结构 · XYZ</button></div>
      <section class="ec-energy"></section><section class="ec-structure" hidden></section>`;
    const energy = root.querySelector('.ec-energy'), structure = root.querySelector('.ec-structure');
    const selectEnergy = mountEnergy(energy);
    mountStructure(structure);
    const buttons = [...root.querySelectorAll('[data-tool]')];
    function select(tool) {
      energy.hidden = tool === 'structure';
      structure.hidden = !energy.hidden;
      if (!energy.hidden) selectEnergy(tool);
      buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.tool === tool)));
    }
    buttons.forEach(button => button.addEventListener('click', () => select(button.dataset.tool)));
    select('her');
    return tool => { select(tool); buttons.find(button => button.dataset.tool === tool).focus(); };
  }
  function chatPlot({ reaction, potential, energies, example }) {
    const figure = document.createElement('figure');
    figure.className = 'ec-result wb-plot';
    const caption = document.createElement('figcaption');
    caption.textContent = reaction.toUpperCase() + ' 自由能图 · ' + (example ? '教学示例' : '用户输入') +
      '｜虚线 0 V，实线 ' + potential + ' V vs RHE';
    const svg = svgNode('svg', {viewBox:'0 0 548 194', role:'img', 'aria-label':caption.textContent});
    drawEnergy(svg, freeEnergy(reaction, potential, energies));
    figure.append(caption, svg);
    return figure;
  }
  window.CatalysisViewers = { mount, chatPlot };
})();
