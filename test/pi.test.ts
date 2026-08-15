import { expect, test } from "bun:test";
import { PI_MODEL, PI_PROVIDER, verifyPiIsolation } from "../src/pi.js";

test("Pi SDK exposes only the browser custom tool", async () => {
  expect(PI_PROVIDER).toBe("anthropic");
  expect(PI_MODEL).toBe("claude-opus-4-8");
  await expect(verifyPiIsolation()).resolves.toEqual(["browser"]);
});
