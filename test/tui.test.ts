import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveDraft, environmentStatus, latestRun, listYaml, loadDotEnv } from "../src/tui.js";

let temporaryDirectory = "";

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = "";
});

test("loads unset keys from a dotenv file and leaves existing values alone", async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "qa-tui-"));
  const file = join(temporaryDirectory, ".env");
  await writeFile(file, "TARGET_URL=http://127.0.0.1:3100\nQA_EMAIL='qa@example.test'\n");
  const environment: NodeJS.ProcessEnv = { QA_EMAIL: "already-set@example.test" };
  expect(await loadDotEnv(file, environment)).toEqual(["TARGET_URL"]);
  expect(environment).toEqual({ TARGET_URL: "http://127.0.0.1:3100", QA_EMAIL: "already-set@example.test" });
});

test("reports missing credentials and the example password placeholder", () => {
  const status = environmentStatus({ TARGET_URL: "http://127.0.0.1:3100", QA_ALLOWED_ORIGINS: "http://127.0.0.1:3100", QA_EMAIL: "qa@example.test", QA_PASSWORD: "replace-with-a-test-password" });
  expect(status.missing).toEqual(["QA_MODEL_API_KEY"]);
  expect(status.warnings[0]).toContain("placeholder");
});

test("approves a draft by moving it into cases/", async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "qa-tui-"));
  await mkdir(join(temporaryDirectory, "drafts"), { recursive: true });
  await writeFile(join(temporaryDirectory, "drafts", "DISC-001.yaml"), "id: DISC-001\n");
  const destination = await approveDraft(temporaryDirectory, "DISC-001.yaml");
  expect(destination).toBe(join(temporaryDirectory, "cases", "DISC-001.yaml"));
  expect(await listYaml(join(temporaryDirectory, "drafts"))).toEqual([]);
  expect(await listYaml(join(temporaryDirectory, "cases"))).toEqual(["DISC-001.yaml"]);
});

test("finds the latest run directory", async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "qa-tui-"));
  expect(await latestRun(temporaryDirectory)).toBeNull();
  await mkdir(join(temporaryDirectory, ".qa", "runs", "aaa"), { recursive: true });
  await mkdir(join(temporaryDirectory, ".qa", "runs", "bbb"), { recursive: true });
  expect(await latestRun(temporaryDirectory)).toBe(join(temporaryDirectory, ".qa", "runs", "bbb"));
});
