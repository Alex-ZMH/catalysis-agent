// Run against a dedicated synthetic project. No research files are needed.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const {createHash} = require("node:crypto");
const {chromium} = require("playwright-core");

async function main() {
  const [base, directory] = process.argv.slice(2);
  assert.equal(new URL(base).hostname, "127.0.0.1");
  const cases = JSON.parse(fs.readFileSync(path.join(directory, "cases.json"), "utf8"));
  const browser = await chromium.launch({executablePath: process.env.CHROME_BIN, headless: true,
    args: ["--disable-background-networking", "--disable-component-update", "--disable-sync"]});
  try {
    const page = await browser.newPage({viewport:{width:1440, height:960}, acceptDownloads:true});
    const errors = [], external = [];
    await page.route("**/*", route => {
      if (new URL(route.request().url()).origin === base) return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
    page.on("pageerror", error => errors.push(error.message));
    async function openPanel() {
      const panel = page.locator("#analysis-panel");
      if (!(await panel.evaluate(node => node.open))) {
        await page.locator("#analysis-nav").click();
      }
    }
    await page.goto(base + "/#studio");
    await openPanel();
    const runs = [];
    for (const key of ["vasp", "csv", "xlsx"]) {
      const {filename, options} = cases[key];
      const kind = key === "vasp" ? "adsorption" : "kinetics";
      await page.selectOption("#analysis-kind", kind);
      await page.selectOption("#analysis-origin", "synthetic");
      if (options.model) await page.selectOption("#analysis-form [name=model]", options.model);
      const advanced = page.locator("#analysis-options");
      if (!(await advanced.isVisible())) await advanced.locator("..").locator("..").locator("summary").click();
      await advanced.fill(JSON.stringify(options));
      await page.setInputFiles("#analysis-upload", path.join(directory, filename));
      const response = page.waitForResponse(r => r.url() === base + "/api/runs" && r.request().method() === "POST");
      await page.click("#analysis-submit");
      const reply = await response;
      const run = await reply.json();
      assert.equal(reply.status(), 200, run.error);
      const result = page.locator("#analysis-results");
      await result.getByText(filename, {exact:true}).first().waitFor();
      const original = run.artifacts.find(a => a.id === run.raw_id);
      const disk = fs.readFileSync(path.join(directory, filename));
      assert.equal(original.sha256, createHash("sha256").update(disk).digest("hex"));
      const downloadPromise = page.waitForEvent("download");
      await result.getByRole("link",{name:filename,exact:true}).click();
      const downloaded = await downloadPromise;
      assert.deepEqual(fs.readFileSync(await downloaded.path()), disk);
      const manifestResponse = await page.request.get(base + run.manifest_url);
      assert.equal((await manifestResponse.json()).run_id,run.id);
      const visibleResult = await result.innerText();
      assert.ok(visibleResult.includes("合成数据"));
      if (key === "vasp") {
        const labels = new Map(run.details.runs.map(row => [row.structure_id, row.logical_id]));
        const rows = Object.fromEntries(run.result.results.map(row => [labels.get(row.structure_id), row]));
        assert.equal(rows.top.adsorption_energy,-1.5);
        assert.equal(rows.bridge.adsorption_energy,-1);
        assert.deepEqual(run.details.ranking.map(id => labels.get(id)),["top","bridge"]);
        assert.deepEqual(rows.hollow.reasons,["unconverged"]);
        assert.deepEqual(rows.variant.reasons,["electronic_method"]);
        assert.ok(visibleResult.includes("eV"));
      } else if (key === "csv") {
        assert.ok(Math.abs(run.result.activation_energy / 52000 - 1) < 0.01);
        assert.ok(visibleResult.includes("活化能"));
      } else {
        assert.ok(Math.abs(run.result.orders.A - 0.8) < 0.02);
        assert.ok(Math.abs(run.result.orders.B + 0.35) < 0.02);
        assert.ok(visibleResult.includes("反应级数"));
      }
      runs.push({key,filename,id:run.id,sha256:original.sha256,result:run.result});
    }
    await page.selectOption("#analysis-kind", "adsorption");
    await page.locator("#analysis-options").fill('{"cell_limits_A":[50,50,10]}');
    await page.setInputFiles("#analysis-upload", path.join(directory,cases.vasp.filename));
    const rejected = page.waitForResponse(r => r.url() === base + "/api/runs" && r.request().method() === "POST");
    await page.click("#analysis-submit");
    const response = await rejected;
    assert.equal(response.status(),400);
    assert.match((await response.json()).error,/exceeded_axes/);
    await page.waitForFunction(() => document.querySelector("#analysis-status").textContent.includes("分析失败"));
    assert.ok(await page.locator("#analysis-results").isHidden());
    await page.reload();
    await openPanel();
    await page.locator("#analysis-history-list button").filter({hasText: cases.vasp.filename}).first().click();
    await page.locator("#analysis-results").getByText(cases.vasp.filename,{exact:true}).first().waitFor();
    const cell = page.locator("#analysis-cell");
    if (!(await cell.evaluate(el => el.open))) await cell.locator("summary").click();
    await page.setInputFiles("#cell-upload",path.join(directory,"POSCAR"));
    await page.selectOption("#cell-mode","construct");
    await page.fill("#cell-form [name=vacuum_A]", "24");
    await page.fill("#cell-form [name=repeat_a]", "2");
    await page.fill("#cell-form [name=repeat_b]", "2");
    async function cellPlan() {
      const response = page.waitForResponse(r => r.url() === base + "/api/cell");
      await page.click("#cell-submit");
      return (await response).json();
    }
    const plan = await cellPlan();
    assert.equal(plan.within_limit,true,plan.error);
    assert.deepEqual(plan.lengths_A,{a:36,b:32,c:32});
    assert.equal(plan.atom_mapping.length,8);
    const dl = page.waitForEvent("download");
    await page.locator("#cell-results a[download]").click();
    assert.equal(fs.readFileSync(await (await dl).path(),"utf8"),plan.poscar);
    await page.fill("#cell-form [name=vacuum_A]", "43");
    const over = await cellPlan();
    assert.equal(over.within_limit,false);
    assert.deepEqual(over.exceeded_axes,["c"]);
    assert.equal(over.lengths_A.c,51);
    assert.equal(over.poscar,undefined);
    await page.locator("#cell-status").getByText(/超限/).waitFor();
    assert.equal(await page.locator("#cell-results a[download]").count(),0);
    assert.deepEqual(errors,[]);
    assert.deepEqual(external,[]);
    console.log(JSON.stringify({runs, cell:{accepted:plan.lengths_A,rejected:over.lengths_A},external,errors}));
  } finally {
    await browser.close();
  }
}
main().catch(error=>{console.error(error);process.exitCode=1});
