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
}

export interface RunOutput {
  results: CaseResult[];
  summary: RunSummary;
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
  if (!options.apiKey) {
    status = "ERROR";
    await appendNdjson(join(options.outputDirectory, "events.ndjson"), { type: "run_error", at: new Date().toISOString(), error: "QA_MODEL_API_KEY is required for the configured QA model" });
    await persistMeta();
    const summary = await persistResults(options.outputDirectory, results, status);
    return { results, summary };
  }

  try {
    await controller.start();
    metadata.versions.chromium = controller.version();
    for (let caseIndex = 0; caseIndex < pack.cases.length; caseIndex += 1) {
      const loaded = pack.cases[caseIndex]!;
      if (options.signal?.aborted) {
        status = "ABORTED";
        break;
      }
      if (restartBeforeNextCase) {
        try {
          await controller.close();
          await controller.start();
          metadata.versions.chromium = controller.version();
          restartBeforeNextCase = false;
          await appendNdjson(join(options.outputDirectory, "events.ndjson"), { type: "browser_restarted", at: new Date().toISOString() });
        } catch (error) {
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
      let browser: CaseBrowser | undefined;
      let redactor = new SecretRedactor([]);
      let result: CaseResult | undefined;
      let createCaseFailed = false;
      try {
        const values = secretsForCase(loaded.testCase, environment);
        redactor = new SecretRedactor(values.values());
        const evidence = new EvidenceStore(options.outputDirectory, redactor);
        try {
          browser = await controller.createCase(evidence, loaded.testCase.id);
        } catch (error) {
          createCaseFailed = true;
          throw error;
        }
        const execution = await (options.caseExecutor ?? executePiCase)({
          caseId: loaded.testCase.id,
          targetUrl: environment[pack.pack.baseUrlFrom]!,
          goal: loaded.testCase.goal,
          steps: loaded.testCase.steps,
          oracle: loaded.testCase.oracle,
          secretBindings: loaded.testCase.data,
          secretValues: values,
          browser,
          signal: options.signal ?? new AbortController().signal,
          apiKey: options.apiKey,
          modelConfiguration: options.modelConfiguration,
          onAccess: async (event) => appendNdjson(join(options.outputDirectory, "access.ndjson"), event),
        });
        metadata.actionCounts[loaded.testCase.id] = execution.actions;
        metadata.tokenUsage[loaded.testCase.id] = execution.usage;

        try {
          result = parseModelResult(redactor.redact(execution.text));
          await validateResultEvidence(result, loaded.testCase.id, new Set(loaded.testCase.steps.map((step) => step.id)), evidence);
        } catch (error) {
          const repaired = await (options.resultRepairer ?? repairPiResult)(options.modelConfiguration, options.apiKey, redactor.redact(execution.text), error instanceof Error ? error.message : String(error), options.signal);
          result = parseModelResult(redactor.redact(repaired));
          await validateResultEvidence(result, loaded.testCase.id, new Set(loaded.testCase.steps.map((step) => step.id)), evidence);
        }
        await appendNdjson(join(options.outputDirectory, "events.ndjson"), { type: "case_completed", caseId: loaded.testCase.id, actions: execution.actions, at: new Date().toISOString() });
      } catch (error) {
        if (options.signal?.aborted) {
          status = "ABORTED";
        } else {
          result = caseError(loaded.testCase.id, error, redactor);
          if (createCaseFailed) restartBeforeNextCase = true;
          await appendNdjson(join(options.outputDirectory, "events.ndjson"), { type: "case_error", caseId: loaded.testCase.id, at: new Date().toISOString(), code: "CASE_EXECUTION" });
        }
      } finally {
        if (browser) {
          try {
            await browser.close();
          } catch (error) {
            await appendNdjson(join(options.outputDirectory, "events.ndjson"), { type: "case_close_error", caseId: loaded.testCase.id, at: new Date().toISOString(), error: redactor.redact(error instanceof Error ? error.message : String(error)) });
          }
        }
        metadata.timings.cases[loaded.testCase.id] = Date.now() - caseStartedAt;
      }
      if (status === "ABORTED") break;
      if (!result) throw new Error(`case ${loaded.testCase.id} completed without a result`);
      results.push(result);
      await persistMeta();
      await persistResults(options.outputDirectory, results, status);
    }
  } catch (error) {
    if (options.signal?.aborted) status = "ABORTED";
    else {
      status = "ERROR";
      await appendNdjson(join(options.outputDirectory, "events.ndjson"), { type: "run_error", at: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
    }
  } finally {
    await controller.close();
  }
  await persistMeta();
  const summary = await persistResults(options.outputDirectory, results, status);
  return { results, summary };
}
