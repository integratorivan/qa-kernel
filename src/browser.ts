import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Request } from "playwright";
import { EvidenceStore, type Evidence } from "./artifacts.js";

const TARGET_SELECTOR = 'button, a[href], input, select, textarea, [role="button"], [role="link"], [role="textbox"], [role="combobox"], [role="checkbox"], [role="switch"], [tabindex]:not([tabindex="-1"])';
const MAX_INTERACTIVE_TARGETS = 60;
const MAX_TABLE_TARGETS = 20;
const REQUEST_WINDOW_MS = 1_500;
const SETTLE_DEADLINE_MS = 8_000;
const DOM_QUIET_MS = 300;

export type InteractiveKind = "button" | "link" | "input" | "icon-control" | "clickable";
export type NameSource = "aria" | "label" | "title" | "placeholder" | "nearby-header" | "nearby-text";

export interface InteractiveTarget {
  ref: string;
  kind: InteractiveKind;
  name: string;
  nameSource: NameSource;
  bounds: { x: number; y: number; width: number; height: number };
  enabled: boolean;
}

export interface Observation {
  snapshotId: string;
  screenshotId: string;
  url: string;
  visibleText: string;
  aria: string;
  interactive: InteractiveTarget[];
  interactiveTruncated: boolean;
  omittedCount: number;
}

export interface ActionResult {
  actionId: string;
  actionStatus: "ok" | "failed";
  observationStatus: "complete" | "incomplete" | "failed";
  beforeEvidenceIds: string[];
  afterEvidenceIds: string[];
  networkEvidenceIds: string[];
  observation: Observation | null;
  warnings: string[];
  error: { code: string; message: string } | null;
}

interface Candidate {
  index: number;
  kind: InteractiveKind;
  name: string;
  nameSource: NameSource;
  bounds: { x: number; y: number; width: number; height: number };
  enabled: boolean;
  priority: number;
  tableKey: string | null;
  isTableHeader: boolean;
}

interface NetworkEntry {
  request: Request;
  startedAt: number;
  finishedAt: number | null;
  status: number | null;
  failure: string | null;
  eligible: boolean;
}

interface SnapshotCapture {
  observation: Observation;
  evidence: Evidence[];
}


