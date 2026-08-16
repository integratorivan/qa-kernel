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
  recordable: boolean;
  settleEligible: boolean;
}

interface SnapshotCapture {
  observation: Observation;
  evidence: Evidence[];
}

interface SnapshotTarget {
  locator: Locator;
  domVersion: number;
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

function isRecordableRequest(request: Request, allowedOrigins: ReadonlySet<string>): boolean {
  if (!(["document", "xhr", "fetch"] as const).includes(request.resourceType() as "document" | "xhr" | "fetch")) return false;
  try {
    return allowedOrigins.has(new URL(request.url()).origin);
  } catch {
    return false;
  }
}

function isSettleEligibleRequest(request: Request, allowedOrigins: ReadonlySet<string>): boolean {
  return isRecordableRequest(request, allowedOrigins) && !isDenylisted(request);
}

function isLongLived(entry: NetworkEntry): boolean {
  return /(?:long[-_]?poll|event|stream)/i.test(new URL(entry.request.url()).pathname);
}

export type Screenshotter = (page: Page) => Promise<Buffer>;


export class BrowserController {
  #browser: Browser | null = null;

  constructor(private readonly allowedOrigins: ReadonlySet<string>, private readonly headless = true, private readonly screenshot: Screenshotter = (page) => page.screenshot({ type: "png" })) {}

  async start(): Promise<void> {
    if (this.#browser) return;
    this.#browser = await chromium.launch({ headless: this.headless });
  }

  async createCase(evidence: EvidenceStore, caseId: string): Promise<CaseBrowser> {
    if (!this.#browser) throw new Error("Chromium has not been started");
    const context = await this.#browser.newContext();
    await context.addInitScript(() => {
      let domVersion = 0;
      new MutationObserver(() => {
        document.documentElement.dataset.qaDomVersion = String(++domVersion);
      }).observe(document, { childList: true, subtree: true, characterData: true });
    });
    const page = await context.newPage();
    return new CaseBrowser(context, page, this.allowedOrigins, evidence, caseId, this.screenshot);
  }

  async close(): Promise<void> {
    const browser = this.#browser;
    this.#browser = null;
    await browser?.close();
  }

  version(): string | null {
    return this.#browser?.version() ?? null;
  }
}

export class CaseBrowser {
  readonly #page: Page;
  readonly #ledger: NetworkEntry[] = [];
  #targets = new Map<string, SnapshotTarget>();
  #secretTargets: Locator[] = [];
  #snapshotOrdinal = 0;
  #actionOrdinal = 0;
  #actionQueue: Promise<void> = Promise.resolve();
  readonly #successfulInteractions = new Set<string>();
  readonly #networkProgress = new Map<string, string>();

  constructor(private readonly context: BrowserContext, page: Page, private readonly allowedOrigins: ReadonlySet<string>, private readonly evidence: EvidenceStore, private readonly caseId: string, private readonly screenshot: Screenshotter) {
    this.#page = page;
    context.on("request", (request) => this.#ledger.push({ request, startedAt: Date.now(), finishedAt: null, status: null, failure: null, recordable: isRecordableRequest(request, allowedOrigins), settleEligible: isSettleEligibleRequest(request, allowedOrigins) }));
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
    return this.#act("open", stepId, signal, async () => {
      const origin = new URL(url).origin;
      if (!this.allowedOrigins.has(origin)) throw new Error(`origin ${origin} is not allowed`);
      await this.#page.goto(url, { waitUntil: "domcontentloaded" });
    });
  }

  async click(ref: string, stepId: string, signal?: AbortSignal): Promise<ActionResult> {
    const target = await this.#target(ref);
    return this.#act("click", stepId, signal, async () => {
      await this.#assertTargetCurrent(target, ref);
      await target.locator.click();
    });
  }

