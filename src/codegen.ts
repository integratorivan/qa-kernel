import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseYaml, validateCase, validatePack, validateResult, type Pack, type TestCase, type CaseResult } from "./schema.js";
import { readRecording, readinessMatchesPersisted, validateCaseResultForCodegen, validateRecordingForCase, type RecordedAction, type RecordedCheck, type RecordedLocator, type RecordingEntry, type CodegenReadiness, oracleCovered } from "./recording.js";

export type CodegenErrorCode =
  | "CODEGEN_RUN_NOT_PASS"
  | "CODEGEN_RECORDING_MISSING"
  | "CODEGEN_RECORDING_INVALID"
  | "CODEGEN_UNSUPPORTED_LOCATOR"
  | "CODEGEN_UNSUPPORTED_ORACLE"
  | "CODEGEN_UNSUPPORTED_ACTION"
  | "CODEGEN_MUTATION_NOT_NONE"
  | "CODEGEN_SECRET_LEAK"
  | "CODEGEN_OUTPUT_EXISTS";

export interface CodegenOptions { runDirectory: string; outputDirectory: string; force?: boolean }
export interface CodegenItem { caseId: string; status: "generated" | "skipped" | "error"; code?: CodegenErrorCode; file?: string }
export interface CodegenOutput { items: CodegenItem[]; exitCode: 0 | 1 }
export interface ValidatedCodegenCase {
  pack: Pack;
  testCase: TestCase;
  result: CaseResult;
  entries: RecordingEntry[];
  actions: RecordedAction[];
  checks: RecordedCheck[];
  readiness: CodegenReadiness;
  runId: string;
  yamlHash: string;
  recordingHash: string;
}

