import { expect, test } from "bun:test";
import { ModelConfigurationError, openRouterRouting, requireModelApiKey, resolveModelConfiguration } from "../src/model.js";

test("defaults to the pinned OpenRouter GLM model", () => {
  expect(resolveModelConfiguration({})).toEqual({ provider: "openrouter", model: "z-ai/glm-5.2" });
});

test("allows only approved direct Anthropic and OpenRouter models", () => {
  expect(resolveModelConfiguration({ QA_MODEL_PROVIDER: "anthropic", QA_MODEL_ID: "claude-opus-4-8" })).toEqual({ provider: "anthropic", model: "claude-opus-4-8" });
  expect(resolveModelConfiguration({ QA_MODEL_PROVIDER: "openrouter", QA_MODEL_ID: "anthropic/claude-opus-4.8" })).toEqual({ provider: "openrouter", model: "anthropic/claude-opus-4.8" });
  expect(() => resolveModelConfiguration({ QA_MODEL_PROVIDER: "openrouter", QA_MODEL_ID: "openrouter/auto" })).toThrow(ModelConfigurationError);
  expect(() => resolveModelConfiguration({ QA_MODEL_PROVIDER: "unsupported" })).toThrow(ModelConfigurationError);
});

test("pins OpenRouter upstream routing for approved models", () => {
  expect(openRouterRouting({ provider: "openrouter", model: "z-ai/glm-5.2" })).toEqual({ order: ["z-ai"], allow_fallbacks: false, require_parameters: true });
  expect(openRouterRouting({ provider: "openrouter", model: "anthropic/claude-opus-4.8" })).toEqual({ order: ["anthropic"], allow_fallbacks: false, require_parameters: true });
  expect(openRouterRouting({ provider: "anthropic", model: "claude-opus-4-8" })).toBeNull();
});

test("requires a model credential only when execution begins", () => {
  expect(() => requireModelApiKey({})).toThrow("QA_MODEL_API_KEY is required");
  expect(requireModelApiKey({ QA_MODEL_API_KEY: "test-key" })).toBe("test-key");
});
