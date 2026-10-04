import test from "node:test";
import assert from "node:assert/strict";

import {
  parsePoolGauge,
  selectGeminiModel
} from "../plugins/antigravity/scripts/lib/quota.mjs";

test("parsePoolGauge parses tab-delimited usage table", () => {
  const table = [
    "Gemini Models\tWeekly Limit Remaining\t88%\t2026-10-11T19:29:21Z",
    "Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-10-11T20:38:11Z"
  ].join("\n");

  const gemini = parsePoolGauge(table, "gemini");
  assert.equal(gemini.percent, 88);
  assert.equal(gemini.reset, "2026-10-11T19:29:21Z");

  const claude = parsePoolGauge(table, "claude");
  assert.equal(claude.percent, 100);
});

test("selectGeminiModel enforces Gemini-only models and fallbacks", () => {
  // Disallows Claude/GPT model request, switching to Gemini default
  const nonGemini = selectGeminiModel("claude-sonnet-4-6");
  assert.equal(nonGemini.switched, true);
  assert.equal(nonGemini.model.startsWith("gemini-"), true);

  // Normal Gemini model when quota is fine
  const normal = selectGeminiModel("gemini-3.8-flash-medium", { gemini: { percent: 50 } });
  assert.equal(normal.switched, false);
  assert.equal(normal.model, "gemini-3.8-flash-medium");

  // Low quota triggers fallback strictly inside Gemini line
  const fallback = selectGeminiModel("gemini-3.8-flash-medium", { gemini: { percent: 1 } });
  assert.equal(fallback.switched, true);
  assert.equal(fallback.model, "gemini-3.8-flash-low");
});
