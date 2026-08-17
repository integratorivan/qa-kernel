import { expect, test } from "bun:test";
import { markLabAborted, reconcileChildRunStatus, scoreLab, type LabRun } from "../src/lab.js";
import type { CaseResult } from "../src/schema.js";

function completed(id: string, verdict: Exclude<CaseResult["verdict"], null>): CaseResult {
  return { schemaVersion: 1, testCaseId: id, executionStatus: "completed", verdict, blockedBy: verdict === "BLOCKED" ? "product" : null, actual: "observed", evidence: [{ stepId: "open", claim: "seen", evidenceIds: ["ev-1"] }], reviewReason: null, error: null };
}

function run(id: string, results: CaseResult[], status: LabRun["status"] = "COMPLETED"): LabRun {
  return { id, status, results };
}

const expectedCases = { "CAB-001": "PASS", "CAB-004": "FAIL" } as const;

test("child process exit status cannot be hidden by a completed checkpoint", () => {
  expect(reconcileChildRunStatus(0, "COMPLETED")).toBe("COMPLETED");
  expect(reconcileChildRunStatus(1, "COMPLETED")).toBe("COMPLETED");
  expect(reconcileChildRunStatus(2, "COMPLETED")).toBe("ERROR");
  expect(reconcileChildRunStatus(130, "COMPLETED")).toBe("ABORTED");
  expect(reconcileChildRunStatus(0, "ERROR")).toBe("ERROR");
  expect(reconcileChildRunStatus(0, "MISSING")).toBe("ERROR");
});

test("lab scorecard fails closed for missing repeats and cases", () => {
  expect(scoreLab({ expectedRepeatCount: 1, expectedCases, runs: [] }).stable).toBe(false);
  expect(scoreLab({ expectedRepeatCount: 1, expectedCases, runs: [run("run-01", [])] }).stable).toBe(false);
  expect(scoreLab({ expectedRepeatCount: 2, expectedCases, runs: [run("run-01", [completed("CAB-001", "PASS")])] }).stable).toBe(false);
});

test("lab scorecard fails closed when every repeat omits an approved case", () => {
  const scored = scoreLab({
    expectedRepeatCount: 2,
    expectedCases,
    runs: [
      run("run-01", [completed("CAB-001", "PASS")]),
      run("run-02", [completed("CAB-001", "PASS")]),
    ],
  });

  expect(scored.status).toBe("ERROR");
  expect(scored.stable).toBe(false);
  expect(scored.lines.join("\n")).toContain("| CAB-004 | FAIL | MISSING | MISSING | no |");
});

test("lab scorecard treats duplicate case IDs as a run error", () => {
  const scored = scoreLab({
    expectedRepeatCount: 1,
    expectedCases,
    runs: [run("run-01", [completed("CAB-001", "PASS"), completed("CAB-001", "PASS"), completed("CAB-004", "FAIL")])],
  });

  expect(scored.status).toBe("ERROR");
  expect(scored.stable).toBe(false);
  expect(scored.lines.join("\n")).toContain("| CAB-001 | PASS | DUPLICATE | no |");
});

test("lab scorecard fails closed when a child run errors despite valid results", () => {
  const scored = scoreLab({
    expectedRepeatCount: 1,
    expectedCases,
    runs: [run("run-01", [completed("CAB-001", "PASS"), completed("CAB-004", "FAIL")], "ERROR")],
  });

  expect(scored.status).toBe("ERROR");
  expect(scored.stable).toBe(false);
  expect(scored.exitCode).toBe(1);
});

test("lab scorecard reports an aborted child run with exit 130", () => {
  const scored = scoreLab({
    expectedRepeatCount: 1,
    expectedCases,
    runs: [run("run-01", [completed("CAB-001", "PASS"), completed("CAB-004", "FAIL")], "ABORTED")],
  });

  expect(scored.status).toBe("ABORTED");
  expect(scored.stable).toBe(false);
  expect(scored.exitCode).toBe(130);
});

test("late SIGINT marks a fully collected lab as aborted", () => {
  const runs = [run("run-01", [completed("CAB-001", "PASS"), completed("CAB-002", "FAIL")])];
  markLabAborted(runs, 1);
  const scored = scoreLab({ expectedRepeatCount: 1, expectedCases, runs });
  expect(runs[0]?.status).toBe("ABORTED");
  expect(scored.status).toBe("ABORTED");
  expect(scored.stable).toBe(false);
  expect(scored.exitCode).toBe(130);
});

test("lab scorecard is stable only for complete matching repeats", () => {
  const scored = scoreLab({
    expectedRepeatCount: 3,
    expectedCases,
    runs: [
      run("run-01", [completed("CAB-001", "PASS"), completed("CAB-004", "FAIL")]),
      run("run-02", [completed("CAB-001", "PASS"), completed("CAB-004", "FAIL")]),
      run("run-03", [completed("CAB-001", "PASS"), completed("CAB-004", "FAIL")]),
    ],
  });

  expect(scored.status).toBe("COMPLETED");
  expect(scored.stable).toBe(true);
  expect(scored.exitCode).toBe(0);
  expect(scored.lines.join("\n")).toContain("| CAB-004 | FAIL | FAIL | FAIL | FAIL | yes |");
});
