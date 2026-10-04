const AGENT_RESPONSE_STEP = "agent_response";

export function createAgyStreamReader() {
  const state = {
    conversationId: null,
    text: "",
    envelope: null,
    steps: [],
    lastStep: null,
    events: 0,
    eventfulLines: 0,
    unparsedLines: 0,
    unknownEvents: new Map()
  };

  function noteConversationId(candidate) {
    if (typeof candidate === "string" && candidate && !state.conversationId) {
      state.conversationId = candidate;
    }
  }

  function accept(line) {
    const text = String(line ?? "").trim();
    if (!text) return;

    let event;
    try {
      event = JSON.parse(text);
    } catch {
      state.unparsedLines += 1;
      return;
    }
    if (!event || typeof event !== "object") {
      state.unparsedLines += 1;
      return;
    }

    state.events += 1;
    const name = typeof event.event === "string" ? event.event : null;
    if (name) state.eventfulLines += 1;
    noteConversationId(event.conversation_id);

    if (name === "init") {
      return;
    }

    if (name === "step_update") {
      const step = event.step_update;
      if (!step || typeof step !== "object") return;
      noteConversationId(step.conversation_id);

      const record = {
        index: typeof step.step_index === "number" ? step.step_index : null,
        type: typeof step.step_type === "string" ? step.step_type : "unknown",
        state: typeof step.state === "string" ? step.state : null
      };
      state.steps.push(record);
      state.lastStep = record;

      if (record.type === AGENT_RESPONSE_STEP && typeof step.text_delta === "string") {
        state.text += step.text_delta;
      }
      return;
    }

    if (name === "result") {
      const result = event.result;
      if (result && typeof result === "object") {
        state.envelope = result;
        noteConversationId(result.conversation_id);
        if (result.response && !state.text) {
          state.text = result.response;
        }
      }
      return;
    }

    if (name === "command_result") {
      return;
    }

    if (name) {
      state.unknownEvents.set(name, (state.unknownEvents.get(name) ?? 0) + 1);
    }
  }

  return {
    accept,
    get state() {
      return state;
    },
    looksLikeStream() {
      return state.eventfulLines > 0;
    },
    partialText() {
      return state.text;
    },
    envelope() {
      return state.envelope;
    },
    progressLabel() {
      if (!state.lastStep) return state.events > 0 ? "started, no step reported" : "no output received";
      const { index, type, state: stepState } = state.lastStep;
      const position = index === null ? "" : `step ${index} `;
      return `${position}${type}${stepState ? ` (${stepState})` : ""}`;
    }
  };
}

export function readAgyStream(rawStdout) {
  const reader = createAgyStreamReader();
  for (const line of String(rawStdout ?? "").split(/\r?\n/)) {
    reader.accept(line);
  }
  return reader;
}
