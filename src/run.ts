import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { appendNdjson, atomicJson, EvidenceStore, runtimeVersions, SecretRedactor } from "./artifacts.js";
import { BrowserController, type CaseBrowser } from "./browser.js";
import { loadPack, secretsForCase, type LoadedPack } from "./pack.js";
import { extractJsonText } from "./json-text.js";
import { executePiCase, repairPiResult } from "./pi.js";
import { openRouterRouting, type ModelConfiguration } from "./model.js";

import { htmlDashboard } from "./dashboard.js";
import { loadAccess, markdownReport, summarize, type RunSummary } from "./report.js";
import { applyOracleCoverage } from "./oracle.js";
import { preflightUrl } from "./preflight.js";
import { type CaseResult, SCHEMA_VERSION, SchemaError, validateResult } from "./schema.js";

export interface RunOptions {
  packDirectory: string;
  outputDirectory: string;
  apiKey: string;
  modelConfiguration: ModelConfiguration;
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  caseExecutor?: typeof executePiCase;
  resultRepairer?: typeof repairPiResult;
  browserController?: BrowserController;
  browserPhaseTimeoutMs?: number;
  abortGraceMs?: number;
  repairTimeoutMs?: number;
  browserLaunchTimeoutMs?: number;
  finalizationTimeoutMs?: number;
  contextCloseTimeoutMs?: number;
  browserCloseTimeoutMs?: number;
  persistCheckpoint?: (write: () => Promise<void>) => Promise<void>;
}

export interface RunOutput {
  results: CaseResult[];
  summary: RunSummary;
}

class CaseDeadlineError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

