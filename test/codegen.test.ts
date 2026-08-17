import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { codegenRun } from "../src/codegen.js";

let temporaryDirectory = "";

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = "";
});

async function syntheticRun(withRecording = true): Promise<{ run: string; out: string }> {
  temporaryDirectory = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "qa-codegen-"));
  const run = join(temporaryDirectory, "run-001");
  const out = join(temporaryDirectory, "specs");
  await mkdir(join(run, "cases"), { recursive: true });
  const pack = { schemaVersion: 1, id: "fixture", name: "Fixture", baseUrlFrom: "TARGET_URL", allowedOriginsFrom: "QA_ALLOWED_ORIGINS", allowedSecretRefs: ["QA_PASSWORD"] };
  const result = { schemaVersion: 1, testCaseId: "FIXTURE-001", executionStatus: "completed", verdict: "PASS", blockedBy: null, actual: "ok", evidence: [], reviewReason: null, error: null };
  const readiness = { status: "ready", uncovered: [], unboundCheckOrdinals: [] };
  const testCase = { schemaVersion: 1, id: "FIXTURE-001", title: "Fixture login", goal: "Login", preconditions: [], data: { passwordFrom: "QA_PASSWORD" }, steps: [{ id: "login", instruction: "Login" }], oracle: { source: "product-requirement", expect: ["Exact text Fixture cabinet is visible", "Exact text Signed in as test user is visible"], reject: ["Exact text Authentication failed is visible", "Heading Sign in is visible"] }, safety: { mutation: "none" } };
  await writeFile(join(run, "pack.yaml"), stringify(pack));
  await writeFile(join(run, "cases", "FIXTURE-001.yaml"), stringify(testCase));
  await writeFile(join(run, "results.json"), JSON.stringify({ schemaVersion: 1, status: "COMPLETED", results: [result], summary: {}, codegenReadiness: { "FIXTURE-001": readiness } }));
  if (withRecording) {
    const entries = [
      { schemaVersion: 1, kind: "action", caseId: "FIXTURE-001", stepId: "login", actionOrdinal: 1, action: "open", frame: "main", sourceSnapshotId: "snap-1", locator: null, url: "/", from: null, value: null, key: null, deltaY: null, actionStatus: "ok", observationStatus: "complete" },
      { schemaVersion: 1, kind: "action", caseId: "FIXTURE-001", stepId: "login", actionOrdinal: 2, action: "fill", frame: "main", sourceSnapshotId: "snap-1", locator: { kind: "label", value: "Password" }, url: null, from: "QA_PASSWORD", value: null, key: null, deltaY: null, actionStatus: "ok", observationStatus: "complete" },
      { schemaVersion: 1, kind: "action", caseId: "FIXTURE-001", stepId: "login", actionOrdinal: 3, action: "click", frame: "main", sourceSnapshotId: "snap-1", locator: { kind: "role", role: "button", name: "Sign in" }, url: null, from: null, value: null, key: null, deltaY: null, actionStatus: "ok", observationStatus: "complete" },
      { schemaVersion: 1, kind: "check", caseId: "FIXTURE-001", stepId: "login", checkOrdinal: 1, oracle: { list: "expect", index: 0 }, check: "text", text: "Fixture cabinet", exact: true, state: "visible", groundingText: "Fixture cabinet", status: "passed" },
      { schemaVersion: 1, kind: "check", caseId: "FIXTURE-001", stepId: "login", checkOrdinal: 2, oracle: { list: "expect", index: 1 }, check: "text", text: "Signed in as test user", exact: true, state: "visible", groundingText: "Signed in as test user", status: "passed" },
      { schemaVersion: 1, kind: "check", caseId: "FIXTURE-001", stepId: "login", checkOrdinal: 3, oracle: { list: "reject", index: 0 }, check: "text", text: "Authentication failed", exact: true, state: "hidden", groundingText: "Authentication failed", status: "passed" },
      { schemaVersion: 1, kind: "check", caseId: "FIXTURE-001", stepId: "login", checkOrdinal: 4, oracle: { list: "reject", index: 1 }, check: "locator", locator: { kind: "role", role: "heading", name: "Sign in" }, state: "hidden", groundingText: "Sign in", status: "passed" },
    ];
    await writeFile(join(run, "recording.ndjson"), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  }
  return { run, out };
}

