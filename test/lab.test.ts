import { expect, test } from "bun:test";
import { scoreLab } from "../src/lab.js";
import type { CaseResult } from "../src/schema.js";

function completed(id: string, verdict: Exclude<CaseResult["verdict"], null>): CaseResult {
  return { schemaVersion: 1, testCaseId: id, executionStatus: "completed", verdict, blockedBy: verdict === "BLOCKED" ? "product" : null, actual: "observed", evidence: [{ stepId: "open", claim: "seen", evidenceIds: ["ev-1"] }], reviewReason: null, error: null };
}

test("lab scorecard is stable only when every repeat matches the expected verdict", () => {
  const pass = scoreLab([[completed("CAB-001", "PASS"), completed("CAB-004", "FAIL")]], { "CAB-004": "FAIL" });
  expect(pass.stable).toBe(true);
  const drift = scoreLab([[completed("CAB-001", "PASS")], [completed("CAB-001", "FAIL")]], {});
  expect(drift.stable).toBe(false);
  expect(drift.lines.join("\n")).toContain("| CAB-001 | PASS | PASS | FAIL | no |");
});
