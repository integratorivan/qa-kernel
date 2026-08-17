import { expect, test } from "bun:test";
import { resolveModelConfiguration } from "../src/model.js";
import { awaitPhaseSetup, BrowserActionGuard, containsApprovedSecret, extractJsonText, finalAssistantText, MODEL_BROWSER_ACTIONS, modelForConfiguration, promptWithFinalization, validateBrowserParameters, verifyPiIsolation } from "../src/pi.js";

const observation = {
  snapshotId: "snapshot",
  screenshotId: "screenshot",
  url: "https://example.test/",
  visibleText: "Cabinet",
  aria: "Cabinet",
  interactive: [{ ref: "s1-e1", kind: "button" as const, name: "Open", nameSource: "aria" as const, bounds: { x: 0, y: 0, width: 10, height: 10 }, enabled: true }],
  interactiveTruncated: false,
  omittedCount: 0,
  ariaTruncated: false,
  visibleTextTruncated: false,
  scroll: { scope: "page" as const, x: 0, y: 0, maxX: 0, maxY: 1_000 },
};

test("Pi SDK exposes only the browser custom tool for the default GLM configuration", async () => {
  const configuration = resolveModelConfiguration({});
  expect(configuration).toEqual({ provider: "openrouter", model: "z-ai/glm-5.2" });
  expect(JSON.stringify(modelForConfiguration(configuration))).toContain('"maxTokensField":"max_tokens","openRouterRouting":{"order":["z-ai"],"allow_fallbacks":false,"require_parameters":true}');

  await expect(verifyPiIsolation(configuration)).resolves.toEqual(["browser"]);
});

test("model-visible browser actions leave lifecycle cleanup to the host", () => {
  expect(MODEL_BROWSER_ACTIONS).not.toContain("close");
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

test("scroll movement resets the no-progress counter", () => {
  const guard = new BrowserActionGuard(0, { maxActions: 25, timeoutMs: 1_000 });
  for (const y of [0, 300, 600]) {
    expect(guard.start(100)).toBeNull();
    expect(guard.observe({ ...observation, scroll: { ...observation.scroll, y } }, "[]")).toBeNull();
  }
});

test("repeated scroll at the same boundary triggers no-progress", () => {
  const guard = new BrowserActionGuard(0, { maxActions: 25, timeoutMs: 1_000 });
  for (let index = 0; index < 2; index += 1) {
    expect(guard.start(100)).toBeNull();
    expect(guard.observe({ ...observation, scroll: { ...observation.scroll, y: 1_000 } }, "[]")).toBeNull();
  }
  expect(guard.start(100)).toBeNull();
  expect(guard.observe({ ...observation, scroll: { ...observation.scroll, y: 1_000 } }, "[]")).toBe("no_progress");
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

test("browser parameter parser rejects extra fields and ambiguous fills", () => {
  expect(() => validateBrowserParameters({ action: "click", stepId: "step", ref: "r", value: "unexpected" })).toThrow("unsupported field");
  expect(() => validateBrowserParameters({ action: "fill", stepId: "step", ref: "r", from: "QA_PASSWORD", value: "literal" })).toThrow("exactly one");
  expect(() => validateBrowserParameters({ action: "checkText", stepId: "step", oracleList: "expect", oracleIndex: 0, text: "Cabinet", state: "visible", ref: "unexpected" })).toThrow("unsupported field");
  expect(() => validateBrowserParameters({ action: "checkLocator", stepId: "step", oracleList: "expect", oracleIndex: 0, locatorKind: "role", role: "heading", name: "Cabinet", locatorValue: "unexpected", state: "visible" })).toThrow("role must not contain");
});

test("time limit also leaves a finalization turn without counting an action", () => {
  const guard = new BrowserActionGuard(0, { timeoutMs: 100 });
  expect(guard.start(100)).toBe("time_limit");
  expect(guard.actions).toBe(0);
});

test("bounds runtime setup and disposes a session that resolves after the phase", async () => {
  const abort = new AbortController();
  const late = Promise.withResolvers<{ dispose(): void }>();
  let disposed = false;
  const setup = awaitPhaseSetup(late.promise, abort.signal, (session) => session.dispose());
  abort.abort(new Error("CASE_PHASE_TIMEOUT"));
  await expect(setup).rejects.toThrow("CASE_PHASE_TIMEOUT");
  late.resolve({ dispose: () => { disposed = true; } });
  await Bun.sleep(0);
  expect(disposed).toBe(true);
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

test("escapes an abort-ignoring initial prompt before finalization", async () => {
  const prompts: string[] = [];
  const session = {
    prompt: async (text: string) => {
      prompts.push(text);
      if (prompts.length === 1) await new Promise<never>(() => {});
    },
    abort: async () => {},
    setActiveToolsByName: () => {},
  };

  await expect(promptWithFinalization(session, "execute", "finalize", () => {}, 5, 100, 5)).resolves.toBe(true);
  expect(prompts).toEqual(["execute", "finalize"]);
});

test("can finalize in a fresh session when the browser session stays busy", async () => {
  const prompts: string[] = [];
  const finalized: string[] = [];
  const session = {
    prompt: async (text: string) => {
      prompts.push(text);
      await new Promise<never>(() => {});
    },
    abort: async () => {},
    setActiveToolsByName: () => {},
  };

  await expect(promptWithFinalization(session, "execute", "finalize", () => {}, 5, 100, 5, async (prompt) => { finalized.push(prompt); })).resolves.toBe(true);
  expect(prompts).toEqual(["execute"]);
  expect(finalized).toEqual(["finalize"]);
});

test("gives finalization its own full budget after the browser phase expires", async () => {
  const session = {
    prompt: async () => await new Promise<never>(() => {}),
    abort: async () => {},
    setActiveToolsByName: () => {},
  };
  let finalized = false;

  await expect(promptWithFinalization(session, "execute", "finalize", () => {}, 5, 50, 5, async (_prompt, signal) => {
    expect(signal.aborted).toBe(false);
    await Bun.sleep(20);
    expect(signal.aborted).toBe(false);
    finalized = true;
  })).resolves.toBe(true);
  expect(finalized).toBe(true);
});

test("bounds a finalization prompt that never resolves", async () => {
  let promptCount = 0;
  let releaseInitial: (() => void) | undefined;
  const session = {
    prompt: async () => {
      promptCount += 1;
      if (promptCount === 1) await new Promise<void>((resolve) => { releaseInitial = resolve; });
      else await new Promise<never>(() => {});
    },
    abort: async () => { releaseInitial?.(); },
    setActiveToolsByName: () => {},
  };

  await expect(promptWithFinalization(session, "execute", "finalize", () => {}, 5, 5, 5)).rejects.toThrow("FINALIZATION_TIMEOUT");
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
