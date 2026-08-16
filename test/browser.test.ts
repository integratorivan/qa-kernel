import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserController } from "../src/browser.js";
import { EvidenceStore, SecretRedactor } from "../src/artifacts.js";

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

  <div id="result"></div>
  <table><thead><tr><th>Product code <button id="header-search" class="icon">⌕</button></th></tr></thead><tbody>${Array.from({ length: 100 }, (_, index) => `<tr><td><button>row-${index}</button></td></tr>`).join("")}</tbody></table>
  <button id="below" style="margin-top: 1400px" onclick="document.querySelector('#result').textContent = 'Below clicked'">Below viewport</button>
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

  test("finds named controls and a header icon without expanding table cells", async () => {
    const browser = await openCase();
    const observation = (await browser.snapshot("inspect"));
    const save = observation.interactive.find((target) => target.name === "Save profile");
    const icon = observation.interactive.find((target) => target.name.includes("Product code"));
    expect(save).toBeDefined();
    expect(icon?.kind).toBe("icon-control");
    expect(observation.interactive.length).toBeLessThanOrEqual(60);
    expect(observation.interactive.filter((target) => target.name.startsWith("row-")).length).toBeLessThanOrEqual(20);
    await browser.click(save!.ref, "save");
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
});
