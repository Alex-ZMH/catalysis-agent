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
    const poscarPath = path.join(directory,"POSCAR");
    const originalPoscar = fs.readFileSync(poscarPath);
    await page.setInputFiles("#cell-upload",poscarPath);
    await page.selectOption("#cell-mode","construct");
    await page.fill("#cell-form [name=repeat_a]", "2");
    await page.fill("#cell-form [name=repeat_b]", "2");
    await page.fill("#cell-form [name=repeat_c]", "1");
    // Chromium omits file contents from Playwright's multipart request data.
    await page.evaluate(() => {
      const fetch = window.fetch;
      window.cellUploads = [];
      window.fetch = (url, init) => {
        if (url === "/api/cell") {
          const file = init.body.get("file");
          window.cellUploads.push(file.arrayBuffer().then(bytes => ({
            name: file.name,
            bytes: Array.from(new Uint8Array(bytes)),
            options: JSON.parse(init.body.get("options")),
          })));
        }
        return fetch(url, init);
      };
    });
    async function cellPlan(vacuum) {
      await page.fill("#cell-form [name=vacuum_A]", String(vacuum));
      const response = page.waitForResponse(r => r.url() === base + "/api/cell" && r.request().method() === "POST");
      await page.click("#cell-submit");
      const reply = await response;
      const plan = await reply.json();
      assert.equal(reply.status(), 200, plan.error);

      const upload = await page.evaluate(() => window.cellUploads.shift());
      assert.equal(upload.name, "POSCAR");
      assert.deepEqual(Buffer.from(upload.bytes), originalPoscar);
      assert.deepEqual(upload.options.repeats, [2,2,1]);
      assert.equal(upload.options.vacuum_A, vacuum);
      assert.deepEqual(plan.repeats, [2,2,1]);
      assert.equal(plan.vacuum_A, vacuum);
      return plan;
    }
    const plan = await cellPlan(42);
    assert.equal(plan.within_limit,true,plan.error);
    assert.deepEqual(plan.lengths_A,{a:36,b:32,c:50});
    assert.equal(plan.actual_vacuum_A,42);
    assert.equal(plan.atom_count,8);
    assert.equal(plan.atom_mapping.length,8);
    const dl = page.waitForEvent("download");
    await page.locator("#cell-results a[download]").click();
    const downloadedPoscar = fs.readFileSync(await (await dl).path(),"utf8");
    assert.equal(downloadedPoscar,plan.poscar);
    const lines = downloadedPoscar.trimEnd().split("\n");
    assert.equal(Number(lines[1]),1);
    assert.deepEqual(lines.slice(2,5).map(line => line.trim().split(/\s+/).map(Number)),[[36,0,0],[0,32,0],[0,0,50]]);
    assert.deepEqual(lines.slice(5,9),["Si","8","Selective dynamics","Direct"]);
    const atoms = lines.slice(9);
    assert.equal(atoms.length,8);
    const normalPositions = atoms.map(line => Number(line.trim().split(/\s+/)[2]) * 50);
    assert.ok(Math.abs(50 - (Math.max(...normalPositions) - Math.min(...normalPositions)) - 42) < 1e-9);
    const over = await cellPlan(43);
    assert.equal(over.within_limit,false);
    assert.deepEqual(over.exceeded_axes,["c"]);
    assert.equal(over.lengths_A.c,51);
    assert.equal(over.poscar,undefined);
    await page.locator("#cell-status").getByText(/超限/).waitFor();
    assert.equal(await page.locator("#cell-results a[download]").count(),0);
    assert.equal(await page.locator("#cell-form").getAttribute("data-poscar-url"),null);
    assert.deepEqual(errors,[]);
    assert.deepEqual(external,[]);
    console.log(JSON.stringify({runs, cell:{accepted:plan.lengths_A,rejected:over.lengths_A},external,errors}));
  } finally {
    await browser.close();
  }
}
main().catch(error=>{console.error(error);process.exitCode=1});
