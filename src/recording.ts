import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { SchemaError, type Pack, type TestCase } from "./schema.js";
import type { CaseResult } from "./schema.js";

export type RecordedLocator =
  | { kind: "testId"; value: string }
  | { kind: "label"; value: string }
  | { kind: "role"; role: string; name: string }
  | { kind: "placeholder"; value: string }
  | { kind: "text"; value: string };

export interface RecordedAction {
  schemaVersion: 1;
  kind: "action";
  caseId: string;
  stepId: string;
  actionOrdinal: number;
  action: "open" | "click" | "fill" | "press" | "scroll";
  frame: "main" | "iframe" | null;
  sourceSnapshotId: string | null;
  locator: RecordedLocator | null;
  url: string | null;
  from: string | null;
  value: string | null;
  key: string | null;
  deltaY: number | null;
  actionStatus: "ok" | "failed";
  observationStatus: "complete" | "incomplete" | "failed" | null;
}

export type OracleRef = { list: "expect" | "reject"; index: number };

interface RecordedCheckBase {
  schemaVersion: 1;
  kind: "check";
  caseId: string;
  stepId: string;
  checkOrdinal: number;
  oracle: OracleRef;
  groundingText: string;
  status: "passed" | "failed" | "unbound";
}

export type UrlRecordedCheck = RecordedCheckBase & { check: "url"; path: string; state: "equals" | "notEquals" };
export type TextRecordedCheck = RecordedCheckBase & { check: "text"; text: string; exact: true; state: "visible" | "hidden" };
export type LocatorRecordedCheck = RecordedCheckBase & { check: "locator"; locator: RecordedLocator; state: "visible" | "hidden" };
export type RecordedCheck = UrlRecordedCheck | TextRecordedCheck | LocatorRecordedCheck;
export type RecordingEntry = RecordedAction | RecordedCheck;

export interface CodegenReadiness {
  status: "ready" | "incomplete";
  uncovered: OracleRef[];
  unboundCheckOrdinals: number[];
}

export class RecordingError extends SchemaError {
  constructor(message: string) {
    super(message);
    this.name = "RecordingError";
  }
}

function recordObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new RecordingError(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function recordText(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new RecordingError(`${path} must be a non-empty string`);
  return value;
}

function recordNullableText(value: unknown, path: string): string | null {
  if (value !== null && typeof value !== "string") throw new RecordingError(`${path} must be a string or null`);
  return value as string | null;
}

function recordOrdinal(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new RecordingError(`${path} must be a positive integer`);
  return Number(value);
}

function exactRecordKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  const unknown = actual.filter((key) => !expected.has(key));
  const missing = keys.filter((key) => !(key in value));
  if (unknown.length > 0) throw new RecordingError(`${path} contains unknown field(s): ${unknown.join(", ")}`);
  if (missing.length > 0) throw new RecordingError(`${path} is missing required field(s): ${missing.join(", ")}`);
}

export function validateRecordedLocator(value: unknown, path = "locator"): RecordedLocator {
  const input = recordObject(value, path);
  if (input.kind === "testId" || input.kind === "label" || input.kind === "placeholder" || input.kind === "text") {
    exactRecordKeys(input, ["kind", "value"], path);
    return { kind: input.kind, value: recordText(input.value, `${path}.value`) } as RecordedLocator;
  }
  if (input.kind === "role") {
    exactRecordKeys(input, ["kind", "role", "name"], path);
    return { kind: "role", role: recordText(input.role, `${path}.role`), name: recordText(input.name, `${path}.name`) };
  }
  throw new RecordingError(`${path}.kind is unsupported`);
}

function validateOracle(value: unknown, path: string): OracleRef {
  const input = recordObject(value, path);
  exactRecordKeys(input, ["list", "index"], path);
  if (input.list !== "expect" && input.list !== "reject") throw new RecordingError(`${path}.list is invalid`);
  if (!Number.isSafeInteger(input.index) || Number(input.index) < 0) throw new RecordingError(`${path}.index must be a non-negative integer`);
  return { list: input.list, index: Number(input.index) };
}

