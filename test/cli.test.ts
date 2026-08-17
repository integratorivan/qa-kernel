import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { interruptController, main } from "../src/cli.js";
import { loadPack } from "../src/pack.js";


let temporaryDirectory = "";

const originalEnvironment = { TARGET_URL: process.env.TARGET_URL, QA_ALLOWED_ORIGINS: process.env.QA_ALLOWED_ORIGINS, QA_EMAIL: process.env.QA_EMAIL, QA_PASSWORD: process.env.QA_PASSWORD, QA_MODEL_API_KEY: process.env.QA_MODEL_API_KEY, QA_MODEL_ID: process.env.QA_MODEL_ID, QA_MODEL_PROVIDER: process.env.QA_MODEL_PROVIDER };

afterEach(async () => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = "";
});

async function writePack() {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "qa-cli-"));
  const packDirectory = join(temporaryDirectory, "pack");
  await mkdir(join(packDirectory, "cases"), { recursive: true });
  await writeFile(join(packDirectory, "pack.yaml"), stringify({ schemaVersion: 1, id: "b2b-smoke", name: "B2B smoke", baseUrlFrom: "TARGET_URL", allowedOriginsFrom: "QA_ALLOWED_ORIGINS", allowedSecretRefs: ["QA_EMAIL", "QA_PASSWORD"] }));
  await writeFile(join(packDirectory, "cases", "B2B-001.yaml"), stringify({ schemaVersion: 1, id: "B2B-001", title: "Sign in", goal: "Access dashboard", preconditions: [], data: { emailFrom: "QA_EMAIL", passwordFrom: "QA_PASSWORD" }, steps: [{ id: "open-login", instruction: "Open login" }], oracle: { source: "product-requirement", expect: ["Dashboard opens"], reject: ["Error appears"] }, safety: { mutation: "none" } }));
  process.env.TARGET_URL = "http://127.0.0.1:3000";
  process.env.QA_ALLOWED_ORIGINS = "http://127.0.0.1:3000";
  process.env.QA_EMAIL = "qa@example.test";
  process.env.QA_PASSWORD = "secret";
  return packDirectory;
}

test("validate accepts a safe approved pack", async () => {
  const packDirectory = await writePack();
  expect(await main(["validate", "--pack", packDirectory])).toBe(0);
});

test("discovery can load a pack before any case is approved", async () => {
  const packDirectory = await writePack();
  await rm(join(packDirectory, "cases"), { recursive: true, force: true });
  expect((await loadPack(packDirectory, process.env, { requireCases: false })).cases).toEqual([]);
});


test("run records a configuration error before launching Chromium", async () => {
  const packDirectory = await writePack();
  delete process.env.QA_MODEL_API_KEY;
  const runDirectory = join(temporaryDirectory, "run");
  expect(await main(["run", "--pack", packDirectory, "--out", runDirectory])).toBe(2);
  expect(await readFile(join(runDirectory, "results.json"), "utf8")).toContain("\"status\": \"ERROR\"");
});
test("report renders persisted case results without a model", async () => {
  const runDirectory = await writePack();
  await writeFile(join(runDirectory, "results.json"), JSON.stringify({ status: "COMPLETED", results: [{ schemaVersion: 1, testCaseId: "B2B-001", executionStatus: "completed", verdict: "PASS", blockedBy: null, actual: "Dashboard loaded", evidence: [{ stepId: "open-login", claim: "Dashboard visible", evidenceIds: ["ev-1"] }], reviewReason: null, error: null }] }));
  expect(await main(["report", "--run", runDirectory])).toBe(0);
  expect(await readFile(join(runDirectory, "report.md"), "utf8")).toContain("B2B-001 — PASS");
});

test("debounces duplicate SIGINT delivery from a script runner", () => {
  const originalExit = process.exit;
  const originalNow = Date.now;
  let exitCode: number | undefined;
  let now = 10_000;
  process.exit = ((code?: number) => { exitCode = code; }) as never;
  Date.now = () => now;
  const interrupt = interruptController();
  try {
    process.emit("SIGINT");
    now += 1_000;
    process.emit("SIGINT");
    expect(interrupt.controller.signal.aborted).toBe(true);
    expect(exitCode).toBeUndefined();
    now += 5_000;
    process.emit("SIGINT");
    expect(exitCode).toBe(130);
  } finally {
    interrupt.dispose();
    process.exit = originalExit;
    Date.now = originalNow;
  }
});
