(() => {
  'use strict';
  const Kb = 8.617333262e-5;
  const assumptions = '固定电位，单一基元步受动力学控制，温区内 ΔG‡ 与传输系数近似恒定。';
  const reactions = {
    her: { label: 'HER · 阴极析氢', steps: [
      { name: 'Volmer · 氢吸附', equation: '* + H⁺ + e⁻ → H*', barrier: .38, delta: -.12 },
      { name: 'Heyrovsky · 氢脱附', equation: 'H* + H⁺ + e⁻ → H₂ + *', barrier: .46, delta: -.08 }
    ]},
    oer: { label: 'OER · 阳极析氧', steps: [
      { name: '水活化', equation: '* + H₂O → *OH + H⁺ + e⁻', barrier: .52, delta: .11 },
      { name: '羟基脱氢', equation: '*OH → *O + H⁺ + e⁻', barrier: .61, delta: .16 },
      { name: '氧氧键形成', equation: '*O + H₂O → *OOH + H⁺ + e⁻', barrier: .78, delta: .23 },
      { name: '氧气释放', equation: '*OOH → O₂ + * + H⁺ + e⁻', barrier: .44, delta: -.17 }
    ]}
  };
  const x = t => 48 + 272 * (t - 298) / 55;
  const rate = (barrier, t) => Math.max(.001, (t / 298) * Math.exp(-barrier / Kb * (1 / t - 1 / 298)));
  const y = value => 126 - 36 * Math.log10(Math.max(value, .01));

  function mount(root, { openDraft } = {}) {
    root.classList.add('catalysis-lab');
    root.innerHTML = `
      <div class="catalysis-lab-layout">
        <div class="catalysis-lab-intro">
          <p class="catalysis-lab-eyebrow">ELECTROCHEMISTRY / KINETICS</p>
          <h2>升高温度，<br>基元反应能快多少？</h2>
          <p class="catalysis-lab-lede">在统一的温度参照下，观察一个基元步的活化自由能如何改变相对反应速率。</p>
          <div class="catalysis-lab-formula">k ∝ T · exp(−ΔG‡ / k<sub>B</sub>T)</div>
          <p>ΔG‡ 为过渡态与初态的自由能差。相对速率以 298 K 时的速率为基准。</p>
          <p><strong>模型条件</strong> · ${assumptions}</p>
        </div>
        <div class="catalysis-lab-panel">
          <div class="catalysis-lab-heading"><span>基元步参数探索</span><small>示例参数</small></div>
          <div class="catalysis-lab-switch" role="group" aria-label="选择反应"><button type="button" data-reaction="her" aria-pressed="true">HER / 阴极</button><button type="button" data-reaction="oer" aria-pressed="false">OER / 阳极</button></div>
          <div class="catalysis-lab-steps" role="group" aria-label="选择基元步"></div>
          <div class="catalysis-lab-readout"><output><span data-rate></span><span>×</span></output><small>相对速率（298 K = 1）</small></div>
          <label for="catalysis-temperature">温度 T <span data-temperature></span> K</label>
          <input type="range" id="catalysis-temperature" min="298" max="353" step="1" value="323">
          <div class="catalysis-lab-metrics"><span>ΔG‡ <strong data-barrier></strong> eV</span><span>ΔG <strong data-delta></strong> eV</span></div>
          <figure class="catalysis-lab-chart">
            <svg viewBox="0 0 342 155" role="img" aria-label="相对速率随温度变化的示意曲线">
              <path class="catalysis-lab-grid" d="M48 18H320 M48 72H320 M184 18V126 M320 18V126"/><path class="catalysis-lab-axes" d="M48 18V126H320"/>
              <g text-anchor="end"><text x="41" y="22">1000</text><text x="41" y="58">100</text><text x="41" y="94">10</text><text x="41" y="130">1</text></g>
              <g text-anchor="middle"><text x="48" y="143">298</text><text x="184" y="143">325</text><text x="320" y="143">353 K</text></g>
              <text x="15" y="13">k/k₀</text><polyline class="catalysis-lab-curve"></polyline><circle class="catalysis-lab-point" r="4.5"></circle>
            </svg>
            <figcaption><span>温度依赖（对数轴）</span><span>当前条件</span></figcaption>
          </figure>
          <button type="button" class="catalysis-lab-action">用这组条件提出研究问题 <span aria-hidden="true">→</span></button>
        </div>
      </div>`;
    const reactionButtons = [...root.querySelectorAll('[data-reaction]')];
    const stepBox = root.querySelector('.catalysis-lab-steps');
    const temperatureInput = root.querySelector('#catalysis-temperature');
    const temperatureOutput = root.querySelector('[data-temperature]');
    const rateOutput = root.querySelector('[data-rate]');
    const barrierOutput = root.querySelector('[data-barrier]');
    const deltaOutput = root.querySelector('[data-delta]');
    const curve = root.querySelector('.catalysis-lab-curve');
    const point = root.querySelector('.catalysis-lab-point');
    let reactionId = 'her', stepIndex = 0;
    const current = () => reactions[reactionId].steps[stepIndex];
    function renderSteps() {
      stepBox.innerHTML = reactions[reactionId].steps.map((item, index) =>
        `<button type="button" data-step="${index}" aria-pressed="${index === stepIndex}"><b>0${index + 1}</b><span>${item.name}</span><small>${item.equation}</small></button>`).join('');
      stepBox.querySelectorAll('[data-step]').forEach(button => button.addEventListener('click', () => {
        stepIndex = Number(button.dataset.step); renderSteps(); update();
      }));
    }
    function update() {
      const item = current(), temperature = temperatureInput.valueAsNumber, relative = rate(item.barrier, temperature);
      temperatureOutput.textContent = temperature;
      rateOutput.textContent = relative >= 1000 ? relative.toExponential(1) : relative.toFixed(2);
      barrierOutput.textContent = item.barrier.toFixed(2);
      deltaOutput.textContent = (item.delta > 0 ? '+' : '−') + Math.abs(item.delta).toFixed(2);
      const points = Array.from({length: 56}, (_, index) => {
        const t = 298 + index;
        return `${x(t).toFixed(2)},${Math.max(18, Math.min(126, y(rate(item.barrier, t)).toFixed(2)))}`;
      });
      curve.setAttribute('points', points.join(' ')); point.setAttribute('cx', x(temperature)); point.setAttribute('cy', Math.max(18, Math.min(126, y(relative))));
    }
    reactionButtons.forEach(button => button.addEventListener('click', () => {
      reactionId = button.dataset.reaction; stepIndex = 0;
      reactionButtons.forEach(item => item.setAttribute('aria-pressed', String(item === button))); renderSteps(); update();
    }));
    temperatureInput.addEventListener('input', update);
    root.querySelector('.catalysis-lab-action').addEventListener('click', () => {
      const item = current();
      openDraft?.(`以${reactions[reactionId].label}的“${item.name}”为研究对象。当前参数：T = ${temperatureInput.value} K，ΔG‡ = ${item.barrier.toFixed(2)} eV，ΔG = ${item.delta.toFixed(2)} eV，相对速率 = ${rateOutput.textContent}×（298 K = 1）。模型假设：${assumptions}\n请据此设计研究步骤，并说明电位、pH、溶剂化、覆盖度和输运条件的设置。`);
    });
    renderSteps(); update();
  }
  window.CatalysisLab = { mount };
})(); 
