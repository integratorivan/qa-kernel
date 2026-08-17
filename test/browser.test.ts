import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARIA_MAX_CHARS, BrowserController, truncateForModel, VISIBLE_TEXT_MAX_CHARS } from "../src/browser.js";
import { EvidenceStore, SecretRedactor } from "../src/artifacts.js";
import { RecordingWriter, readRecording } from "../src/recording.js";
let server: Bun.Server<unknown>;
let controller: BrowserController;
let origin = "";
let temporaryDirectory = "";

const pageHtml = `<!doctype html>
<html><head><link rel="prefetch" href="/prefetch"></head><body>
  <label>Email <input id="email" type="email"></label>
  <label>Password <input id="password" type="password"></label>
  <button id="check-credentials" onclick="document.querySelector('#result').textContent = document.querySelector('#email').value === 'secret-sentinel' && document.querySelector('#password').value === 'fixture-password' ? 'Credentials intact' : 'Credentials corrupted'">Check credentials</button>
  <button id="save" onclick="document.querySelector('#result').textContent = 'Saved'">Save profile</button>
  <button id="slow" onclick="fetch('/api/slow').then(() => document.querySelector('#result').textContent = 'Slow complete')">Slow check</button>
  <button id="poll" onclick="fetch('/api/long-poll')">Open long poll</button>
  <button id="analytics" onclick="fetch('/analytics')">Send analytics</button>
  <button id="delayed-update" onclick="setTimeout(() => document.querySelector('#result').textContent = 'Delayed update', 4000)">Start delayed update</button>
  <button id="delayed-network" onclick="setTimeout(() => fetch('/api/delayed'), 700)">Start delayed network</button>
  <div id="scroll-box" style="height: 120px; overflow: auto">
    <button id="scroll-anchor">Scroll area</button>
    <div style="height: 900px"></div>
    <button id="inside-scroll" onclick="document.querySelector('#result').textContent = 'Container clicked'">Inside container</button>
  </div>

  <div id="toolbar" role="toolbar">
    <button id="templates">Шаблоны</button>
    <button id="columns-icon" onclick="document.querySelector('#columns-popup').hidden = false; document.querySelector('#columns-popup').dataset.open = 'true'; document.querySelector('#columns-popup').textContent = 'Columns open'"><img src="/icon.svg"></button>
    <span id="columns-label">Колонки</span>
    <button id="labelled-icon" aria-labelledby="columns-label" onclick="document.querySelector('#result').textContent = 'Labelled icon clicked'"><img src="/icon.svg"></button>
  </div>
  <button id="orphan-icon"><img src="/icon.svg"></button>
  <svg id="raw-svg" width="16" height="16"></svg>
  <div id="result"></div>
  <table><thead><tr><th>Product code <button id="header-search" class="icon">⌕</button></th></tr></thead><tbody>${Array.from({ length: 100 }, (_, index) => `<tr><td><button>row-${index}</button></td><td>bare cell</td></tr>`).join("")}</tbody></table>
  <button id="below" style="margin-top: 1400px" onclick="document.querySelector('#result').textContent = 'Below clicked'">Below viewport</button>
  <div id="columns-popup" hidden data-open="false"></div>
</body></html>`;

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      // Real timers are required: Playwright must observe network completion
      // against Chromium's actual event loop, not Bun's fake clock.
      if (url.pathname === "/api/slow") {
        const response = Promise.withResolvers<Response>();
        setTimeout(() => response.resolve(new Response("ok")), 2_700);
        return response.promise;
      }
      if (url.pathname === "/api/long-poll") {
        const response = Promise.withResolvers<Response>();
        setTimeout(() => response.resolve(new Response("ok")), 2_500);
        return response.promise;
      }
      if (url.pathname === "/analytics" || url.pathname === "/prefetch") {
        const response = Promise.withResolvers<Response>();
        setTimeout(() => response.resolve(new Response("ok")), 2_500);
        return response.promise;
      }
      if (url.pathname === "/api/delayed") return new Response("delayed");

      return new Response(pageHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  controller = new BrowserController(new Set([origin]));
  await controller.start();
});

