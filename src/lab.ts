import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { atomicJson } from "./artifacts.js";
import { htmlDashboard } from "./dashboard.js";
import { resolveModelConfiguration, type ModelConfiguration } from "./model.js";
import { loadAccess, markdownReport, summarize } from "./report.js";
import { runPack } from "./run.js";
import type { CaseResult, Verdict } from "./schema.js";

export interface LabOptions {
  packDirectory: string;
  outputDirectory: string;
  repeat?: number;
  apiKey: string;
  modelConfiguration: ModelConfiguration;
  signal?: AbortSignal;
}

export interface LabExpectationFile {
  repeat?: number;
  expected?: Record<string, Verdict>;
}

function expectedVerdict(expectations: Record<string, Verdict>, caseId: string): Verdict {
  return expectations[caseId] ?? "PASS";
}

function outcome(result: CaseResult): string {
  return result.executionStatus === "error" ? "CASE_ERROR" : result.verdict ?? "CASE_ERROR";
}

export function scoreLab(runs: CaseResult[][], expectations: Record<string, Verdict>): { stable: boolean; lines: string[] } {
  const caseIds = [...new Set(runs.flat().map((result) => result.testCaseId))].sort();
  const lines = ["# Lab scorecard", "", `| case | expected | ${runs.map((_, index) => `r${index + 1}`).join(" | ")} | match |`, `| --- | --- | ${runs.map(() => "---").join(" | ")} | --- |`];
  let stable = true;
  for (const caseId of caseIds) {
    const expected = expectedVerdict(expectations, caseId);
    const actual = runs.map((results) => {
      const result = results.find((item) => item.testCaseId === caseId);
      return result ? outcome(result) : "MISSING";
    });
    const match = actual.every((value) => value === expected);
    if (!match) stable = false;
    lines.push(`| ${caseId} | ${expected} | ${actual.join(" | ")} | ${match ? "yes" : "no"} |`);
  }
  lines.push("", `Stable: **${stable ? "yes" : "no"}**`, "");
  return { stable, lines };
}

export async function runLab(options: LabOptions): Promise<{ exitCode: number; scorecard: string }> {
  if (!options.apiKey) throw new Error("QA_MODEL_API_KEY is required for qa lab");
  const configured = parse(await readFile(join(options.packDirectory, "lab.yaml"), "utf8")) as LabExpectationFile;
  const repeat = options.repeat ?? configured.repeat ?? 5;
  const expectations = configured.expected ?? {};
  await mkdir(options.outputDirectory, { recursive: true });
  const server = Bun.spawn(["bun", "run", "fixtures/lab-apps.ts"], {
    cwd: join(import.meta.dir, ".."),
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
  const runs: CaseResult[][] = [];
  try {
    const started = Date.now();
    while (Date.now() - started < 8_000) {
      try {
        if ((await fetch("http://127.0.0.1:3200/")).ok) break;
      } catch {
        await Bun.sleep(150);
      }
    }
    for (let index = 0; index < repeat; index += 1) {
      if (options.signal?.aborted) break;
      process.stderr.write(`qa lab: run ${index + 1}/${repeat}\n`);
      const outputDirectory = join(options.outputDirectory, `run-${String(index + 1).padStart(2, "0")}`);
      const output = await runPack({
        packDirectory: options.packDirectory,
        outputDirectory,
        apiKey: options.apiKey,
        modelConfiguration: options.modelConfiguration,
        environment,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      runs.push(output.results);
    }
  } finally {
    server.kill();
    await server.exited;
  }
  const scored = scoreLab(runs, expectations);
  const scorecard = scored.lines.join("\n");
  await Bun.write(join(options.outputDirectory, "scorecard.md"), scorecard);
  const flat = runs.flat();
  const summary = summarize(flat);
  await atomicJson(join(options.outputDirectory, "summary.json"), { repeat: runs.length, stable: scored.stable, summary, expectations });
  await Bun.write(join(options.outputDirectory, "dashboard.html"), htmlDashboard(flat, summary, await loadAccess(options.outputDirectory)));
  await Bun.write(join(options.outputDirectory, "report.md"), markdownReport(flat, summary));
  return { exitCode: scored.stable ? summary.exitCode === 2 ? 2 : 0 : 1, scorecard };
}

export async function labFromCli(packDirectory: string, outputDirectory: string, repeat?: number, signal?: AbortSignal): Promise<number> {
  const output = await runLab({
    packDirectory,
    outputDirectory,
    ...(repeat ? { repeat } : {}),
    apiKey: process.env.QA_MODEL_API_KEY ?? "",
    modelConfiguration: resolveModelConfiguration(),
    ...(signal ? { signal } : {}),
  });
  process.stdout.write(`${output.scorecard}\n`);
  return output.exitCode;
}
