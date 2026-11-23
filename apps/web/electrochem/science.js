(() => {
  'use strict';

  const reactions = {
    her: { states: ['*', 'H*', '* + H₂'], inputs: ['ΔG(H*)'], direction: 1, equilibrium: 0 },
    oer: { states: ['*', 'OH*', 'O*', 'OOH*', '* + O₂'], inputs: ['ΔG(OH*)', 'ΔG(O*)', 'ΔG(OOH*)'], direction: -1, equilibrium: 1.23 },
  };

  function freeEnergy(reaction, potential, energies) {
    if (!Object.hasOwn(reactions, reaction)) throw new Error('请选择 HER 或 OER。');
    const { states, inputs, direction, equilibrium } = reactions[reaction];
    if (!Number.isFinite(potential) || !Array.isArray(energies) || energies.length !== inputs.length ||
        !energies.every(Number.isFinite)) throw new Error('请填写电位和全部中间体自由能。');
    const reference = [0, ...energies, reaction === 'her' ? 0 : 4.92];
    const levels = reference.map((value, index) => value + direction * index * potential);
    const increments = values => values.slice(1).map((value, index) => value - values[index]);
    const standardSteps = increments(reference);
    const steps = increments(levels);
    if (![...levels, ...steps, ...standardSteps].every(Number.isFinite)) throw new Error('输入超出数值范围。');
    const highest = Math.max(...standardSteps);
    const limitingPotential = -direction * highest;
    const limitingSteps = standardSteps.flatMap((value, index) => Math.abs(value - highest) < 1e-9 ? [index] : []);
    return { states, reference, levels, steps, limitingSteps, limitingPotential,
      overpotential: Math.abs(limitingPotential - equilibrium) };
  }

  const elements = new Set(('H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn ' +
    'Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd ' +
    'Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf ' +
    'Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og').split(' '));
  const decimal = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
  const maxXYZBytes = 256 * 1024;

  function parseXYZ(text) {
    if (typeof text !== 'string' || text.length > maxXYZBytes) throw new Error('XYZ 预览上限为 256 KiB。');
    const lines = text.trimEnd().split(/\r?\n/);
    const header = lines[0].trim();
    const count = Number(header);
    if (!/^\d+$/.test(header) || count < 1 || count > 2000) throw new Error('首行须为原子数（1–2000）。');
    if (lines.length !== count + 2) throw new Error('只支持单帧 XYZ：原子数、注释行和坐标行须完整匹配。');
    return lines.slice(2).map((line, index) => {
      const [element, ...columns] = line.trim().split(/\s+/);
      const xyz = columns.map(Number);
      if (!elements.has(element) || columns.length !== 3 || !columns.every(value => decimal.test(value)) ||
          !xyz.every(value => Number.isFinite(value) && Math.abs(value) <= 1e6)) {
        throw new Error(`第 ${index + 3} 行须为元素及三个有效 Å 坐标（绝对值 ≤ 10⁶）。`);
      }
      return { element, xyz };
    });
  }

  function suggestTool(question) {
    if (/\bxyz\b|原子坐标|位点结构/i.test(question)) return 'structure';
    if (/能垒|速率|选择性|覆盖度|动力学|tafel|barrier|kinetic/i.test(question)) return null;
    const her = /\bher\b|析氢/i.test(question);
    const oer = /\boer\b|析氧/i.test(question);
    return her === oer ? null : her ? 'her' : 'oer';
  }

  const api = { freeEnergy, reactions, parseXYZ, maxXYZBytes, suggestTool };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.CatalysisScience = api;
})();