function validateRelativePathUrl(value: string): void {
  if (!value.startsWith("/") || value.startsWith("//")) throw new RecordingError("open requires a relative path URL");
  let parsed: URL;
  try {
    parsed = new URL(value, "https://qa-kernel.invalid");
  } catch {
    throw new RecordingError("open requires a valid relative path URL");
  }
  if (parsed.origin !== "https://qa-kernel.invalid" || parsed.hash !== "" || `${parsed.pathname}${parsed.search}` !== value) throw new RecordingError("open requires a canonical relative path URL");
}

function validateAction(value: Record<string, unknown>): RecordedAction {
  exactRecordKeys(value, ["schemaVersion", "kind", "caseId", "stepId", "actionOrdinal", "action", "frame", "sourceSnapshotId", "locator", "url", "from", "value", "key", "deltaY", "actionStatus", "observationStatus"], "recording action");
  if (value.schemaVersion !== 1 || value.kind !== "action") throw new RecordingError("recording action schemaVersion/kind is invalid");
  if (value.frame !== "main" && value.frame !== "iframe" && value.frame !== null) throw new RecordingError("recording action.frame is invalid");
  if (value.sourceSnapshotId !== null && typeof value.sourceSnapshotId !== "string") throw new RecordingError("recording action.sourceSnapshotId must be string or null");
  const action = value.action;
  if (!( ["open", "click", "fill", "press", "scroll"] as const).includes(action as RecordedAction["action"])) throw new RecordingError("recording action.action is invalid");
  if (value.actionStatus !== "ok" && value.actionStatus !== "failed") throw new RecordingError("recording action.actionStatus is invalid");
  if (value.observationStatus !== null && !( ["complete", "incomplete", "failed"] as const).includes(value.observationStatus as "complete")) throw new RecordingError("recording action.observationStatus is invalid");
  const locator = value.locator === null ? null : validateRecordedLocator(value.locator, "recording action.locator");
  const result: RecordedAction = {
    schemaVersion: 1,
    kind: "action",
    caseId: recordText(value.caseId, "recording action.caseId"),
    stepId: recordText(value.stepId, "recording action.stepId"),
    actionOrdinal: recordOrdinal(value.actionOrdinal, "recording action.actionOrdinal"),
    action: action as RecordedAction["action"],
    frame: value.frame,
    sourceSnapshotId: value.sourceSnapshotId as string | null,
    locator,
    url: recordNullableText(value.url, "recording action.url"),
    from: recordNullableText(value.from, "recording action.from"),
    value: recordNullableText(value.value, "recording action.value"),
    key: recordNullableText(value.key, "recording action.key"),
    deltaY: value.deltaY === null ? null : typeof value.deltaY === "number" && Number.isFinite(value.deltaY) ? value.deltaY : (() => { throw new RecordingError("recording action.deltaY must be number or null"); })(),
    actionStatus: value.actionStatus,
    observationStatus: value.observationStatus as RecordedAction["observationStatus"],
  };
  if (result.action === "fill") {
    if ((result.from === null) === (result.value === null)) throw new RecordingError("fill must contain exactly one of from/value");
  } else if (result.from !== null || result.value !== null) throw new RecordingError(`${result.action} must not contain from/value`);
  if (result.action === "press" && result.key === null) throw new RecordingError("press requires key");
  if (result.action !== "press" && result.key !== null) throw new RecordingError(`${result.action} must not contain key`);
  if (result.action === "open") {
    if (result.url === null) throw new RecordingError("open requires a relative path URL");
    validateRelativePathUrl(result.url);
  }
  if (result.action !== "open" && result.url !== null) throw new RecordingError(`${result.action} must not contain url`);
  return result;
}

