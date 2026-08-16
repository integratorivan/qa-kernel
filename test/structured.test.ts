import { expect, test } from "bun:test";
import { completeStructuredJson } from "../src/structured.js";

test("OpenRouter repair falls back from json_schema to json_object on the pinned GLM endpoint", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const text = await completeStructuredJson({
    configuration: { provider: "openrouter", model: "z-ai/glm-5.2" },
    apiKey: "test-key",
    schemaName: "qa_discovery_result",
    schema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" } }, required: ["ok"] },
    userContent: JSON.stringify({ invalidResult: "Based on exploration" }),
    fetchImpl: async (url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url: String(url), body });
      const format = body.response_format as { type?: string };
      if (format.type === "json_schema") return new Response(JSON.stringify({ error: { message: "No endpoints found for z-ai/glm-5.2." } }), { status: 404 });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  expect(text).toBe('{"ok":true}');
  expect(requests).toHaveLength(2);
  expect((requests[0]?.body.response_format as { type: string }).type).toBe("json_schema");
  expect((requests[0]?.body.provider as { require_parameters: boolean }).require_parameters).toBe(false);
  expect(requests[1]?.body.response_format).toEqual({ type: "json_object" });
  expect(requests[1]?.body.provider).toEqual({ order: ["z-ai"], allow_fallbacks: false, require_parameters: true });
});

test("surfaces an OpenRouter structured-output failure after both formats fail", async () => {
  await expect(completeStructuredJson({
    configuration: { provider: "openrouter", model: "z-ai/glm-5.2" },
    apiKey: "test-key",
    schemaName: "qa_discovery_result",
    schema: { type: "object" },
    userContent: "{}",
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: "No endpoints found for z-ai/glm-5.2." } }), { status: 404 }),
  })).rejects.toThrow("OpenRouter structured output failed");
});
