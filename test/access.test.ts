import { expect, test } from "bun:test";
import { accessLine, type AccessEvent } from "../src/access.js";
import { htmlDashboard } from "../src/dashboard.js";
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
