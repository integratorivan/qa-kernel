import type { CaseResult } from "./schema.js";

const STOP_WORDS = new Set([
  "this", "that", "with", "from", "have", "been", "were", "they", "them", "then", "than", "into", "over", "also", "only", "just", "when", "what", "your", "their", "there", "here", "will", "does", "page", "user",
  "после", "если", "или", "при", "для", "этот", "этого", "эта", "это", "как", "был", "были", "быть", "чтобы", "также", "только",
]);

function keywords(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3 && !STOP_WORDS.has(word));
}

export function droppedOracleExpects(expects: readonly string[], sources: readonly string[]): string[] {
  const haystack = sources.join(" ").toLowerCase();
  const dropped: string[] = [];
  for (const line of expects) {
    const words = keywords(line);
    if (words.length === 0) continue;
    if (!words.some((word) => haystack.includes(word))) dropped.push(line);
  }
  return dropped;
}

export function applyOracleCoverage(result: CaseResult, expects: readonly string[]): { result: CaseResult; dropped: string[] } {
  if (result.executionStatus !== "completed" || result.verdict !== "PASS") return { result, dropped: [] };
  const dropped = droppedOracleExpects(expects, [result.actual, ...result.evidence.map((claim) => claim.claim)]);
  if (dropped.length === 0) return { result, dropped };
  const preview = dropped.slice(0, 3).join(" | ");
  const extra = dropped.length > 3 ? " …" : "";
  return {
    result: {
      ...result,
      verdict: "INCONCLUSIVE",
      reviewReason: `Host dropped ${dropped.length} oracle expect line(s) with no matching claim: ${preview}${extra}`,
    },
    dropped,
  };
}
