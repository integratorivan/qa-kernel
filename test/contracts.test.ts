import { expect, test } from "bun:test";
import { caseJsonSchema, discoveryJsonSchema, secretRefToDataKey } from "../src/contracts.js";

test("maps allowlisted secret refs to case data keys", () => {
  expect(secretRefToDataKey("QA_EMAIL")).toBe("emailFrom");
  expect(secretRefToDataKey("QA_PASSWORD")).toBe("passwordFrom");
});

test("discovery schema requires a full case object instead of summary", () => {
  const schema = discoveryJsonSchema(["QA_EMAIL", "QA_PASSWORD"]);
  const draft = (schema.properties as { drafts: { items: { properties: { case: { required: string[]; properties: Record<string, unknown> } } } } }).drafts.items.properties.case;
  expect(draft.required).toEqual(["schemaVersion", "id", "title", "goal", "preconditions", "data", "steps", "oracle", "safety"]);
  expect(draft.properties).not.toHaveProperty("summary");
  expect((draft.properties.data as { properties: Record<string, unknown> }).properties).toEqual({
    emailFrom: { type: "string", enum: ["QA_EMAIL"], description: "Allowlisted secret ref QA_EMAIL" },
    passwordFrom: { type: "string", enum: ["QA_PASSWORD"], description: "Allowlisted secret ref QA_PASSWORD" },
  });
  expect(caseJsonSchema([]).properties).not.toHaveProperty("summary");
});
