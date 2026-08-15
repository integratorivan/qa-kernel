import type { CaseResult, Verdict } from "./schema.js";

export interface RunSummary {
  status: "COMPLETED" | "ERROR" | "ABORTED";
  counts: Record<Verdict | "CASE_ERROR", number>;
  exitCode: 0 | 1 | 2 | 130;
}

export function summarize(results: readonly CaseResult[], status: RunSummary["status"] = "COMPLETED"): RunSummary {
  const counts: Record<Verdict | "CASE_ERROR", number> = { PASS: 0, FAIL: 0, BLOCKED: 0, INCONCLUSIVE: 0, CASE_ERROR: 0 };
  for (const result of results) {
    if (result.executionStatus === "error") counts.CASE_ERROR += 1;
    else counts[result.verdict] += 1;
  }
  const exitCode: RunSummary["exitCode"] = status === "ABORTED" ? 130 : status === "ERROR" || counts.CASE_ERROR > 0 ? 2 : counts.FAIL > 0 || counts.BLOCKED > 0 || counts.INCONCLUSIVE > 0 ? 1 : 0;
  return { status, counts, exitCode };
}

export function markdownReport(results: readonly CaseResult[], summary: RunSummary): string {
  const lines = [
    "# QA run report",
    "",
    `Status: **${summary.status}**`,
    "",
    "## Summary",
    "",
    "| PASS | FAIL | BLOCKED | INCONCLUSIVE | CASE_ERROR |",
    "| ---: | ---: | ---: | ---: | ---: |",
    `| ${summary.counts.PASS} | ${summary.counts.FAIL} | ${summary.counts.BLOCKED} | ${summary.counts.INCONCLUSIVE} | ${summary.counts.CASE_ERROR} |`,
    "",
    "## Cases",
    "",
  ];
  for (const result of results) {
    const outcome = result.executionStatus === "error" ? "CASE_ERROR" : result.verdict;
    lines.push(`### ${result.testCaseId} — ${outcome}`, "");
    if (result.executionStatus === "error") lines.push(`Technical error: ${result.error.code}: ${result.error.message}`, "");
    else {
      lines.push(result.actual, "");
      if (result.blockedBy) lines.push(`Blocked by: ${result.blockedBy}`, "");
      if (result.reviewReason) lines.push(`Review reason: ${result.reviewReason}`, "");
      for (const claim of result.evidence) lines.push(`- ${claim.stepId}: ${claim.claim} (${claim.evidenceIds.join(", ")})`);
      if (result.evidence.length > 0) lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}
