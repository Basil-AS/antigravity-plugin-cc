import test from "node:test";
import assert from "node:assert/strict";

import { createAgyStreamReader, readAgyStream } from "../plugins/antigravity/scripts/lib/agy-stream.mjs";

test("agy-stream parses full stream-json with result", () => {
  const lines = [
    JSON.stringify({ event: "init", conversation_id: "conv-1", init: { cwd: "/tmp" } }),
    JSON.stringify({ event: "step_update", step_update: { conversation_id: "conv-1", step_index: 0, state: "ACTIVE", step_type: "agent_response", text_delta: "Hello " } }),
    JSON.stringify({ event: "step_update", step_update: { conversation_id: "conv-1", step_index: 0, state: "ACTIVE", step_type: "agent_response", text_delta: "World!" } }),
    JSON.stringify({ event: "result", result: { conversation_id: "conv-1", status: "SUCCESS", response: "Hello World!", duration_seconds: 1.5 } })
  ];

  const reader = readAgyStream(lines.join("\n"));
  assert.equal(reader.looksLikeStream(), true);
  assert.equal(reader.partialText(), "Hello World!");
  assert.equal(reader.envelope()?.status, "SUCCESS");
  assert.equal(reader.state.conversationId, "conv-1");
});

test("agy-stream salvages partialText on cutoff/timeout without result envelope", () => {
  const lines = [
    JSON.stringify({ event: "init", conversation_id: "conv-2" }),
    JSON.stringify({ event: "step_update", step_update: { conversation_id: "conv-2", step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "First part... " } }),
    JSON.stringify({ event: "step_update", step_update: { conversation_id: "conv-2", step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "Second part before timeout." } })
  ];

  const reader = readAgyStream(lines.join("\n"));
  assert.equal(reader.looksLikeStream(), true);
  assert.equal(reader.envelope(), null);
  assert.equal(reader.partialText(), "First part... Second part before timeout.");
  assert.match(reader.progressLabel(), /step 1 agent_response/);
});
