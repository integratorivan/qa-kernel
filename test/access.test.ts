import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { accessLine, sanitizeAccessEvent, sanitizeAccessUrl, type AccessEvent } from "../src/access.js";
import { htmlDashboard, htmlLabDashboard } from "../src/dashboard.js";
import { markdownReport, summarize } from "../src/report.js";

const event: AccessEvent = {
  at: "2026-08-16T13:46:47.000Z",
  caseId: "B2B-001",
  stepId: "submit-login",
  action: "click",
  ref: "s2-e3",
  from: null,
  requestedUrl: null,
  pageUrl: "https://devatlaskm.marketing-logic.ru/monitoring/matrix",
  actionStatus: "ok",
  observationStatus: "complete",
  screenshotId: "ev-screen",
  snapshotId: "ev-snap",
  networkEvidenceIds: ["ev-net"],
  interactiveCount: 12,
  limitReached: null,
};

test("access line never includes a secret value", () => {
  expect(accessLine({ ...event, from: "QA_PASSWORD" })).toContain("from=QA_PASSWORD");
  expect(accessLine(event)).not.toContain("secret");
});

test("access URLs keep only origin and pathname", () => {
  const unsafe = "https://example.test/cabinet/reports?token=secret#private";
  expect(sanitizeAccessUrl(unsafe)).toBe("https://example.test/cabinet/reports");
  expect(sanitizeAccessEvent({ ...event, requestedUrl: unsafe, pageUrl: unsafe })).toMatchObject({ requestedUrl: "https://example.test/cabinet/reports", pageUrl: "https://example.test/cabinet/reports" });
  expect(accessLine({ ...event, pageUrl: unsafe })).not.toContain("secret");
});

test("report includes the access trail", () => {
  const result = {
    schemaVersion: 1 as const,
    testCaseId: "B2B-001",
    executionStatus: "completed" as const,
    verdict: "PASS" as const,
    blockedBy: null,
    actual: "Cabinet opened",
    evidence: [{ stepId: "submit-login", claim: "Matrix visible", evidenceIds: ["ev-screen"] }],
    reviewReason: null,
    error: null,
  };
  expect(markdownReport([result], summarize([result]), [event])).toContain("## Access trail");
  expect(markdownReport([result], summarize([result]), [event])).toContain("click submit-login s2-e3 → https://devatlaskm.marketing-logic.ru/monitoring/matrix");
  expect(htmlDashboard([result], summarize([result]), [event])).toContain("Access trail");
  expect(htmlDashboard([result], summarize([result]), [event])).toContain("screenshots/ev-screen.png");
});

test("lab dashboard links every scheduled repeat without an inline gallery", () => {
  const counts = summarize([]).counts;
  const html = htmlLabDashboard([
    { id: "run-01", status: "COMPLETED", counts, durationMs: 100 },
    { id: "run-02", status: "ERROR", counts, durationMs: 20 },
    { id: "run-03", status: "MISSING", counts, durationMs: 0 },
  ]);
  expect(html).toContain('href="run-01/dashboard.html"');
  expect(html).toContain('href="run-02/dashboard.html"');
  expect(html).toContain('href="run-03/dashboard.html"');
  expect(html).not.toContain("<img");
});

test("Copy note reports success or an explicit fallback error from file URLs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qa-dashboard-"));
  const path = join(directory, "dashboard.html");
  await Bun.write(path, htmlDashboard([], summarize([]), []));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => { throw new Error("clipboard blocked"); } } });
      document.execCommand = () => { throw new Error("copy blocked"); };
    });
    await page.goto(`file://${path}`);
    await page.getByRole("button", { name: "Copy note" }).click();
    await expect(page.locator("#copy-status").textContent()).resolves.toBe("Copy failed. Select the note and copy it manually.");
  } finally {
    await browser.close();
  }
}, 10_000);

test("Copy note uses the execCommand fallback from file URLs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qa-dashboard-"));
  const path = join(directory, "dashboard.html");
  await Bun.write(path, htmlDashboard([], summarize([]), []));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => { throw new Error("clipboard blocked"); } } });
      document.execCommand = (command) => command === "copy";
    });
    await page.goto(`file://${path}`);
    await page.getByRole("button", { name: "Copy note" }).click();
    await expect(page.locator("#copy-status").textContent()).resolves.toBe("Copied");
  } finally {
    await browser.close();
  }
}, 10_000);
