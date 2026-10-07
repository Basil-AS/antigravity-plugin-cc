import fs from "node:fs";

// Post-processing of agy's free-text report before it reaches the caller.

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// agy runs inside a throw-away worktree (e.g. %TEMP%\agy-task-x\repo), so its
// file links point at a copy that is deleted after the job. Map every spelling
// of that path (native, forward slashes, file:/// URI, any drive-letter case)
// back to the real workspace.
export function rewriteIsolationPaths(text, isolation, workspaceRoot) {
  if (!text || !isolation || isolation.mode !== "worktree" || !isolation.workPath) return text;
  const segments = isolation.workPath.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) return text;
  const leading = /^[\\/]/.test(isolation.workPath) ? "[\\\\/]" : "";
  const body = segments.map(escapeRegExp).join("[\\\\/]+");
  // Do not swallow a longer sibling name (…/repo vs …/repo-old).
  const pattern = new RegExp(`(file:\\/\\/\\/?)?${leading}${body}(?![^\\\\/\\s)\\]"'\`>:,;.])`, "gi");
  const forward = workspaceRoot.replace(/\\/g, "/");
  return text.replace(pattern, (match, uri) => {
    if (uri) return `file://${forward.startsWith("/") ? "" : "/"}${forward}`;
    return match.includes("\\") ? workspaceRoot : forward;
  });
}

const CAVEAT_HEADING = /^(#{1,6})\s*(?:⚠\s*)?(unverified|not verified|caveats?|limitations|assumptions|непровер|не провер|оговорк)/i;
const CAVEAT_LINE =
  /\b(did ?n[o']t|have ?n[o']t|has ?n[o']t|could ?n[o']t|was not|were not|not)\s+(verif|check|confirm|cross-?check|validat)|\bunverified\b|\bHYPOTHESIS\b|\bnot determined\b|\bassum(?:e|ed|ing|ption)\b|не\s+(свер|провер|подтвер)|без\s+(провер|свер)|построчно\s+не|гипотез/i;
const NONE_BODY = /^(none|nothing|n\/a|нет|ничего)[.!]?$/i;

// Pull the model's own caveats (an "Unverified" section, or sentences that
// admit a claim was not checked) so they can be shown up front instead of
// buried at the end of a long report.
export function extractCaveats(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const found = [];
  let sectionLevel = null;
  let inFence = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = line.match(/^(#{1,6})\s/);
    if (heading) {
      const caveat = line.match(CAVEAT_HEADING);
      if (caveat) {
        sectionLevel = caveat[1].length;
        continue;
      }
      if (sectionLevel !== null && heading[1].length <= sectionLevel) sectionLevel = null;
    }
    if (!line) continue;
    const item = line.replace(/^([-*+]|\d+[.)])\s+/, "");
    if (sectionLevel !== null) {
      if (!NONE_BODY.test(item)) found.push(item);
    } else if (CAVEAT_LINE.test(line)) {
      found.push(item);
    }
  }
  return [...new Set(found)].slice(0, 20);
}

export function renderCaveats(caveats) {
  if (!caveats || caveats.length === 0) return "";
  return [
    "## ⚠ Unverified by Antigravity — check before relying on these",
    "",
    ...caveats.map((c) => `- ${c}`)
  ].join("\n");
}

// If finalising a finished turn throws (patch capture, verification,
// rendering), keep the raw answer on disk and in the output, say loudly that
// post-processing failed, and fail the job so it is never mistaken for clean.
export function salvageTaskResult({ responseFile, result, error }) {
  const message = error instanceof Error ? error.message : String(error);
  const raw = String(result.response ?? "");
  let saved = true;
  try {
    fs.writeFileSync(responseFile, raw, "utf8");
  } catch {
    saved = false;
  }
  const rendered = [
    "## ⚠ Post-processing failed",
    "",
    `Antigravity finished, but the plugin failed while finalising the result: ${message}`,
    saved
      ? `Raw answer saved to \`${responseFile}\`. Any isolated worktree was left in place; inspect it before discarding.`
      : "The raw answer could not be saved to disk; it is reproduced below.",
    "",
    raw.trimEnd(),
    ""
  ].join("\n");
  return {
    exitStatus: 1,
    conversationId: result.conversation_id,
    payload: { ...result, postProcessingError: message, responseFile: saved ? responseFile : null },
    rendered,
    summary: `[post-processing failed] ${raw.slice(0, 120).replace(/\r?\n/g, " ")}`
  };
}
