import { sanitizeAccessUrl, type AccessEvent } from "./access.js";
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
      <td>${escape(sanitizeAccessUrl(event.pageUrl) ?? sanitizeAccessUrl(event.requestedUrl) ?? "")}</td>
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
  <p><button type="button" id="copy">Copy note</button> <span id="copy-status" role="status"></span></p>
  <script>
    document.getElementById("copy").addEventListener("click", async () => {
      const note = document.getElementById("note");
      const status = document.getElementById("copy-status");
      try {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
        await navigator.clipboard.writeText(note.value);
      } catch {
        try {
          note.focus();
          note.select();
          if (!document.execCommand("copy")) throw new Error("copy command was rejected");
        } catch {
          status.textContent = "Copy failed. Select the note and copy it manually.";
          return;
        }
      }
      status.textContent = "Copied";
    });
  </script>
</body></html>
`;
}

export interface LabDashboardRow {
  id: string;
  status: "COMPLETED" | "ERROR" | "ABORTED" | "MISSING";
  counts: RunSummary["counts"];
  durationMs: number;
}

export function htmlLabDashboard(rows: readonly LabDashboardRow[]): string {
  const body = rows.map((row) => `<tr>
    <td><a href="${escape(row.id)}/dashboard.html">${escape(row.id)}</a></td>
    <td>${escape(row.status)}</td>
    <td>${row.counts.PASS}</td>
    <td>${row.counts.FAIL}</td>
    <td>${row.counts.BLOCKED}</td>
    <td>${row.counts.INCONCLUSIVE}</td>
    <td>${row.counts.CASE_ERROR}</td>
    <td>${row.durationMs}</td>
  </tr>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>QA lab dashboard</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 24px; color: #111; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { border-bottom: 1px solid #ddd; text-align: left; padding: 6px 8px; }
</style></head><body>
  <h1>QA lab dashboard</h1>
  <table><thead><tr><th>repeat</th><th>status</th><th>PASS</th><th>FAIL</th><th>BLOCKED</th><th>INCONCLUSIVE</th><th>CASE_ERROR</th><th>duration ms</th></tr></thead><tbody>${body}</tbody></table>
</body></html>
`;
}

export function htmlMissingRunDashboard(id: string, status: "ERROR" | "ABORTED" | "MISSING", message = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(id)} ${status}</title></head><body><h1>${escape(id)}</h1><p>Status: <strong>${status}</strong></p>${message ? `<p>${escape(message)}</p>` : ""}</body></html>\n`;
}
