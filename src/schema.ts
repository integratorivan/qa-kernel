import { parseDocument } from "yaml";

export const SCHEMA_VERSION = 1 as const;

export type Verdict = "PASS" | "FAIL" | "BLOCKED" | "INCONCLUSIVE";
export type BlockedBy = "capability" | "credentials" | "environment" | "safety" | "product";
export type OracleSource = "product-requirement" | "user-approved" | "qa-heuristic" | "baseline" | "inferred";

export interface Pack {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  name: string;
  baseUrlFrom: string;
  allowedOriginsFrom: string;
  allowedSecretRefs: string[];
}

export interface CaseStep {
  id: string;
  instruction: string;
}

export interface TestCase {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  title: string;
  goal: string;
  preconditions: string[];
  data: Record<string, string>;
  steps: CaseStep[];
  oracle: {
    source: OracleSource;
    expect: string[];
    reject: string[];
  };
  safety: { mutation: "none" };
}

export interface EvidenceClaim {
  stepId: string;
  claim: string;
  evidenceIds: string[];
}

export interface CompletedCaseResult {
  schemaVersion: typeof SCHEMA_VERSION;
  testCaseId: string;
  executionStatus: "completed";
  verdict: Verdict;
  blockedBy: BlockedBy | null;
  actual: string;
  evidence: EvidenceClaim[];
  reviewReason: string | null;
  error: null;
}

export interface ErroredCaseResult {
  schemaVersion: typeof SCHEMA_VERSION;
  testCaseId: string;
  executionStatus: "error";
  verdict: null;
  blockedBy: null;
  actual: null;
  evidence: [];
  reviewReason: null;
  error: { code: string; message: string };
}

export type CaseResult = CompletedCaseResult | ErroredCaseResult;

export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaError";
  }
}

type UnknownRecord = Record<string, unknown>;

function object(value: unknown, path: string): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SchemaError(`${path} must be an object`);
  }
  return value as UnknownRecord;
}

function exactKeys(value: UnknownRecord, keys: readonly string[], path: string): void {
  const unexpected = Object.keys(value).filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !(key in value));
  if (unexpected.length > 0) throw new SchemaError(`${path} contains unknown field(s): ${unexpected.join(", ")}`);
  if (missing.length > 0) throw new SchemaError(`${path} is missing required field(s): ${missing.join(", ")}`);
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new SchemaError(`${path} must be a non-empty string`);
  return value;
}

function stringArray(value: unknown, path: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) throw new SchemaError(`${path} must be a non-empty string array`);
  return value.map((item, index) => text(item, `${path}[${index}]`));
}

function identifier(value: unknown, path: string): string {
  const result = text(value, path);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(result)) throw new SchemaError(`${path} must be an identifier`);
  return result;
}

function schemaVersion(value: unknown, path: string): typeof SCHEMA_VERSION {
  if (value !== SCHEMA_VERSION) throw new SchemaError(`${path} must equal ${SCHEMA_VERSION}`);
  return SCHEMA_VERSION;
}

export function parseYaml(content: string, source: string): unknown {
  const document = parseDocument(content, { uniqueKeys: true });
  if (document.errors.length > 0) throw new SchemaError(`${source}: ${document.errors.map((error) => error.message).join("; ")}`);
  return document.toJS({ mapAsMap: false });
}

export function validatePack(value: unknown): Pack {
  const input = object(value, "pack");
  exactKeys(input, ["schemaVersion", "id", "name", "baseUrlFrom", "allowedOriginsFrom", "allowedSecretRefs"], "pack");
  const secrets = stringArray(input.allowedSecretRefs, "pack.allowedSecretRefs", true);
  if (new Set(secrets).size !== secrets.length) throw new SchemaError("pack.allowedSecretRefs must not contain duplicates");
  return {
    schemaVersion: schemaVersion(input.schemaVersion, "pack.schemaVersion"),
    id: identifier(input.id, "pack.id"),
    name: text(input.name, "pack.name"),
    baseUrlFrom: identifier(input.baseUrlFrom, "pack.baseUrlFrom"),
    allowedOriginsFrom: identifier(input.allowedOriginsFrom, "pack.allowedOriginsFrom"),
    allowedSecretRefs: secrets,
  };
}