class CodegenCaseError extends Error {
  constructor(readonly code: CodegenErrorCode, message: string) {
    super(message);
    this.name = "CodegenCaseError";
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function json(value: string): string { return JSON.stringify(value); }

export function emitLocator(locator: RecordedLocator): string {
  switch (locator.kind) {
    case "testId": return `page.getByTestId(${json(locator.value)})`;
    case "label": return `page.getByLabel(${json(locator.value)}, { exact: true })`;
    case "role": return `page.getByRole(${json(locator.role)}, { name: ${json(locator.name)}, exact: true })`;
    case "placeholder": return `page.getByPlaceholder(${json(locator.value)}, { exact: true })`;
    case "text": return `page.getByText(${json(locator.value)}, { exact: true })`;
    default: return exhaustive(locator);
  }
}

export function emitAction(action: RecordedAction): string[] {
  if (action.actionStatus !== "ok") return [];
  if (action.frame !== "main") throw new CodegenCaseError("CODEGEN_UNSUPPORTED_LOCATOR", "successful action is outside the main frame");
  switch (action.action) {
    case "open": {
      if (action.url === null) throw new CodegenCaseError("CODEGEN_RECORDING_INVALID", "open action has no URL");
      const expression = action.url === "/" ? "process.env.TARGET_URL!" : `new URL(${json(action.url)}, process.env.TARGET_URL!).toString()`;
      return [`  await page.goto(${expression});`];
    }
    case "click": return [`  await ${requireLocator(action)}.click();`];
    case "fill": {
      const locator = requireLocator(action);
      if (action.from !== null) return [`  await ${locator}.fill(process.env.${action.from}!);`];
      if (action.value !== null) return [`  await ${locator}.fill(${json(action.value)});`];
      throw new CodegenCaseError("CODEGEN_RECORDING_INVALID", "fill action has no source");
    }
    case "press": return [`  await ${requireLocator(action)}.press(${json(action.key ?? "")});`];
    case "scroll": throw new CodegenCaseError("CODEGEN_UNSUPPORTED_ACTION", "scroll is not supported by the first replay contract");
  }
}

export function emitCheck(check: RecordedCheck): string[] {
  if (check.status !== "passed") return [];
  switch (check.check) {
    case "url": return [`  await expect.poll(() => new URL(page.url()).pathname)${check.state === "equals" ? `.toBe(${json(check.path)})` : `.not.toBe(${json(check.path)})`};`];
    case "text": return [`  await expect(${emitLocator({ kind: "text", value: check.text })})${check.state === "visible" ? ".toBeVisible()" : ".toBeHidden()"};`];
    case "locator": return [`  await expect(${emitLocator(check.locator)})${check.state === "visible" ? ".toBeVisible()" : ".toBeHidden()"};`];
    default: throw new CodegenCaseError("CODEGEN_RECORDING_INVALID", "unsupported check variant");
  }
}

function emitCheckLocator(check: RecordedCheck): string {
  if (check.check === "url") return "";
  if (check.check === "text") return emitLocator({ kind: "text", value: check.text });
  return emitLocator(check.locator);
}

function requireLocator(action: RecordedAction): string {
  if (action.locator === null) throw new CodegenCaseError("CODEGEN_UNSUPPORTED_LOCATOR", `successful ${action.action} has no stable locator`);
  return emitLocator(action.locator);
}

function exhaustive(value: never): never { throw new CodegenCaseError("CODEGEN_RECORDING_INVALID", `unsupported recording variant ${String(value)}`); }

export function generateSpec(input: ValidatedCodegenCase): string {
  const body: string[] = [
    `// Generated from case ${input.testCase.id} and run ${input.runId}.`,
    `// yaml-sha256: ${input.yamlHash}; recording-sha256: ${input.recordingHash}`,
    `import { expect, test } from "@playwright/test";`,
    "",
    `test(${json(`${input.testCase.id} — ${input.testCase.title}`)}, async ({ page }) => {`,
  ];
  for (const entry of input.entries) {
    if (entry.kind === "action") body.push(...emitAction(entry));
    else body.push(...emitCheck(entry));
  }
  body.push("});", "");
  return body.join("\n");
}

interface LoadedRun {
  pack: Pack;
  cases: { testCase: TestCase; source: string; file: string }[];
  results: CaseResult[];
  resultByCase: Map<string, CaseResult>;
  entries: RecordingEntry[];
  rawLines: string[];
  recordingMissing: boolean;
  persistedReadiness: Record<string, unknown>;
}

async function loadRun(directory: string): Promise<LoadedRun> {
  const [packSource, resultSource] = await Promise.all([readFile(join(directory, "pack.yaml"), "utf8"), readFile(join(directory, "results.json"), "utf8")]);
  let pack: Pack;
  try { pack = validatePack(parseYaml(packSource, "run/pack.yaml")); } catch (error) { throw new CodegenCaseError("CODEGEN_RECORDING_INVALID", `invalid copied pack.yaml: ${safeMessage(error)}`); }
  const caseDirectory = join(directory, "cases");
  let files: string[];
  try { files = (await readdir(caseDirectory)).filter((file) => file.endsWith(".yaml")).sort(); } catch (error) { throw new CodegenCaseError("CODEGEN_RECORDING_INVALID", `cannot read run cases: ${safeMessage(error)}`); }
  const cases = [] as LoadedRun["cases"];
  for (const file of files) {
    const source = await readFile(join(caseDirectory, file), "utf8");
    try { cases.push({ testCase: validateCase(parseYaml(source, `run/cases/${file}`), pack), source, file }); } catch (error) { throw new CodegenCaseError("CODEGEN_RECORDING_INVALID", `invalid copied case ${file}: ${safeMessage(error)}`); }
  }
  if (new Set(cases.map((item) => item.testCase.id)).size !== cases.length) throw new CodegenCaseError("CODEGEN_RECORDING_INVALID", "duplicate case ID in run inventory");
  let parsedResults: unknown;
  try { parsedResults = JSON.parse(resultSource); } catch (error) { throw new CodegenCaseError("CODEGEN_RECORDING_INVALID", `invalid results.json: ${safeMessage(error)}`); }
  const resultObject = parsedResults && typeof parsedResults === "object" ? parsedResults as Record<string, unknown> : null;
  if (!resultObject || !Array.isArray(resultObject.results)) throw new CodegenCaseError("CODEGEN_RECORDING_INVALID", "results.json has no results array");
  const persistedReadiness = resultObject.codegenReadiness && typeof resultObject.codegenReadiness === "object" ? resultObject.codegenReadiness as Record<string, unknown> : {};
  const results = resultObject.results.map((item: unknown) => validateResult(item));
  if (new Set(results.map((item) => item.testCaseId)).size !== results.length) throw new CodegenCaseError("CODEGEN_RECORDING_INVALID", "duplicate result case ID");
  const known = new Set(cases.map((item) => item.testCase.id));
  if (results.some((item) => !known.has(item.testCaseId))) throw new CodegenCaseError("CODEGEN_RECORDING_INVALID", "result references unknown case ID");
  const recordingPath = join(directory, "recording.ndjson");
  let recordingMissing = false;
  let recording: { entries: RecordingEntry[]; rawLines: string[] } = { entries: [], rawLines: [] };
  try {
    await access(recordingPath);
    recording = await readRecording(recordingPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") recordingMissing = true;
    else if (!recordingMissing) throw new CodegenCaseError("CODEGEN_RECORDING_INVALID", safeMessage(error));
  }
  if (recording.entries.some((entry) => !known.has(entry.caseId))) throw new CodegenCaseError("CODEGEN_RECORDING_INVALID", "recording references unknown case ID");
  return { pack, cases, results, resultByCase: new Map(results.map((result) => [result.testCaseId, result])), entries: recording.entries, rawLines: recording.rawLines, recordingMissing, persistedReadiness };
}
function safeMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

async function validateCaseForGeneration(run: LoadedRun, item: LoadedRun["cases"][number], result: CaseResult): Promise<ValidatedCodegenCase> {
  try { validateCaseResultForCodegen(result, item.testCase.id); } catch { throw new CodegenCaseError("CODEGEN_RUN_NOT_PASS", `case ${item.testCase.id} is not a PASS result`); }
  if (item.testCase.safety.mutation !== "none") throw new CodegenCaseError("CODEGEN_MUTATION_NOT_NONE", "only mutation:none cases are supported");
  const selected = run.entries.filter((entry) => entry.caseId === item.testCase.id);
  try { validateRecordingForCase(selected, item.testCase, run.pack); } catch (error) {
    const message = safeMessage(error);
    if (/secret/i.test(message)) throw new CodegenCaseError("CODEGEN_SECRET_LEAK", "recording contains a prohibited secret value");
    throw new CodegenCaseError(message.includes("grounded") ? "CODEGEN_UNSUPPORTED_ORACLE" : "CODEGEN_RECORDING_INVALID", message);
  }
  const checks = selected.filter((entry): entry is RecordedCheck => entry.kind === "check");
  const readiness = oracleCovered(item.testCase, checks);
  const persisted = run.persistedReadiness[item.testCase.id];
  if (persisted === undefined || !readinessMatchesPersisted(persisted, readiness)) throw new CodegenCaseError("CODEGEN_RECORDING_INVALID", "persisted codegenReadiness does not match recording coverage");
  if (readiness.status !== "ready") throw new CodegenCaseError("CODEGEN_UNSUPPORTED_ORACLE", "oracle is not fully covered by grounded passed checks");
  const actions = selected.filter((entry): entry is RecordedAction => entry.kind === "action" && entry.actionStatus === "ok");
  const rawLines = run.rawLines.filter((line) => line.includes(`"caseId":${JSON.stringify(item.testCase.id)}`));
  return { pack: run.pack, testCase: item.testCase, result, entries: selected, actions, checks, readiness, runId: basename(runDirectoryForHashes(run)), yamlHash: sha256(item.source), recordingHash: sha256(rawLines.join("")) };
}

function runDirectoryForHashes(run: LoadedRun): string { return (run as LoadedRun & { directory?: string }).directory ?? "run"; }

async function atomicSpec(path: string, content: string, force: boolean): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  try { await access(path); if (!force) throw new CodegenCaseError("CODEGEN_OUTPUT_EXISTS", "spec already exists"); } catch (error) { if (error instanceof CodegenCaseError) throw error; }
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}

export async function codegenRun(options: CodegenOptions): Promise<CodegenOutput> {
  let run: LoadedRun;
  try { run = await loadRun(options.runDirectory); } catch (error) {
    if (error instanceof CodegenCaseError && error.code === "CODEGEN_RECORDING_MISSING") return { items: [], exitCode: 1 };
    throw error;
  }
  (run as LoadedRun & { directory: string }).directory = options.runDirectory;
  const items: CodegenItem[] = [];
  for (const item of run.cases) {
    const result = run.resultByCase.get(item.testCase.id);
    if (!result || result.executionStatus !== "completed" || result.verdict !== "PASS") { items.push({ caseId: item.testCase.id, status: "skipped", code: "CODEGEN_RUN_NOT_PASS" }); continue; }
    if (run.recordingMissing) {
      items.push({ caseId: item.testCase.id, status: "error", code: "CODEGEN_RECORDING_MISSING" });
      continue;
    }
    try {
      const validated = await validateCaseForGeneration(run, item, result);
      const output = join(options.outputDirectory, `${item.testCase.id}.spec.ts`);
      await atomicSpec(output, generateSpec({ ...validated, runId: basename(options.runDirectory) }), options.force ?? false);
      items.push({ caseId: item.testCase.id, status: "generated", file: output });
    } catch (error) {
      const code = error instanceof CodegenCaseError ? error.code : "CODEGEN_RECORDING_INVALID";
      items.push({ caseId: item.testCase.id, status: "error", code });
    }
  }
  return { items, exitCode: items.some((item) => item.status === "error") ? 1 : 0 };
}
