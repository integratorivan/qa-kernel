export type JsonSchema = Record<string, unknown>;

export function secretRefToDataKey(ref: string): string {
  const parts = ref.split("_");
  const words = parts.length > 1 ? parts.slice(1) : parts;
  const camel = words.map((word, index) => {
    const lower = word.toLowerCase();
    return index === 0 ? lower : `${lower.slice(0, 1).toUpperCase()}${lower.slice(1)}`;
  }).join("");
  return `${camel}From`;
}

function identifierString(): JsonSchema {
  return { type: "string", minLength: 1, pattern: "^[A-Za-z][A-Za-z0-9_-]*$", description: "Identifier starting with a letter" };
}

function nonEmptyString(description: string): JsonSchema {
  return { type: "string", minLength: 1, description };
}

function stringArray(description: string, minItems = 0): JsonSchema {
  return { type: "array", minItems, items: { type: "string", minLength: 1 }, description };
}

export function caseJsonSchema(allowedSecretRefs: readonly string[] = []): JsonSchema {
  const dataProperties: Record<string, JsonSchema> = {};
  for (const ref of allowedSecretRefs) {
    dataProperties[secretRefToDataKey(ref)] = { type: "string", enum: [ref], description: `Allowlisted secret ref ${ref}` };
  }
  return {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "id", "title", "goal", "preconditions", "data", "steps", "oracle", "safety"],
    properties: {
      schemaVersion: { type: "integer", enum: [1] },
      id: identifierString(),
      title: nonEmptyString("Short case title"),
      goal: nonEmptyString("What the case verifies"),
      preconditions: stringArray("Preconditions, may be empty"),
      data: {
        type: "object",
        additionalProperties: false,
        properties: dataProperties,
        description: "Optional *From keys bound to allowlisted secret refs. Do not invent other keys or a summary field.",
      },
      steps: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "instruction"],
          properties: {
            id: identifierString(),
            instruction: nonEmptyString("What the operator should do"),
          },
        },
      },
      oracle: {
        type: "object",
        additionalProperties: false,
        required: ["source", "expect", "reject"],
        properties: {
          source: { type: "string", enum: ["product-requirement", "user-approved", "qa-heuristic", "baseline", "inferred"] },
          expect: stringArray("Observable expected facts", 1),
          reject: stringArray("Observable reject facts", 1),
        },
      },
      safety: {
        type: "object",
        additionalProperties: false,
        required: ["mutation"],
        properties: { mutation: { type: "string", enum: ["none"] } },
      },
    },
  };
}

export function discoveryJsonSchema(allowedSecretRefs: readonly string[] = []): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: ["productMap", "uncoveredAreas", "drafts"],
    properties: {
      productMap: stringArray("Visited product areas", 1),
      uncoveredAreas: stringArray("Seen but not operated areas"),
      drafts: {
        type: "array",
        minItems: 2,
        maxItems: 3,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["status", "case", "evidenceIds"],
          properties: {
            status: { type: "string", enum: ["ready", "needsCapability"], description: "ready only after a successful click, fill, or press. needsCapability only when a visible control could not be operated after a fresh snapshot." },
            case: caseJsonSchema(allowedSecretRefs),
            evidenceIds: stringArray("Existing explore-step evidence IDs", 1),
          },
        },
      },
    },
  };
}

export const RESULT_JSON_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "testCaseId", "executionStatus", "verdict", "blockedBy", "actual", "evidence", "reviewReason", "error"],
  properties: {
    schemaVersion: { type: "integer", enum: [1] },
    testCaseId: identifierString(),
    executionStatus: { type: "string", enum: ["completed"] },
    verdict: { type: "string", enum: ["PASS", "FAIL", "BLOCKED", "INCONCLUSIVE"] },
    blockedBy: { type: ["string", "null"], enum: ["capability", "credentials", "environment", "safety", "product", null] },
    actual: nonEmptyString("What was observed"),
    evidence: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["stepId", "claim", "evidenceIds"],
        properties: {
          stepId: identifierString(),
          claim: nonEmptyString("Claim about this step"),
          evidenceIds: stringArray("Existing evidence IDs for this step", 1),
        },
      },
    },
    reviewReason: { type: ["string", "null"], description: "Required string for INCONCLUSIVE, otherwise null" },
    error: { type: "null" },
  },
};

export const DISCOVERY_INSTRUCTION = [
  "Explore only areas directly reachable for this mission.",
  "Use browser.open first.",
  "Each draft must be self-contained: if the flow needs login, include those login steps in that same case and do not assume another draft already ran.",
  "Name visible controls in steps: click Войти, fill the Email field. Do not write vague navigate-to-login instructions.",
  "oracle.expect and oracle.reject must be observable facts: visible text, URL, element presence, or network outcome. Not CSS, colors, performance, or layout.",
  "Keep each case short: 3-7 steps. A focused case that can pass is better than a long tour.",
  "Do not invent features behind authentication unless you operated a visible login form in this session.",
  "When finished, return only one JSON object that matches resultContract exactly.",
  "Each draft.case must be a full semantic case object with schemaVersion, id, title, goal, preconditions, data, steps, oracle, and safety.",
  "Do not add summary or other fields. Do not put a string in case.",
  "Every draft needs existing explore-step evidence IDs.",
  "ready requires a successful click, fill, or press.",
  "needsCapability is only when a visible control could not be operated after a fresh snapshot.",
  "Do not invent unseen capability.",
].join(" ");
