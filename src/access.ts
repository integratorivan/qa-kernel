export interface AccessEvent {
  at: string;
  caseId: string;
  stepId: string;
  action: string;
  ref: string | null;
  from: string | null;
  requestedUrl: string | null;
  pageUrl: string | null;
  actionStatus: string | null;
  observationStatus: string | null;
  screenshotId: string | null;
  snapshotId: string | null;
  networkEvidenceIds: string[];
  interactiveCount: number | null;
  limitReached: string | null;
}

export type AccessSink = (event: AccessEvent) => Promise<void>;

export function sanitizeAccessUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

export function sanitizeAccessEvent(event: AccessEvent): AccessEvent {
  return {
    ...event,
    requestedUrl: sanitizeAccessUrl(event.requestedUrl),
    pageUrl: sanitizeAccessUrl(event.pageUrl),
  };
}

export function accessLine(event: AccessEvent): string {
  const page = sanitizeAccessUrl(event.pageUrl) ?? sanitizeAccessUrl(event.requestedUrl) ?? "";
  const target = [event.ref ? `ref=${event.ref}` : "", event.from ? `from=${event.from}` : ""].filter(Boolean).join(" ");
  const targetText = target ? ` ${target}` : "";
  const status = [event.actionStatus, event.observationStatus].filter(Boolean).join("/");
  return `${event.caseId} ${event.action} ${event.stepId}${targetText} ${page} ${status}`.trim();
}