function pathWithoutQuery(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

function safeNetworkFailure(request: Request): string | null {
  const failure = request.failure();
  return failure?.errorText ?? null;
}

function isDenylisted(request: Request): boolean {
  const url = request.url().toLowerCase();
  const purpose = request.headers().purpose ?? request.headers()["x-moz"];
  return /analytics|telemetry|sentry|segment|datadog|google-analytics|doubleclick/.test(url) || purpose === "prefetch";
}

function isEligibleRequest(request: Request, allowedOrigins: ReadonlySet<string>): boolean {
  if (!(["document", "xhr", "fetch"] as const).includes(request.resourceType() as "document" | "xhr" | "fetch")) return false;
  if (isDenylisted(request)) return false;
  try {
    return allowedOrigins.has(new URL(request.url()).origin);
  } catch {
    return false;
  }
}

function isLongLived(entry: NetworkEntry): boolean {
  return /(?:long[-_]?poll|event|stream)/i.test(new URL(entry.request.url()).pathname);
}

export class BrowserController {
  #browser: Browser | null = null;

  constructor(private readonly allowedOrigins: ReadonlySet<string>, private readonly headless = true) {}

  async start(): Promise<void> {
    if (this.#browser) return;
    this.#browser = await chromium.launch({ headless: this.headless });
  }

  async createCase(evidence: EvidenceStore, caseId: string): Promise<CaseBrowser> {
    if (!this.#browser) throw new Error("Chromium has not been started");
    const context = await this.#browser.newContext();
    const page = await context.newPage();
    return new CaseBrowser(context, page, this.allowedOrigins, evidence, caseId);
  }

  async close(): Promise<void> {
    await this.#browser?.close();
    this.#browser = null;
  }
}

export class CaseBrowser {
  readonly #page: Page;
  readonly #ledger: NetworkEntry[] = [];
  #targets = new Map<string, Locator>();
  #snapshotOrdinal = 0;
  #actionOrdinal = 0;

  constructor(private readonly context: BrowserContext, page: Page, private readonly allowedOrigins: ReadonlySet<string>, private readonly evidence: EvidenceStore, private readonly caseId: string) {
    this.#page = page;
    context.on("request", (request) => this.#ledger.push({ request, startedAt: Date.now(), finishedAt: null, status: null, failure: null, eligible: isEligibleRequest(request, allowedOrigins) }));
    context.on("response", (response) => {
      const entry = this.#ledger.find((candidate) => candidate.request === response.request());
      if (entry) entry.status = response.status();
    });
    context.on("requestfinished", (request) => {
      const entry = this.#ledger.find((candidate) => candidate.request === request);
      if (entry) entry.finishedAt = Date.now();
    });
    context.on("requestfailed", (request) => {
      const entry = this.#ledger.find((candidate) => candidate.request === request);
      if (entry) {
        entry.finishedAt = Date.now();
        entry.failure = safeNetworkFailure(request);
      }
    });
  }

  async open(url: string, stepId: string, signal?: AbortSignal): Promise<ActionResult> {
    return this.#act(stepId, signal, async () => {
      const origin = new URL(url).origin;
      if (!this.allowedOrigins.has(origin)) throw new Error(`origin ${origin} is not allowed`);
      await this.#page.goto(url, { waitUntil: "domcontentloaded" });
    });
  }

  async click(ref: string, stepId: string, signal?: AbortSignal): Promise<ActionResult> {
    const target = this.#target(ref);
    return this.#act(stepId, signal, async () => { await target.click(); });
  }

  async fill(ref: string, value: string, stepId: string, signal?: AbortSignal): Promise<ActionResult> {
    const target = this.#target(ref);
    return this.#act(stepId, signal, async () => { await target.fill(value); });
  }

  async press(ref: string, key: string, stepId: string, signal?: AbortSignal): Promise<ActionResult> {
    const target = this.#target(ref);
    return this.#act(stepId, signal, async () => { await target.press(key); });
  }

  async scroll(stepId: string, deltaY: number, signal?: AbortSignal): Promise<ActionResult> {
    return this.#act(stepId, signal, async () => { await this.#page.mouse.wheel(0, deltaY); });
  }

  async snapshot(stepId: string): Promise<Observation> {
    return (await this.#capture(stepId, "after")).observation;
  }

  async close(): Promise<void> {
    await this.context.close();
  }

  async #act(stepId: string, signal: AbortSignal | undefined, operation: () => Promise<void>): Promise<ActionResult> {
    const actionId = `act-${++this.#actionOrdinal}`;
    const warnings: string[] = [];
    const before = await this.#capture(stepId, "before", warnings);
    const watermark = Date.now();
    let actionStatus: ActionResult["actionStatus"] = "ok";
    let error: ActionResult["error"] = null;
    try {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      await operation();
    } catch (caught) {
      actionStatus = "failed";
      error = { code: "BROWSER_ACTION", message: caught instanceof Error ? caught.message : String(caught) };
    }
    const actionEndedAt = Date.now();
    const settled = actionStatus === "ok" ? await this.#settle(watermark, actionEndedAt, signal) : "failed";
    let after: SnapshotCapture | null = null;
    try {
      after = await this.#capture(stepId, "after", warnings);
    } catch (caught) {
      warnings.push(`after observation failed: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
    const networks = await this.#recordEligibleNetwork(stepId, watermark, actionEndedAt);
    return { actionId, actionStatus, observationStatus: after ? settled : "failed", beforeEvidenceIds: before.evidence.map((item) => item.id), afterEvidenceIds: after?.evidence.map((item) => item.id) ?? [], networkEvidenceIds: networks.map((item) => item.id), observation: after?.observation ?? null, warnings, error };
  }

  async #capture(stepId: string, phase: "before" | "after", warnings: string[] = []): Promise<SnapshotCapture> {
    const url = this.#page.url();
    const screenshot = await this.#captureScreenshot(stepId, phase, url, warnings);
    const aria = await this.#page.locator("body").ariaSnapshot();
    const rawCandidates = await this.#page.locator(TARGET_SELECTOR).evaluateAll((elements) => elements.map((element, index) => {
      const bounds = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      if (bounds.width <= 0 || bounds.height <= 0 || bounds.right <= 0 || bounds.bottom <= 0 || bounds.left >= window.innerWidth || bounds.top >= window.innerHeight || style.visibility === "hidden" || style.display === "none" || style.opacity === "0") return null;
      const html = element as HTMLElement;
      const tag = element.tagName.toLowerCase();
      const ariaLabel = element.getAttribute("aria-label")?.trim();
      const labels = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement ? [...(element.labels ?? [])].map((label) => label.innerText.trim()).filter(Boolean).join(" ") : "";
      const title = element.getAttribute("title")?.trim();
      const placeholder = html.getAttribute("placeholder")?.trim();
      const rawOwnText = html.innerText?.trim().replace(/\s+/g, " ") ?? "";
      const ownText = /^[\p{P}\p{S}\s]+$/u.test(rawOwnText) ? "" : rawOwnText;
      const header = element.closest("th")?.innerText.trim().replace(/\s+/g, " ") ?? "";
      const nearby = element.closest("label, [role=group], [role=region]")?.textContent?.trim().replace(/\s+/g, " ") ?? "";
      const name = ariaLabel || labels || title || placeholder || ownText || (header ? `${header} — control` : nearby);
      const nameSource: NameSource = ariaLabel ? "aria" : labels ? "label" : title ? "title" : placeholder ? "placeholder" : header ? "nearby-header" : "nearby-text";
      const kind: InteractiveKind = tag === "button" || element.getAttribute("role") === "button" ? nameSource === "nearby-header" && !ariaLabel && !ownText ? "icon-control" : "button" : tag === "a" || element.getAttribute("role") === "link" ? "link" : ["input", "textarea", "select"].includes(tag) ? "input" : "clickable";
      if (!name) return null;
      const semantic = Boolean(ariaLabel || labels || title || placeholder || ownText);
      const table = element.closest("table, [role=table], [role=grid]");
      const tableKey = table ? table.id || `table-${[...document.querySelectorAll("table, [role=table], [role=grid]")].indexOf(table)}` : null;
      return { index, kind, name, nameSource, bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }, enabled: !(html as HTMLButtonElement).disabled && element.getAttribute("aria-disabled") !== "true", priority: semantic ? 1 : header ? 2 : 3, tableKey, isTableHeader: Boolean(element.closest("th, [role=columnheader]")) };
    }).filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null));
    const selected: Candidate[] = [];
    const perTable: Record<string, number> = {};
    for (const candidate of rawCandidates.sort((left, right) => Number(right.isTableHeader) - Number(left.isTableHeader) || left.priority - right.priority)) {
      if (selected.length >= MAX_INTERACTIVE_TARGETS) break;
      const tableCount = candidate.tableKey ? perTable[candidate.tableKey] ?? 0 : 0;
      if (candidate.tableKey && tableCount >= MAX_TABLE_TARGETS) continue;
      selected.push(candidate);
      if (candidate.tableKey) perTable[candidate.tableKey] = tableCount + 1;
    }
    this.#targets = new Map();
    const snapshotOrdinal = ++this.#snapshotOrdinal;
    const interactive = selected.map((candidate, index) => {
      const ref = `s${snapshotOrdinal}-e${index + 1}`;
      this.#targets.set(ref, this.#page.locator(TARGET_SELECTOR).nth(candidate.index));
      return { ref, kind: candidate.kind, name: candidate.name, nameSource: candidate.nameSource, bounds: candidate.bounds, enabled: candidate.enabled };
    });
    const visibleText = await this.#page.locator("body").innerText();
    const snapshotContent = JSON.stringify({ url, visibleText, aria, interactive, interactiveTruncated: rawCandidates.length > selected.length, omittedCount: rawCandidates.length - selected.length }, null, 2);
    const snapshot = await this.evidence.record({ caseId: this.caseId, stepId, actionOrdinal: this.#actionOrdinal, phase, kind: "snapshot", url, extension: "json", content: snapshotContent });
    const screenshotId = screenshot?.id ?? "";
    if (!screenshotId) warnings.push("screenshot capture failed");
    return { observation: { snapshotId: snapshot.id, screenshotId, url, visibleText, aria, interactive, interactiveTruncated: rawCandidates.length > selected.length, omittedCount: rawCandidates.length - selected.length }, evidence: screenshot ? [snapshot, screenshot] : [snapshot] };
  }

  async #captureScreenshot(stepId: string, phase: "before" | "after", url: string, warnings: string[]): Promise<Evidence | null> {
    try {
      const content = await this.#page.screenshot({ type: "png" });
      return await this.evidence.record({ caseId: this.caseId, stepId, actionOrdinal: this.#actionOrdinal, phase, kind: "screenshot", url, extension: "png", content });
    } catch (caught) {
      warnings.push(`screenshot failed: ${caught instanceof Error ? caught.message : String(caught)}`);
      return null;
    }
  }

  #target(ref: string): Locator {
    const target = this.#targets.get(ref);
    if (!target) throw new Error(`stale or unknown target ref ${ref}; request a fresh snapshot`);
    return target;
  }

  async #settle(watermark: number, actionEndedAt: number, signal?: AbortSignal): Promise<"complete" | "incomplete"> {
    const requestWindowEndsAt = actionEndedAt + REQUEST_WINDOW_MS;
    while (Date.now() < requestWindowEndsAt) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      await this.#page.waitForTimeout(50);
    }
    const eligible = this.#ledger.filter((entry) => entry.eligible && entry.startedAt >= watermark && entry.startedAt <= requestWindowEndsAt && !isLongLived(entry));
    const deadline = watermark + SETTLE_DEADLINE_MS;
    while (eligible.some((entry) => entry.finishedAt === null) && Date.now() < deadline) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      await this.#page.waitForTimeout(50);
    }
    if (eligible.some((entry) => entry.finishedAt === null)) return "incomplete";
    await this.#waitForDomQuiet(deadline, signal);
    return Date.now() > deadline ? "incomplete" : "complete";
  }

  async #waitForDomQuiet(deadline: number, signal?: AbortSignal): Promise<void> {
    let previous = await this.#page.locator("body").innerText();
    let quietSince = Date.now();
    while (Date.now() < deadline) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      await this.#page.waitForTimeout(50);
      const current = await this.#page.locator("body").innerText();
      if (current !== previous) {
        previous = current;
        quietSince = Date.now();
      }
      if (Date.now() - quietSince >= DOM_QUIET_MS) return;
    }
  }

  async #recordEligibleNetwork(stepId: string, watermark: number, actionEndedAt: number): Promise<Evidence[]> {
    const requestWindowEndsAt = actionEndedAt + REQUEST_WINDOW_MS;
    const eligible = this.#ledger.filter((entry) => entry.eligible && entry.startedAt >= watermark && entry.startedAt <= requestWindowEndsAt);
    return Promise.all(eligible.map(async (entry) => this.evidence.record({ caseId: this.caseId, stepId, actionOrdinal: this.#actionOrdinal, phase: "after", kind: "network", url: pathWithoutQuery(entry.request.url()), extension: "json", content: JSON.stringify({ method: entry.request.method(), url: pathWithoutQuery(entry.request.url()), status: entry.status, resourceType: entry.request.resourceType(), duration: (entry.finishedAt ?? Date.now()) - entry.startedAt, error: entry.failure }) })));
  }
}
