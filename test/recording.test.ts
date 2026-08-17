import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { RecordingWriter, groundingMatches, oracleCovered, readRecording, validateRecordingEntry } from "../src/recording.js";

let temporaryDirectory = "";

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = "";
});

test("RecordingWriter preserves append order", async () => {
  temporaryDirectory = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "qa-recording-"));
  const path = join(temporaryDirectory, "recording.ndjson");
  const writer = new RecordingWriter(path);
  await Promise.all([1, 2, 3].map((ordinal) => writer.append({ schemaVersion: 1, kind: "action", caseId: "CASE-001", stepId: `step-${ordinal}`, actionOrdinal: ordinal, action: "open", frame: "main", sourceSnapshotId: null, locator: null, url: "/", from: null, value: null, key: null, deltaY: null, actionStatus: "ok", observationStatus: "complete" })));
  await writer.close();
  const lines = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { actionOrdinal: number });
  expect(lines.map((line) => line.actionOrdinal)).toEqual([1, 2, 3]);
});

test("recording validation rejects secret-like literals and grounding ignores assertion vocabulary", () => {
  expect(() => validateRecordingEntry({ schemaVersion: 1, kind: "action", caseId: "CASE-001", stepId: "fill", actionOrdinal: 1, action: "fill", frame: "main", sourceSnapshotId: null, locator: { kind: "label", value: "Password" }, url: null, from: null, value: "sk-live-token", key: null, deltaY: null, actionStatus: "ok", observationStatus: "complete" })).not.toThrow();
  expect(groundingMatches('Exact text "Fixture cabinet" is visible', "Fixture cabinet")).toBe(true);
  expect(groundingMatches("The page is visible", "visible")).toBe(false);
});

test("readRecording validates every persisted line", async () => {
  temporaryDirectory = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "qa-recording-"));
  const path = join(temporaryDirectory, "recording.ndjson");
  await Bun.write(path, "{\"schemaVersion\":1,\"kind\":\"unknown\"}\n");
  await expect(readRecording(path)).rejects.toThrow("recording line 1");
});
test("failed check keeps readiness incomplete even with a later pass", () => {
  const caseData = { oracle: { expect: ["Fixture cabinet"], reject: [] } } as unknown as Parameters<typeof oracleCovered>[0];
  const checks = [
    { schemaVersion: 1, kind: "check", caseId: "CASE-001", stepId: "step", checkOrdinal: 1, oracle: { list: "expect", index: 0 }, check: "text", text: "Fixture cabinet", exact: true, state: "visible", groundingText: "Fixture cabinet", status: "failed" },
    { schemaVersion: 1, kind: "check", caseId: "CASE-001", stepId: "step", checkOrdinal: 2, oracle: { list: "expect", index: 0 }, check: "text", text: "Fixture cabinet", exact: true, state: "visible", groundingText: "Fixture cabinet", status: "passed" },
  ] as const;
  expect(oracleCovered(caseData, checks).status).toBe("incomplete");
  expect(oracleCovered(caseData, checks).unboundCheckOrdinals).toEqual([1]);
});
