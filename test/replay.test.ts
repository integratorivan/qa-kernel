import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { replayPack } from "../src/replay.js";

let temporaryDirectory = "";

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = "";
});

test("replay rejects non-positive repeat and missing specs", async () => {
  temporaryDirectory = await mkdtemp(join(".qa", "replay-test-"));
  await expect(replayPack({ packDirectory: temporaryDirectory, repeat: 0 })).rejects.toThrow("positive integer");
  await expect(replayPack({ packDirectory: temporaryDirectory, repeat: 1 })).rejects.toThrow("specs directory is missing");
});

test("replay invokes Playwright without model credentials", async () => {
  temporaryDirectory = await mkdtemp(join(".qa", "replay-test-"));
  const packDirectory = join(temporaryDirectory, "pack");
  await mkdir(join(packDirectory, "specs"), { recursive: true });
  await writeFile(join(packDirectory, "specs", "smoke.spec.ts"), 'import { test } from "@playwright/test"; test("replay smoke", async () => {});');
  const outputDirectory = join(temporaryDirectory, "output");
  const previousKey = process.env.QA_MODEL_API_KEY;
  delete process.env.QA_MODEL_API_KEY;
  try {
    expect(await replayPack({ packDirectory, repeat: 2, outputDirectory })).toBe(0);
  } finally {
    if (previousKey === undefined) delete process.env.QA_MODEL_API_KEY;
    else process.env.QA_MODEL_API_KEY = previousKey;
  }
});
