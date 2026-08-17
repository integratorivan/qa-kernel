import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Request } from "playwright";
import { EvidenceStore, type Evidence } from "./artifacts.js";
import { containsSecretLike, groundingMatches, oracleAssertionCompatible, type RecordedAction, type RecordedCheck, type RecordedLocator, type RecordingWriter } from "./recording.js";

const TARGET_SELECTOR = 'button, a[href], input, select, textarea, [role="button"], [role="link"], [role="textbox"], [role="combobox"], [role="checkbox"], [role="switch"], [tabindex]:not([tabindex="-1"])';
const MAX_INTERACTIVE_TARGETS = 60;
const MAX_TABLE_TARGETS = 20;
const REQUEST_WINDOW_MS = 1_500;
const SETTLE_DEADLINE_MS = 8_000;
const DOM_QUIET_MS = 300;
export const ARIA_MAX_CHARS = 80_000;
export const VISIBLE_TEXT_MAX_CHARS = 30_000;

export function truncateForModel(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const sliced = text.slice(0, maxChars);
  const lineBreak = sliced.lastIndexOf("\n");
  const kept = lineBreak > 0 ? sliced.slice(0, lineBreak) : sliced;
  return { text: `${kept}\n\n[truncated: showing ${maxChars} of ${text.length} chars]`, truncated: true };
}

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
export interface ScrollState {
  scope: "page" | "container";
  x: number;
  y: number;
  maxX: number;
  maxY: number;
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
  ariaTruncated: boolean;
  visibleTextTruncated: boolean;
  scroll: ScrollState;
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
  role: string;
  testId: string | null;
  placeholder: string | null;
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
  locatorCandidates: RecordedLocator[];
  sourceSnapshotId: string;
  frame: "main";
  domVersion: number;
}




function safeCheckErrorCode(error: unknown): "CHECK_TIMEOUT" | "CHECK_MISMATCH" | "CHECK_FAILED" {
  const code = error instanceof Error ? error.message : "";
  if (code === "CHECK_TIMEOUT") return "CHECK_TIMEOUT";
  if (code === "CHECK_MISMATCH") return "CHECK_MISMATCH";
  return "CHECK_FAILED";
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

function processTree(): Map<number, number> {
  const table = new Map<number, number>();
  const output = Bun.spawnSync(["ps", "-axo", "pid=,ppid="]).stdout.toString();
  for (const line of output.split("\n")) {
    const [pidText, parentText] = line.trim().split(/\s+/, 2);
    const pid = Number(pidText);
    const parent = Number(parentText);
    if (Number.isInteger(pid) && Number.isInteger(parent)) table.set(pid, parent);
  }
  return table;
}

function descendantsOf(root: number, table = processTree()): Set<number> {
  const descendants = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parent] of table) {
      if (parent !== root && !descendants.has(parent)) continue;
      if (descendants.has(pid)) continue;
      descendants.add(pid);
      changed = true;
    }
  }
  return descendants;
}

