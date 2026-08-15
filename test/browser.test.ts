import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserController } from "../src/browser.js";
import { EvidenceStore, SecretRedactor } from "../src/artifacts.js";

let server: Bun.Server<unknown>;
let controller: BrowserController;
let origin = "";
let temporaryDirectory = "";

const pageHtml = `<!doctype html>
<html><body>
  <label>Email <input id="email" type="email"></label>
  <button id="save" onclick="document.querySelector('#result').textContent = 'Saved'">Save profile</button>
  <button id="slow" onclick="fetch('/api/slow').then(() => document.querySelector('#result').textContent = 'Slow complete')">Slow check</button>
  <button id="poll" onclick="fetch('/api/long-poll')">Open long poll</button>
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
    await browser.close();
  }, 15_000);
});