afterAll(async () => {
  await controller.close();
  await server.stop(true);
});

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = "";
});

async function openCase() {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "qa-browser-"));
  const browser = await controller.createCase(new EvidenceStore(temporaryDirectory, new SecretRedactor(["secret-sentinel"])), "B2B-001");
  const opened = await browser.open(`${origin}/`, "open-page");
  expect(opened.actionStatus).toBe("ok");
  expect(opened.observationStatus).toBe("complete");
  expect(opened.observation).not.toBeNull();
  return browser;
}

describe("browser controller", () => {
  test("captures a quiet observation early while keeping the full attribution window", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "qa-browser-"));
    const screenshotTimes: number[] = [];
    const timingController = new BrowserController(new Set([origin]), true, async (page) => {
      screenshotTimes.push(Date.now());
      return page.screenshot({ type: "png" });
    });
    await timingController.start();
    const browser = await timingController.createCase(new EvidenceStore(temporaryDirectory, new SecretRedactor([])), "B2B-001");
    const startedAt = Date.now();
    await browser.open(`${origin}/`, "open-page");
    expect(screenshotTimes[1]! - startedAt).toBeLessThan(1_200);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_400);
    await browser.close();
    await timingController.close();
  }, 10_000);

  test("finds named controls and local toolbar/header icons without expanding table cells", async () => {
    const browser = await openCase();
    const observation = await browser.snapshot("inspect");
    const save = observation.interactive.find((target) => target.name === "Save profile");
    const icon = observation.interactive.find((target) => target.name.includes("Product code"));
    const toolbarIcon = observation.interactive.find((target) => target.kind === "icon-control" && target.name.includes("Шаблоны"));
    expect(save).toBeDefined();
    expect(icon?.kind).toBe("icon-control");
    expect(toolbarIcon?.kind).toBe("icon-control");
    expect(toolbarIcon?.nameSource).toBe("nearby-text");
    const labelledIcon = observation.interactive.find((target) => target.kind === "icon-control" && target.name.includes("Колонки"));
    expect(labelledIcon?.nameSource).toBe("nearby-text");
    expect(observation.interactive.filter((target) => target.kind === "icon-control")).toHaveLength(3);
    expect(observation.interactive.some((target) => target.name === "orphan-icon")).toBe(false);
    expect(observation.interactive.some((target) => target.name === "bare cell")).toBe(false);
    expect(observation.interactive.some((target) => target.name === "raw-svg")).toBe(false);
    expect(observation.interactive.length).toBeLessThanOrEqual(60);
    expect(observation.interactive.filter((target) => target.name.startsWith("row-")).length).toBeLessThanOrEqual(20);
    expect(observation.interactiveTruncated).toBe(true);
    expect(observation.omittedCount).toBeGreaterThan(0);

    const headerClicked = await browser.click(icon!.ref, "header-search");
    expect(headerClicked.actionStatus).toBe("ok");
    const toolbarAfterHeader = headerClicked.observation?.interactive.find((target) => target.kind === "icon-control" && target.name.includes("Шаблоны"));
    expect(toolbarAfterHeader).toBeDefined();
    const toolbarClicked = await browser.click(toolbarAfterHeader!.ref, "open-columns");
    expect(toolbarClicked.observation?.visibleText).toContain("Columns open");
    const saveAfterToolbar = toolbarClicked.observation?.interactive.find((target) => target.name === "Save profile");
    const saved = await browser.click(saveAfterToolbar!.ref, "save");
    const labelledAfterSave = saved.observation?.interactive.find((target) => target.kind === "icon-control" && target.name.includes("Колонки"));
    const labelledClicked = await browser.click(labelledAfterSave!.ref, "labelled-icon");
    expect(labelledClicked.observation?.visibleText).toContain("Labelled icon clicked");
    await browser.close();
  }, 10_000);

  test("serializes parallel secret fills without corrupting input values or action ordinals", async () => {
    const browser = await openCase();
    const observation = await browser.snapshot("inspect");
    const email = observation.interactive.find((target) => target.name === "Email");
    const password = observation.interactive.find((target) => target.name === "Password");
    const [emailResult, passwordResult] = await Promise.all([
      browser.fillSecret(email!.ref, "secret-sentinel", "fill-credentials"),
      browser.fillSecret(password!.ref, "fixture-password", "fill-credentials"),
    ]);
    expect(emailResult.actionId).toBe("act-2");
    expect(passwordResult.actionId).toBe("act-3");
    const check = passwordResult.observation?.interactive.find((target) => target.name === "Check credentials");
    const checked = await browser.click(check!.ref, "submit-login");
    expect(checked.observation?.visibleText).toContain("Credentials intact");
    await browser.close();
  }, 15_000);

  test("issues fresh refs after scrolling to an offscreen control", async () => {
    const browser = await openCase();
    const initial = await browser.snapshot("initial");
    expect(initial.interactive.some((target) => target.name === "Below viewport")).toBe(false);
    const scrolled = await browser.scroll("scroll", 5_000);
    const below = scrolled.observation?.interactive.find((target) => target.name === "Below viewport");
    expect(below).toBeDefined();
    const clicked = await browser.click(below!.ref, "below");
    expect(clicked.observation?.visibleText).toContain("Below clicked");
    await browser.close();
  }, 10_000);

  test("scrolls the container that owns a visible anchor ref", async () => {
    const browser = await openCase();
    const initial = await browser.snapshot("initial");
    const anchor = initial.interactive.find((target) => target.name === "Scroll area");
    expect(initial.interactive.some((target) => target.name === "Inside container")).toBe(false);
    const scrolled = await browser.scroll("scroll", 1_000, undefined, anchor!.ref);
    expect(scrolled.observation?.scroll.scope).toBe("container");
    expect(scrolled.observation?.scroll.y).toBeGreaterThan(0);
    const inside = scrolled.observation?.interactive.find((target) => target.name === "Inside container");
    expect(inside).toBeDefined();
    const clicked = await browser.click(inside!.ref, "inside");
    expect(clicked.observation?.visibleText).toContain("Container clicked");
    await browser.close();
  }, 10_000);

  test("waits for a slow XHR but does not let long polling hold the action", async () => {
    const browser = await openCase();
    const observation = await browser.snapshot("inspect");
    const slow = observation.interactive.find((target) => target.name === "Slow check");
    const startedAt = Date.now();
    const slowResult = await browser.click(slow!.ref, "slow");
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2_500);
    expect(slowResult.observationStatus).toBe("complete");
    const poll = slowResult.observation?.interactive.find((target) => target.name === "Open long poll");
    const pollStartedAt = Date.now();
    const pollResult = await browser.click(poll!.ref, "poll");
    expect(Date.now() - pollStartedAt).toBeLessThan(2_400);
    expect(pollResult.observationStatus).toBe("complete");
    const analytics = pollResult.observation?.interactive.find((target) => target.name === "Send analytics");
    const analyticsStartedAt = Date.now();
    const analyticsResult = await browser.click(analytics!.ref, "analytics");
    expect(Date.now() - analyticsStartedAt).toBeLessThan(2_400);
    expect(analyticsResult.observationStatus).toBe("complete");
    expect(analyticsResult.networkEvidenceIds.length).toBe(1);
    await browser.close();
  }, 15_000);

  test("attributes a request that starts after early DOM quiet but inside the 1500 ms window", async () => {
    const browser = await openCase();
    const observation = await browser.snapshot("inspect");
    const delayed = observation.interactive.find((target) => target.name === "Start delayed network");
    const result = await browser.click(delayed!.ref, "delayed-network");
    expect(result.networkEvidenceIds).toHaveLength(1);
    expect(await readFile(join(temporaryDirectory, "network.ndjson"), "utf8")).toContain("/api/delayed");
    await browser.close();
  }, 10_000);

  test("preserves successful actions when screenshot capture fails", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "qa-browser-"));
    const failingController = new BrowserController(new Set([origin]), true, async () => {
      throw new Error("intentional screenshot failure");
    });
    await failingController.start();
    const browser = await failingController.createCase(new EvidenceStore(temporaryDirectory, new SecretRedactor([])), "B2B-001");
    const opened = await browser.open(`${origin}/`, "open-page");
    const save = opened.observation?.interactive.find((target) => target.name === "Save profile");
    const clicked = await browser.click(save!.ref, "save");
    expect(clicked.actionStatus).toBe("ok");
    expect(clicked.observation?.visibleText).toContain("Saved");
    expect(clicked.warnings.some((warning) => warning.includes("screenshot"))).toBe(true);
    await browser.close();
    await failingController.close();
  }, 10_000);

  test("aborts an in-flight action and allows Chromium cleanup", async () => {
    const browser = await openCase();
    const observation = await browser.snapshot("inspect");
    const slow = observation.interactive.find((target) => target.name === "Slow check");
    const abort = new AbortController();
    const pending = browser.click(slow!.ref, "slow", abort.signal);
    // This integration test must interrupt Chromium's real settle loop.
    setTimeout(() => abort.abort(new Error("cancelled by test")), 100);
    await expect(pending).rejects.toThrow("cancelled by test");
    await browser.close();
  }, 10_000);

  test("rejects a snapshot when its case signal is already aborted", async () => {
    const browser = await openCase();
    const abort = new AbortController();
    abort.abort(new Error("snapshot cancelled by test"));
    await expect(browser.snapshot("inspect", abort.signal)).rejects.toThrow("snapshot cancelled by test");
    await browser.close();
  }, 10_000);

  test("rejects a ref after an asynchronous DOM update", async () => {
    const browser = await openCase();
    const observation = await browser.snapshot("inspect");
    const save = observation.interactive.find((target) => target.name === "Save profile");
    const delayed = observation.interactive.find((target) => target.name === "Start delayed update");
    await browser.click(delayed!.ref, "delay");
    // This integration test waits for the fixture's real asynchronous DOM mutation.
    const gate = Promise.withResolvers<void>();
    setTimeout(gate.resolve, 2_500);
    await gate.promise;
    await expect(browser.click(save!.ref, "save")).rejects.toThrow("stale");
    await browser.close();
  }, 12_000);

  test("redacts a secret field from observations and persisted evidence", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "qa-browser-"));
    const secret = "secret-sentinel@example.test";
    const evidence = new EvidenceStore(temporaryDirectory, new SecretRedactor([secret]));
    const browser = await controller.createCase(evidence, "B2B-001");
    await browser.open(`${origin}/`, "open-page");
    const observation = await browser.snapshot("inspect");
    const email = observation.interactive.find((target) => target.name === "Email");
    const filled = await browser.fillSecret(email!.ref, secret, "fill-email");
    expect(filled.observation?.visibleText).not.toContain(secret);
    expect(filled.observation?.aria).not.toContain(secret);
    for (const item of evidence.all()) {
      expect(await Bun.file(join(temporaryDirectory, item.file)).text()).not.toContain(secret);
    }
    await browser.close();
  }, 10_000);

  test("rejects and does not record a literal secret passed through fill", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "qa-browser-secret-"));
    const secret = "plain-secret-sentinel";
    const recording = new RecordingWriter(join(temporaryDirectory, "recording.ndjson"));
    const evidence = new EvidenceStore(temporaryDirectory, new SecretRedactor([secret]));
    const browser = await controller.createCase(evidence, "B2B-001", { recording, secretValues: [secret] });
    try {
      await browser.open(`${origin}/`, "open-page");
      const observation = await browser.snapshot("inspect");
      const email = observation.interactive.find((target) => target.name === "Email");
      await expect(browser.fill(email!.ref, secret, "fill-email")).rejects.toThrow("fill must contain exactly one of from/value");
      await recording.close();
      const persisted = await readRecording(join(temporaryDirectory, "recording.ndjson"));
      expect(JSON.stringify(persisted.entries)).not.toContain(secret);
    } finally {
      await browser.close();
    }
  }, 10_000);

  test("does not persist a secret-valued stable locator", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "qa-browser-locator-secret-"));
    const secret = "locator-secret-sentinel";
    const secretServer = Bun.serve({
      port: 0,
      fetch: () => new Response(`<button aria-label="${secret}">Secret control</button>`, { headers: { "content-type": "text/html; charset=utf-8" } }),
    });
    const secretOrigin = `http://127.0.0.1:${secretServer.port}`;
    const secretController = new BrowserController(new Set([secretOrigin]));
    await secretController.start();
    const recording = new RecordingWriter(join(temporaryDirectory, "recording.ndjson"));
    const browser = await secretController.createCase(new EvidenceStore(temporaryDirectory, new SecretRedactor([secret])), "CASE-SECRET", { recording, secretValues: [secret] });
    try {
      await expect(browser.open(`${secretOrigin}/?token=${secret}`, "open-secret")).rejects.toThrow("RECORDING_SECRET_LITERAL");
      const opened = await browser.open(`${secretOrigin}/`, "open-page");
      const target = opened.observation?.interactive.find((item) => item.name.includes("REDACTED"));
      expect(target).toBeDefined();
      await expect(browser.click(target!.ref, "click-secret")).resolves.toMatchObject({ actionStatus: "ok" });
      await recording.close();
      const persisted = await readRecording(join(temporaryDirectory, "recording.ndjson"));
      const click = persisted.entries.find((entry) => entry.kind === "action" && entry.action === "click");
      if (!click || click.kind !== "action") throw new Error("recorded click action missing");
      expect(click.locator).toBeNull();
      expect(JSON.stringify(persisted.entries)).not.toContain(secret);
    } finally {
      await browser.close();
      await secretController.close();
      await secretServer.stop(true);
    }
  }, 15_000);
  test("truncates model-facing snapshot text and keeps the full evidence file", async () => {
    expect(truncateForModel("short", 80).truncated).toBe(false);
    const huge = `${"marker-line\n".repeat(8)}${"x".repeat(ARIA_MAX_CHARS)}`;
    const truncated = truncateForModel(huge, 80);
    expect(truncated.truncated).toBe(true);
    expect(truncated.text.length).toBeLessThan(huge.length);
    expect(truncated.text).toContain("truncated:");

    const html = `<!doctype html><html><body><p id="blob">${"visible-chunk-".repeat(Math.ceil(VISIBLE_TEXT_MAX_CHARS / 10))}</p><button>Open cabinet</button></body></html>`;
    const largeServer = Bun.serve({ port: 0, fetch: () => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }) });
    const largeOrigin = `http://127.0.0.1:${largeServer.port}`;
    const largeController = new BrowserController(new Set([largeOrigin]));
    await largeController.start();
    temporaryDirectory = await mkdtemp(join(tmpdir(), "qa-browser-truncate-"));
    const evidence = new EvidenceStore(temporaryDirectory, new SecretRedactor([]));
    const browser = await largeController.createCase(evidence, "B2B-001");
    try {
      const opened = await browser.open(`${largeOrigin}/`, "open-page");
      expect(opened.observation?.visibleTextTruncated).toBe(true);
      expect(opened.observation?.visibleText.length).toBeLessThan(VISIBLE_TEXT_MAX_CHARS + 80);
      const snapshot = evidence.all().find((item) => item.id === opened.observation?.snapshotId);
      expect(snapshot).toBeDefined();
      const persisted = JSON.parse(await readFile(join(temporaryDirectory, snapshot!.file), "utf8")) as { visibleText: string };
      expect(persisted.visibleText.length).toBeGreaterThan(VISIBLE_TEXT_MAX_CHARS);
    } finally {
      await browser.close();
      await largeController.close();
      largeServer.stop(true);
    }
  }, 15_000);
});
