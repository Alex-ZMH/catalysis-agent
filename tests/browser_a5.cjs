// Run in a loopback synthetic project. The optional directory receives real browser screenshots.
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

async function main() {
  const [base, directory, screenshots] = process.argv.slice(2);
  assert.equal(new URL(base).hostname, "127.0.0.1");
  const read = name => fs.readFileSync(path.join(directory, name));
  const cases = JSON.parse(read("cases.json"));
  if (screenshots) fs.mkdirSync(screenshots, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN, headless: true,
    args: ["--disable-background-networking", "--disable-component-update", "--disable-sync"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1080 }, acceptDownloads: true });
    const errors = [], external = [], runs = [], discrepancies = [];
    page.on("pageerror", err => errors.push(err.message));
    await page.route("**/*", route => {
      if (new URL(route.request().url()).origin === base) return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
    const panel = page.locator("#analysis-panel");
    async function openPanel() {
      await panel.waitFor({ state: "attached" });
      if (!await panel.evaluate(node => node.open)) await page.click("#analysis-nav");
    }
    async function capture(name, selector) {
      if (!screenshots) return;
      const anchor = page.locator(selector).first();
      await anchor.evaluate(node => node.scrollIntoView({ behavior: "instant", block: "start" }));
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: path.join(screenshots, name + ".png"), animations: "disabled" });
    }
    async function submit() {
      const pending = page.waitForResponse(r => r.url() === base + "/api/runs" && r.request().method() === "POST");
      await page.click("#analysis-submit");
      return pending;
    }
    async function rows(selector) {
      return page.locator(selector + " tbody tr").evaluateAll(nodes =>
        nodes.map(row => Array.from(row.cells, cell => cell.textContent.trim())));
    }
    async function listRuns() {
      const response = await page.request.get(base + "/api/runs");
      return (await response.json()).runs.map(row => row.id);
    }
    await page.goto(base + "/#studio");
    await openPanel();
    for (const kind of ["md", "equipment"]) {
      const { filename, reference, options } = cases[kind];
      const oracle = JSON.parse(read(reference));
      await page.selectOption("#analysis-kind", kind);
      await page.selectOption("#analysis-origin", "synthetic");
      await page.fill("#analysis-length-unit", options.length_unit);
      const advanced = page.locator("#analysis-advanced");
      if (options.field_units) {
        if (!await advanced.evaluate(el => el.open)) await advanced.locator("summary").click();
        await page.fill("#analysis-options", JSON.stringify({ field_units: options.field_units }));
        await advanced.locator("summary").click();
      }
      await page.setInputFiles("#analysis-upload", path.join(directory, filename));
      await page.setInputFiles("#analysis-reference", path.join(directory, reference));
      await capture(kind + "-upload", "#analysis-form");
      const response = await submit();
      const run = await response.json();
      assert.equal(response.status(), 200, run.error);
      assert.equal(run.origin, "synthetic");
      await page.locator("#analysis-a5-comparison").getByText("已与独立参考比较", { exact: true }).waitFor();
      if (kind === "md") {
        assert.equal(run.result.dump.length_unit, oracle.length_unit);
        assert.equal(run.result.dump.coordinate_mode, oracle.coordinate_mode);
        assert.equal(run.details.reference_verified, true);
        const frameChecks = await rows("#analysis-md-frame-checks");
        assert.equal(frameChecks.length, oracle.frames.length);
        for (const target of oracle.frames) {
          await page.fill("#analysis-md-step", String(target.timestep));
          await page.locator("#analysis-md-step-form button").click();
          await page.locator("#analysis-md-frames h4").getByText("时间步 " + target.timestep, { exact: true }).waitFor();
          const frameText = await page.locator("#analysis-md-frames").innerText();
          assert.ok(frameText.includes(target.cell.periodic.map(p => p ? "周期" : "非周期").join(" / ")));
          for (const vector of [target.cell.origin, ...target.cell.vectors]) assert.ok(frameText.includes(vector.join(", ")));
          const got = new Map((await rows("#analysis-md-atoms")).map(row => [Number(row[0]), row.slice(1).map(Number)]));
          assert.equal(got.size, target.atoms.length);
          for (const atom of target.atoms) assert.deepEqual(got.get(atom.id), atom.position);
          const check = frameChecks.find(row => Number(row[0]) === target.timestep);
          assert.equal(Number(check[1]), target.atoms.length);
          assert.ok(Number(check[2]) <= oracle.absolute_tolerance);
          if (target.timestep === 120) await capture("md-frame-120", "#analysis-md-result");
        }
      } else {
        const fields = await rows("#analysis-equipment-fields");
        assert.deepEqual(fields.map(row => row.slice(1)), [["T", "1", "K"], ["T", "1", "K"]]);
        for (const [index, expected] of oracle.profiles.entries()) {
          const owner = page.locator("#analysis-equipment-profiles");
          if (index) await owner.getByRole("button", { name: "下一页", exact: true }).first().click();
          assert.ok((await owner.innerText()).includes("（" + expected.field.association + "）"));
          const samples = await rows("#analysis-equipment-samples");
          assert.equal(samples.length, expected.values.length);
          samples.forEach((row, i) => {
            assert.equal(Number(row[1]), expected.fractions[i]);
            assert.equal(Number(row[3]), expected.values[i]);
            assert.ok(Math.abs(Number(row[2]) - expected.values[i]) <= expected.absolute_tolerance);
            assert.ok(Number(row[4]) <= expected.absolute_tolerance);
            assert.equal(row[5], "有效");
          });
          await capture("equipment-" + expected.field.association, "#analysis-equipment-fields");
        }
      }
      const manifest = await (await page.request.get(base + run.manifest_url)).json();
      assert.deepEqual(new Set(manifest.inputs), new Set([run.raw_id, run.reference_id]));
      const sourceHashes = {};
      for (const [name, id] of [[filename, run.raw_id], [reference, run.reference_id]]) {
        const original = run.artifacts.find(a => a.id === id);
        const disk = read(name);
        assert.equal(original.sha256, sha256(disk));
        const link = page.locator(".ca-artifacts").getByRole("link", { name, exact: true });
        const row = link.locator("..");
        assert.ok((await row.innerText()).includes(original.sha256));
        const download = page.waitForEvent("download");
        await link.click();
        assert.deepEqual(fs.readFileSync(await (await download).path()), disk);
        sourceHashes[name] = original.sha256;
      }
      for (const id of manifest.outputs) {
        const parents = manifest.artifacts.find(a => a.artifact_id === id).parents;
        assert.deepEqual(new Set(parents), new Set([...manifest.inputs, manifest.parameters_artifact]));
      }
      await capture(kind + "-provenance", "#analysis-results h4:text-is('来源与下载')");
      const comparisons = kind === "md" ? run.details.frame_checks : run.result.line_profiles.map(profile => ({
        field: profile.field, a: profile.a, b: profile.b, unit: profile.unit, samples: profile.samples,
        reference: profile.reference.values,
        max_abs_error: Math.max(...profile.samples.map((s, i) => Math.abs(s.value - profile.reference.values[i]))),
      }));
      runs.push({ kind, id: run.id, code_commit: manifest.code_commit, manifest: run.manifest_url, sourceHashes, comparisons });
      const bad = structuredClone(oracle);
      const historyBeforeMismatch = await listRuns();
      if (kind === "md") bad.frames[1].atoms[0].position[0] += 1;
      else bad.profiles[0].values[2] += 1;
      // The production form clears successful file selections. Re-select both original and modified reference.
      await page.setInputFiles("#analysis-upload", path.join(directory, filename));
      await page.setInputFiles("#analysis-reference", { name: "mismatch.json", mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(bad)) });
      const compared = await submit();
      const published = await compared.json();
      assert.equal(compared.status(), 200);
      assert.equal(published.details.reference_status, "mismatch");
      const problem = published.details.reference_error;
      assert.match(problem, kind === "md" ? /step 120 atom id.*axis x/ : /sample 2.*0\.4/);
      await page.locator("#analysis-results").waitFor({ state: "visible" });
      const after = await listRuns();
      assert.ok(after.includes(published.id));
      assert.deepEqual(after.filter(id => id !== published.id), historyBeforeMismatch);
      discrepancies.push({ id: published.id, problem });
    }
    await page.reload();
    await openPanel();
    for (const run of runs) {
      const opened = page.waitForResponse(r => r.url() === base + "/api/runs/" + run.id);
      await page.locator('#analysis-history-list button[data-run-id="' + run.id + '"]').click();
      assert.equal((await (await opened).json()).id, run.id);
      await page.locator("#analysis-a5-reference-artifact").getByRole("link", {name: cases[run.kind].reference}).waitFor();
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    console.log(JSON.stringify({ runs, discrepancies, external, pageErrors: errors }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
