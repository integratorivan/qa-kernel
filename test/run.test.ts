import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { BrowserController } from "../src/browser.js";
import { runPack } from "../src/run.js";

let server: Bun.Server<unknown>;
let origin = "";
let temporaryDirectory = "";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/api/slow") {
        const response = Promise.withResolvers<Response>();
        setTimeout(() => response.resolve(new Response("ok")), 2_700);
        return response.promise;
      }
      return new Response("<label>Email <input type='email'></label><button>Open cabinet</button><button onclick=\"fetch('/api/slow')\">Slow check</button>", { headers: { "content-type": "text/html" } });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.stop(true);
});

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = "";
});

async function writePack(caseIds = ["RUN-001"], secretRef?: string) {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "qa-run-"));
  const packDirectory = join(temporaryDirectory, "pack");
  await mkdir(join(packDirectory, "cases"), { recursive: true });
  await writeFile(join(packDirectory, "pack.yaml"), stringify({ schemaVersion: 1, id: "runner", name: "Runner", baseUrlFrom: "TARGET_URL", allowedOriginsFrom: "QA_ALLOWED_ORIGINS", allowedSecretRefs: secretRef ? [secretRef] : [] }));
  await Promise.all(caseIds.map((caseId) => writeFile(join(packDirectory, "cases", `${caseId}.yaml`), stringify({ schemaVersion: 1, id: caseId, title: "Open cabinet", goal: "Open the read-only cabinet", preconditions: [], data: secretRef ? { secretFrom: secretRef } : {}, steps: [{ id: "open-login", instruction: "Open the cabinet" }], oracle: { source: "product-requirement", expect: ["Cabinet loads"], reject: ["Error screen"] }, safety: { mutation: "none" } }))));
  return packDirectory;
}

async function allFileText(directory: string): Promise<string> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
  return (await Promise.all(files.map(async (file) => Buffer.from(await Bun.file(file).arrayBuffer()).toString("utf8")))).join("\n");
}

function chromiumPids(): string[] {
  const processList = Bun.spawnSync(["ps", "-axo", "pid=,comm="]).stdout.toString();
  return processList.split("\n").map((line) => line.trim().split(/\s+/, 2)).filter(([, command]) => /^(Chromium|chrome|chromium)$/.test(command ?? "")).map(([pid]) => pid!);
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
      expect(input.targetUrl).toBe(`${origin}`);
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
  const meta = JSON.parse(await readFile(join(outputDirectory, "meta.json"), "utf8"));
  expect(meta.versions).toEqual({ bun: Bun.version, playwright: "1.62.1", pi: "0.84.2", chromium: expect.any(String) });
  expect(meta.timings.cases["RUN-001"]).toBeGreaterThan(0);
});

