import { expect, test } from "bun:test";
import { applyOracleCoverage, droppedOracleExpects } from "../src/oracle.js";
import { SCHEMA_VERSION, type CaseResult } from "../src/schema.js";

test("keeps expect lines that share a distinctive word with the claims", () => {
  expect(droppedOracleExpects(["Cabinet loads"], ["Cabinet opened", "The cabinet page rendered"])).toEqual([]);
  expect(droppedOracleExpects(["Пользователь попал в авторизованный кабинет"], ["Кабинет открыт"])).toEqual([]);
});

test("reports expect lines with no overlapping content word", () => {
  expect(droppedOracleExpects(["Dashboard opens", "Cabinet loads"], ["Page rendered"])).toEqual(["Dashboard opens", "Cabinet loads"]);
});

test("downgrades an uncovered PASS to INCONCLUSIVE", () => {
  const pass: CaseResult = {
    schemaVersion: SCHEMA_VERSION,
    testCaseId: "RUN-001",
    executionStatus: "completed",
    verdict: "PASS",
    blockedBy: null,
    actual: "Something else appeared",
    evidence: [{ stepId: "open-login", claim: "Fixture rendered", evidenceIds: ["ev-1"] }],
    reviewReason: null,
    error: null,
  };
  const covered = applyOracleCoverage(pass, ["Cabinet loads"]);
  expect(covered.dropped).toEqual(["Cabinet loads"]);
  expect(covered.result.executionStatus).toBe("completed");
  if (covered.result.executionStatus !== "completed") throw new Error("expected completed result");
  expect(covered.result.verdict).toBe("INCONCLUSIVE");
  expect(covered.result.reviewReason).toContain("Cabinet loads");
});

test("leaves FAIL and covered PASS unchanged", () => {
  const fail: CaseResult = {
    schemaVersion: SCHEMA_VERSION,
    testCaseId: "RUN-001",
    executionStatus: "completed",
    verdict: "FAIL",
    blockedBy: null,
    actual: "Error screen",
    evidence: [{ stepId: "open-login", claim: "Error visible", evidenceIds: ["ev-1"] }],
    reviewReason: null,
    error: null,
  };
  expect(applyOracleCoverage(fail, ["Cabinet loads"]).result.verdict).toBe("FAIL");
  const pass: CaseResult = {
    ...fail,
    verdict: "PASS",
    actual: "Cabinet opened",
    evidence: [{ stepId: "open-login", claim: "Cabinet rendered", evidenceIds: ["ev-1"] }],
  };
  expect(applyOracleCoverage(pass, ["Cabinet loads"]).dropped).toEqual([]);
  expect(applyOracleCoverage(pass, ["Cabinet loads"]).result.verdict).toBe("PASS");
});