function isProcessAlive(pid: number): boolean {
  if (pid <= 1 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface ProcessIdentity {
  pid: number;
  startedAt: string;
  command: string;
}

function processIdentity(pid: number): ProcessIdentity | null {
  if (!isProcessAlive(pid)) return null;
  const startedAt = Bun.spawnSync(["ps", "-p", String(pid), "-o", "lstart="]).stdout.toString().trim();
  const command = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="]).stdout.toString().trim();
  return startedAt && command ? { pid, startedAt, command } : null;
}

function isSameProcess(identity: ProcessIdentity): boolean {
  const current = processIdentity(identity.pid);
  return current?.startedAt === identity.startedAt && current.command === identity.command;
}

function signalProcess(identity: ProcessIdentity, signal: NodeJS.Signals): void {
  if (!isSameProcess(identity)) return;
  try {
    process.kill(identity.pid, signal);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (code !== "ESRCH") throw error;
  }
}

async function waitForProcessExit(identities: ReadonlyMap<number, ProcessIdentity>, timeoutMs: number): Promise<ProcessIdentity[]> {
  const deadline = Date.now() + timeoutMs;
  let live = [...identities.values()].filter(isSameProcess);
  while (live.length > 0 && Date.now() < deadline) {
    await Bun.sleep(25);
    live = live.filter(isSameProcess);
  }
  return live;
}

function ownedProcessTree(ownedProcesses: ReadonlyMap<number, ProcessIdentity>): Map<number, ProcessIdentity> {
  const table = processTree();
  const owned = new Map(ownedProcesses);
  for (const identity of ownedProcesses.values()) {
    if (!isSameProcess(identity)) continue;
    for (const pid of descendantsOf(identity.pid, table)) {
      const descendant = processIdentity(pid);
      if (descendant) owned.set(pid, descendant);
    }
  }
  return owned;
}

function playwrightProcessesForLaunch(launchId: string): Map<number, ProcessIdentity> {
  const owned = new Map<number, ProcessIdentity>();
  for (const pid of descendantsOf(process.pid)) {
    const identity = processIdentity(pid);
    if (identity?.command.includes(`--qa-kernel-launch-id=${launchId}`)) owned.set(pid, identity);
  }
  return owned;
}

async function forceCloseOwnedBrowser(browser: Browser | null, ownedProcesses: ReadonlyMap<number, ProcessIdentity>): Promise<void> {
  const owned = ownedProcessTree(ownedProcesses);
  if (browser) {
    const graceful = browser.close().catch(() => {});
    await Promise.race([graceful, Bun.sleep(100)]);
  }
  let live = [...owned.values()].filter(isSameProcess).reverse();
  for (const identity of live) signalProcess(identity, "SIGTERM");
  live = await waitForProcessExit(owned, 500);
  for (const identity of live.reverse()) signalProcess(identity, "SIGKILL");
  live = await waitForProcessExit(owned, 1_000);
  if (live.length > 0) throw new Error(`Chromium processes survived cleanup: ${live.map((item) => item.pid).join(", ")}`);
}
export interface CaseBrowserOptions {
  recording?: RecordingWriter;
  targetUrl?: string | undefined;
  secretRefs?: readonly string[];
  secretValues?: readonly string[];
  oracle?: { expect: readonly string[]; reject: readonly string[] };
}

export type Screenshotter = (page: Page) => Promise<Buffer>;


export class BrowserController {
  #browser: Browser | null = null;
  #ownedProcesses = new Map<number, ProcessIdentity>();
  #generation = 0;
  #pendingLaunch: { generation: number; launchId: string; owned: Map<number, ProcessIdentity> } | null = null;

  constructor(private readonly allowedOrigins: ReadonlySet<string>, private readonly headless = true, private readonly screenshot: Screenshotter = (page) => page.screenshot({ type: "png" }), private readonly launchBrowser: (launchId: string) => Promise<Browser> = (launchId) => chromium.launch({ headless, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, args: [`--qa-kernel-launch-id=${launchId}`] })) {}

  async start(): Promise<void> {
    if (this.#browser) return;
    if (this.#pendingLaunch) throw new Error("Chromium launch is already in progress");
    const generation = ++this.#generation;
    const launchId = crypto.randomUUID();
    const launchOwned = new Map<number, ProcessIdentity>();
    this.#pendingLaunch = { generation, launchId, owned: launchOwned };
    let browser: Browser;
    try {
      browser = await this.launchBrowser(launchId);
    } catch (error) {
      for (const [pid, identity] of playwrightProcessesForLaunch(launchId)) launchOwned.set(pid, identity);
      if (generation !== this.#generation) await forceCloseOwnedBrowser(null, launchOwned);
      else for (const [pid, identity] of launchOwned) this.#ownedProcesses.set(pid, identity);
      if (this.#pendingLaunch?.generation === generation) this.#pendingLaunch = null;
      throw error;
    }
    for (const [pid, identity] of playwrightProcessesForLaunch(launchId)) launchOwned.set(pid, identity);
    if (this.#pendingLaunch?.generation === generation) this.#pendingLaunch = null;
    if (generation !== this.#generation) {
      await forceCloseOwnedBrowser(browser, launchOwned);
      throw new Error("Chromium launch was cancelled");
    }
    this.#browser = browser;
    for (const [pid, identity] of launchOwned) this.#ownedProcesses.set(pid, identity);
    try {
      const session = await browser.newBrowserCDPSession();
      const processInfo = await session.send("SystemInfo.getProcessInfo") as { processInfo: { id: number; type: string }[] };
      await session.detach();
      if (generation !== this.#generation) throw new Error("Chromium launch was cancelled");
      for (const item of processInfo.processInfo) {
        const identity = processIdentity(item.id);
        if (identity) {
          launchOwned.set(item.id, identity);
          this.#ownedProcesses.set(item.id, identity);
        }
      }
      if (!processInfo.processInfo.some((item) => item.type === "browser")) throw new Error("Chromium did not report its owned browser process");
    } catch (error) {
      if (generation === this.#generation) {
        this.#browser = null;
        ++this.#generation;
      }
      await forceCloseOwnedBrowser(browser, launchOwned);
      throw error;
    }
  }

  async createCase(evidence: EvidenceStore, caseId: string, options: CaseBrowserOptions = {}): Promise<CaseBrowser> {
    if (!this.#browser) throw new Error("Chromium has not been started");
    const context = await this.#browser.newContext();
    await context.addInitScript(() => {
      let domVersion = 0;
      new MutationObserver(() => {
        document.documentElement.dataset.qaDomVersion = String(++domVersion);
      }).observe(document, { childList: true, subtree: true, characterData: true });
    });
    const page = await context.newPage();
    return new CaseBrowser(context, page, this.allowedOrigins, evidence, caseId, this.screenshot, options);
  }

  async close(): Promise<void> {
    this.#rememberPendingLaunch();
    const browser = this.#browser;
    this.#browser = null;
    ++this.#generation;
    this.#ownedProcesses = ownedProcessTree(this.#ownedProcesses);
    await browser?.close();
    const live = await waitForProcessExit(this.#ownedProcesses, 1_000);
    if (live.length > 0) throw new Error(`Chromium did not exit after close: ${live.map((item) => item.pid).join(", ")}`);
    this.#ownedProcesses.clear();
  }

  async forceClose(): Promise<void> {
    this.#rememberPendingLaunch();
    const browser = this.#browser;
    this.#browser = null;
    ++this.#generation;
    await forceCloseOwnedBrowser(browser, this.#ownedProcesses);
    this.#ownedProcesses.clear();
  }

  version(): string | null {
    return this.#browser?.version() ?? null;
  }

  isAlive(): boolean {
    return this.#browser?.isConnected() ?? false;
  }

  #rememberPendingLaunch(): void {
    const pending = this.#pendingLaunch;
    if (!pending) return;
    for (const [pid, identity] of playwrightProcessesForLaunch(pending.launchId)) pending.owned.set(pid, identity);
    for (const [pid, identity] of pending.owned) this.#ownedProcesses.set(pid, identity);
    this.#pendingLaunch = null;
  }
}

export interface CheckResult {
  kind: "url" | "text" | "locator";
  status: "passed" | "failed" | "unbound";
  pathname?: string;
  visible?: boolean;
  errorCode?: string;
}

export class CaseBrowser {
  readonly #page: Page;
  readonly #ledger: NetworkEntry[] = [];
  #targets = new Map<string, SnapshotTarget>();
  #secretTargets: Locator[] = [];
  #snapshotOrdinal = 0;
  #actionOrdinal = 0;
  #checkOrdinal = 0;
  #actionQueue: Promise<void> = Promise.resolve();
  readonly #successfulInteractions = new Set<string>();
  readonly #networkProgress = new Map<string, string>();

  constructor(private readonly context: BrowserContext, page: Page, private readonly allowedOrigins: ReadonlySet<string>, private readonly evidence: EvidenceStore, private readonly caseId: string, private readonly screenshot: Screenshotter, private readonly options: CaseBrowserOptions = {}) {
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
    return this.#act("open", stepId, signal, null, null, async () => {
      const origin = new URL(url).origin;
      if (!this.allowedOrigins.has(origin)) throw new Error(`origin ${origin} is not allowed`);
      await this.#page.goto(url, { waitUntil: "domcontentloaded" });
    });
  }
  async click(ref: string, stepId: string, signal?: AbortSignal): Promise<ActionResult> {
    const target = this.#targets.get(ref) ?? null;
    if (!target && !this.options.recording) throw new Error(`stale or unknown target ref ${ref}; request a fresh snapshot`);
    return this.#act("click", stepId, signal, target, ref, async () => {
      if (!target) throw new Error(`stale or unknown target ref ${ref}; request a fresh snapshot`);
      await this.#assertTargetCurrent(target, ref);
      await target.locator.click();
    });
  }
  async fill(ref: string, value: string, stepId: string, signal?: AbortSignal): Promise<ActionResult> {
    const target = this.#targets.get(ref) ?? null;
    if (!target && !this.options.recording) throw new Error(`stale or unknown target ref ${ref}; request a fresh snapshot`);
    return this.#act("fill", stepId, signal, target, ref, async () => {
      if (!target) throw new Error(`stale or unknown target ref ${ref}; request a fresh snapshot`);
      await this.#assertTargetCurrent(target, ref);
      await target.locator.fill(value);
    }, null, value);
  }

  async fillSecret(ref: string, value: string, fromOrStepId: string, stepIdOrSignal?: string | AbortSignal, signal?: AbortSignal): Promise<ActionResult> {
    const from = typeof stepIdOrSignal === "string" ? fromOrStepId : this.options.secretRefs?.length === 1 ? this.options.secretRefs[0]! : null;
    const stepId = typeof stepIdOrSignal === "string" ? stepIdOrSignal : fromOrStepId;
    const actionSignal = typeof stepIdOrSignal === "string" ? signal : stepIdOrSignal;
    const target = this.#targets.get(ref) ?? null;
    if (!target && !this.options.recording) throw new Error(`stale or unknown target ref ${ref}; request a fresh snapshot`);
    if (target) this.#secretTargets.push(target.locator);
    return this.#act("fill", stepId, actionSignal, target, ref, async () => {
      if (!target) throw new Error(`stale or unknown target ref ${ref}; request a fresh snapshot`);
      await this.#assertTargetCurrent(target, ref);
      await target.locator.fill(value);
    }, from, null);
  }

  async press(ref: string, key: string, stepId: string, signal?: AbortSignal): Promise<ActionResult> {
    const target = this.#targets.get(ref) ?? null;
    if (!target && !this.options.recording) throw new Error(`stale or unknown target ref ${ref}; request a fresh snapshot`);
    return this.#act("press", stepId, signal, target, ref, async () => {
      if (!target) throw new Error(`stale or unknown target ref ${ref}; request a fresh snapshot`);
      await target.locator.press(key);
    }, null, null, key);
  }
  async checkUrl(path: string, state: "equals" | "notEquals", stepId: string, oracleList: "expect" | "reject", oracleIndex: number, signal?: AbortSignal): Promise<CheckResult> {
    const ordinal = ++this.#checkOrdinal;
    const groundingText = path;
    const oracle = this.options.oracle?.[oracleList]?.[oracleIndex];
    let status: RecordedCheck["status"] = oracle && oracleAssertionCompatible(oracleList, state) && groundingMatches(oracle, path) ? "failed" : "unbound";
    let pathname: string | undefined;
    let errorCode: string | undefined;
    if (status !== "unbound") {
      try {
        if (signal?.aborted) throw signal.reason ?? new Error("aborted");
        await this.#boundedCheck(async () => {
          pathname = new URL(this.#page.url()).pathname;
          if ((state === "equals" && pathname !== path) || (state === "notEquals" && pathname === path)) throw new Error("CHECK_MISMATCH");
        }, signal);
        status = "passed";
      } catch (error) {
        errorCode = safeCheckErrorCode(error);
      }
    }
    await this.#recordCheck({ schemaVersion: 1, kind: "check", caseId: this.caseId, stepId, checkOrdinal: ordinal, oracle: { list: oracleList, index: oracleIndex }, check: "url", path, state, groundingText, status });
    return { kind: "url", status, ...(pathname === undefined ? {} : { pathname }), ...(errorCode === undefined ? {} : { errorCode }) };
  }

  async checkText(text: string, state: "visible" | "hidden", stepId: string, oracleList: "expect" | "reject", oracleIndex: number, signal?: AbortSignal): Promise<CheckResult> {
    const ordinal = ++this.#checkOrdinal;
    const oracle = this.options.oracle?.[oracleList]?.[oracleIndex];
    let status: RecordedCheck["status"] = oracle && oracleAssertionCompatible(oracleList, state) && groundingMatches(oracle, text) ? "failed" : "unbound";
    let errorCode: string | undefined;
    if (status !== "unbound") {
      try {
        await this.#boundedCheck(() => this.#page.getByText(text, { exact: true }).waitFor({ state, timeout: 5_000 }), signal);
        status = "passed";
      } catch (error) {
        errorCode = safeCheckErrorCode(error);
      }
    }
    await this.#recordCheck({ schemaVersion: 1, kind: "check", caseId: this.caseId, stepId, checkOrdinal: ordinal, oracle: { list: oracleList, index: oracleIndex }, check: "text", text, exact: true, state, groundingText: text, status });
    return { kind: "text", status, ...(errorCode === undefined ? {} : { errorCode }) };
  }

  async checkLocator(locator: RecordedLocator, state: "visible" | "hidden", stepId: string, oracleList: "expect" | "reject", oracleIndex: number, signal?: AbortSignal): Promise<CheckResult> {
    const ordinal = ++this.#checkOrdinal;
    const actual = this.#locator(locator);
    const groundingText = await this.#groundingForLocator(locator, actual);
    const oracle = this.options.oracle?.[oracleList]?.[oracleIndex];
    let status: RecordedCheck["status"] = oracle && oracleAssertionCompatible(oracleList, state) && groundingMatches(oracle, groundingText) ? "failed" : "unbound";
    let errorCode: string | undefined;
    if (status !== "unbound") {
      try {
        await this.#boundedCheck(() => actual.waitFor({ state, timeout: 5_000 }), signal);
        status = "passed";
      } catch (error) {
        errorCode = safeCheckErrorCode(error);
      }
    }
    await this.#recordCheck({ schemaVersion: 1, kind: "check", caseId: this.caseId, stepId, checkOrdinal: ordinal, oracle: { list: oracleList, index: oracleIndex }, check: "locator", locator, state, groundingText, status });
    return { kind: "locator", status, visible: status === "passed" && state === "visible", ...(errorCode === undefined ? {} : { errorCode }) };
  }

  async #boundedCheck(work: () => Promise<void>, signal?: AbortSignal): Promise<void> {
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("CHECK_TIMEOUT")), 5_000));
    if (!signal) {
      await Promise.race([work(), timeout]);
      return;
    }
    if (signal.aborted) throw signal.reason ?? new Error("aborted");
    await Promise.race([work(), timeout, new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true }))]);
  }

  async #groundingForLocator(locator: RecordedLocator, actual: Locator): Promise<string> {
    if (locator.kind !== "testId") return locator.kind === "role" ? locator.name : locator.value;
    return await actual.evaluate((element) => {
      const html = element as HTMLElement;
      const labels = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement ? [...(element.labels ?? [])].map((label) => label.innerText.trim()).filter(Boolean).join(" ") : "";
      return element.getAttribute("aria-label")?.trim() || labels || html.innerText?.trim() || element.textContent?.trim() || "";
    }).catch(() => "");
  }

  async #recordCheck(check: RecordedCheck): Promise<void> {
    if (!this.options.recording) return;
    const literals = check.check === "url"
      ? [check.path, check.groundingText]
      : check.check === "text"
        ? [check.text, check.groundingText]
        : [check.groundingText, check.locator.kind === "role" ? check.locator.role : check.locator.value, check.locator.kind === "role" ? check.locator.name : ""];
    if (literals.some((value) => containsSecretLike(value, this.options.secretValues ?? []))) return;
    await this.options.recording.append(check);
  }




  async scroll(stepId: string, deltaY: number, signal?: AbortSignal, ref?: string): Promise<ActionResult> {
    const target = ref ? this.#targets.get(ref) ?? null : null;
    if (ref && !target && !this.options.recording) throw new Error(`stale or unknown target ref ${ref}; request a fresh snapshot`);
    return this.#act("scroll", stepId, signal, target, ref ?? null, async () => {
      if (!target) {
        await this.#page.mouse.wheel(0, deltaY);
        await this.#page.evaluate(() => {
          (window as typeof window & { __qaScrollOwner?: Element }).__qaScrollOwner = document.scrollingElement ?? document.documentElement;
        });
        return;
      }
      await this.#assertTargetCurrent(target, ref!);
      await target.locator.evaluate((element, amount) => {
        let parent = element.parentElement;
        while (parent) {
          const style = window.getComputedStyle(parent);
          if (/(auto|scroll)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight) {
            (window as typeof window & { __qaScrollOwner?: Element }).__qaScrollOwner = parent;
            parent.scrollBy(0, amount);
            return;
          }
          parent = parent.parentElement;
        }
        (window as typeof window & { __qaScrollOwner?: Element }).__qaScrollOwner = document.scrollingElement ?? document.documentElement;
        window.scrollBy(0, amount);
      }, deltaY);
    });
  }

  async snapshot(stepId: string, signal?: AbortSignal): Promise<Observation> {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    const capture = this.#capture(stepId, "after");
    if (!signal) return (await capture).observation;
    return await new Promise<Observation>((resolve, reject) => {
      const onAbort = () => reject(signal.reason ?? new Error("aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
      capture.then(
        (result) => {
          signal.removeEventListener("abort", onAbort);
          if (signal.aborted) reject(signal.reason ?? new Error("aborted"));
          else resolve(result.observation);
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
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

  async #awaitWithAbort<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    const pending = Promise.resolve().then(work);
    if (!signal) return pending;
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason ?? new Error("aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    if (signal.aborted) {
      pending.catch(() => {});
      throw signal.reason ?? new Error("aborted");
    }
    try {
      return await Promise.race([pending, aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
      pending.catch(() => {});
    }
  }

  async #act(kind: "open" | "click" | "fill" | "press" | "scroll", stepId: string, signal: AbortSignal | undefined, target: SnapshotTarget | null, ref: string | null, operation: () => Promise<void>, from: string | null = null, value: string | null = null, key: string | null = null, deltaY: number | null = null): Promise<ActionResult> {
    const previousAction = this.#actionQueue;
    let releaseAction!: () => void;
    this.#actionQueue = new Promise<void>((resolve) => { releaseAction = resolve; });
    try {
      await this.#awaitWithAbort(() => previousAction, signal);
      const actionOrdinal = ++this.#actionOrdinal;
      const actionId = `act-${actionOrdinal}`;
      const warnings: string[] = [];
      const before = await this.#awaitWithAbort(() => this.#capture(stepId, "before", warnings), signal);
      const stableLocator = target && ref ? await this.#awaitWithAbort(() => this.#stableLocator(target), signal) : null;
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
      await this.#recordAction({ schemaVersion: 1, kind: "action", caseId: this.caseId, stepId, actionOrdinal, action: kind, frame: target?.frame ?? "main", sourceSnapshotId: target?.sourceSnapshotId ?? null, locator: stableLocator, url: kind === "open" ? this.#recordedPath(this.#page.url()) : null, from, value: this.#safeRecordedValue(value), key, deltaY, actionStatus, observationStatus: after ? settled : "failed" });
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
    const rawCandidates = await this.#page.locator(TARGET_SELECTOR).evaluateAll((elements) => {
      const interactiveSelector = 'button, a[href], input, select, textarea, [role="button"], [role="link"], [role="textbox"], [role="combobox"], [role="checkbox"], [role="switch"], [tabindex]:not([tabindex="-1"])';
      const normalize = (value: string | null | undefined): string => value?.trim().replace(/\s+/g, " ") ?? "";
      const nonSymbolText = (value: string | null | undefined): string => {
        const normalized = normalize(value);
        return normalized && !/^[\p{P}\p{S}\s]+$/u.test(normalized) ? normalized : "";
      };
      const isVisible = (candidate: Element): boolean => {
        const bounds = candidate.getBoundingClientRect();
        const style = window.getComputedStyle(candidate);
        return bounds.width > 0 && bounds.height > 0 && bounds.right > 0 && bounds.bottom > 0 && bounds.left < window.innerWidth && bounds.top < window.innerHeight && style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
      };
      const visibleTextFrom = (candidate: Element): string => nonSymbolText((candidate as HTMLElement).innerText);
      const textFrom = (candidate: Element): string => visibleTextFrom(candidate) || nonSymbolText(candidate.textContent);
      const labelledByText = (candidate: Element): string => (candidate.getAttribute("aria-labelledby")?.trim().split(/\s+/) ?? [])
        .map((id) => document.getElementById(id))
        .filter((label): label is HTMLElement => label instanceof HTMLElement)
        .map((label) => textFrom(label))
        .filter(Boolean)
        .join(" ");
      const explicitName = (candidate: Element): string => {
        const html = candidate as HTMLElement;
        const ariaLabel = normalize(candidate.getAttribute("aria-label"));
        const labels = candidate instanceof HTMLInputElement || candidate instanceof HTMLTextAreaElement || candidate instanceof HTMLSelectElement ? [...(candidate.labels ?? [])].map((label) => normalize(label.innerText)).filter(Boolean).join(" ") : "";
        const title = normalize(candidate.getAttribute("title"));
        const placeholder = normalize(html.getAttribute("placeholder"));
        const ownText = textFrom(candidate);
        const labelledBy = labelledByText(candidate);
        return ariaLabel || labels || title || placeholder || ownText || labelledBy;
      };
      const nearbyText = (element: Element): string => {
        const labelledBy = labelledByText(element);
        if (labelledBy) return labelledBy;
        if (element.closest("table, [role=table], [role=grid]")) return "";
        const parent = element.parentElement;
        if (!parent) return "";
        const toolbar = element.closest('[role="toolbar"], [role="group"]');
        const canUseSiblings = toolbar !== null || parent.children.length <= 8;
        if (canUseSiblings) {
          const elementIndex = [...parent.children].indexOf(element);
          const sibling = [...parent.children]
            .map((candidate, index) => ({ candidate, index, distance: Math.abs(index - elementIndex) }))
            .filter(({ candidate }) => candidate !== element && isVisible(candidate))
            .sort((left, right) => left.distance - right.distance)
            .map(({ candidate }) => {
              if (candidate.matches(interactiveSelector)) return explicitName(candidate);
              return toolbar ? textFrom(candidate) : "";
            })
            .find(Boolean);
          if (sibling) return sibling;
        }
        if (!toolbar) return "";
        const toolbarName = labelledByText(toolbar) || explicitName(toolbar);
        return toolbarName.length <= 80 ? toolbarName : "";
      };
      return elements.map((element, index) => {
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
        const headerElement = element.closest("th, [role=columnheader]");
        const header = headerElement ? visibleTextFrom(headerElement) : "";
        const nearby = tag === "button" || element.getAttribute("role") === "button" ? nearbyText(element) : "";
        const semanticName = ariaLabel || labels || title || placeholder || ownText;
        const name = semanticName || (header ? `${header} — control` : nearby ? `${nearby} — icon` : "");
        const nameSource: NameSource = ariaLabel ? "aria" : labels ? "label" : title ? "title" : placeholder ? "placeholder" : header ? "nearby-header" : "nearby-text";
        const isIconControl = !semanticName && (nameSource === "nearby-header" || nameSource === "nearby-text");
        const kind: InteractiveKind = tag === "button" || element.getAttribute("role") === "button" ? isIconControl ? "icon-control" : "button" : tag === "a" || element.getAttribute("role") === "link" ? "link" : ["input", "textarea", "select"].includes(tag) ? "input" : "clickable";
        if (!name) return null;
        const semantic = Boolean(ariaLabel || labels || title || placeholder || ownText);
        const table = element.closest("table, [role=table], [role=grid]");
        const tableKey = table ? table.id || `table-${[...document.querySelectorAll("table, [role=table], [role=grid]")].indexOf(table)}` : null;
        return { index, kind, name, nameSource, bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }, enabled: !(html as HTMLButtonElement).disabled && element.getAttribute("aria-disabled") !== "true", priority: semantic ? 1 : header ? 2 : 3, tableKey, isTableHeader: Boolean(element.closest("th, [role=columnheader]")), role: element.getAttribute("role") || (tag === "button" ? "button" : tag === "a" ? "link" : ["input", "textarea"].includes(tag) ? "textbox" : tag), testId: element.getAttribute("data-testid"), placeholder: placeholder || null };
      }).filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);
    });
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
      this.#targets.set(ref, { locator: this.#page.locator(TARGET_SELECTOR).nth(candidate.index), locatorCandidates: this.#locatorCandidates(candidate), sourceSnapshotId: "", frame: "main", domVersion });
      return { ref, kind: candidate.kind, name: this.evidence.redactText(candidate.name), nameSource: candidate.nameSource, bounds: candidate.bounds, enabled: candidate.enabled };
    });
    const visibleText = this.evidence.redactText(await this.#page.locator("body").innerText());
    const safeUrl = this.evidence.redactText(url);
    const safeAria = this.evidence.redactText(aria);
    const scroll = await this.#page.evaluate(() => {
      const owner = (window as typeof window & { __qaScrollOwner?: Element }).__qaScrollOwner;
      if (owner instanceof HTMLElement && owner.isConnected && owner !== document.scrollingElement && owner !== document.documentElement && owner !== document.body) {
        return { scope: "container" as const, x: owner.scrollLeft, y: owner.scrollTop, maxX: Math.max(0, owner.scrollWidth - owner.clientWidth), maxY: Math.max(0, owner.scrollHeight - owner.clientHeight) };
      }
      return { scope: "page" as const, x: window.scrollX, y: window.scrollY, maxX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth), maxY: Math.max(0, document.documentElement.scrollHeight - window.innerHeight) };
    });
    const modelAria = truncateForModel(safeAria, ARIA_MAX_CHARS);
    const modelVisible = truncateForModel(visibleText, VISIBLE_TEXT_MAX_CHARS);
    const snapshotContent = JSON.stringify({ url: safeUrl, visibleText, aria: safeAria, interactive, interactiveTruncated: rawCandidates.length > selected.length, omittedCount: rawCandidates.length - selected.length, scroll }, null, 2);
    const snapshot = await this.evidence.record({ caseId: this.caseId, stepId, actionOrdinal: this.#actionOrdinal, phase, kind: "snapshot", url: safeUrl, extension: "json", content: snapshotContent });
    for (const target of this.#targets.values()) target.sourceSnapshotId = snapshot.id;
    const screenshotId = screenshot?.id ?? "";
    if (!screenshotId) warnings.push("screenshot capture failed");
    return { observation: { snapshotId: snapshot.id, screenshotId, url: safeUrl, visibleText: modelVisible.text, aria: modelAria.text, interactive, interactiveTruncated: rawCandidates.length > selected.length, omittedCount: rawCandidates.length - selected.length, ariaTruncated: modelAria.truncated, visibleTextTruncated: modelVisible.truncated, scroll }, evidence: screenshot ? [snapshot, screenshot] : [snapshot] };
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
  #locatorCandidates(candidate: Candidate): RecordedLocator[] {
    const candidates: RecordedLocator[] = [];
    if (candidate.testId) candidates.push({ kind: "testId", value: candidate.testId });
    if (candidate.nameSource === "label") candidates.push({ kind: "label", value: candidate.name });
    if (candidate.role && candidate.name) candidates.push({ kind: "role", role: candidate.role, name: candidate.name });
    if (candidate.placeholder) candidates.push({ kind: "placeholder", value: candidate.placeholder });
    if ((candidate.kind === "button" || candidate.kind === "link") && candidate.name) candidates.push({ kind: "text", value: candidate.name });
    return candidates;
  }

  async #stableLocator(target: SnapshotTarget): Promise<RecordedLocator | null> {
    const ephemeral = await target.locator.elementHandle().catch(() => null);
    if (!ephemeral) return null;
    try {
      for (const candidate of target.locatorCandidates) {
        const locator = this.#locator(candidate);
        let handle: Awaited<ReturnType<Locator["elementHandle"]>> | null = null;
        try {
          if (await locator.count() !== 1) continue;
          handle = await locator.elementHandle();
          if (!handle) continue;
          const same = await locator.evaluate((element, other) => element === other, ephemeral);
          if (same) return candidate;
        } catch {
          continue;
        } finally {
          await handle?.dispose().catch(() => {});
        }
      }
      return null;
    } finally {
      await ephemeral.dispose().catch(() => {});
    }
  }

  #locator(locator: RecordedLocator): Locator {
    switch (locator.kind) {
      case "testId": return this.#page.getByTestId(locator.value);
      case "label": return this.#page.getByLabel(locator.value, { exact: true });
      case "role": return this.#page.getByRole(locator.role as Parameters<Page["getByRole"]>[0], { name: locator.name, exact: true });
      case "placeholder": return this.#page.getByPlaceholder(locator.value, { exact: true });
      case "text": return this.#page.getByText(locator.value, { exact: true });
    }
  }

  #recordedPath(url: string): string | null {
    try {
      const parsed = new URL(url);
      const target = this.options.targetUrl ? new URL(this.options.targetUrl) : null;
      if (target && parsed.origin !== target.origin) return parsed.toString();
      return `${parsed.pathname || "/"}${parsed.search}`;
    } catch {
      return null;
    }
  }

  #safeRecordedValue(value: string | null): string | null {
    if (value === null) return null;
    if (containsSecretLike(value, this.options.secretValues ?? [])) return null;
    return value;
  }

  #safeRecordedLocator(locator: RecordedLocator | null): RecordedLocator | null {
    if (locator === null) return null;
    const literals = locator.kind === "role" ? [locator.role, locator.name] : [locator.value];
    return literals.some((value) => containsSecretLike(value, this.options.secretValues ?? [])) ? null : locator;
  }

  async #recordAction(action: RecordedAction): Promise<void> {
    if (!this.options.recording) return;
    if ((action.action === "open" && action.url !== null && containsSecretLike(action.url, this.options.secretValues ?? [])) || (action.action === "press" && action.key !== null && containsSecretLike(action.key, this.options.secretValues ?? []))) throw new Error("RECORDING_SECRET_LITERAL");
    await this.options.recording.append({ ...action, locator: this.#safeRecordedLocator(action.locator) });
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
    const readBody = async () => this.#page.locator("body").innerText({ timeout: Math.max(1, deadline - Date.now()) });
    let previous: string;
    try {
      previous = await readBody();
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") return "incomplete";
      throw error;
    }
    let quietSince = Date.now();
    let sawEligibleRequest = false;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      const now = Date.now();
      const eligible = this.#ledger.filter((entry) => entry.settleEligible && entry.startedAt >= watermark && entry.startedAt <= requestWindowEndsAt && !isLongLived(entry));
      if (eligible.length > 0) sawEligibleRequest = true;
      let current: string;
      try {
        current = await readBody();
      } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") return "incomplete";
        throw error;
      }
      if (current !== previous) {
        previous = current;
        quietSince = now;
      }
      const domIsQuiet = now - quietSince >= DOM_QUIET_MS;
      if (domIsQuiet && (!sawEligibleRequest || eligible.every((entry) => entry.finishedAt !== null))) return "complete";
      if (!sawEligibleRequest && now >= requestWindowEndsAt) return "incomplete";
      await Bun.sleep(50);
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
      await Bun.sleep(Math.min(50, windowEndsAt - Date.now()));
    }
  }
}
