import { expect, test } from "bun:test";
import { resolveModelConfiguration } from "../src/model.js";
import { BrowserActionGuard, containsApprovedSecret, extractJsonText, finalAssistantText, modelForConfiguration, promptWithFinalization, verifyPiIsolation } from "../src/pi.js";

const observation = {
  snapshotId: "snapshot",
  screenshotId: "screenshot",
  url: "https://example.test/",
  visibleText: "Cabinet",
  aria: "Cabinet",
  interactive: [{ ref: "s1-e1", kind: "button" as const, name: "Open", nameSource: "aria" as const, bounds: { x: 0, y: 0, width: 10, height: 10 }, enabled: true }],
  interactiveTruncated: false,
  omittedCount: 0,
};

test("Pi SDK exposes only the browser custom tool for the default GLM configuration", async () => {
  const configuration = resolveModelConfiguration({});
  expect(configuration).toEqual({ provider: "openrouter", model: "z-ai/glm-5.2" });
  expect(JSON.stringify(modelForConfiguration(configuration))).toContain('"maxTokensField":"max_tokens","openRouterRouting":{"order":["z-ai"],"allow_fallbacks":false,"require_parameters":true}');

  await expect(verifyPiIsolation(configuration)).resolves.toEqual(["browser"]);
});

test("the third identical observation returns a finalization gate", () => {
  const guard = new BrowserActionGuard(0, { maxActions: 25, timeoutMs: 1_000 });
  for (let index = 0; index < 2; index += 1) {
    expect(guard.start(100)).toBeNull();
    expect(guard.observe({ ...observation, snapshotId: `snapshot-${index}`, interactive: [{ ...observation.interactive[0]!, ref: `s${index + 1}-e1` }] }, "[]")).toBeNull();
  }
  expect(guard.start(100)).toBeNull();
  expect(guard.observe({ ...observation, snapshotId: "snapshot-3", interactive: [{ ...observation.interactive[0]!, ref: "s3-e1" }] }, "[]")).toBe("no_progress");
  expect(guard.actions).toBe(3);
});

test("network changes reset no-progress and the last allowed action returns control", () => {
  const guard = new BrowserActionGuard(0, { maxActions: 3, timeoutMs: 1_000 });
  expect(guard.start(100)).toBeNull();
  expect(guard.observe(observation, "[]")).toBeNull();
  expect(guard.start(100)).toBeNull();
  expect(guard.observe(observation, '[{"url":"https://example.test/api"}]')).toBeNull();
  expect(guard.start(100)).toBeNull();
  expect(guard.observe(observation, "[]")).toBe("action_limit");
  expect(guard.start(100)).toBe("action_limit");
  expect(guard.actions).toBe(3);
});

test("rejects an approved secret hidden inside an ordinary fill value", () => {
  expect(containsApprovedSecret("prefix-secret-sentinel-suffix", ["secret-sentinel"])).toBe(true);
  expect(containsApprovedSecret("public test data", ["secret-sentinel"])).toBe(false);
});

test("time limit also leaves a finalization turn without counting an action", () => {
  const guard = new BrowserActionGuard(0, { timeoutMs: 100 });
  expect(guard.start(100)).toBe("time_limit");
  expect(guard.actions).toBe(0);
});

test("hard case timeout aborts inference and runs one tool-free finalization turn", async () => {
  const prompts: string[] = [];
  const activeTools: string[][] = [];
  let resolveInitial: (() => void) | undefined;
  const session = {
    prompt: async (text: string) => {
      prompts.push(text);
      if (prompts.length === 1) await new Promise<void>((resolve) => { resolveInitial = resolve; });
    },
    abort: async () => { resolveInitial?.(); },
    setActiveToolsByName: (tools: string[]) => { activeTools.push(tools); },
  };
  let timeoutNotified = false;
  await expect(promptWithFinalization(session, "execute", "finalize", () => { timeoutNotified = true; }, 5, 100)).resolves.toBe(true);
  expect(timeoutNotified).toBe(true);
  expect(prompts).toEqual(["execute", "finalize"]);
  expect(activeTools).toEqual([[]]);
});

test("uses the session-owned final assistant text with deltas only as fallback", () => {
  expect(finalAssistantText({ getLastAssistantText: () => '{"verdict":"PASS"}' }, ["partial"])).toBe('{"verdict":"PASS"}');
  expect(finalAssistantText({ getLastAssistantText: () => undefined }, ["fall", "back"])).toBe("fallback");
});

test("extracts a JSON object from prose or a fenced block", () => {
  expect(extractJsonText('Based on the visit {"productMap":["Login"],"uncoveredAreas":[],"drafts":[]}')).toBe('{"productMap":["Login"],"uncoveredAreas":[],"drafts":[]}');
  expect(extractJsonText("```json\n{\"ok\":true}\n```")).toBe('{"ok":true}');
  expect(extractJsonText("Based on exploration there is no object")).toBe("Based on exploration there is no object");
});

test("surfaces a provider error instead of repairing an empty JSON result", () => {
  expect(() => finalAssistantText({ getLastAssistantText: () => "", messages: [{ role: "assistant", stopReason: "error", errorMessage: "provider rejected request" }] }, [])).toThrow("provider rejected request");
});
