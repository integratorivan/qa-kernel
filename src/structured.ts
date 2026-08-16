import { extractJsonText } from "./json-text.js";
import { openRouterRouting, type ModelConfiguration } from "./model.js";
import type { JsonSchema } from "./contracts.js";

export class StructuredOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StructuredOutputError";
  }
}

export type StructuredFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<Response>;

export interface StructuredCompletionInput {
  configuration: ModelConfiguration;
  apiKey: string;
  schemaName: string;
  schema: JsonSchema;
  userContent: string;
  signal?: AbortSignal;
  fetchImpl?: StructuredFetch;
}

interface OpenRouterMessage {
  role: string;
  content?: unknown;
}

function textFromOpenRouter(payload: unknown): string {
  const root = payload && typeof payload === "object" ? payload as { choices?: Array<{ message?: OpenRouterMessage }> } : {};
  const content = root.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
      return "";
    }).join("");
  }
  return "";
}

function textFromAnthropic(payload: unknown): string {
  const root = payload && typeof payload === "object" ? payload as { content?: Array<{ type?: string; text?: string }> } : {};
  return (root.content ?? []).filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text ?? "").join("");
}

async function readError(response: Response): Promise<string> {
  const body = await response.text();
  return `${response.status}: ${body.slice(0, 500)}`;
}

function openRouterBody(input: StructuredCompletionInput, format: "json_schema" | "json_object"): string {
  const routing = openRouterRouting(input.configuration);
  return JSON.stringify({
    model: input.configuration.model,
    temperature: 0,
    messages: [
      { role: "system", content: "Return one JSON object that matches the provided schema. No markdown, no prose." },
      { role: "user", content: `${input.userContent}\n\nJSON schema:\n${JSON.stringify(input.schema)}` },
    ],
    response_format: format === "json_schema"
      ? { type: "json_schema", json_schema: { name: input.schemaName, strict: true, schema: input.schema } }
      : { type: "json_object" },
    provider: format === "json_schema" ? { ...routing, require_parameters: false } : routing,
  });
}

export async function completeStructuredJson(input: StructuredCompletionInput): Promise<string> {
  if (!input.apiKey) throw new StructuredOutputError("QA_MODEL_API_KEY is required for structured JSON repair");
  const fetchImpl = input.fetchImpl ?? ((url, init) => fetch(url, init));
  if (input.configuration.provider === "openrouter") {
    const attempts: Array<"json_schema" | "json_object"> = ["json_schema", "json_object"];
    const errors: string[] = [];
    for (const format of attempts) {
      const response = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          "content-type": "application/json",
        },
        ...(input.signal ? { signal: input.signal } : {}),
        body: openRouterBody(input, format),
      });
      if (!response.ok) {
        errors.push(`${format}: ${await readError(response)}`);
        continue;
      }
      const text = extractJsonText(textFromOpenRouter(await response.json()));
      if (!text) {
        errors.push(`${format}: empty content`);
        continue;
      }
      return text;
    }
    throw new StructuredOutputError(`OpenRouter structured output failed: ${errors.join(" | ")}`);
  }

  const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": input.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    ...(input.signal ? { signal: input.signal } : {}),
    body: JSON.stringify({
      model: input.configuration.model,
      max_tokens: 4096,
      temperature: 0,
      messages: [{ role: "user", content: input.userContent }],
      output_format: { type: "json_schema", schema: input.schema },
    }),
  });
  if (!response.ok) throw new StructuredOutputError(`Anthropic structured output failed: ${await readError(response)}`);
  const text = extractJsonText(textFromAnthropic(await response.json()));
  if (!text) throw new StructuredOutputError("Anthropic structured output returned empty content");
  return text;
}
