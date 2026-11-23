(() => {
  'use strict';
  const common = typeof module !== 'undefined' && module.exports;
  const science = common ? require('./science.js') : window.CatalysisScience;
  const examples = { her: [-0.1, 0.22], oer: [1.23, 1.1, 2.8, 4.15] };
  function calculated(reaction, values, example) {
    const [potential, ...energies] = values;
    const result = science.freeEnergy(reaction, potential, energies);
    const names = result.limitingSteps.map(index => result.states[index] + ' → ' + result.states[index + 1]);
    const format = value => Number(value.toFixed(4));
    return { mode: 'local', tool: reaction, plot: { reaction, potential, energies, example },
      text: (example ? '已运行教学示例（不是实验结果）。' : '已按你提供的数值运行 CHE 计算。') +
        '\n0 V 下的输入：' + science.reactions[reaction].inputs.map((label,index) => label + ' = ' + energies[index] + ' eV').join('，') + '。' +
        '\n在 ' + potential + ' V vs RHE，各步 ΔG 为 ' + result.steps.map(format).join('、') + ' eV。' +
        '\n电位决定步：' + names.join('、') + '。限制电位 ' + format(result.limitingPotential) +
        ' V vs RHE，理论过电位 ' + format(result.overpotential) + ' V。这是热力学结果，不是反应速率。' };
  }

  function localReply(question, turns) {
    const previous = turns.at(-1)?.reply;
    const ask = question.trim();
    const tool = science.suggestTool(ask);
    const contextual = tool || previous?.tool;
    const say = (text, selected = null) => ({ text, mode: 'local', tool: selected });
    if (/^(?:请)?(?:直接)?(?:运行|演示|计算|跑一下|看)(?:一个|这个)?(?:\s*(?:HER|OER|析氢|析氧)\s*)?(?:教学)?示例[。！!？?]?$/i.test(ask)) {
      if (examples[contextual]) return calculated(contextual, examples[contextual], true);
      return say('要看哪条反应路径？可以发送「运行 HER 示例」或「运行 OER 示例」。');
    }
    const command = /^(HER|OER)\s*[:：]\s*(.+)$/i.exec(ask);
    if (command) {
      const reaction = command[1].toLowerCase();
      const values = command[2].split(/[\s,，;；]+/);
      const required = reaction === 'her' ? 2 : 4;
      if (values.length === required && values.every(value => /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value) && Math.abs(Number(value)) <= 1000)) {
        return calculated(reaction, values.map(Number), false);
      }
      return say('未运行：格式是 ' + (reaction === 'her' ? 'HER: U ΔG(H*)' : 'OER: U ΔG(OH*) ΔG(O*) ΔG(OOH*)') +
        '。电位单位 V vs RHE，自由能单位 eV；请只填写数值。', reaction);
    }
    if (/^(为什么|怎么得到的|解释结果|解释一下)[？?。！!]*$/.test(ask) && previous?.plot) {
      const plot = previous.plot, result = science.freeEnergy(plot.reaction, 0, plot.energies);
      return say('先在 0 V 下用相邻累计自由能相减，得到每一步的 ΔG。最大的上坡步是 ' +
        Number(Math.max(...result.steps).toFixed(4)) + ' eV。' + (plot.reaction === 'oer'
          ? '析氧的每一步都释放一个电子，因此限制电位减去平衡电位 1.23 V 就是理论过电位。'
          : '析氢的每一步都消耗一个电子，因此限制电位取该上坡值的负值，过电位取其绝对值。'), plot.reaction);
    }
    if (tool === 'her') return say('析氢路径中，H* 结合太弱会使吸附上坡，太强则使脱附上坡。在 Volmer–Heyrovsky 模型中，比较这两步就能找到限制电位。\n发送「运行 HER 示例」可直接看图。用自己的数据时发送 HER: U ΔG(H*)，单位依次是 V vs RHE、eV。', tool);
    if (tool === 'oer') return say('析氧路径是 * → OH* → O* → OOH* → O₂。把相邻中间体的累计形成自由能相减，0 V 下最大上坡步决定限制电位；对应的理论过电位是限制电位减 1.23 V。\n发送「运行 OER 示例」即可看图。用自己的数据时发送 OER: U ΔG(OH*) ΔG(O*) ΔG(OOH*)，单位依次是 V vs RHE、eV、eV、eV。', tool);
    if (tool === 'structure') return say('可以。打开「查看位点结构」，选择单帧 XYZ 文件。第一行填原子数，第二行是注释，其后每行是元素符号与三个 Å 坐标。图中可旋转、点选原子；坐标不会上传。', tool);
    return say('当前是本地分析模式，不是通用语言模型。我可以计算 HER / OER 自由能路径，或查看原子结构。试试发送「运行 OER 示例」。开放式机理讨论需要在完整服务中连接语言模型。');
  }
  if (common) module.exports = { localReply, calculated };
  else window.CatalysisChat = { localReply };
})();