test("repairs one invalid result without browser actions", async () => {
  const packDirectory = await writePack();
  const outputDirectory = join(temporaryDirectory, "run");
  let repairCalls = 0;
  const output = await runPack({
    packDirectory,
    outputDirectory,
    apiKey: "test-key",
    modelConfiguration: { provider: "openrouter", model: "z-ai/glm-5.2" },
    environment: { TARGET_URL: origin, QA_ALLOWED_ORIGINS: origin },
    caseExecutor: async (input) => {
      const opened = await input.browser.open(`${origin}/`, "open-login", input.signal);
      return { text: "not-json", activeTools: ["browser"], actions: 1, usage: null, evidenceIds: opened.afterEvidenceIds } as never;
    },
    resultRepairer: async (_configuration, _apiKey, _invalid, _error) => {
      repairCalls += 1;
      const manifest = (await readFile(join(outputDirectory, "evidence.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      const evidenceIds = manifest.filter((item) => item.caseId === "RUN-001" && item.stepId === "open-login" && item.phase === "after").map((item) => item.id);
      return JSON.stringify({ schemaVersion: 1, testCaseId: "RUN-001", executionStatus: "completed", verdict: "PASS", blockedBy: null, actual: "Cabinet opened", evidence: [{ stepId: "open-login", claim: "Cabinet rendered", evidenceIds }], reviewReason: null, error: null });
    },
  });
  expect(repairCalls).toBe(1);
  expect(output.summary.counts.PASS).toBe(1);
});

test("accepts one JSON code fence without invoking repair", async () => {
  const packDirectory = await writePack();
  const outputDirectory = join(temporaryDirectory, "run");
  let repairCalls = 0;
  const output = await runPack({
    packDirectory,
    outputDirectory,
    apiKey: "test-key",
    modelConfiguration: { provider: "openrouter", model: "z-ai/glm-5.2" },
    environment: { TARGET_URL: origin, QA_ALLOWED_ORIGINS: origin },
    caseExecutor: async (input) => {
      const opened = await input.browser.open(`${origin}/`, "open-login", input.signal);
      const result = { schemaVersion: 1, testCaseId: input.caseId, executionStatus: "completed", verdict: "PASS", blockedBy: null, actual: "Cabinet opened", evidence: [{ stepId: "open-login", claim: "Cabinet rendered", evidenceIds: opened.afterEvidenceIds }], reviewReason: null, error: null };
      return { text: `\`\`\`json\n${JSON.stringify(result)}\n\`\`\``, activeTools: ["browser"], actions: 1, usage: null };
    },
    resultRepairer: async () => {
      repairCalls += 1;
      throw new Error("repair must not run");
    },
  });
  expect(repairCalls).toBe(0);
  expect(output.summary.counts.PASS).toBe(1);
});

test("continues after CASE_ERROR and counts an intentional status mix", async () => {
  const caseIds = ["RUN-001", "RUN-002", "RUN-003", "RUN-004", "RUN-005"];
  const packDirectory = await writePack(caseIds);
  const outputDirectory = join(temporaryDirectory, "run");
  const attempted: string[] = [];
  const output = await runPack({
    packDirectory,
    outputDirectory,
    apiKey: "test-key",
    modelConfiguration: { provider: "openrouter", model: "z-ai/glm-5.2" },
    environment: { TARGET_URL: origin, QA_ALLOWED_ORIGINS: origin },
    caseExecutor: async (input) => {
      attempted.push(input.caseId);
      const opened = await input.browser.open(`${origin}/`, "open-login", input.signal);
      if (input.caseId === "RUN-001") return { text: "not-json", activeTools: ["browser"], actions: 1, usage: null };
      const verdicts: Record<string, "PASS" | "FAIL" | "BLOCKED" | "INCONCLUSIVE"> = { "RUN-002": "PASS", "RUN-003": "FAIL", "RUN-004": "BLOCKED", "RUN-005": "INCONCLUSIVE" };
      const verdict = verdicts[input.caseId]!;
      return { text: JSON.stringify({ schemaVersion: 1, testCaseId: input.caseId, executionStatus: "completed", verdict, blockedBy: verdict === "BLOCKED" ? "environment" : null, actual: `Intentional ${verdict}`, evidence: [{ stepId: "open-login", claim: "Fixture rendered", evidenceIds: opened.afterEvidenceIds }], reviewReason: verdict === "INCONCLUSIVE" ? "Fixture intentionally leaves the outcome uncertain" : null, error: null }), activeTools: ["browser"], actions: 1, usage: null };
    },
    resultRepairer: async () => "still-not-json",
  });
  expect(attempted).toEqual(caseIds);
  expect(output.summary.counts).toEqual({ PASS: 1, FAIL: 1, BLOCKED: 1, INCONCLUSIVE: 1, CASE_ERROR: 1 });
  expect(output.summary.exitCode).toBe(2);
}, 30_000);

test("persists a CASE_ERROR when creating one case fails and continues the pack", async () => {
  const caseIds = ["RUN-001", "RUN-002", "RUN-003"];
  const packDirectory = await writePack(caseIds);
  const outputDirectory = join(temporaryDirectory, "run");
  const controller = new BrowserController(new Set([origin]));
  const createCase = controller.createCase.bind(controller);
  let createAttempts = 0;
  const start = controller.start.bind(controller);
  let startCalls = 0;
  controller.start = async () => {
    startCalls += 1;
    await start();
  };
  const executed: string[] = [];
  controller.createCase = async (...args) => {
    createAttempts += 1;
    if (createAttempts === 2) throw new Error("fixture context creation failed");
    return createCase(...args);
  };

  const output = await runPack({
    packDirectory,
    outputDirectory,
    apiKey: "test-key",
    modelConfiguration: { provider: "openrouter", model: "z-ai/glm-5.2" },
    environment: { TARGET_URL: origin, QA_ALLOWED_ORIGINS: origin },
    browserController: controller,
    caseExecutor: async (input) => {
      executed.push(input.caseId);
      const opened = await input.browser.open(`${origin}/`, "open-login", input.signal);
      return {
        text: JSON.stringify({ schemaVersion: 1, testCaseId: input.caseId, executionStatus: "completed", verdict: "PASS", blockedBy: null, actual: "Cabinet opened", evidence: [{ stepId: "open-login", claim: "Fixture rendered", evidenceIds: opened.afterEvidenceIds }], reviewReason: null, error: null }),
        activeTools: ["browser"],
        actions: 1,
        usage: null,
      };
    },
  });

  expect(executed).toEqual(["RUN-001", "RUN-003"]);
  expect(startCalls).toBe(2);
  expect(output.results.map((result) => result.testCaseId)).toEqual(caseIds);
  expect(output.results[1]?.executionStatus).toBe("error");
  expect(await readFile(join(outputDirectory, "results.json"), "utf8")).toContain('"RUN-002"');
}, 30_000);

test("keeps a persisted verdict when case context cleanup fails", async () => {
  const packDirectory = await writePack();
  const outputDirectory = join(temporaryDirectory, "run");
  const controller = new BrowserController(new Set([origin]));
  const createCase = controller.createCase.bind(controller);
  controller.createCase = async (...args) => {
    const browser = await createCase(...args);
    browser.close = async () => {
      throw new Error("fixture context close failed");
    };
    return browser;
  };

  const output = await runPack({
    packDirectory,
    outputDirectory,
    apiKey: "test-key",
    modelConfiguration: { provider: "openrouter", model: "z-ai/glm-5.2" },
    environment: { TARGET_URL: origin, QA_ALLOWED_ORIGINS: origin },
    browserController: controller,
    caseExecutor: async (input) => {
      const opened = await input.browser.open(`${origin}/`, "open-login", input.signal);
      return {
        text: JSON.stringify({ schemaVersion: 1, testCaseId: input.caseId, executionStatus: "completed", verdict: "PASS", blockedBy: null, actual: "Cabinet opened", evidence: [{ stepId: "open-login", claim: "Fixture rendered", evidenceIds: opened.afterEvidenceIds }], reviewReason: null, error: null }),
        activeTools: ["browser"],
        actions: 1,
        usage: null,
      };
    },
  });

  expect(output.results[0]?.verdict).toBe("PASS");
  expect(await readFile(join(outputDirectory, "results.json"), "utf8")).toContain('"verdict": "PASS"');
  expect(await readFile(join(outputDirectory, "events.ndjson"), "utf8")).toContain('"case_close_error"');
}, 30_000);

test("persists remaining technical results when browser restart fails", async () => {
  const caseIds = ["RUN-001", "RUN-002", "RUN-003"];
  const packDirectory = await writePack(caseIds);
  const outputDirectory = join(temporaryDirectory, "run");
  const controller = new BrowserController(new Set([origin]));
  const createCase = controller.createCase.bind(controller);
  const start = controller.start.bind(controller);
  let createAttempts = 0;
  let startCalls = 0;
  controller.start = async () => {
    startCalls += 1;
    if (startCalls === 2) throw new Error("fixture browser restart failed");
    await start();
  };
  controller.createCase = async (...args) => {
    createAttempts += 1;
    if (createAttempts === 2) throw new Error("fixture context creation failed");
    return createCase(...args);
  };

  const output = await runPack({
    packDirectory,
    outputDirectory,
    apiKey: "test-key",
    modelConfiguration: { provider: "openrouter", model: "z-ai/glm-5.2" },
    environment: { TARGET_URL: origin, QA_ALLOWED_ORIGINS: origin },
    browserController: controller,
    caseExecutor: async (input) => {
      const opened = await input.browser.open(`${origin}/`, "open-login", input.signal);
      return {
        text: JSON.stringify({ schemaVersion: 1, testCaseId: input.caseId, executionStatus: "completed", verdict: "PASS", blockedBy: null, actual: "Cabinet opened", evidence: [{ stepId: "open-login", claim: "Fixture rendered", evidenceIds: opened.afterEvidenceIds }], reviewReason: null, error: null }),
        activeTools: ["browser"],
        actions: 1,
        usage: null,
      };
    },
  });

  expect(output.summary.status).toBe("ERROR");
  expect(output.results.map((result) => result.testCaseId)).toEqual(caseIds);
  expect(output.results[2]?.error?.code).toBe("BROWSER_RECOVERY");
  expect(await readFile(join(outputDirectory, "results.json"), "utf8")).toContain('"BROWSER_RECOVERY"');
}, 30_000);

test("restarts Chromium after it dies between cases without leaving a child process", async () => {
  const caseIds = ["RUN-001", "RUN-002", "RUN-003"];
  const packDirectory = await writePack(caseIds);
  const outputDirectory = join(temporaryDirectory, "run");
  const controller = new BrowserController(new Set([origin]));
  const chromiumBefore = chromiumPids();
  const start = controller.start.bind(controller);
  let startCalls = 0;
  controller.start = async () => {
    startCalls += 1;
    await start();
  };

  const output = await runPack({
    packDirectory,
    outputDirectory,
    apiKey: "test-key",
    modelConfiguration: { provider: "openrouter", model: "z-ai/glm-5.2" },
    environment: { TARGET_URL: origin, QA_ALLOWED_ORIGINS: origin },
    browserController: controller,
    caseExecutor: async (input) => {
      const opened = await input.browser.open(`${origin}/`, "open-login", input.signal);
      if (input.caseId === "RUN-001") await controller.close();
      return {
        text: JSON.stringify({ schemaVersion: 1, testCaseId: input.caseId, executionStatus: "completed", verdict: "PASS", blockedBy: null, actual: "Cabinet opened", evidence: [{ stepId: "open-login", claim: "Fixture rendered", evidenceIds: opened.afterEvidenceIds }], reviewReason: null, error: null }),
        activeTools: ["browser"],
        actions: 1,
        usage: null,
      };
    },
  });

  expect(output.results.map((result) => result.testCaseId)).toEqual(caseIds);
  expect(output.results.map((result) => result.verdict)).toEqual(["PASS", null, "PASS"]);
  expect(startCalls).toBe(2);
  expect(chromiumPids()).toEqual(chromiumBefore);
}, 30_000);

test("continues after a completed BLOCKED case", async () => {
  const caseIds = ["RUN-001", "RUN-002"];
  const packDirectory = await writePack(caseIds);
  const outputDirectory = join(temporaryDirectory, "run");
  const executed: string[] = [];

  const output = await runPack({
    packDirectory,
    outputDirectory,
    apiKey: "test-key",
    modelConfiguration: { provider: "openrouter", model: "z-ai/glm-5.2" },
    environment: { TARGET_URL: origin, QA_ALLOWED_ORIGINS: origin },
    caseExecutor: async (input) => {
      executed.push(input.caseId);
      const opened = await input.browser.open(`${origin}/`, "open-login", input.signal);
      const verdict = input.caseId === "RUN-001" ? "BLOCKED" : "PASS";
      return {
        text: JSON.stringify({ schemaVersion: 1, testCaseId: input.caseId, executionStatus: "completed", verdict, blockedBy: verdict === "BLOCKED" ? "environment" : null, actual: "Fixture verdict", evidence: [{ stepId: "open-login", claim: "Fixture rendered", evidenceIds: opened.afterEvidenceIds }], reviewReason: null, error: null }),
        activeTools: ["browser"],
        actions: 1,
        usage: null,
      };
    },
  });

  expect(executed).toEqual(caseIds);
  expect(output.results.map((result) => result.verdict)).toEqual(["BLOCKED", "PASS"]);
}, 30_000);

test("removes a sentinel secret from browser evidence and every run artifact", async () => {
  const secret = "secret-sentinel@example.test";
  const packDirectory = await writePack(["RUN-001"], "QA_SECRET");
  const outputDirectory = join(temporaryDirectory, "run");
  const output = await runPack({
    packDirectory,
    outputDirectory,
    apiKey: "test-key",
    modelConfiguration: { provider: "openrouter", model: "z-ai/glm-5.2" },
    environment: { TARGET_URL: origin, QA_ALLOWED_ORIGINS: origin, QA_SECRET: secret },
    caseExecutor: async (input) => {
      expect(input.secretBindings).toEqual({ secretFrom: "QA_SECRET" });
      const opened = await input.browser.open(`${origin}/`, "open-login", input.signal);
      const email = opened.observation?.interactive.find((target) => target.name === "Email");
      const filled = await input.browser.fillSecret(email!.ref, input.secretValues.get("QA_SECRET")!, "open-login", input.signal);
      return { text: JSON.stringify({ schemaVersion: 1, testCaseId: input.caseId, executionStatus: "completed", verdict: "PASS", blockedBy: null, actual: `Opened for ${secret}`, evidence: [{ stepId: "open-login", claim: `The ${secret} account opened`, evidenceIds: filled.afterEvidenceIds }], reviewReason: null, error: null }), activeTools: ["browser"], actions: 2, usage: null };
    },
  });
  expect(output.results[0]?.actual).toContain("[REDACTED]");
  expect(await allFileText(outputDirectory)).not.toContain(secret);
});

test("aborts during settle and closes the owned Chromium instance", async () => {
  const packDirectory = await writePack();
  const outputDirectory = join(temporaryDirectory, "run");
  const abort = new AbortController();
  const controller = new BrowserController(new Set([origin]));
  const output = await runPack({
    packDirectory,
    outputDirectory,
    apiKey: "test-key",
    modelConfiguration: { provider: "openrouter", model: "z-ai/glm-5.2" },
    environment: { TARGET_URL: origin, QA_ALLOWED_ORIGINS: origin },
    signal: abort.signal,
    browserController: controller,
    caseExecutor: async (input) => {
      const opened = await input.browser.open(`${origin}/`, "open-login", input.signal);
      const slow = opened.observation?.interactive.find((target) => target.name === "Slow check");
      setTimeout(() => abort.abort(new Error("SIGINT")), 100);
      await input.browser.click(slow!.ref, "open-login", input.signal);
      throw new Error("unreachable");
    },
  });
  expect(output.summary.status).toBe("ABORTED");
  expect(output.summary.exitCode).toBe(130);
  expect(controller.version()).toBeNull();
});

test("real SIGINT during settle exits 130 without an orphan Chromium", async () => {
  const packDirectory = await writePack();
  const outputDirectory = join(temporaryDirectory, "sigint-run");
  const chromiumBefore = chromiumPids();
  const child = Bun.spawn(["bun", "run", "test/sigint-harness.ts", packDirectory, outputDirectory, origin], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  let stdout = "";
  while (!stdout.includes("SETTLING")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    stdout += new TextDecoder().decode(chunk.value);
  }
  reader.releaseLock();
  expect(stdout).toContain("SETTLING");
  child.kill("SIGINT");
  expect(await child.exited).toBe(130);
  const persisted = JSON.parse(await readFile(join(outputDirectory, "results.json"), "utf8"));
  expect(persisted.status).toBe("ABORTED");
  expect(chromiumPids()).toEqual(chromiumBefore);
});

test("escapes a hung browser phase after the host deadline and continues", async () => {
  const caseIds = ["RUN-001", "RUN-002"];
  const packDirectory = await writePack(caseIds);
  const outputDirectory = join(temporaryDirectory, "run");
  const startedAt = Date.now();

  const output = await runPack({
    packDirectory,
    outputDirectory,
    apiKey: "test-key",
    modelConfiguration: { provider: "openrouter", model: "z-ai/glm-5.2" },
    environment: { TARGET_URL: origin, QA_ALLOWED_ORIGINS: origin },
    browserPhaseTimeoutMs: 3_000,
    abortGraceMs: 20,
    caseExecutor: async (input) => {
      if (input.caseId === "RUN-001") return await new Promise<never>(() => {});
      const opened = await input.browser.open(`${origin}/`, "open-login", input.signal);
      return {
        text: JSON.stringify({ schemaVersion: 1, testCaseId: input.caseId, executionStatus: "completed", verdict: "PASS", blockedBy: null, actual: "Cabinet opened", evidence: [{ stepId: "open-login", claim: "Fixture rendered", evidenceIds: opened.afterEvidenceIds }], reviewReason: null, error: null }),
        activeTools: ["browser"],
        actions: 1,
        usage: null,
      };
    },
  });

  expect(Date.now() - startedAt).toBeLessThan(5_000);
  expect(output.results.map((result) => result.testCaseId)).toEqual(caseIds);
  expect(output.results[0]?.error?.code).toBe("CASE_PHASE_TIMEOUT");
  expect(output.results[1]?.verdict).toBe("PASS");
}, 30_000);

test("rejects a repair that returns after its host deadline", async () => {
  const packDirectory = await writePack();
  const outputDirectory = join(temporaryDirectory, "run");
  const output = await runPack({
    packDirectory,
    outputDirectory,
    apiKey: "test-key",
    modelConfiguration: { provider: "openrouter", model: "z-ai/glm-5.2" },
    environment: { TARGET_URL: origin, QA_ALLOWED_ORIGINS: origin },
    repairTimeoutMs: 10,
    abortGraceMs: 100,
    caseExecutor: async (input) => {
      await input.browser.open(`${origin}/`, "open-login", input.signal);
      return { text: "not-json", activeTools: ["browser"], actions: 1, usage: null } as never;
    },
    resultRepairer: async () => {
      await Bun.sleep(30);
      return "{}";
    },
  });

  expect(output.results[0]?.error?.code).toBe("RESULT_REPAIR_TIMEOUT");
}, 30_000);
