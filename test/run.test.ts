import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { runPack } from "../src/run.js";

let server: Bun.Server<unknown>;
let origin = "";
let temporaryDirectory = "";

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: () => new Response("<button>Open cabinet</button>", { headers: { "content-type": "text/html" } }) });
  origin = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.stop(true);
});

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = "";
});

async function writePack() {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "qa-run-"));
  const packDirectory = join(temporaryDirectory, "pack");
  await mkdir(join(packDirectory, "cases"), { recursive: true });
  await writeFile(join(packDirectory, "pack.yaml"), stringify({ schemaVersion: 1, id: "runner", name: "Runner", baseUrlFrom: "TARGET_URL", allowedOriginsFrom: "QA_ALLOWED_ORIGINS", allowedSecretRefs: [] }));
  await writeFile(join(packDirectory, "cases", "RUN-001.yaml"), stringify({ schemaVersion: 1, id: "RUN-001", title: "Open cabinet", goal: "Open the read-only cabinet", preconditions: [], data: {}, steps: [{ id: "open-login", instruction: "Open the cabinet" }], oracle: { source: "product-requirement", expect: ["Cabinet loads"], reject: ["Error screen"] }, safety: { mutation: "none" } }));
  return packDirectory;
}

test("persists a PASS only after the host validates real action evidence", async () => {
  const packDirectory = await writePack();
  const outputDirectory = join(temporaryDirectory, "run");
  const output = await runPack({
    packDirectory,
    outputDirectory,
    apiKey: "test-key",
    modelConfiguration: { provider: "openrouter", model: "z-ai/glm-5.2" },

    environment: { TARGET_URL: origin, QA_ALLOWED_ORIGINS: origin },
    caseExecutor: async (input) => {
      const opened = await input.browser.open(`${origin}/`, "open-login", input.signal);
      return {
        text: JSON.stringify({ schemaVersion: 1, testCaseId: input.caseId, executionStatus: "completed", verdict: "PASS", blockedBy: null, actual: "Cabinet opened", evidence: [{ stepId: "open-login", claim: "The cabinet page rendered", evidenceIds: opened.afterEvidenceIds }], reviewReason: null, error: null }),
        activeTools: ["browser"],
        actions: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  });
  expect(output.results[0]?.executionStatus).toBe("completed");

  expect(output.summary.counts.PASS).toBe(1);
  expect(output.summary.exitCode).toBe(0);
  expect(await readFile(join(outputDirectory, "results.json"), "utf8")).toContain('"verdict": "PASS"');
  expect(await readFile(join(outputDirectory, "meta.json"), "utf8")).toContain('"openRouterRouting": {\n    "order": [\n      "z-ai"\n    ],\n    "allow_fallbacks": false,\n    "require_parameters": true');
  expect(await readFile(join(outputDirectory, "meta.json"), "utf8")).toContain('"RUN-001": 1');
});
