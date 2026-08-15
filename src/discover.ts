import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { appendNdjson, atomicJson, EvidenceStore, SecretRedactor } from "./artifacts.js";
import { BrowserController } from "./browser.js";
import { loadPack, type LoadedPack } from "./pack.js";
import { executePiCase } from "./pi.js";
import { openRouterRouting, type ModelConfiguration } from "./model.js";

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

function parseDiscovery(text: string, pack: LoadedPack, evidence: EvidenceStore): DiscoveryOutput {
  const raw = record(JSON.parse(text), "discovery result");
  exactKeys(raw, ["productMap", "uncoveredAreas", "drafts"], "discovery result");
  const productMap = strings(raw.productMap, "productMap");
  const uncoveredAreas = strings(raw.uncoveredAreas, "uncoveredAreas");
  if (!Array.isArray(raw.drafts) || raw.drafts.length < 2 || raw.drafts.length > 3) throw new Error("discovery must return two or three drafts");
  const drafts = raw.drafts.map((item, index) => {
    const draft = record(item, `drafts[${index}]`);
    exactKeys(draft, ["status", "case", "evidenceIds"], `drafts[${index}]`);
    if (draft.status !== "ready" && draft.status !== "needsCapability") throw new Error(`drafts[${index}].status is invalid`);
    const status: DiscoveryDraft["status"] = draft.status;
    const evidenceIds = strings(draft.evidenceIds, `drafts[${index}].evidenceIds`);
    evidence.validate({ caseId: "DISCOVERY", stepId: "explore", evidenceIds });
    return { testCase: validateCase(draft.case, pack.pack), status, evidenceIds };
  });
  if (new Set(drafts.map((draft) => draft.testCase.id)).size !== drafts.length) throw new Error("discovery draft IDs must be unique");
  return { drafts, productMap, uncoveredAreas };
}

export async function discover(options: DiscoverOptions): Promise<DiscoveryOutput> {
  const environment = options.environment ?? process.env;
  const pack = await loadPack(options.packDirectory, environment, { requireCases: false });
  const targetUrl = environment[pack.pack.baseUrlFrom];
  if (!targetUrl) throw new Error(`missing ${pack.pack.baseUrlFrom}`);
  await mkdir(options.outputDirectory, { recursive: true });
  const secretValues = new Map(pack.pack.allowedSecretRefs.map((ref) => [ref, environment[ref] ?? ""]));
  const evidence = new EvidenceStore(options.outputDirectory, new SecretRedactor(secretValues.values()));
  const controller = new BrowserController(new Set(pack.allowedOrigins));
  try {
    await controller.start();
    const browser = await controller.createCase(evidence, "DISCOVERY");
    try {
      const prompt = JSON.stringify({
        mission: options.mission,
        targetUrl,
        allowedSecretRefs: pack.pack.allowedSecretRefs,
        instruction: "Explore only areas directly reachable for this mission. Use browser.open first. Produce only JSON with productMap:string[], uncoveredAreas:string[], drafts: 2-3 objects {status:'ready'|'needsCapability', case:<semantic case>, evidenceIds:string[]}. Every draft needs current-case evidence IDs from the explore step. Do not invent unseen capability. A ready draft requires a successful key interaction; needsCapability requires an observed control the browser could not operate.",
      });
      const output = await executePiCase({ caseId: "DISCOVERY", goal: options.mission, steps: [{ id: "explore", instruction: "Explore the mission-relevant product area" }], oracle: { source: "qa-heuristic", expect: ["Grounded draft cases"], reject: ["Unseen capability"] }, secretValues, browser, signal: options.signal ?? new AbortController().signal, apiKey: options.apiKey, modelConfiguration: options.modelConfiguration, prompt });
      const parsed = parseDiscovery(output.text, pack, evidence);
      await mkdir(options.draftOutputDirectory, { recursive: true });
      await Promise.all(parsed.drafts.map((draft) => Bun.write(join(options.draftOutputDirectory, `${draft.testCase.id}.yaml`), stringify(draft.testCase))));
      await Bun.write(join(options.outputDirectory, "product-map.yaml"), stringify({ productMap: parsed.productMap, uncoveredAreas: parsed.uncoveredAreas }));
      await atomicJson(join(options.outputDirectory, "result.json"), { schemaVersion: SCHEMA_VERSION, drafts: parsed.drafts.map((draft) => ({ id: draft.testCase.id, status: draft.status, evidenceIds: draft.evidenceIds })) });
      await atomicJson(join(options.outputDirectory, "meta.json"), { schemaVersion: SCHEMA_VERSION, provider: options.modelConfiguration.provider, model: options.modelConfiguration.model, openRouterRouting: openRouterRouting(options.modelConfiguration), mission: options.mission, targetOrigin: new URL(targetUrl).origin, actionCount: output.actions, completedAt: new Date().toISOString() });
      await appendNdjson(join(options.outputDirectory, "events.ndjson"), { type: "discovery_completed", actionCount: output.actions, at: new Date().toISOString() });
      return parsed;
    } finally {
      await browser.close();
    }
  } finally {
    await controller.close();
  }
}
