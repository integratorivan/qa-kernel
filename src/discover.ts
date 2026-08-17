import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { appendNdjson, atomicJson, EvidenceStore, runtimeVersions, SecretRedactor } from "./artifacts.js";
import { BrowserController } from "./browser.js";
import { loadPack, type LoadedPack } from "./pack.js";
import { discoveryJsonSchema, DISCOVERY_INSTRUCTION, secretRefToDataKey } from "./contracts.js";
import { extractJsonText } from "./json-text.js";
import { executePiCase, repairPiResult } from "./pi.js";
import { openRouterRouting, type ModelConfiguration } from "./model.js";
import { completeStructuredJson } from "./structured.js";

import { preflightUrl } from "./preflight.js";
import { SCHEMA_VERSION, type TestCase, validateCase } from "./schema.js";

export interface DiscoverOptions {
  packDirectory: string;
  outputDirectory: string;
  draftOutputDirectory: string;
  mission: string;
  apiKey: string;
  modelConfiguration: ModelConfiguration;

  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  caseExecutor?: typeof executePiCase;
  resultRepairer?: typeof repairPiResult;
}



export interface DiscoveryDraft {
  testCase: TestCase;
  status: "ready" | "needsCapability";
  evidenceIds: string[];
}

export interface DiscoveryOutput {
  drafts: DiscoveryDraft[];
  productMap: string[];
  uncoveredAreas: string[];
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const actual = Object.keys(value);
  const unknown = actual.filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !(key in value));
  if (unknown.length > 0 || missing.length > 0) throw new Error(`${path} has invalid fields`);
}

function strings(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) throw new Error(`${path} must be a string array`);
  return value;
}

function log(message: string): void {
  process.stderr.write(`qa discover: ${message}\n`);
}

async function repairDiscoveryJson(options: DiscoverOptions, pack: LoadedPack, evidence: EvidenceStore, invalidResult: string, validationError: string, schema: ReturnType<typeof discoveryJsonSchema>): Promise<string> {
  if (options.resultRepairer) return options.resultRepairer(options.modelConfiguration, options.apiKey, invalidResult, validationError, options.signal, schema);
  const userContent = JSON.stringify({
    instruction: "Rewrite the discovery result to match the JSON schema exactly. Each draft.case must include schemaVersion, id, title, goal, preconditions, data, steps, oracle, and safety. Do not add summary. Use only availableExploreEvidenceIds. Change unjustified ready drafts to needsCapability instead of inventing interactions.",
    validationError,
    invalidResult,
    allowedSecretRefs: pack.pack.allowedSecretRefs,
    caseDataKeys: Object.fromEntries(pack.pack.allowedSecretRefs.map((ref) => [secretRefToDataKey(ref), ref])),
    availableExploreEvidenceIds: evidence.all().filter((item) => item.stepId === "explore").map((item) => item.id),
  });
  try {
    return await completeStructuredJson({
      configuration: options.modelConfiguration,
      apiKey: options.apiKey,
      schemaName: "qa_discovery_result",
      schema,
      ...(options.signal ? { signal: options.signal } : {}),
      userContent,
    });
  } catch {
    return repairPiResult(options.modelConfiguration, options.apiKey, invalidResult, validationError, options.signal, schema);
  }
}

async function parseDiscovery(text: string, pack: LoadedPack, evidence: EvidenceStore, browser: Awaited<ReturnType<BrowserController["createCase"]>>): Promise<DiscoveryOutput> {
  const raw = record(JSON.parse(extractJsonText(text)), "discovery result");
  exactKeys(raw, ["productMap", "uncoveredAreas", "drafts"], "discovery result");
  const productMap = strings(raw.productMap, "productMap");
  const uncoveredAreas = strings(raw.uncoveredAreas, "uncoveredAreas");
  if (!Array.isArray(raw.drafts) || raw.drafts.length < 2 || raw.drafts.length > 3) throw new Error("discovery must return two or three drafts");
  const drafts = await Promise.all(raw.drafts.map(async (item, index) => {
    const draft = record(item, `drafts[${index}]`);
    exactKeys(draft, ["status", "case", "evidenceIds"], `drafts[${index}]`);
    if (draft.status !== "ready" && draft.status !== "needsCapability") throw new Error(`drafts[${index}].status is invalid`);
    const status: DiscoveryDraft["status"] = draft.status;
    const evidenceIds = strings(draft.evidenceIds, `drafts[${index}].evidenceIds`);
    await evidence.validate({ caseId: "DISCOVERY", stepId: "explore", evidenceIds });
    let resolved = status;
    if (status === "ready" && !browser.hasSuccessfulInteraction("explore", evidenceIds)) {
      resolved = "needsCapability";
    }
    return { testCase: validateCase(draft.case, pack.pack), status: resolved, evidenceIds };
  }));
  if (new Set(drafts.map((draft) => draft.testCase.id)).size !== drafts.length) throw new Error("discovery draft IDs must be unique");
  return { drafts, productMap, uncoveredAreas };
}