  async fill(ref: string, value: string, stepId: string, signal?: AbortSignal): Promise<ActionResult> {
    const target = await this.#target(ref);
    return this.#act("fill", stepId, signal, async () => {
      await this.#assertTargetCurrent(target, ref);
      await target.locator.fill(value);
    });
  }
  async fillSecret(ref: string, value: string, stepId: string, signal?: AbortSignal): Promise<ActionResult> {
    const target = await this.#target(ref);
    this.#secretTargets.push(target.locator);
    return this.#act("fill", stepId, signal, async () => {
      await this.#assertTargetCurrent(target, ref);
      await target.locator.fill(value);
    });
  }


  async press(ref: string, key: string, stepId: string, signal?: AbortSignal): Promise<ActionResult> {
    const target = await this.#target(ref);
    return this.#act("press", stepId, signal, async () => {
      await this.#assertTargetCurrent(target, ref);
      await target.locator.press(key);
    });
  }

  async scroll(stepId: string, deltaY: number, signal?: AbortSignal, ref?: string): Promise<ActionResult> {
    const target = ref ? await this.#target(ref) : null;
    return this.#act("scroll", stepId, signal, async () => {
      if (!target) {
        await this.#page.mouse.wheel(0, deltaY);
        return;
      }
      await this.#assertTargetCurrent(target, ref!);
      await target.locator.evaluate((element, amount) => {
        let parent = element.parentElement;
        while (parent) {
          const style = window.getComputedStyle(parent);
          if (/(auto|scroll)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight) {
            parent.scrollBy(0, amount);
            return;
          }
          parent = parent.parentElement;
        }
        window.scrollBy(0, amount);
      }, deltaY);
    });
  }

  async snapshot(stepId: string): Promise<Observation> {
    return (await this.#capture(stepId, "after")).observation;
  }

  async close(): Promise<void> {
    await this.context.close();
  }

  hasSuccessfulInteraction(stepId: string, evidenceIds: readonly string[]): boolean {
    const referenced = new Set(evidenceIds);
    return this.evidence.all().some((item) => referenced.has(item.id) && item.stepId === stepId && item.phase === "after" && this.#successfulInteractions.has(`${stepId}:${item.actionOrdinal}`));
  }

  networkProgress(result: unknown): string {
    if (!result || typeof result !== "object" || !("actionId" in result) || typeof result.actionId !== "string") return "[]";
    return this.#networkProgress.get(result.actionId) ?? "[]";
  }

  async #act(kind: "open" | "click" | "fill" | "press" | "scroll", stepId: string, signal: AbortSignal | undefined, operation: () => Promise<void>): Promise<ActionResult> {
    const previousAction = this.#actionQueue;
    let releaseAction!: () => void;
    this.#actionQueue = new Promise<void>((resolve) => { releaseAction = resolve; });
    await previousAction;
    try {
      const actionOrdinal = ++this.#actionOrdinal;
      const actionId = `act-${actionOrdinal}`;
      const warnings: string[] = [];
      const before = await this.#capture(stepId, "before", warnings);
      const watermark = Date.now();
      let actionStatus: ActionResult["actionStatus"] = "ok";
      let error: ActionResult["error"] = null;
      try {
        if (signal?.aborted) throw signal.reason ?? new Error("aborted");
        await operation();
      } catch (caught) {
        if (signal?.aborted) throw caught;
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
      if (actionStatus === "ok" && settled === "complete" && after && (kind === "click" || kind === "fill" || kind === "press")) this.#successfulInteractions.add(`${stepId}:${actionOrdinal}`);
      await this.#waitForAttributionWindow(actionEndedAt, signal);
      const network = await this.#recordNetwork(stepId, actionOrdinal, watermark, actionEndedAt);
      this.#networkProgress.set(actionId, network.progress);
      const networks = network.evidence;
      return { actionId, actionStatus, observationStatus: after ? settled : "failed", beforeEvidenceIds: before.evidence.map((item) => item.id), afterEvidenceIds: after?.evidence.map((item) => item.id) ?? [], networkEvidenceIds: networks.map((item) => item.id), observation: after?.observation ?? null, warnings, error };
    } finally {
      releaseAction();
    }
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
    const domVersion = await this.#page.evaluate(() => Number(document.documentElement.dataset.qaDomVersion ?? "0"));
    const interactive = selected.map((candidate, index) => {
      const ref = `s${snapshotOrdinal}-e${index + 1}`;
      this.#targets.set(ref, { locator: this.#page.locator(TARGET_SELECTOR).nth(candidate.index), domVersion });
      return { ref, kind: candidate.kind, name: this.evidence.redactText(candidate.name), nameSource: candidate.nameSource, bounds: candidate.bounds, enabled: candidate.enabled };
    });
    const visibleText = this.evidence.redactText(await this.#page.locator("body").innerText());
    const safeUrl = this.evidence.redactText(url);
    const safeAria = this.evidence.redactText(aria);
    const snapshotContent = JSON.stringify({ url: safeUrl, visibleText, aria: safeAria, interactive, interactiveTruncated: rawCandidates.length > selected.length, omittedCount: rawCandidates.length - selected.length }, null, 2);
    const snapshot = await this.evidence.record({ caseId: this.caseId, stepId, actionOrdinal: this.#actionOrdinal, phase, kind: "snapshot", url: safeUrl, extension: "json", content: snapshotContent });
    const screenshotId = screenshot?.id ?? "";
    if (!screenshotId) warnings.push("screenshot capture failed");
    return { observation: { snapshotId: snapshot.id, screenshotId, url: safeUrl, visibleText, aria: safeAria, interactive, interactiveTruncated: rawCandidates.length > selected.length, omittedCount: rawCandidates.length - selected.length }, evidence: screenshot ? [snapshot, screenshot] : [snapshot] };
  }

  async #captureScreenshot(stepId: string, phase: "before" | "after", url: string, warnings: string[]): Promise<Evidence | null> {
    const restores = await Promise.all(this.#secretTargets.map(async (target) => target.evaluate((element) => {
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return null;
      const original = element.value;
      element.value = element instanceof HTMLInputElement && element.type === "email" ? "redacted@example.invalid" : "REDACTED";
      return original;
    }).catch(() => null)));
    try {
      const content = await this.screenshot(this.#page);
      return await this.evidence.record({ caseId: this.caseId, stepId, actionOrdinal: this.#actionOrdinal, phase, kind: "screenshot", url, extension: "png", content });
    } catch (caught) {
      warnings.push(`screenshot failed: ${caught instanceof Error ? caught.message : String(caught)}`);
      return null;
    } finally {
      await Promise.all(this.#secretTargets.map((target, index) => {
        const original = restores[index];
        return original === null ? undefined : target.evaluate((element, value) => {
          if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) element.value = value;
        }, original).catch(() => undefined);
      }));
    }
  }

  async #target(ref: string): Promise<SnapshotTarget> {
    const target = this.#targets.get(ref);
    if (!target) throw new Error(`stale or unknown target ref ${ref}; request a fresh snapshot`);
    await this.#assertTargetCurrent(target, ref);
    return target;
  }

  async #assertTargetCurrent(target: SnapshotTarget, ref: string): Promise<void> {
    const domVersion = await this.#page.evaluate(() => Number(document.documentElement.dataset.qaDomVersion ?? "0"));
    if (target.domVersion !== domVersion) throw new Error(`stale target ref ${ref}; the DOM changed and requires a fresh snapshot`);
  }

  async #settle(watermark: number, actionEndedAt: number, signal?: AbortSignal): Promise<"complete" | "incomplete"> {
    const requestWindowEndsAt = actionEndedAt + REQUEST_WINDOW_MS;
    const deadline = watermark + SETTLE_DEADLINE_MS;
    let previous = await this.#page.locator("body").innerText();
    let quietSince = Date.now();
    let sawEligibleRequest = false;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      const now = Date.now();
      const eligible = this.#ledger.filter((entry) => entry.settleEligible && entry.startedAt >= watermark && entry.startedAt <= requestWindowEndsAt && !isLongLived(entry));
      if (eligible.length > 0) sawEligibleRequest = true;
      const current = await this.#page.locator("body").innerText();
      if (current !== previous) {
        previous = current;
        quietSince = now;
      }
      const domIsQuiet = now - quietSince >= DOM_QUIET_MS;
      if (domIsQuiet && (!sawEligibleRequest || eligible.every((entry) => entry.finishedAt !== null))) return "complete";
      if (!sawEligibleRequest && now >= requestWindowEndsAt) return "incomplete";
      await this.#page.waitForTimeout(50);
    }
    return "incomplete";
  }

  async #recordNetwork(stepId: string, actionOrdinal: number, watermark: number, actionEndedAt: number): Promise<{ evidence: Evidence[]; progress: string }> {
    const requestWindowEndsAt = actionEndedAt + REQUEST_WINDOW_MS;
    const recordable = this.#ledger.filter((entry) => entry.recordable && entry.startedAt >= watermark && entry.startedAt <= requestWindowEndsAt);
    const facts = recordable.map((entry) => ({ method: entry.request.method(), url: pathWithoutQuery(entry.request.url()), status: entry.status, resourceType: entry.request.resourceType(), error: entry.failure, settleEligible: entry.settleEligible && !isLongLived(entry) }));
    const evidence = await Promise.all(recordable.map(async (entry, index) => this.evidence.record({ caseId: this.caseId, stepId, actionOrdinal, phase: "after", kind: "network", url: pathWithoutQuery(entry.request.url()), extension: "json", content: JSON.stringify({ ...facts[index], duration: (entry.finishedAt ?? Date.now()) - entry.startedAt }) })));
    return { evidence, progress: JSON.stringify(facts) };
  }

  async #waitForAttributionWindow(actionEndedAt: number, signal?: AbortSignal): Promise<void> {
    const windowEndsAt = actionEndedAt + REQUEST_WINDOW_MS;
    while (Date.now() < windowEndsAt) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      await this.#page.waitForTimeout(Math.min(50, windowEndsAt - Date.now()));
    }
  }
}
