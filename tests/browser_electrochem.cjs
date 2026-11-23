const assert = require('node:assert/strict');
const { cp, mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright-core');

async function main() {
  const directory = await mkdtemp(path.join(tmpdir(), 'ec-viewer-'));
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN, headless: true });
  try {
    await cp(path.join(__dirname, '../apps/web/electrochem'), directory, { recursive: true });
    const address = process.argv[2] || pathToFileURL(path.join(directory, 'index.html')).href;
    const url = new URL(address);
    assert.ok(url.protocol === 'file:' || url.hostname === '127.0.0.1');
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [], outside = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const target = new URL(route.request().url());
      if (target.origin === url.origin || target.protocol === 'blob:') return route.continue();
      outside.push(target.href);
      return route.abort();
    });
    await page.goto(address + '#studio');
    if (url.protocol === 'http:') {
      await page.locator('#analysis-nav').waitFor();
    }
    await page.getByRole('button', { name: '运行 OER 示例', exact:true }).click();
    assert.equal(await page.locator('.wb-message').count(), 0);
    await page.getByRole('button', { name:'发送消息' }).click();
    await page.locator('.wb-message.assistant .wb-plot svg').waitFor();
    assert.match(await page.locator('.wb-message.assistant').innerText(), /0\.47 V/);
    const composer = page.getByRole('textbox', {name:'研究问题'});
    await composer.fill('为什么？');
    await composer.press('Enter');
    await page.locator('.wb-message.assistant').nth(1).waitFor();
    assert.match(await page.locator('.wb-message.assistant').nth(1).innerText(), /1\.23/);
    await page.reload();
    await page.getByRole('button', {name:'展开对话导航'}).click();
    await page.locator('.wb-history button').filter({hasText:'运行 OER 示例'}).first().click();
    await page.locator('.wb-message.assistant .wb-plot svg').waitFor();
    await page.getByRole('button', {name:'打开 OER 分析工具'}).first().click();
    await page.getByRole('button', { name: '载入教学示例' }).click();
    assert.equal(await page.locator('.ec-energy tbody tr').count(), 4);
    assert.match(await page.locator('.ec-metrics').innerText(), /0\.47/);
    const energy = page.getByLabel('ΔG(OH*) / eV', { exact: true });
    await energy.fill('1.2');
    assert.equal(await page.locator('.ec-energy .ec-result').isVisible(), false);
    await page.getByRole('button', { name: '绘制自由能图' }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出输入与结果 JSON' }).click();
    const snapshot = JSON.parse(await readFile(await (await download).path(), 'utf8'));
    assert.equal(snapshot.source, '基于教学示例修改');
    assert.equal(snapshot.intermediates_eV_at_0V['ΔG(OH*)'], 1.2);
    await page.getByRole('button', { name: 'HER · 析氢', exact: true }).click();
    await page.getByRole('button', { name: 'OER · 析氧', exact: true }).click();
    assert.equal(await energy.inputValue(), '1.2');

    await page.getByRole('button', { name: '位点结构 · XYZ' }).click();
    const upload = page.locator('.ec-structure input[type=file]');
    await upload.setInputFiles({ name: 'site.xyz', mimeType: 'text/plain', buffer: Buffer.from('2\nsurface\nPt 0 0 0\nH 0 0 1.63') });
    const circles = page.locator('.ec-structure circle');
    await circles.last().waitFor();
    const before = await circles.last().getAttribute('cy');
    await page.getByLabel('俯仰 / °').press('ArrowLeft');
    assert.notEqual(await circles.last().getAttribute('cy'), before);
    await page.getByLabel('原子序号').fill('2');
    assert.match(await page.locator('.ec-structure output').innerText(), /#2 H.*1\.63/);
    await upload.setInputFiles({ name: 'broken.xyz', mimeType: 'text/plain', buffer: Buffer.from('3\nmissing coordinates') });
    await page.locator('.ec-structure .ec-result').waitFor({ state: 'hidden' });
    await page.locator('.ec-structure .ec-status').filter({ hasText: '单帧' }).waitFor();
    assert.deepEqual(errors, []);
    assert.deepEqual(outside, []);
    assert.equal(await page.locator('.wb-main').evaluate(node => node.scrollWidth <= node.clientWidth), true);
    console.log('PASS: question routing, CHE, JSON export, XYZ, mobile layout, no external requests');
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