export async function discover(options: DiscoverOptions): Promise<DiscoveryOutput> {
  const startedAt = Date.now();
  const environment = options.environment ?? process.env;
  const pack = await loadPack(options.packDirectory, environment, { requireCases: false });
  const targetUrl = environment[pack.pack.baseUrlFrom];
  if (!targetUrl) throw new Error(`missing ${pack.pack.baseUrlFrom}`);
  if (!options.apiKey) throw new Error("QA_MODEL_API_KEY is required for the configured QA model");
  log(`preflight ${targetUrl}`);
  await preflightUrl(targetUrl);
  await mkdir(options.outputDirectory, { recursive: true });
  const secretValues = new Map(pack.pack.allowedSecretRefs.map((ref) => [ref, environment[ref] ?? ""]));
  const evidence = new EvidenceStore(options.outputDirectory, new SecretRedactor(secretValues.values()));
  const controller = new BrowserController(new Set(pack.allowedOrigins));
  try {
    await controller.start();
    const browser = await controller.createCase(evidence, "DISCOVERY");
    try {
      const resultContract = discoveryJsonSchema(pack.pack.allowedSecretRefs);
      const prompt = JSON.stringify({
        mission: options.mission,
        targetUrl,
        allowedSecretRefs: pack.pack.allowedSecretRefs,
        resultContract,
        instruction: DISCOVERY_INSTRUCTION,
      });
      log("starting isolated model session and Chromium");
      const output = await (options.caseExecutor ?? executePiCase)({
        caseId: "DISCOVERY",
        targetUrl,
        goal: options.mission,
        steps: [{ id: "explore", instruction: "Explore the mission-relevant product area" }],
        oracle: { source: "qa-heuristic", expect: ["Grounded draft cases"], reject: ["Unseen capability"] },
        secretValues,
        browser,
        signal: options.signal ?? new AbortController().signal,
        apiKey: options.apiKey,
        modelConfiguration: options.modelConfiguration,
        prompt,
        onAccess: async (event) => appendNdjson(join(options.outputDirectory, "access.ndjson"), event),
      });
      const modelText = evidence.redactText(output.text);
      await Bun.write(join(options.outputDirectory, "model-output.txt"), `${modelText}\n`);
      log(`model returned ${output.actions} browser actions; parsing structured drafts`);
      let parsed: DiscoveryOutput;
      try {
        parsed = await parseDiscovery(modelText, pack, evidence, browser);
      } catch (error) {
        log("structured result invalid; requesting one schema-constrained JSON repair without browser tools");
        const repaired = evidence.redactText(await repairDiscoveryJson(options, pack, evidence, modelText, error instanceof Error ? error.message : String(error), resultContract));
        await Bun.write(join(options.outputDirectory, "model-output.repaired.txt"), `${repaired}\n`);
        try {
          parsed = await parseDiscovery(repaired, pack, evidence, browser);
        } catch (repairError) {
          const preview = extractJsonText(repaired).slice(0, 240).replaceAll("\n", " ");
          throw new Error(`${repairError instanceof Error ? repairError.message : String(repairError)} (model output starts with: ${preview || "<empty>"})`);
        }
      }
      await mkdir(options.draftOutputDirectory, { recursive: true });
      await Promise.all(parsed.drafts.map((draft) => Bun.write(join(options.draftOutputDirectory, `${draft.testCase.id}.yaml`), stringify(draft.testCase))));
      await Bun.write(join(options.outputDirectory, "product-map.yaml"), stringify({ productMap: parsed.productMap, uncoveredAreas: parsed.uncoveredAreas }));
      await atomicJson(join(options.outputDirectory, "result.json"), { schemaVersion: SCHEMA_VERSION, drafts: parsed.drafts.map((draft) => ({ id: draft.testCase.id, status: draft.status, evidenceIds: draft.evidenceIds })) });
      await atomicJson(join(options.outputDirectory, "meta.json"), { schemaVersion: SCHEMA_VERSION, provider: options.modelConfiguration.provider, model: options.modelConfiguration.model, openRouterRouting: openRouterRouting(options.modelConfiguration), versions: { ...(await runtimeVersions()), chromium: controller.version() }, mission: options.mission, targetOrigin: new URL(targetUrl).origin, actionCount: output.actions, timings: { startedAt: new Date(startedAt).toISOString(), completedAt: new Date().toISOString(), durationMs: Date.now() - startedAt } });
      await appendNdjson(join(options.outputDirectory, "events.ndjson"), { type: "discovery_completed", actionCount: output.actions, at: new Date().toISOString() });
      log(`wrote ${parsed.drafts.length} drafts to ${options.draftOutputDirectory}`);
      return parsed;
    } finally {
      await browser.close();
    }
  } finally {
    await controller.close();
  }
}
