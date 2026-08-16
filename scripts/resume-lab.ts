import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { atomicJson } from "../src/artifacts.js";
import { htmlDashboard } from "../src/dashboard.js";
import { scoreLab, type LabExpectationFile } from "../src/lab.js";
import { resolveModelConfiguration } from "../src/model.js";
import { loadAccess, markdownReport, summarize } from "../src/report.js";
import { runPack } from "../src/run.js";
import { validateResult, type CaseResult } from "../src/schema.js";

const root = process.argv[2] ?? ".qa/labs/lab-20260816-1741";
const only = (process.argv[3] ?? "4,5").split(",").map(Number);
const configured = parse(await readFile("packs/lab-smoke/lab.yaml", "utf8")) as LabExpectationFile;
const server = Bun.spawn(["bun", "run", "fixtures/lab-apps.ts"], {
  env: { ...process.env, QA_LAB_PORT: "3200", QA_EMAIL: "qa@example.test", QA_PASSWORD: "fixture-password" },
  stdout: "pipe",
  stderr: "pipe",
});
const environment = {
  ...process.env,
  TARGET_URL: "http://127.0.0.1:3200/",
  QA_ALLOWED_ORIGINS: "http://127.0.0.1:3200",
  QA_EMAIL: "qa@example.test",
  QA_PASSWORD: "fixture-password",
};

try {
  const started = Date.now();
  while (Date.now() - started < 8_000) {
    try {
      if ((await fetch("http://127.0.0.1:3200/")).ok) break;
    } catch {
      await Bun.sleep(150);
    }
  }
  for (const index of only) {
    const outputDirectory = join(root, `run-${String(index).padStart(2, "0")}`);
    await rm(outputDirectory, { recursive: true, force: true });
    process.stderr.write(`qa lab resume: run ${index}\n`);
    await runPack({
      packDirectory: "packs/lab-smoke",
      outputDirectory,
      apiKey: process.env.QA_MODEL_API_KEY ?? "",
      modelConfiguration: resolveModelConfiguration(),
      environment,
    });
  }
} finally {
  server.kill();
  await server.exited;
}

const names = (await readdir(root)).filter((name) => name.startsWith("run-")).sort();
const runs: CaseResult[][] = [];
for (const name of names) {
  try {
    const parsed = JSON.parse(await readFile(join(root, name, "results.json"), "utf8")) as { results: unknown[] };
    runs.push(parsed.results.map((result) => validateResult(result)));
  } catch {
    runs.push([]);
  }
}
const scored = scoreLab(runs, configured.expected ?? {});
const scorecard = scored.lines.join("\n");
const flat = runs.flat();
const summary = summarize(flat);
await Bun.write(join(root, "scorecard.md"), scorecard);
await atomicJson(join(root, "summary.json"), { repeat: runs.length, stable: scored.stable, summary, expectations: configured.expected ?? {} });
await Bun.write(join(root, "dashboard.html"), htmlDashboard(flat, summary, await loadAccess(root)));
await Bun.write(join(root, "report.md"), markdownReport(flat, summary));
process.stdout.write(`${scorecard}\n`);
process.exit(scored.stable ? 0 : 1);
