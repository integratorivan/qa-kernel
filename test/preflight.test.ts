import { afterAll, expect, test } from "bun:test";
import { PreflightError, preflightUrl, type PreflightFetch } from "../src/preflight.js";

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/head-ok") {
      if (request.method === "HEAD") return new Response(null, { status: 204 });
      return new Response("unexpected GET", { status: 500 });
    }
    if (path === "/no-head") {
      if (request.method === "HEAD") return new Response(null, { status: 405 });
      return new Response("ok");
    }
    if (path === "/failing") return new Response("down", { status: 503 });
    return new Response("not found", { status: 404 });
  },
});
const origin = `http://127.0.0.1:${server.port}`;

afterAll(() => server.stop(true));

test("accepts a reachable URL after HEAD", async () => {
  await preflightUrl(`${origin}/head-ok`);
});

test("falls back to GET when HEAD is not allowed", async () => {
  await preflightUrl(`${origin}/no-head`);
});

test("treats HTTP error statuses as reachable", async () => {
  await preflightUrl(`${origin}/failing`);
});

test("skips non-http URLs", async () => {
  await preflightUrl("file:///tmp/index.html");
});

test("fails fast on connection refused", async () => {
  await expect(preflightUrl("http://127.0.0.1:1/")).rejects.toThrow(PreflightError);
  await expect(preflightUrl("http://127.0.0.1:1/")).rejects.toThrow(/unreachable/);
});

test("fails when the target exceeds the preflight deadline", async () => {
  const fetchImpl: PreflightFetch = (_url, init) => new Promise((_, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }
    signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true });
  });
  await expect(preflightUrl(`${origin}/head-ok`, 20, fetchImpl)).rejects.toThrow(/did not respond within 20ms/);
});