export function validateCase(value: unknown, pack: Pack): TestCase {
  const input = object(value, "case");
  exactKeys(input, ["schemaVersion", "id", "title", "goal", "preconditions", "data", "steps", "oracle", "safety"], "case");
  const dataInput = object(input.data, "case.data");
  const data: Record<string, string> = {};
  for (const [key, ref] of Object.entries(dataInput)) {
    if (!/^[A-Za-z][A-Za-z0-9]*From$/.test(key)) throw new SchemaError(`case.data.${key} must end with From`);
    const secretRef = identifier(ref, `case.data.${key}`);
    if (!pack.allowedSecretRefs.includes(secretRef)) throw new SchemaError(`case.data.${key} references unapproved secret ${secretRef}`);
    data[key] = secretRef;
  }
  const rawSteps = input.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) throw new SchemaError("case.steps must be a non-empty array");
  const steps = rawSteps.map((rawStep, index) => {
    const step = object(rawStep, `case.steps[${index}]`);
    exactKeys(step, ["id", "instruction"], `case.steps[${index}]`);
    return { id: identifier(step.id, `case.steps[${index}].id`), instruction: text(step.instruction, `case.steps[${index}].instruction`) };
  });
  if (new Set(steps.map((step) => step.id)).size !== steps.length) throw new SchemaError("case.steps IDs must be unique");
  const rawOracle = object(input.oracle, "case.oracle");
  exactKeys(rawOracle, ["source", "expect", "reject"], "case.oracle");
  const source = text(rawOracle.source, "case.oracle.source") as OracleSource;
  if (!(["product-requirement", "user-approved", "qa-heuristic", "baseline", "inferred"] as const).includes(source)) {
    throw new SchemaError("case.oracle.source is invalid");
  }
  const rawSafety = object(input.safety, "case.safety");
  exactKeys(rawSafety, ["mutation"], "case.safety");
  if (rawSafety.mutation !== "none") throw new SchemaError("case.safety.mutation must equal none");
  return {
    schemaVersion: schemaVersion(input.schemaVersion, "case.schemaVersion"),
    id: identifier(input.id, "case.id"),
    title: text(input.title, "case.title"),
    goal: text(input.goal, "case.goal"),
    preconditions: stringArray(input.preconditions, "case.preconditions", true),
    data,
    steps,
    oracle: { source, expect: stringArray(rawOracle.expect, "case.oracle.expect"), reject: stringArray(rawOracle.reject, "case.oracle.reject") },
    safety: { mutation: "none" },
  };
}

export function validateResult(value: unknown): CaseResult {
  const input = object(value, "result");
  exactKeys(input, ["schemaVersion", "testCaseId", "executionStatus", "verdict", "blockedBy", "actual", "evidence", "reviewReason", "error"], "result");
  const testCaseId = identifier(input.testCaseId, "result.testCaseId");
  const version = schemaVersion(input.schemaVersion, "result.schemaVersion");
  if (input.executionStatus === "error") {
    if (input.verdict !== null || input.blockedBy !== null || input.actual !== null || input.reviewReason !== null || !Array.isArray(input.evidence) || input.evidence.length !== 0) {
      throw new SchemaError("error result must not include a verdict, claims, or product fields");
    }
    const error = object(input.error, "result.error");
    exactKeys(error, ["code", "message"], "result.error");
    return { schemaVersion: version, testCaseId, executionStatus: "error", verdict: null, blockedBy: null, actual: null, evidence: [], reviewReason: null, error: { code: identifier(error.code, "result.error.code"), message: text(error.message, "result.error.message") } };
  }
  if (input.executionStatus !== "completed") throw new SchemaError("result.executionStatus is invalid");
  const verdict = input.verdict;
  if (!(["PASS", "FAIL", "BLOCKED", "INCONCLUSIVE"] as const).includes(verdict as Verdict)) throw new SchemaError("result.verdict is invalid");
  const blockedBy = input.blockedBy;
  if (verdict === "BLOCKED") {
    if (!( ["capability", "credentials", "environment", "safety", "product"] as const).includes(blockedBy as BlockedBy)) throw new SchemaError("BLOCKED result requires valid blockedBy");
  } else if (blockedBy !== null) throw new SchemaError("only BLOCKED result may set blockedBy");
  const reviewReason = input.reviewReason;
  if (verdict === "INCONCLUSIVE") text(reviewReason, "result.reviewReason");
  else if (reviewReason !== null) throw new SchemaError("only INCONCLUSIVE result may set reviewReason");
  if (input.error !== null) throw new SchemaError("completed result must have null error");
  if (!Array.isArray(input.evidence)) throw new SchemaError("result.evidence must be an array");
  const evidence = input.evidence.map((raw, index) => {
    const claim = object(raw, `result.evidence[${index}]`);
    exactKeys(claim, ["stepId", "claim", "evidenceIds"], `result.evidence[${index}]`);
    const evidenceIds = stringArray(claim.evidenceIds, `result.evidence[${index}].evidenceIds`);
    return { stepId: identifier(claim.stepId, `result.evidence[${index}].stepId`), claim: text(claim.claim, `result.evidence[${index}].claim`), evidenceIds };
  });
  return { schemaVersion: version, testCaseId, executionStatus: "completed", verdict: verdict as Verdict, blockedBy: blockedBy as BlockedBy | null, actual: text(input.actual, "result.actual"), evidence, reviewReason: reviewReason as string | null, error: null };
}

export function configuredOrigins(pack: Pack, environment: NodeJS.ProcessEnv): string[] {
  const value = environment[pack.allowedOriginsFrom];
  if (!value) throw new SchemaError(`missing ${pack.allowedOriginsFrom}`);
  const origins = value.split(",").map((origin) => origin.trim()).filter(Boolean).map((origin) => new URL(origin).origin);
  if (origins.length === 0) throw new SchemaError(`${pack.allowedOriginsFrom} must contain an origin`);
  if (new Set(origins).size !== origins.length) throw new SchemaError(`${pack.allowedOriginsFrom} contains duplicate origins`);
  const target = environment[pack.baseUrlFrom];
  if (!target) throw new SchemaError(`missing ${pack.baseUrlFrom}`);
  if (!origins.includes(new URL(target).origin)) throw new SchemaError(`${pack.baseUrlFrom} origin is not allowlisted`);
  return origins;
}
