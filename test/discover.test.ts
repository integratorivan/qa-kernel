import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { discover } from "../src/discover.js";

let server: Bun.Server<unknown>;
let origin = "";
let temporaryDirectory = "";

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: () => new Response("<button>Open cabinet</button>", { headers: { "content-type": "text/html" } }) });
  origin = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => server.stop(true));
afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = "";
});

async function writePack() {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "qa-discover-"));
  const packDirectory = join(temporaryDirectory, "pack");
  await mkdir(packDirectory, { recursive: true });
  await writeFile(join(packDirectory, "pack.yaml"), stringify({ schemaVersion: 1, id: "discover", name: "Discover", baseUrlFrom: "TARGET_URL", allowedOriginsFrom: "QA_ALLOWED_ORIGINS", allowedSecretRefs: [] }));
  return packDirectory;
}

function draft(id: string, evidenceIds: string[]) {
  return { status: "ready", case: { schemaVersion: 1, id, title: "Open cabinet", goal: "Open cabinet", preconditions: [], data: {}, steps: [{ id: "open", instruction: "Open cabinet" }], oracle: { source: "qa-heuristic", expect: ["Cabinet opens"], reject: ["Error"] }, safety: { mutation: "none" } }, evidenceIds };
}

test("rejects ready drafts backed only by opening a page", async () => {
  const packDirectory = await writePack();
  const output = await discover({
    packDirectory,
    outputDirectory: join(temporaryDirectory, "discovery"),
    draftOutputDirectory: join(packDirectory, "drafts"),
    mission: "Find cabinet flows",
    apiKey: "test-key",
    modelConfiguration: { provider: "openrouter", model: "z-ai/glm-5.2" },
    environment: { TARGET_URL: origin, QA_ALLOWED_ORIGINS: origin },
    caseExecutor: async (input) => {
      const opened = await input.browser.open(`${origin}/`, "explore", input.signal);
      const drafts = [draft("DISC-001", opened.afterEvidenceIds), draft("DISC-002", opened.afterEvidenceIds)];
      return { text: JSON.stringify({ productMap: ["Cabinet"], uncoveredAreas: [], drafts }), activeTools: ["browser"], actions: 1, usage: null };
    },
    resultRepairer: async (_configuration, _apiKey, invalid) => invalid,
  });
  expect(output.drafts.map((item) => item.status)).toEqual(["needsCapability", "needsCapability"]);
}, 15_000);

test("accepts ready drafts backed by a successful fixed-step interaction", async () => {
  const packDirectory = await writePack();
  const output = await discover({
    packDirectory,
    outputDirectory: join(temporaryDirectory, "discovery"),
    draftOutputDirectory: join(packDirectory, "drafts"),
    mission: "Find cabinet flows",
    apiKey: "test-key",
    modelConfiguration: { provider: "openrouter", model: "z-ai/glm-5.2" },
    environment: { TARGET_URL: origin, QA_ALLOWED_ORIGINS: origin },
    caseExecutor: async (input) => {
      const opened = await input.browser.open(`${origin}/`, "explore", input.signal);
      const button = opened.observation?.interactive.find((target) => target.name === "Open cabinet");
      const clicked = await input.browser.click(button!.ref, "explore", input.signal);
      const drafts = [draft("DISC-001", clicked.afterEvidenceIds), draft("DISC-002", clicked.afterEvidenceIds)];
      return { text: JSON.stringify({ productMap: ["Cabinet"], uncoveredAreas: [], drafts }), activeTools: ["browser"], actions: 2, usage: null };
    },
  });
  expect(output.drafts.map((item) => item.status)).toEqual(["ready", "ready"]);
  expect(await Bun.file(join(packDirectory, "drafts", "DISC-001.yaml")).exists()).toBe(true);
}, 15_000);

test("repairs a non-JSON discovery result once without new browser actions", async () => {
  const packDirectory = await writePack();
  let repairCalls = 0;
  const output = await discover({
    packDirectory,
    outputDirectory: join(temporaryDirectory, "discovery"),
    draftOutputDirectory: join(packDirectory, "drafts"),
    mission: "Find cabinet flows",
    apiKey: "test-key",
    modelConfiguration: { provider: "openrouter", model: "z-ai/glm-5.2" },
    environment: { TARGET_URL: origin, QA_ALLOWED_ORIGINS: origin },
    caseExecutor: async (input) => {
      const opened = await input.browser.open(`${origin}/`, "explore", input.signal);
      const button = opened.observation?.interactive.find((target) => target.name === "Open cabinet");
      const clicked = await input.browser.click(button!.ref, "explore", input.signal);
      return { text: "Based on the exploration the login form is visible", activeTools: ["browser"], actions: 2, usage: null, evidenceIds: clicked.afterEvidenceIds } as never;
    },
    resultRepairer: async (_configuration, _apiKey, _invalid, _error, _signal, contract) => {
      repairCalls += 1;
      expect(contract).toHaveProperty(["properties", "drafts"]);
      const ids = (await Bun.file(join(temporaryDirectory, "discovery", "evidence.ndjson")).text()).trim().split("\n").map((line) => JSON.parse(line) as { id: string; phase: string; stepId: string }).filter((item) => item.phase === "after" && item.stepId === "explore").map((item) => item.id);
      return JSON.stringify({ productMap: ["Cabinet"], uncoveredAreas: [], drafts: [draft("DISC-001", ids), draft("DISC-002", ids)] });
    },
  });
  expect(repairCalls).toBe(1);
  expect(output.drafts).toHaveLength(2);
}, 15_000);

test("checks the API key before creating discovery artifacts or Chromium", async () => {
  const packDirectory = await writePack();
  const outputDirectory = join(temporaryDirectory, "discovery");
  await expect(discover({
    packDirectory,
    outputDirectory,
    draftOutputDirectory: join(packDirectory, "drafts"),
    mission: "Find cabinet flows",
    apiKey: "",
    modelConfiguration: { provider: "openrouter", model: "z-ai/glm-5.2" },
    environment: { TARGET_URL: origin, QA_ALLOWED_ORIGINS: origin },
  })).rejects.toThrow("QA_MODEL_API_KEY");
  expect(await Bun.file(outputDirectory).exists()).toBe(false);
});
