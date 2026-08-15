import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { appendNdjson, atomicJson, EvidenceStore, SecretRedactor } from "./artifacts.js";
import { BrowserController } from "./browser.js";
import { loadPack, secretsForCase, type LoadedPack } from "./pack.js";
import { executePiCase, PI_MODEL, PI_PROVIDER, repairPiResult } from "./pi.js";
import { markdownReport, summarize, type RunSummary } from "./report.js";
import { type CaseResult, SCHEMA_VERSION, SchemaError, validateResult } from "./schema.js";

export interface RunOptions {
  packDirectory: string;
  outputDirectory: string;
  apiKey: string;
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  caseExecutor?: typeof executePiCase;
}

export interface RunOutput {
  results: CaseResult[];
  summary: RunSummary;
}

function caseError(caseId: string, error: unknown, redact: SecretRedactor): CaseResult {
  return {
    schemaVersion: SCHEMA_VERSION,
    testCaseId: caseId,
    executionStatus: "error",
    verdict: null,
    blockedBy: null,
    actual: null,
    evidence: [],
    reviewReason: null,
    error: { code: "CASE_EXECUTION", message: redact.redact(error instanceof Error ? error.message : String(error)) },
  };
}

function parseModelResult(text: string): CaseResult {
  try {
    return validateResult(JSON.parse(text));
  } catch (error) {
    throw new SchemaError(error instanceof Error ? error.message : String(error));
  }
}

function validateResultEvidence(result: CaseResult, caseId: string, stepIds: ReadonlySet<string>, evidence: EvidenceStore): void {
  if (result.testCaseId !== caseId) throw new SchemaError(`model result belongs to ${result.testCaseId}, not ${caseId}`);
  if (result.executionStatus === "error") throw new SchemaError("model must return a completed product verdict, not a case error");
  if (result.evidence.length === 0) throw new SchemaError("completed result must include evidence-backed claims");
  for (const claim of result.evidence) {
    if (!stepIds.has(claim.stepId)) throw new SchemaError(`claim references unknown step ${claim.stepId}`);
    evidence.validate({ caseId, stepId: claim.stepId, evidenceIds: claim.evidenceIds });
  }
}

async function persistResults(outputDirectory: string, results: readonly CaseResult[], status: RunSummary["status"]): Promise<RunSummary> {
  const summary = summarize(results, status);
  await atomicJson(join(outputDirectory, "results.json"), { schemaVersion: SCHEMA_VERSION, status, results, summary });
  await Bun.write(join(outputDirectory, "report.md"), markdownReport(results, summary));
  return summary;
}

async function copyApprovedCases(pack: LoadedPack, outputDirectory: string): Promise<void> {
  const destination = join(outputDirectory, "cases");
  await mkdir(destination, { recursive: true });
  await Promise.all(pack.cases.map((item) => copyFile(join(pack.directory, "cases", item.file), join(destination, item.file))));
}

export async function runPack(options: RunOptions): Promise<RunOutput> {
  const environment = options.environment ?? process.env;
  const pack = await loadPack(options.packDirectory, environment);
  await mkdir(options.outputDirectory, { recursive: true });
  await copyApprovedCases(pack, options.outputDirectory);
  const metadata = {
    schemaVersion: SCHEMA_VERSION,
    provider: PI_PROVIDER,
    model: PI_MODEL,
    targetOrigins: pack.allowedOrigins,
    startedAt: new Date().toISOString(),
    actionCounts: {} as Record<string, number>,
    tokenUsage: {} as Record<string, unknown | null>,
  };
  const persistMeta = async () => atomicJson(join(options.outputDirectory, "meta.json"), { ...metadata, updatedAt: new Date().toISOString() });
  await persistMeta();
  const controller = new BrowserController(new Set(pack.allowedOrigins));
  const results: CaseResult[] = [];
  let status: RunSummary["status"] = "COMPLETED";
  if (!options.apiKey) {
    status = "ERROR";
    await appendNdjson(join(options.outputDirectory, "events.ndjson"), { type: "run_error", at: new Date().toISOString(), error: "QA_PI_API_KEY is required for the pinned Pi model" });
    await persistMeta();
    const summary = await persistResults(options.outputDirectory, results, status);
    return { results, summary };
  }

  try {
    await controller.start();
    for (const loaded of pack.cases) {
      if (options.signal?.aborted) {
        status = "ABORTED";
        break;
      }
      const values = secretsForCase(loaded.testCase, environment);
      const redactor = new SecretRedactor(values.values());
      const evidence = new EvidenceStore(options.outputDirectory, redactor);
      const browser = await controller.createCase(evidence, loaded.testCase.id);
      let result: CaseResult;
      try {
        const execution = await (options.caseExecutor ?? executePiCase)({ caseId: loaded.testCase.id, goal: loaded.testCase.goal, steps: loaded.testCase.steps, oracle: loaded.testCase.oracle, secretValues: values, browser, signal: options.signal ?? new AbortController().signal, apiKey: options.apiKey });
        metadata.actionCounts[loaded.testCase.id] = execution.actions;
        metadata.tokenUsage[loaded.testCase.id] = execution.usage;

        try {
          result = parseModelResult(execution.text);
          validateResultEvidence(result, loaded.testCase.id, new Set(loaded.testCase.steps.map((step) => step.id)), evidence);
        } catch (error) {
          const repaired = await repairPiResult(options.apiKey, execution.text, error instanceof Error ? error.message : String(error), options.signal);
          result = parseModelResult(repaired);
          validateResultEvidence(result, loaded.testCase.id, new Set(loaded.testCase.steps.map((step) => step.id)), evidence);
        }
        await appendNdjson(join(options.outputDirectory, "events.ndjson"), { type: "case_completed", caseId: loaded.testCase.id, actions: execution.actions, at: new Date().toISOString() });
      } catch (error) {
        if (options.signal?.aborted) {
          status = "ABORTED";
          break;
        }
        result = caseError(loaded.testCase.id, error, redactor);
        await appendNdjson(join(options.outputDirectory, "events.ndjson"), { type: "case_error", caseId: loaded.testCase.id, at: new Date().toISOString(), code: "CASE_EXECUTION" });
      } finally {
        await browser.close();
      }
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
