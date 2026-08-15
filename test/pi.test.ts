import { expect, test } from "bun:test";
import { resolveModelConfiguration } from "../src/model.js";
import { modelForConfiguration, verifyPiIsolation } from "../src/pi.js";

test("Pi SDK exposes only the browser custom tool for the default GLM configuration", async () => {
  const configuration = resolveModelConfiguration({});
  expect(configuration).toEqual({ provider: "openrouter", model: "z-ai/glm-5.2" });
  expect(JSON.stringify(modelForConfiguration(configuration))).toContain('"openRouterRouting":{"order":["z-ai"],"allow_fallbacks":false,"require_parameters":true}');

  await expect(verifyPiIsolation(configuration)).resolves.toEqual(["browser"]);
});