test("codegen emits semantic locators and no kernel dependency", async () => {
  const input = await syntheticRun();
  const output = await codegenRun({ runDirectory: input.run, outputDirectory: input.out });
  expect(output.exitCode).toBe(0);
  expect(output.items).toEqual([{ caseId: "FIXTURE-001", status: "generated", file: join(input.out, "FIXTURE-001.spec.ts") }]);
  const source = await readFile(join(input.out, "FIXTURE-001.spec.ts"), "utf8");
  expect(source).toContain("getByLabel(\"Password\"");
  expect(source).toContain("getByRole(\"button\"");
  expect(source).toContain("getByText(\"Fixture cabinet\", { exact: true })");
  expect(source).not.toContain("qa-kernel");
  expect(source).toContain("// Generated from case FIXTURE-001 and run run-001.");
  expect(source).toContain("process.env.QA_PASSWORD!");
});
test("codegen does not overwrite an existing spec without force", async () => {
  const input = await syntheticRun();
  const first = await codegenRun({ runDirectory: input.run, outputDirectory: input.out });
  expect(first.exitCode).toBe(0);
  const specPath = join(input.out, "FIXTURE-001.spec.ts");
  const original = await readFile(specPath, "utf8");
  const second = await codegenRun({ runDirectory: input.run, outputDirectory: input.out });
  expect(second.items).toEqual([{ caseId: "FIXTURE-001", status: "error", code: "CODEGEN_OUTPUT_EXISTS" }]);
  expect(await readFile(specPath, "utf8")).toBe(original);
  const forced = await codegenRun({ runDirectory: input.run, outputDirectory: input.out, force: true });
  expect(forced.items).toEqual([{ caseId: "FIXTURE-001", status: "generated", file: specPath }]);
});

test("old run without recording fails closed per PASS case", async () => {
  const input = await syntheticRun(false);
  const output = await codegenRun({ runDirectory: input.run, outputDirectory: input.out });
  expect(output.items).toEqual([{ caseId: "FIXTURE-001", status: "error", code: "CODEGEN_RECORDING_MISSING" }]);
  expect(output.exitCode).toBe(1);
});
test("matching incomplete readiness still blocks PASS codegen", async () => {
  const input = await syntheticRun();
  const recordingPath = join(input.run, "recording.ndjson");
  const entries = (await readFile(recordingPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  const failed = entries[3]!;
  failed.status = "failed";
  await writeFile(recordingPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  const resultsPath = join(input.run, "results.json");
  const results = JSON.parse(await readFile(resultsPath, "utf8")) as { codegenReadiness: Record<string, unknown> };
  results.codegenReadiness["FIXTURE-001"] = { status: "incomplete", uncovered: [{ list: "expect", index: 0 }], unboundCheckOrdinals: [1] };
  await writeFile(resultsPath, JSON.stringify(results));
  const output = await codegenRun({ runDirectory: input.run, outputDirectory: input.out });
  expect(output.items).toEqual([{ caseId: "FIXTURE-001", status: "error", code: "CODEGEN_UNSUPPORTED_ORACLE" }]);
});

test("codegen rejects a text check whose literal differs from grounding", async () => {
  const input = await syntheticRun();
  const recordingPath = join(input.run, "recording.ndjson");
  const entries = (await readFile(recordingPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  const check = entries[3];
  if (!check || typeof check.text !== "string") throw new Error("synthetic check missing text");
  check.text = "Signed in as test user";
  await writeFile(recordingPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  const output = await codegenRun({ runDirectory: input.run, outputDirectory: input.out });
  expect(output.items).toEqual([{ caseId: "FIXTURE-001", status: "error", code: "CODEGEN_UNSUPPORTED_ORACLE" }]);
});

test("codegen rejects literals matching an available allowlisted secret", async () => {
  const input = await syntheticRun();
  const previous = process.env.QA_PASSWORD;
  process.env.QA_PASSWORD = "runtime-secret";
  try {
    const recordingPath = join(input.run, "recording.ndjson");
    const entries = (await readFile(recordingPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const check = entries[3];
    if (!check || typeof check.text !== "string") throw new Error("synthetic check missing text");
    check.text = "runtime-secret";
    await writeFile(recordingPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    const output = await codegenRun({ runDirectory: input.run, outputDirectory: input.out });
    expect(output.items).toEqual([{ caseId: "FIXTURE-001", status: "error", code: "CODEGEN_SECRET_LEAK" }]);
  } finally {
    if (previous === undefined) delete process.env.QA_PASSWORD;
    else process.env.QA_PASSWORD = previous;
  }
});
