import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceError, EvidenceStore, SecretRedactor } from "../src/artifacts.js";
import { markdownReport, summarize } from "../src/report.js";
import { SchemaError, configuredOrigins, validateCase, validatePack, validateResult } from "../src/schema.js";

const pack = validatePack({ schemaVersion: 1, id: "b2b-smoke", name: "B2B smoke", baseUrlFrom: "TARGET_URL", allowedOriginsFrom: "QA_ALLOWED_ORIGINS", allowedSecretRefs: ["QA_EMAIL", "QA_PASSWORD"] });
const caseInput = { schemaVersion: 1, id: "B2B-001", title: "Sign in", goal: "Access dashboard", preconditions: ["Logged out"], data: { emailFrom: "QA_EMAIL", passwordFrom: "QA_PASSWORD" }, steps: [{ id: "open-login", instruction: "Open sign in" }, { id: "submit-login", instruction: "Submit credentials" }], oracle: { source: "product-requirement", expect: ["Dashboard opens"], reject: ["Error screen"] }, safety: { mutation: "none" } };

let temporaryDirectory = "";
afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = "";
});

describe("semantic cases", () => {
  test("rejects an unapproved secret reference", () => {
    expect(() => validateCase({ ...caseInput, data: { passwordFrom: "NOT_ALLOWED" } }, pack)).toThrow(SchemaError);
  });

  test("rejects unsafe mutations", () => {
    expect(() => validateCase({ ...caseInput, safety: { mutation: "create" } }, pack)).toThrow("must equal none");
  });

  test("requires an allowlisted target origin", () => {
    expect(() => configuredOrigins(pack, { TARGET_URL: "https://example.test/login", QA_ALLOWED_ORIGINS: "https://other.test" })).toThrow("not allowlisted");
  });
});

describe("results and evidence", () => {
  test("rejects a blocked result without blockedBy", () => {
    expect(() => validateResult({ schemaVersion: 1, testCaseId: "B2B-001", executionStatus: "completed", verdict: "BLOCKED", blockedBy: null, actual: "No control", evidence: [], reviewReason: null, error: null })).toThrow("requires valid blockedBy");
  });

  test("redacts persisted evidence and rejects cross-step references", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "qa-kernel-"));
    const evidence = new EvidenceStore(temporaryDirectory, new SecretRedactor(["secret-sentinel"]));
    const recorded = await evidence.record({ caseId: "B2B-001", stepId: "open-login", actionOrdinal: 1, phase: "before", kind: "snapshot", url: "https://example.test/?token=secret-sentinel", extension: "json", content: "secret-sentinel" });
    expect(await readFile(join(temporaryDirectory, recorded.file), "utf8")).toBe("[REDACTED]");
    expect(() => evidence.validate({ caseId: "B2B-001", stepId: "open-login", evidenceIds: [recorded.id] })).not.toThrow();

    expect(() => evidence.validate({ caseId: "B2B-001", stepId: "submit-login", evidenceIds: [recorded.id] })).toThrow(EvidenceError);
  });

  test("computes counts and reports only persisted results", () => {
    const pass = validateResult({ schemaVersion: 1, testCaseId: "B2B-001", executionStatus: "completed", verdict: "PASS", blockedBy: null, actual: "Dashboard loaded", evidence: [{ stepId: "submit-login", claim: "Dashboard visible", evidenceIds: ["ev-1"] }], reviewReason: null, error: null });
    const error = validateResult({ schemaVersion: 1, testCaseId: "B2B-002", executionStatus: "error", verdict: null, blockedBy: null, actual: null, evidence: [], reviewReason: null, error: { code: "MODEL_RESULT", message: "Invalid JSON" } });
    const summary = summarize([pass, error]);
    expect(summary).toEqual({ status: "COMPLETED", counts: { PASS: 1, FAIL: 0, BLOCKED: 0, INCONCLUSIVE: 0, CASE_ERROR: 1 }, exitCode: 2 });
    expect(markdownReport([pass, error], summary)).toContain("B2B-002 — CASE_ERROR");
  });
});
