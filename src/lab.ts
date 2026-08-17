import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { atomicJson } from "./artifacts.js";
import { cleanupProcessGroup, signalProcessGroup } from "./child-process.js";
import { htmlLabDashboard, htmlMissingRunDashboard, type LabDashboardRow } from "./dashboard.js";
import { resolveModelConfiguration, type ModelConfiguration } from "./model.js";
import { loadPack } from "./pack.js";
import { markdownReport, summarize } from "./report.js";
import { validateResult, type CaseResult, type Verdict } from "./schema.js";

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
  durationMs?: number;
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

async function forwardOutput(stream: ReadableStream<Uint8Array>, destination: NodeJS.WriteStream): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return;
      destination.write(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
}


export function markLabAborted(runs: LabRun[], repeat: number): void {
  if (repeat <= 0 || runs.some((run) => run.status === "ABORTED")) return;
  if (runs.length < repeat) {
    runs.push({ id: `run-${String(runs.length + 1).padStart(2, "0")}`, status: "ABORTED", results: [], durationMs: 0 });
    return;
  }
  const last = runs[repeat - 1]!;
  runs[repeat - 1] = { ...last, status: "ABORTED" };
}

export function reconcileChildRunStatus(exitCode: number, persistedStatus: LabRun["status"]): LabRun["status"] {
  if (exitCode === 130 || persistedStatus === "ABORTED") return "ABORTED";
  if (persistedStatus === "ERROR" || persistedStatus === "MISSING" || (exitCode !== 0 && exitCode !== 1)) return "ERROR";
  return "COMPLETED";
}