async function executeWithDeadline<T>(execute: (signal: AbortSignal) => Promise<T>, externalSignal: AbortSignal | undefined, timeoutMs: number, timeoutCode: string, abortGraceMs: number): Promise<T> {
  const controller = new AbortController();
  let phaseTimer: Parameters<typeof clearTimeout>[0];
  let graceTimer: Parameters<typeof clearTimeout>[0];
  let rejectEscape: ((reason: unknown) => void) | undefined;
  const abort = (reason: unknown) => {
    if (controller.signal.aborted) return;
    controller.abort(reason);
    graceTimer = setTimeout(() => rejectEscape?.(reason), abortGraceMs);
  };
  const onExternalAbort = () => abort(externalSignal?.reason ?? new Error("case cancelled"));
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  if (externalSignal?.aborted) onExternalAbort();
  const deadline = new CaseDeadlineError(timeoutCode);
  phaseTimer = setTimeout(() => abort(deadline), timeoutMs);
  const work = execute(controller.signal);
  void work.catch(() => {});
  const escape = new Promise<never>((_, reject) => {
    rejectEscape = reject;
  });
  try {
    const result = await Promise.race([work, escape]);
    if (controller.signal.aborted) throw controller.signal.reason;
    return result;
  } finally {
    clearTimeout(phaseTimer);
    clearTimeout(graceTimer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

function caseError(caseId: string, error: unknown, redact: SecretRedactor, code = "CASE_EXECUTION"): CaseResult {
  return {
    schemaVersion: SCHEMA_VERSION,
    testCaseId: caseId,
    executionStatus: "error",
    verdict: null,
    blockedBy: null,
    actual: null,
    evidence: [],
    reviewReason: null,
    error: { code, message: redact.redact(error instanceof Error ? error.message : String(error)) },
  };
}

function technicalErrorCode(error: unknown): string {
  if (error instanceof CaseDeadlineError) return error.code;
  if (error instanceof Error && /^(CASE_PHASE|CASE_TOTAL|FINALIZATION|RESULT_REPAIR|BROWSER_LAUNCH|CONTEXT_CLOSE|BROWSER_CLOSE)_TIMEOUT$/.test(error.message)) return error.message;
  return "CASE_EXECUTION";
}

function parseModelResult(text: string): CaseResult {
  try {
    return validateResult(JSON.parse(extractJsonText(text)));
  } catch (error) {
    throw new SchemaError(error instanceof Error ? error.message : String(error));
  }
}

async function validateResultEvidence(result: CaseResult, caseId: string, stepIds: ReadonlySet<string>, evidence: EvidenceStore): Promise<void> {
  if (result.testCaseId !== caseId) throw new SchemaError(`model result belongs to ${result.testCaseId}, not ${caseId}`);
  if (result.executionStatus === "error") throw new SchemaError("model must return a completed product verdict, not a case error");
  if (result.evidence.length === 0) throw new SchemaError("completed result must include evidence-backed claims");
  for (const claim of result.evidence) {
    if (!stepIds.has(claim.stepId)) throw new SchemaError(`claim references unknown step ${claim.stepId}`);
    await evidence.validate({ caseId, stepId: claim.stepId, evidenceIds: claim.evidenceIds });
  }
}

async function persistResults(outputDirectory: string, results: readonly CaseResult[], status: RunSummary["status"]): Promise<RunSummary> {
  const summary = summarize(results, status);
  const access = await loadAccess(outputDirectory);
  await atomicJson(join(outputDirectory, "results.json"), { schemaVersion: SCHEMA_VERSION, status, results, summary });
  await Bun.write(join(outputDirectory, "report.md"), markdownReport(results, summary, access));
  await Bun.write(join(outputDirectory, "dashboard.html"), htmlDashboard(results, summary, access));
  return summary;
}

async function copyApprovedCases(pack: LoadedPack, outputDirectory: string): Promise<void> {
  const destination = join(outputDirectory, "cases");
  await mkdir(destination, { recursive: true });
  await Promise.all(pack.cases.map((item) => copyFile(join(pack.directory, "cases", item.file), join(destination, item.file))));
}

export async function runPack(options: RunOptions): Promise<RunOutput> {
  const runStartedAt = Date.now();
  const environment = options.environment ?? process.env;
  const pack = await loadPack(options.packDirectory, environment);
  await mkdir(options.outputDirectory, { recursive: true });
  await copyApprovedCases(pack, options.outputDirectory);
  const metadata = {
    schemaVersion: SCHEMA_VERSION,
    provider: options.modelConfiguration.provider,
    model: options.modelConfiguration.model,
    openRouterRouting: openRouterRouting(options.modelConfiguration),

    targetOrigins: pack.allowedOrigins,
    versions: { ...(await runtimeVersions()), chromium: null as string | null },
    timings: { startedAt: new Date(runStartedAt).toISOString(), durationMs: 0, cases: {} as Record<string, number> },
    actionCounts: {} as Record<string, number>,
    tokenUsage: {} as Record<string, unknown | null>,
  };
  const persistMeta = async () => {
    metadata.timings.durationMs = Date.now() - runStartedAt;
    await atomicJson(join(options.outputDirectory, "meta.json"), { ...metadata, updatedAt: new Date().toISOString() });
  };
  await persistMeta();
  const controller = options.browserController ?? new BrowserController(new Set(pack.allowedOrigins));
  const results: CaseResult[] = [];
  let status: RunSummary["status"] = "COMPLETED";
  let restartBeforeNextCase = false;
  const abortGraceMs = options.abortGraceMs ?? 5_000;
  const browserCloseTimeoutMs = options.browserCloseTimeoutMs ?? 10_000;
  const forceCloseController = async () => {
    try {
      await executeWithDeadline(async () => await controller.forceClose(), undefined, browserCloseTimeoutMs, "BROWSER_CLOSE_TIMEOUT", 0);
    } catch (error) {
      await appendNdjson(join(options.outputDirectory, "events.ndjson"), { type: "browser_force_close_error", at: new Date().toISOString(), code: technicalErrorCode(error), error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  };
  const closeController = async () => {
    if (!controller.isAlive()) {
      await forceCloseController();
      return;
    }
    try {
      await executeWithDeadline(async () => await controller.close(), undefined, browserCloseTimeoutMs, "BROWSER_CLOSE_TIMEOUT", 0);
    } catch (error) {
      await appendNdjson(join(options.outputDirectory, "events.ndjson"), { type: "browser_close_error", at: new Date().toISOString(), code: technicalErrorCode(error), error: error instanceof Error ? error.message : String(error) });
      await forceCloseController();
    }
  };
  if (!options.apiKey) {
    status = "ERROR";
    await appendNdjson(join(options.outputDirectory, "events.ndjson"), { type: "run_error", at: new Date().toISOString(), error: "QA_MODEL_API_KEY is required for the configured QA model" });
    await persistMeta();
    const summary = await persistResults(options.outputDirectory, results, status);
    return { results, summary };
  }

  try {
    const targetUrl = environment[pack.pack.baseUrlFrom];
    if (!targetUrl) throw new Error(`missing ${pack.pack.baseUrlFrom}`);
    await preflightUrl(targetUrl);
    await executeWithDeadline(async () => await controller.start(), options.signal, options.browserLaunchTimeoutMs ?? 30_000, "BROWSER_LAUNCH_TIMEOUT", abortGraceMs);
    metadata.versions.chromium = controller.version();
    for (let caseIndex = 0; caseIndex < pack.cases.length; caseIndex += 1) {
      const loaded = pack.cases[caseIndex]!;
      if (options.signal?.aborted) {
        status = "ABORTED";
        break;
      }
      if (!restartBeforeNextCase && !controller.isAlive()) restartBeforeNextCase = true;
      if (restartBeforeNextCase) {
        try {
          await closeController();
          await executeWithDeadline(async () => await controller.start(), options.signal, options.browserLaunchTimeoutMs ?? 30_000, "BROWSER_LAUNCH_TIMEOUT", abortGraceMs);
          metadata.versions.chromium = controller.version();
          restartBeforeNextCase = false;
          await appendNdjson(join(options.outputDirectory, "events.ndjson"), { type: "browser_restarted", at: new Date().toISOString() });
        } catch (error) {
          if (options.signal?.aborted) {
            status = "ABORTED";
            break;
          }
          status = "ERROR";
          const restartError = new Error(`browser restart failed: ${error instanceof Error ? error.message : String(error)}`);
          for (const pending of pack.cases.slice(caseIndex)) {
            results.push(caseError(pending.testCase.id, restartError, new SecretRedactor([]), "BROWSER_RECOVERY"));
            metadata.timings.cases[pending.testCase.id] = 0;
            await appendNdjson(join(options.outputDirectory, "events.ndjson"), { type: "case_error", caseId: pending.testCase.id, at: new Date().toISOString(), code: "BROWSER_RECOVERY" });
          }
          await persistMeta();
          await persistResults(options.outputDirectory, results, status);
          break;
        }
      }
      const caseStartedAt = Date.now();
      const browserPhaseTimeoutMs = options.browserPhaseTimeoutMs ?? 5 * 60_000;
      const browserPhaseDeadline = caseStartedAt + browserPhaseTimeoutMs;
      let browser: CaseBrowser | undefined;
      let redactor = new SecretRedactor([]);
      let result: CaseResult | undefined;
      let createCaseFailed = false;
      let checkpointFailed = false;
      try {
        const values = secretsForCase(loaded.testCase, environment);
        redactor = new SecretRedactor(values.values());
        const evidence = new EvidenceStore(options.outputDirectory, redactor);
        try {
          browser = await executeWithDeadline(
            async () => await controller.createCase(evidence, loaded.testCase.id),
            options.signal,
            Math.max(1, browserPhaseDeadline - Date.now()),
            "CASE_PHASE_TIMEOUT",
            abortGraceMs,
          );
        } catch (error) {
          createCaseFailed = true;
          throw error;
        }
        const caseBrowser = browser;
        if (!caseBrowser) throw new Error(`case ${loaded.testCase.id} has no browser`);
        const evidenceManifest = () => evidence.all().reduce<Record<string, string[]>>((byStep, item) => {
          (byStep[item.stepId] ??= []).push(item.id);
          return byStep;
        }, {});
        const phaseRemainingMs = Math.max(1, browserPhaseDeadline - Date.now());
        const finalizationTimeoutMs = options.finalizationTimeoutMs ?? 30_000;
        const caseExecutor = options.caseExecutor ?? executePiCase;
        const execution = await executeWithDeadline(
          (signal) => caseExecutor({
            caseId: loaded.testCase.id,
            targetUrl: environment[pack.pack.baseUrlFrom]!,
            goal: loaded.testCase.goal,
            steps: loaded.testCase.steps,
            oracle: loaded.testCase.oracle,
            secretBindings: loaded.testCase.data,
            secretValues: values,
            browser: caseBrowser,
            signal,
            apiKey: options.apiKey,
            modelConfiguration: options.modelConfiguration,
            onAccess: async (event) => appendNdjson(join(options.outputDirectory, "access.ndjson"), event),
            evidenceManifest,
            browserPhaseTimeoutMs: phaseRemainingMs,
            finalizationTimeoutMs,
            abortGraceMs,
          }),
          options.signal,
          options.caseExecutor ? phaseRemainingMs : phaseRemainingMs + finalizationTimeoutMs + (2 * abortGraceMs) + 100,
          options.caseExecutor ? "CASE_PHASE_TIMEOUT" : "CASE_TOTAL_TIMEOUT",
          abortGraceMs,
        );
        metadata.actionCounts[loaded.testCase.id] = execution.actions;
        metadata.tokenUsage[loaded.testCase.id] = execution.usage;

        try {
          result = parseModelResult(redactor.redact(execution.text));
          await validateResultEvidence(result, loaded.testCase.id, new Set(loaded.testCase.steps.map((step) => step.id)), evidence);
        } catch (error) {
          const repaired = await executeWithDeadline(
            (signal) => (options.resultRepairer ?? repairPiResult)(options.modelConfiguration, options.apiKey, redactor.redact(execution.text), error instanceof Error ? error.message : String(error), signal, undefined, evidenceManifest()),
            options.signal,
            options.repairTimeoutMs ?? 30_000,
            "RESULT_REPAIR_TIMEOUT",
            abortGraceMs,
          );
          result = parseModelResult(redactor.redact(repaired));
          await validateResultEvidence(result, loaded.testCase.id, new Set(loaded.testCase.steps.map((step) => step.id)), evidence);
        }
        if (!result) throw new Error(`case ${loaded.testCase.id} completed without a result`);
        const covered = applyOracleCoverage(result, loaded.testCase.oracle.expect);
        if (covered.dropped.length > 0) {
          await appendNdjson(join(options.outputDirectory, "events.ndjson"), { type: "oracle_coverage", caseId: loaded.testCase.id, dropped: covered.dropped, at: new Date().toISOString() });
        }
        result = covered.result;
        await appendNdjson(join(options.outputDirectory, "events.ndjson"), { type: "case_completed", caseId: loaded.testCase.id, actions: execution.actions, at: new Date().toISOString() });
      } catch (error) {
        if (options.signal?.aborted) {
          status = "ABORTED";
          metadata.timings.cases[loaded.testCase.id] = Date.now() - caseStartedAt;
          await persistMeta();
          await persistResults(options.outputDirectory, results, status);
        } else {
          const code = technicalErrorCode(error);
          result = caseError(loaded.testCase.id, error, redactor, code);
          if (createCaseFailed) restartBeforeNextCase = true;
          await appendNdjson(join(options.outputDirectory, "events.ndjson"), { type: "case_error", caseId: loaded.testCase.id, at: new Date().toISOString(), code });
        }
      } finally {
        if (status !== "ABORTED" && result) {
          results.push(result);
          const writeCheckpoint = async () => {
            await persistMeta();
            await persistResults(options.outputDirectory, results, status);
          };
          try {
            await (options.persistCheckpoint ? options.persistCheckpoint(writeCheckpoint) : writeCheckpoint());
          } catch (error) {
            results[results.length - 1] = caseError(loaded.testCase.id, error, redactor, "ARTIFACT_PERSIST");
            await appendNdjson(join(options.outputDirectory, "events.ndjson"), { type: "case_error", caseId: loaded.testCase.id, at: new Date().toISOString(), code: "ARTIFACT_PERSIST" }).catch(() => {});
            try {
              await writeCheckpoint();
            } catch (retryError) {
              status = "ERROR";
              checkpointFailed = true;
              await appendNdjson(join(options.outputDirectory, "events.ndjson"), { type: "run_error", at: new Date().toISOString(), code: "ARTIFACT_PERSIST", error: retryError instanceof Error ? retryError.message : String(retryError) }).catch(() => {});
            }
          }
        }
        if (browser) {
          try {
            await executeWithDeadline(async () => await browser!.close(), undefined, options.contextCloseTimeoutMs ?? 10_000, "CONTEXT_CLOSE_TIMEOUT", 0);
          } catch (error) {
            restartBeforeNextCase = true;
            await appendNdjson(join(options.outputDirectory, "events.ndjson"), { type: "case_close_error", caseId: loaded.testCase.id, at: new Date().toISOString(), code: technicalErrorCode(error), error: redactor.redact(error instanceof Error ? error.message : String(error)) });
          }
        }
        metadata.timings.cases[loaded.testCase.id] = Date.now() - caseStartedAt;
      }
      if (status === "ABORTED") break;
      if (!result) throw new Error(`case ${loaded.testCase.id} completed without a result`);
      if (checkpointFailed) break;
    }
  } catch (error) {
    if (options.signal?.aborted) status = "ABORTED";
    else {
      status = "ERROR";
      await appendNdjson(join(options.outputDirectory, "events.ndjson"), { type: "run_error", at: new Date().toISOString(), code: technicalErrorCode(error), error: error instanceof Error ? error.message : String(error) });
    }
  } finally {
    try {
      await closeController();
    } catch (error) {
      if (!options.signal?.aborted) status = "ERROR";
      await appendNdjson(join(options.outputDirectory, "events.ndjson"), { type: "run_error", at: new Date().toISOString(), code: "BROWSER_CLEANUP", error: error instanceof Error ? error.message : String(error) }).catch(() => {});
    }
  }
  while (true) {
    const abortedBeforePersist = Boolean(options.signal?.aborted);
    if (abortedBeforePersist) status = "ABORTED";
    await persistMeta();
    const summary = await persistResults(options.outputDirectory, results, status);
    if (Boolean(options.signal?.aborted) === abortedBeforePersist) return { results, summary };
  }
}
