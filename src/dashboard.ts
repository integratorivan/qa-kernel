import type { AccessEvent } from "./access.js";
import type { CaseResult } from "./schema.js";
import type { RunSummary } from "./report.js";

function escape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;");
}

function screenshotName(event: AccessEvent): string | null {
  return event.screenshotId ? `screenshots/${event.screenshotId}.png` : null;
}

export function htmlDashboard(results: readonly CaseResult[], summary: RunSummary, access: readonly AccessEvent[]): string {
  const cases = results.map((result) => {
    const outcome = result.executionStatus === "error" ? "CASE_ERROR" : result.verdict;
    const body = result.executionStatus === "error"
      ? `<p>Technical error: ${escape(result.error.code)}: ${escape(result.error.message)}</p>`
      : `<p>${escape(result.actual)}</p>${result.blockedBy ? `<p>Blocked by: ${escape(result.blockedBy)}</p>` : ""}${result.reviewReason ? `<p>Review reason: ${escape(result.reviewReason)}</p>` : ""}<ul>${result.evidence.map((claim) => `<li><code>${escape(claim.stepId)}</code> ${escape(claim.claim)} <small>${escape(claim.evidenceIds.join(", "))}</small></li>`).join("")}</ul>`;
    return `<section class="case"><h2>${escape(result.testCaseId)} — ${escape(outcome ?? "")}</h2>${body}</section>`;
  }).join("");

  const trail = access.map((event) => {
    const shot = screenshotName(event);
    return `<tr>
      <td>${escape(event.at)}</td>
      <td><code>${escape(event.caseId)}</code></td>
      <td>${escape(event.action)}</td>
      <td><code>${escape(event.stepId)}</code>${event.ref ? ` <code>${escape(event.ref)}</code>` : ""}${event.from ? ` from=${escape(event.from)}` : ""}</td>
      <td>${escape(event.pageUrl ?? event.requestedUrl ?? "")}</td>
      <td>${escape([event.actionStatus, event.observationStatus].filter(Boolean).join(" / "))}</td>
      <td>${shot ? `<a href="${escape(shot)}">screenshot</a>` : ""}</td>
    </tr>`;
  }).join("");

  const gallery = access.flatMap((event) => {
    const shot = screenshotName(event);
    return shot ? [`<figure><img src="${escape(shot)}" alt="${escape(event.action)} ${escape(event.stepId)}"><figcaption>${escape(event.caseId)} ${escape(event.action)} ${escape(event.stepId)}</figcaption></figure>`] : [];
  }).join("");

  const note = [
    `Run: (paste folder name)`,
    `Case:`,
    `What I expected:`,
    `What I saw:`,
    `Why this is wrong:`,
  ].join("\n");

  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>QA run dashboard</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 24px; color: #111; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { border-bottom: 1px solid #ddd; text-align: left; padding: 6px 8px; vertical-align: top; }
  img { max-width: 420px; border: 1px solid #ddd; }
  .gallery { display: flex; flex-wrap: wrap; gap: 16px; }
  textarea { width: 100%; min-height: 140px; }
  .counts { display: flex; gap: 16px; }
</style></head><body>
  <h1>QA run dashboard</h1>
  <p>Status: <strong>${escape(summary.status)}</strong> · exit ${summary.exitCode}</p>
  <p class="counts">PASS ${summary.counts.PASS} · FAIL ${summary.counts.FAIL} · BLOCKED ${summary.counts.BLOCKED} · INCONCLUSIVE ${summary.counts.INCONCLUSIVE} · CASE_ERROR ${summary.counts.CASE_ERROR}</p>
  ${cases}
  <h2>Access trail</h2>
  <table><thead><tr><th>at</th><th>case</th><th>action</th><th>step</th><th>url</th><th>status</th><th>shot</th></tr></thead><tbody>${trail}</tbody></table>
  <h2>Screenshots</h2>
  <div class="gallery">${gallery}</div>
  <h2>Note for the agent</h2>
  <p>Скопируй и кинь в чат. Секреты не пиши.</p>
  <textarea id="note">${escape(note)}</textarea>
  <p><button type="button" id="copy">Copy note</button></p>
  <script>
    document.getElementById("copy").addEventListener("click", async () => {
      await navigator.clipboard.writeText(document.getElementById("note").value);
    });
  </script>
</body></html>
`;
}
