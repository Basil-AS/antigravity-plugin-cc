import test from "node:test";
import assert from "node:assert/strict";

import { validateAgainstSchema } from "../plugins/antigravity/scripts/lib/schema-validate.mjs";

test("schema-validate approves compliant object", () => {
  const schema = {
    type: "object",
    required: ["verdict", "summary", "count"],
    additionalProperties: false,
    properties: {
      verdict: { type: "string", enum: ["approve", "needs-attention"] },
      summary: { type: "string", minLength: 1 },
      count: { type: "integer", minimum: 0 }
    }
  };

  const validData = {
    verdict: "approve",
    summary: "All good",
    count: 3
  };

  const result = validateAgainstSchema(validData, schema);
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test("schema-validate rejects missing fields and extra properties", () => {
  const schema = {
    type: "object",
    required: ["verdict"],
    additionalProperties: false,
    properties: {
      verdict: { type: "string", enum: ["approve", "needs-attention"] }
    }
  };

  const invalidData = {
    verdict: "invalid-verdict",
    extra: 123
  };

  const result = validateAgainstSchema(invalidData, schema);
  assert.equal(result.valid, false);
  assert.equal(result.errors.length >= 2, true);
});
