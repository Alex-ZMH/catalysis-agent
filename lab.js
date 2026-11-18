(function () {
  'use strict';

  const assumptions = '恒温、吸附平衡、等价独立位点、单层吸附，无明显吸附质侧向相互作用。';
  const question = '在固定温度下，实测覆盖率随活度的变化能否由同一个 K 描述？低活度区和趋于饱和时的偏差是否超出测量不确定度？';
  const activityMax = 5;
  const coverage = (k, a) => k * a / (1 + k * a);
  const x = a => 38 + 280 * a / activityMax;
  const y = theta => 118 - 100 * theta;

  function mount(root, { openDraft }) {
    root.classList.add('catalysis-lab');
    root.innerHTML = `
      <div class="catalysis-lab-layout">
        <div class="catalysis-lab-intro">
          <h2>朗格缪尔吸附</h2>
          <p>改变吸附平衡常数或活度，观察平衡时有多少表面位点被占据。</p>
          <div class="catalysis-lab-formula">θ = Ka / (1 + Ka)</div>
          <p>θ 为占据位点的分数。a 为相对于所选标准态的无量纲活度，K 为同一标准态下的无量纲吸附平衡常数。</p>
          <p><strong>适用边界</strong> · ${assumptions}</p>
        </div>
        <div class="catalysis-lab-panel">
          <div class="catalysis-lab-heading"><span>吸附平衡探索</span><small>实时调整</small></div>
          <div class="catalysis-lab-readout">
            <output for="catalysis-k catalysis-a"><span data-coverage></span><span>%</span></output>
            <small>平衡覆盖率 θ</small>
          </div>
          <label for="catalysis-k">吸附平衡常数 K <span data-k-value></span></label>
          <input type="range" id="catalysis-k" min="0.1" max="5" step="0.1" value="1">
          <label for="catalysis-a">活度 a <span data-a-value></span></label>
          <input type="range" id="catalysis-a" min="0" max="${activityMax}" step="0.1" value="1">
          <p class="catalysis-lab-note">K 和 a 均无量纲。范围与初始值为教学假设。</p>
          <figure class="catalysis-lab-chart">
            <svg viewBox="0 0 342 155" role="img" aria-label="平衡覆盖率 θ 随无量纲活度 a 变化的等温线">
              <path class="catalysis-lab-grid" d="M38 18H318 M38 68H318 M178 18V118 M318 18V118"/>
              <path class="catalysis-lab-axes" d="M38 18V118H318"/>
              <g text-anchor="end"><text x="31" y="22">1</text><text x="31" y="72">0.5</text><text x="31" y="122">0</text></g>
              <g text-anchor="middle"><text x="38" y="135">0</text><text x="178" y="135">2.5</text><text x="318" y="135">5</text><text x="178" y="152">活度 a</text></g>
              <text x="15" y="13">θ</text>
              <polyline class="catalysis-lab-curve"/>
              <circle class="catalysis-lab-point" r="4.5"/>
            </svg>
            <figcaption><span>等温线 θ(a)</span><span>当前条件</span></figcaption>
          </figure>
          <button type="button" class="catalysis-lab-action">用这组条件提出研究问题 <span aria-hidden="true">→</span></button>
        </div>
      </div>`;

    const kInput = root.querySelector('#catalysis-k');
    const aInput = root.querySelector('#catalysis-a');
    const kValue = root.querySelector('[data-k-value]');
    const aValue = root.querySelector('[data-a-value]');
    const readout = root.querySelector('[data-coverage]');
    const curve = root.querySelector('polyline');
    const point = root.querySelector('circle');

    function updatePoint() {
      const a = aInput.valueAsNumber;
      const theta = coverage(kInput.valueAsNumber, a);
      aValue.textContent = a.toFixed(1);
      readout.textContent = (100 * theta).toFixed(1);
      point.setAttribute('cx', x(a));
      point.setAttribute('cy', y(theta));
    }

    function updateCurve() {
      const k = kInput.valueAsNumber;
      kValue.textContent = k.toFixed(1);
      const points = Array.from({ length: 101 }, (_, index) => {
        const a = activityMax * index / 100;
        return `${x(a).toFixed(2)},${y(coverage(k, a)).toFixed(2)}`;
      });
      curve.setAttribute('points', points.join(' '));
      updatePoint();
    }

    kInput.addEventListener('input', updateCurve);
    aInput.addEventListener('input', updatePoint);
    root.querySelector('.catalysis-lab-action').addEventListener('click', () => {
      openDraft(`以朗格缪尔等温吸附为教学模型，当前 K = ${kValue.textContent}（无量纲），a = ${aValue.textContent}（无量纲），模型给出的平衡覆盖率 θ = ${readout.textContent}%。参数范围和初始值为教学假设。模型假设：${assumptions}\n待验证问题：${question}\n请梳理验证方案及所需实验条件，仅拟定研究计划，不提交计算。`);
    });
    updateCurve();
  }

  window.CatalysisLab = { mount };
}());