function validateCheck(value: Record<string, unknown>): RecordedCheck {
  const common = ["schemaVersion", "kind", "caseId", "stepId", "checkOrdinal", "oracle", "check", "groundingText", "status"];
  if (value.schemaVersion !== 1 || value.kind !== "check") throw new RecordingError("recording check schemaVersion/kind is invalid");
  const check = value.check;
  if (check === "url") {
    exactRecordKeys(value, [...common, "path", "state"], "recording url check");
    if (value.state !== "equals" && value.state !== "notEquals") throw new RecordingError("recording url check.state is invalid");
    return { schemaVersion: 1, kind: "check", caseId: recordText(value.caseId, "recording check.caseId"), stepId: recordText(value.stepId, "recording check.stepId"), checkOrdinal: recordOrdinal(value.checkOrdinal, "recording check.checkOrdinal"), oracle: validateOracle(value.oracle, "recording check.oracle"), check: "url", path: recordText(value.path, "recording url check.path"), state: value.state, groundingText: recordText(value.groundingText, "recording check.groundingText"), status: validateCheckStatus(value.status) };
  }
  if (check === "text") {
    exactRecordKeys(value, [...common, "text", "exact", "state"], "recording text check");
    if (value.exact !== true || (value.state !== "visible" && value.state !== "hidden")) throw new RecordingError("recording text check fields are invalid");
    return { schemaVersion: 1, kind: "check", caseId: recordText(value.caseId, "recording check.caseId"), stepId: recordText(value.stepId, "recording check.stepId"), checkOrdinal: recordOrdinal(value.checkOrdinal, "recording check.checkOrdinal"), oracle: validateOracle(value.oracle, "recording check.oracle"), check: "text", text: recordText(value.text, "recording text check.text"), exact: true, state: value.state, groundingText: recordText(value.groundingText, "recording check.groundingText"), status: validateCheckStatus(value.status) };
  }
  if (check === "locator") {
    exactRecordKeys(value, [...common, "locator", "state"], "recording locator check");
    if (value.state !== "visible" && value.state !== "hidden") throw new RecordingError("recording locator check.state is invalid");
    return { schemaVersion: 1, kind: "check", caseId: recordText(value.caseId, "recording check.caseId"), stepId: recordText(value.stepId, "recording check.stepId"), checkOrdinal: recordOrdinal(value.checkOrdinal, "recording check.checkOrdinal"), oracle: validateOracle(value.oracle, "recording check.oracle"), check: "locator", locator: validateRecordedLocator(value.locator, "recording locator check.locator"), state: value.state, groundingText: recordText(value.groundingText, "recording check.groundingText"), status: validateCheckStatus(value.status) };
  }
  throw new RecordingError("recording check.check is invalid");
}

function validateCheckStatus(value: unknown): "passed" | "failed" | "unbound" {
  if (value !== "passed" && value !== "failed" && value !== "unbound") throw new RecordingError("recording check.status is invalid");
  return value;
}

export function validateRecordingEntry(value: unknown): RecordingEntry {
  const input = recordObject(value, "recording entry");
  if (input.kind === "action") return validateAction(input);
  if (input.kind === "check") return validateCheck(input);
  throw new RecordingError("recording entry.kind is invalid");
}

export function containsSecretLike(value: string, secretValues: Iterable<string> = []): boolean {
  if ([...secretValues].some((secret) => secret.length > 0 && value.includes(secret))) return true;
  return /-----BEGIN [A-Z0-9 ]+-----|\b(?:eyJ[a-zA-Z0-9_-]+\.){2}[a-zA-Z0-9_-]+\b|\b(?:sk-|ghp_|glpat-|xoxb-)[A-Za-z0-9_-]+/.test(value);
}

export class RecordingWriter {
  #queue: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(private readonly path: string) {}

  append(entry: RecordingEntry): Promise<void> {
    if (this.#closed) return Promise.reject(new RecordingError("recording writer is closed"));
    const validated = validateRecordingEntry(entry);
    this.#queue = this.#queue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${JSON.stringify(validated)}\n`, "utf8");
    });
    return this.#queue;
  }

  async flush(): Promise<void> {
    await this.#queue;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    await this.flush();
    this.#closed = true;
  }
}

export interface RecordingReadResult {
  entries: RecordingEntry[];
  rawLines: string[];
}

