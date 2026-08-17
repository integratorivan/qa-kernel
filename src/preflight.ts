export const PREFLIGHT_TIMEOUT_MS = 8_000;

export type PreflightFetch = (url: string, init?: RequestInit) => Promise<Response>;

export class PreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreflightError";
  }
}

export async function preflightUrl(url: string, timeoutMs = PREFLIGHT_TIMEOUT_MS, fetchImpl: PreflightFetch = fetch): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response = await fetchImpl(url, { method: "HEAD", signal: controller.signal, redirect: "manual" });
    if (response.status === 405 || response.status === 501) {
      response = await fetchImpl(url, { method: "GET", signal: controller.signal, redirect: "manual" });
    }
    void response;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new PreflightError(`Target URL ${url} did not respond within ${timeoutMs}ms. The server may be wedged, still starting, or unreachable.`);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new PreflightError(`Target URL ${url} is unreachable: ${message}. Check that the server is running.`);
  } finally {
    clearTimeout(timer);
  }
}
