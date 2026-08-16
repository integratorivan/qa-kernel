export function extractJsonText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  const fenced = [...trimmed.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/gi)].map((match) => match[1]?.trim() ?? "").filter((block) => block.length > 0);
  for (const candidate of fenced.length > 0 ? fenced : [trimmed]) {
    if (candidate.startsWith("{") && candidate.endsWith("}")) return candidate;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) return candidate.slice(start, end + 1);
  }
  return trimmed;
}