async function runIsolatedPack(options: LabOptions, environment: NodeJS.ProcessEnv, outputDirectory: string): Promise<{ status: LabRun["status"]; results: CaseResult[] }> {
  const child = Bun.spawn([process.execPath, "src/cli.ts", "run", "--pack", options.packDirectory, "--out", outputDirectory], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...environment,
      QA_MODEL_API_KEY: options.apiKey,
      QA_MODEL_PROVIDER: options.modelConfiguration.provider,
      QA_MODEL_ID: options.modelConfiguration.model,
    },
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  const stdout = forwardOutput(child.stdout, process.stdout);
  const stderr = forwardOutput(child.stderr, process.stderr);
  let forceTimer: Parameters<typeof clearTimeout>[0];
  const abortChild = () => {
    signalProcessGroup(child.pid, "SIGINT", () => child.kill("SIGINT"));
    forceTimer = setTimeout(() => signalProcessGroup(child.pid, "SIGKILL", () => child.kill("SIGKILL")), 30_000);
  };
  options.signal?.addEventListener("abort", abortChild, { once: true });
  if (options.signal?.aborted) abortChild();
  let exitCode = 2;
  try {
    exitCode = await child.exited;
    const survivors = await cleanupProcessGroup(child.pid, () => child.kill("SIGKILL"));
    if (survivors.length > 0) throw new Error(`isolated run process group survived cleanup: ${survivors.join(", ")}`);
    await Promise.all([stdout, stderr]);
  } finally {
    clearTimeout(forceTimer);
    options.signal?.removeEventListener("abort", abortChild);
  }
  const persisted = JSON.parse(await readFile(join(outputDirectory, "results.json"), "utf8")) as { status?: unknown; results?: unknown };
  if (!Array.isArray(persisted.results) || !["COMPLETED", "ERROR", "ABORTED"].includes(String(persisted.status))) throw new Error("isolated run produced invalid results.json");
  return { status: reconcileChildRunStatus(exitCode, persisted.status as LabRun["status"]), results: persisted.results.map((result) => validateResult(result)) };
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
  const healthToken = crypto.randomUUID();
  const server = Bun.spawn(["bun", "run", "fixtures/lab-apps.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, QA_LAB_PORT: "3200", QA_LAB_HEALTH_TOKEN: healthToken, QA_EMAIL: "qa@example.test", QA_PASSWORD: "fixture-password" },
    stdout: "inherit",
    stderr: "inherit",
    detached: true,
  });
  const runs: LabRun[] = [];
  let fatalError: string | null = null;
  const runId = (index: number) => `run-${String(index + 1).padStart(2, "0")}`;
  try {
    const started = Date.now();
    let ready = false;
    while (Date.now() - started < 8_000) {
      if (options.signal?.aborted) break;
      try {
        const response = await fetch("http://127.0.0.1:3200/__qa_health", { signal: AbortSignal.timeout(1_000) });
        if (response.ok && await response.text() === healthToken) {
          ready = true;
          break;
        }
      } catch {
        await Bun.sleep(150);
      }
    }
    if (!ready && !options.signal?.aborted) throw new Error("lab fixture did not become ready within 8 seconds");
    for (let index = 0; index < repeat; index += 1) {
      if (options.signal?.aborted) break;
      process.stderr.write(`qa lab: run ${index + 1}/${repeat}\n`);
      const id = runId(index);
      const outputDirectory = join(options.outputDirectory, id);
      const startedAt = Date.now();
      try {
        const output = await runIsolatedPack(options, environment, outputDirectory);
        runs.push({ id, status: output.status, results: output.results, durationMs: Date.now() - startedAt });
        if (output.status === "ABORTED") break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        runs.push({ id, status: options.signal?.aborted ? "ABORTED" : "ERROR", results: [], durationMs: Date.now() - startedAt });
        await mkdir(outputDirectory, { recursive: true });
        await Bun.write(join(outputDirectory, "dashboard.html"), htmlMissingRunDashboard(id, options.signal?.aborted ? "ABORTED" : "ERROR", message));
        if (options.signal?.aborted) break;
      }
    }
  } catch (error) {
    fatalError = error instanceof Error ? error.message : String(error);
  } finally {
    signalProcessGroup(server.pid, "SIGTERM", () => server.kill("SIGTERM"));
    const exited = await Promise.race([server.exited.then(() => true), Bun.sleep(5_000).then(() => false)]);
    if (!exited) signalProcessGroup(server.pid, "SIGKILL", () => server.kill("SIGKILL"));
    await Promise.race([server.exited, Bun.sleep(1_000)]);
    const survivors = await cleanupProcessGroup(server.pid, () => server.kill("SIGKILL"));
    if (survivors.length > 0) fatalError = `lab fixture process group survived cleanup: ${survivors.join(", ")}`;
  }
  if (fatalError && runs.length < repeat) {
    const id = runId(runs.length);
    runs.push({ id, status: options.signal?.aborted ? "ABORTED" : "ERROR", results: [], durationMs: 0 });
    const directory = join(options.outputDirectory, id);
    await mkdir(directory, { recursive: true });
    await Bun.write(join(directory, "dashboard.html"), htmlMissingRunDashboard(id, options.signal?.aborted ? "ABORTED" : "ERROR", fatalError));
  } else if (fatalError && runs.length > 0 && !options.signal?.aborted) {
    const last = runs[runs.length - 1]!;
    runs[runs.length - 1] = { ...last, status: "ERROR" };
  }
  const persistRootArtifacts = async () => {
    const scored = scoreLab({ expectedRepeatCount: repeat, expectedCases, runs });
    const scorecard = scored.lines.join("\n");
    await Bun.write(join(options.outputDirectory, "scorecard.md"), scorecard);
    const flat = runs.flatMap((run) => run.results);
    const summary = summarize(flat, scored.status);
    const rows: LabDashboardRow[] = Array.from({ length: repeat }, (_, index) => {
      const run = runs[index];
      return {
        id: runId(index),
        status: run?.status ?? "MISSING",
        counts: summarize(run?.results ?? [], run?.status === "ABORTED" ? "ABORTED" : run?.status === "ERROR" ? "ERROR" : "COMPLETED").counts,
        durationMs: run?.durationMs ?? 0,
      };
    });
    for (const row of rows) {
      if (row.status === "COMPLETED") continue;
      const directory = join(options.outputDirectory, row.id);
      await mkdir(directory, { recursive: true });
      const dashboard = join(directory, "dashboard.html");
      if (!(await Bun.file(dashboard).exists())) await Bun.write(dashboard, htmlMissingRunDashboard(row.id, row.status));
    }
    await atomicJson(join(options.outputDirectory, "summary.json"), { repeat, completedRepeats: runs.filter((run) => run.status === "COMPLETED").length, stable: scored.stable, status: scored.status, exitCode: scored.exitCode, summary, expectations: expectedCases, runs });
    await Bun.write(join(options.outputDirectory, "dashboard.html"), htmlLabDashboard(rows));
    await Bun.write(join(options.outputDirectory, "report.md"), markdownReport(flat, summary));
    return { exitCode: scored.exitCode, scorecard };
  };
  while (true) {
    const abortedBeforePersist = Boolean(options.signal?.aborted);
    if (abortedBeforePersist) markLabAborted(runs, repeat);
    const output = await persistRootArtifacts();
    if (Boolean(options.signal?.aborted) === abortedBeforePersist) return output;
  }
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