export async function readRecording(path: string): Promise<RecordingReadResult> {
  const content = await readFile(path, "utf8");
  const rawLines = content.split("\n").slice(0, -1).map((line) => `${line}\n`);
  if (content.length > 0 && !content.endsWith("\n")) throw new RecordingError("recording.ndjson must end with newline");
  const entries = rawLines.map((line, index) => {
    try {
      return validateRecordingEntry(JSON.parse(line));
    } catch (error) {
      throw new RecordingError(`recording line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return { entries, rawLines };
}

function normalizePhrase(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

export function groundingMatches(oracleLine: string, phrase: string): boolean {
  const normalizedOracle = normalizePhrase(oracleLine);
  const normalizedPhrase = normalizePhrase(phrase);
  if (!normalizedPhrase || /^(?:visible|hidden|opened|success|successful|failed|displayed|shown|видим|скрыт|открыт|успеш|ошибк)[\s.]*$/u.test(normalizedPhrase)) return false;
  return normalizedOracle.includes(normalizedPhrase);
}

export function oracleAssertionCompatible(list: OracleRef["list"], state: "equals" | "notEquals" | "visible" | "hidden"): boolean {
  return list === "expect" ? state === "equals" || state === "visible" : state === "notEquals" || state === "hidden";
}

export function oracleCovered(caseData: TestCase, checks: readonly RecordedCheck[]): CodegenReadiness {
  const uncovered: OracleRef[] = [];
  const unboundCheckOrdinals: number[] = [];
  for (const check of checks) {
    if (check.status !== "passed") unboundCheckOrdinals.push(check.checkOrdinal);
  }
  const covered = (list: OracleRef["list"], index: number): boolean => checks.some((check) => check.status === "passed" && check.oracle.list === list && check.oracle.index === index && oracleAssertionCompatible(list, check.state));
  for (let index = 0; index < caseData.oracle.expect.length; index += 1) if (!covered("expect", index)) uncovered.push({ list: "expect", index });
  for (let index = 0; index < caseData.oracle.reject.length; index += 1) if (!covered("reject", index)) uncovered.push({ list: "reject", index });
  return { status: uncovered.length === 0 && unboundCheckOrdinals.length === 0 ? "ready" : "incomplete", uncovered, unboundCheckOrdinals };
}

export function readinessMatchesPersisted(value: unknown, computed: CodegenReadiness): boolean {
  const input = recordObject(value, "codegenReadiness");
  return JSON.stringify(input) === JSON.stringify(computed);
}

export function validateRecordingForCase(entries: readonly RecordingEntry[], testCase: TestCase, pack: Pack): void {
  const seenActions = new Set<number>();
  const seenChecks = new Set<number>();
  for (const entry of entries) {
    if (entry.caseId !== testCase.id) throw new RecordingError(`recording entry belongs to unknown case ${entry.caseId}`);
    if (entry.kind === "action") {
      if (seenActions.has(entry.actionOrdinal)) throw new RecordingError(`duplicate action ordinal ${entry.actionOrdinal}`);
      seenActions.add(entry.actionOrdinal);
      if (entry.action === "fill" && entry.from !== null && (!pack.allowedSecretRefs.includes(entry.from) || !Object.values(testCase.data).includes(entry.from))) throw new RecordingError("fill.from is not an approved case secret");
      if (entry.action === "fill" && entry.value !== null && containsSecretLike(entry.value)) throw new RecordingError("recording contains a secret-like literal");
    } else {
      if (seenChecks.has(entry.checkOrdinal)) throw new RecordingError(`duplicate check ordinal ${entry.checkOrdinal}`);
      seenChecks.add(entry.checkOrdinal);
      if (entry.oracle.list === "expect" && entry.oracle.index >= testCase.oracle.expect.length) throw new RecordingError("check oracle index is out of range");
      if (entry.oracle.list === "reject" && entry.oracle.index >= testCase.oracle.reject.length) throw new RecordingError("check oracle index is out of range");
      const oracle = testCase.oracle[entry.oracle.list][entry.oracle.index];
      if (typeof oracle !== "string") throw new RecordingError("check oracle index is out of range");
      if (entry.check === "url") {
        if (!groundingMatches(oracle, entry.path)) throw new RecordingError("check is not grounded in its oracle line");
      } else if (entry.check === "text") {
        if (entry.groundingText !== entry.text || !groundingMatches(oracle, entry.text)) throw new RecordingError("check is not grounded in its oracle line");
      } else if (!groundingMatches(oracle, entry.groundingText)) {
        throw new RecordingError("check is not grounded in its oracle line");
      }
    }
  }
}

export function validateCaseResultForCodegen(result: CaseResult, caseId: string): void {
  if (result.testCaseId !== caseId || result.executionStatus !== "completed" || result.verdict !== "PASS") throw new RecordingError(`case ${caseId} is not a PASS result`);
}
