const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freeEnergy, parseXYZ, suggestTool } = require('../apps/web/electrochem/science.js');
const { localReply } = require('../apps/web/electrochem/chat.js');

test('offline conversation: ask, run explicit example, explain in context', () => {
  const guide = localReply('解释析氧', []);
  assert.equal(guide.tool, 'oer');
  assert.ok(!guide.plot);
  const result = localReply('运行示例', [{question:'解释析氧', reply:guide}]);
  assert.equal(result.plot.reaction, 'oer');
  assert.match(result.text, /0\.47 V/);
  assert.match(localReply('为什么？', [{question:'运行示例', reply:result}]).text, /1\.7.*1\.23/s);
  assert.ok(!localReply('不要运行示例', [{question:'解释析氧', reply:guide}]).plot);
});

function close(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
}

test('HER: Volmer–Heyrovsky reduction consumes one electron per step', () => {
  const result = freeEnergy('her', -0.10, [0.22]);
  close(result.levels[1], 0.12);
  close(result.levels[2], -0.20);
  close(result.steps[1], -0.32);
  close(result.limitingPotential, -0.22);
  close(result.overpotential, 0.22);
  assert.deepEqual(result.limitingSteps, [0]);
  assert.deepEqual(freeEnergy('her', 0, [-0.22]).limitingSteps, [1]);
});

test('OER: cumulative adsorption free energies, not incremental steps', () => {
  const result = freeEnergy('oer', 1.23, [1.10, 2.80, 4.15]);
  close(result.levels[2], 0.34);
  close(result.levels[4], 0);
  close(result.steps[1], 0.47);
  close(result.limitingPotential, 1.70);
  close(result.overpotential, 0.47);
  assert.deepEqual(result.limitingSteps, [1]);
  const ideal = freeEnergy('oer', 1.23, [1.23, 2.46, 3.69]);
  close(ideal.overpotential, 0);
  assert.deepEqual(ideal.limitingSteps, [0, 1, 2, 3]);
});

test('inputs must be complete finite numbers; never infer a missing value', () => {
  for (const args of [['orr', 0, [0]], ['her', '', [0]], ['her', 0, ['']],
    ['oer', 1.23, [1, 2]], ['her', 0, [NaN]], ['her', Infinity, [0]]]) {
    assert.throws(() => freeEnergy(...args));
  }
});

test('read exactly one XYZ frame with real element symbols and Å coordinates', () => {
  const file = '\uFEFF2\r\n\r\nPt 0 0 0\r\nH 0 0 1.62e0\r\n';
  assert.deepEqual(parseXYZ(file), [{element: 'Pt', xyz: [0, 0, 0]}, {element: 'H', xyz: [0, 0, 1.62]}]);
  for (const bad of ['2\ncomment\nH 0 0 0', file + '1\nframe2\nH 0 0 0',
    '1\ncomment\nXx 0 0 0', '1\ncomment\nC 1 NaN 0', '1\ncomment\nC 1 2 0xff',
    '1\ncomment\nC 1 2 3 extra', '1000000\ncomment\n']) assert.throws(() => parseXYZ(bad));
});

test('ambiguous questions and unsupported methods are not silently computed', () => {
  assert.equal(suggestTool('看看 OER 自由能图'), 'oer');
  assert.equal(suggestTool('析氢过电位'), 'her');
  assert.equal(suggestTool('查看 Pt 表面 XYZ 坐标'), 'structure');
  for (const question of ['HER 和 OER', '怎样拟合 Tafel 斜率？', '气象', 'OER 反应能垒']) {
    assert.equal(suggestTool(question), null);
  }
});
