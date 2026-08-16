import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { atomicJson } from "./artifacts.js";
import { htmlDashboard } from "./dashboard.js";
import { resolveModelConfiguration, type ModelConfiguration } from "./model.js";
import { loadPack } from "./pack.js";
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

export interface LabRun {
  id: string;
  status: "COMPLETED" | "ERROR" | "ABORTED" | "MISSING";
  results: CaseResult[];
}

export interface LabScoreInput {
  expectedRepeatCount: number;
  expectedCases: Record<string, Verdict>;
  runs: LabRun[];
}

export interface LabScore {
  status: "COMPLETED" | "ERROR" | "ABORTED";
  stable: boolean;
  exitCode: 0 | 1 | 130;
  lines: string[];
}

function expectedVerdict(expectations: Record<string, Verdict>, caseId: string): Verdict {
  return expectations[caseId] ?? "PASS";
}

function outcome(result: CaseResult): string {
  return result.executionStatus === "error" ? "CASE_ERROR" : result.verdict ?? "CASE_ERROR";
}

export function scoreLab({ expectedRepeatCount, expectedCases, runs }: LabScoreInput): LabScore {
  const caseIds = Object.keys(expectedCases).sort();
  const scheduledRuns = Array.from({ length: expectedRepeatCount }, (_, index) => runs[index]);
  let exactInventory = caseIds.length > 0 && runs.length === expectedRepeatCount;

  for (const run of scheduledRuns) {
    if (!run || run.status !== "COMPLETED" || run.results.length !== caseIds.length) exactInventory = false;
    const resultCounts: Record<string, number> = {};
    for (const result of run?.results ?? []) {
      resultCounts[result.testCaseId] = (resultCounts[result.testCaseId] ?? 0) + 1;
    }
    if (caseIds.some((caseId) => resultCounts[caseId] !== 1) || Object.keys(resultCounts).some((caseId) => !Object.hasOwn(expectedCases, caseId))) exactInventory = false;
  }

  const lines = [
    "# Lab scorecard",
    "",
    `| case | expected | ${scheduledRuns.map((_, index) => `r${index + 1}`).join(" | ")} | match |`,
    `| --- | --- | ${scheduledRuns.map(() => "---").join(" | ")} | --- |`,
  ];
  let verdictsMatch = true;
  for (const caseId of caseIds) {
    const expected = expectedVerdict(expectedCases, caseId);
    const actual = scheduledRuns.map((run) => {
      if (!run) return "MISSING";
      const matching = run.results.filter((result) => result.testCaseId === caseId);
      return matching.length === 1 && matching[0] ? outcome(matching[0]) : matching.length === 0 ? "MISSING" : "DUPLICATE";
    });
    const match = actual.every((value) => value === expected);
    if (!match) verdictsMatch = false;
    lines.push(`| ${caseId} | ${expected} | ${actual.join(" | ")} | ${match ? "yes" : "no"} |`);
  }

  const status = runs.some((run) => run.status === "ABORTED")
    ? "ABORTED"
    : exactInventory ? "COMPLETED" : "ERROR";
  const stable = status === "COMPLETED" && verdictsMatch;
  const exitCode = status === "ABORTED" ? 130 : stable ? 0 : 1;
  lines.push("", "## Repeats", "", "| repeat | status |", "| --- | --- |");
  for (let index = 0; index < expectedRepeatCount; index += 1) {
    lines.push(`| r${index + 1} | ${runs[index]?.status ?? "MISSING"} |`);
  }
  lines.push("", `Status: **${status}**`, `Stable: **${stable ? "yes" : "no"}**`, "");
  return { status, stable, exitCode, lines };
}

export async function runLab(options: LabOptions): Promise<{ exitCode: number; scorecard: string }> {
  const configured = parse(await readFile(join(options.packDirectory, "lab.yaml"), "utf8")) as LabExpectationFile;
  const repeat = options.repeat ?? configured.repeat ?? 5;
  const environment = {
    ...process.env,
    TARGET_URL: "http://127.0.0.1:3200/",
    QA_ALLOWED_ORIGINS: "http://127.0.0.1:3200",
    QA_EMAIL: "qa@example.test",
    QA_PASSWORD: "fixture-password",
  };
  const loadedPack = await loadPack(options.packDirectory, environment);
  const expectedCases = Object.fromEntries(loadedPack.cases.map(({ testCase }) => [testCase.id, "PASS" as Verdict]));
  for (const [caseId, verdict] of Object.entries(configured.expected ?? {})) {
    if (!Object.hasOwn(expectedCases, caseId)) throw new Error(`lab.yaml expected verdict references unapproved case ${caseId}`);
    expectedCases[caseId] = verdict;
  }
  await mkdir(options.outputDirectory, { recursive: true });
  const server = Bun.spawn(["bun", "run", "fixtures/lab-apps.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, QA_LAB_PORT: "3200", QA_EMAIL: "qa@example.test", QA_PASSWORD: "fixture-password" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const runs: LabRun[] = [];
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
      runs.push({ id: `run-${String(index + 1).padStart(2, "0")}`, status: output.summary.status, results: output.results });
    }
  } finally {
    server.kill();
    await server.exited;
  }
  const scored = scoreLab({ expectedRepeatCount: repeat, expectedCases, runs });
  const scorecard = scored.lines.join("\n");
  await Bun.write(join(options.outputDirectory, "scorecard.md"), scorecard);
  const flat = runs.flatMap((run) => run.results);
  const summary = summarize(flat, scored.status);
  await atomicJson(join(options.outputDirectory, "summary.json"), { repeat, completedRepeats: runs.length, stable: scored.stable, status: scored.status, summary, expectations: expectedCases });
  await Bun.write(join(options.outputDirectory, "dashboard.html"), htmlDashboard(flat, summary, await loadAccess(options.outputDirectory)));
  await Bun.write(join(options.outputDirectory, "report.md"), markdownReport(flat, summary));
  return { exitCode: options.signal?.aborted ? 130 : scored.exitCode, scorecard };
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
