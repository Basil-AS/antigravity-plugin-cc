function formatLineRange(finding) {
  if (!finding.line_start) return "";
  if (!finding.line_end || finding.line_end === finding.line_start) {
    return `:${finding.line_start}`;
  }
  return `:${finding.line_start}-${finding.line_end}`;
}

export function normalizeReviewFinding(finding, index) {
  const source = finding && typeof finding === "object" && !Array.isArray(finding) ? finding : {};
  const lineStart = Number.isInteger(source.line_start) && source.line_start > 0 ? source.line_start : null;
  const lineEnd =
    Number.isInteger(source.line_end) && source.line_end > 0 && (!lineStart || source.line_end >= lineStart)
      ? source.line_end
      : lineStart;

  return {
    severity: typeof source.severity === "string" && source.severity.trim() ? source.severity.trim() : "low",
    title: typeof source.title === "string" && source.title.trim() ? source.title.trim() : `Finding ${index + 1}`,
    body: typeof source.body === "string" && source.body.trim() ? source.body.trim() : "No details provided.",
    file: typeof source.file === "string" && source.file.trim() ? source.file.trim() : "unknown",
    line_start: lineStart,
    line_end: lineEnd,
    recommendation: typeof source.recommendation === "string" ? source.recommendation.trim() : ""
  };
}

export function normalizeReviewResultData(data) {
  return {
    verdict: String(data.verdict || "approve").trim(),
    summary: String(data.summary || "").trim(),
    findings: Array.isArray(data.findings)
      ? data.findings.map((f, i) => normalizeReviewFinding(f, i))
      : [],
    next_steps: Array.isArray(data.next_steps)
      ? data.next_steps.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim())
      : []
  };
}

function escapeMarkdownCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

export function renderSetupReport(setupData) {
  const lines = [
    "# Antigravity CLI Setup",
    "",
    `**Overall Ready:** ${setupData.ready ? "READY" : "NOT READY"}`,
    "",
    "## Components",
    `- **Node.js:** ${setupData.node.version} (${setupData.node.available ? "OK" : "FAILED"})`,
    `- **Git:** ${setupData.git.version} (${setupData.git.available ? "OK" : "FAILED"})`,
    `- **Antigravity CLI (agy):** ${setupData.agy.version || "not found"} (${setupData.agy.available ? "OK" : "FAILED"})`,
    `- **Google Authentication:** ${setupData.auth.authenticated ? `Authenticated (${setupData.auth.authMethod})` : "NOT AUTHENTICATED"}`
  ];

  if (setupData.quota && setupData.quota.available) {
    lines.push("", "## Quota Pools");
    for (const [label, pool] of [["Gemini Pool", setupData.quota.gemini], ["Claude/GPT Pool", setupData.quota.claude]]) {
      if (!pool || pool.percent === null) continue;
      const windows = (pool.windows ?? []).length > 0 ? pool.windows : [{ window: pool.window || "limit", percent: pool.percent, reset: pool.reset }];
      const detail = windows
        .map((w) => `${w.window} ${w.percent}%${w.reset ? ` (resets ${w.reset})` : ""}`)
        .join(", ");
      lines.push(`- **${label}:** ${pool.percent}% usable — ${detail}`);
    }
  }

  if (!setupData.auth.authenticated) {
    lines.push(
      "",
      "> [!IMPORTANT]",
      "> You need to authenticate with Google. Run `agy` interactively in your terminal to complete login."
    );
  }

  return `${lines.join("\n")}\n`;
}

export function renderQueuedTaskLaunch(payload) {
  const lines = [
    `# Queued Antigravity Task: \`${payload.jobId}\``,
    "",
    `- **Status:** \`${payload.status}\``,
    `- **Title:** ${payload.title || "Task"}`,
    `- **Log File:** \`${payload.logFile}\``,
    "",
    "Check progress anytime with `/agy:status` or get output with `/agy:result`."
  ];
  return `${lines.join("\n")}\n`;
}

export function renderJobStatusReport(job) {
  const lines = [
    `# Antigravity Job: \`${job.id}\``,
    "",
    `- **Type:** ${job.kindLabel || job.jobClass || "job"}`,
    `- **Status:** \`${job.status}\``,
    `- **Phase:** \`${job.phase || "unknown"}\``,
    `- **Elapsed:** ${job.elapsed || job.duration || "n/a"}`,
    `- **Log:** \`${job.logFile || "n/a"}\``
  ];

  if (job.progressPreview && job.progressPreview.length > 0) {
    lines.push("", "## Recent Progress", "```", ...job.progressPreview, "```");
  }

  return `${lines.join("\n")}\n`;
}

export function renderStatusPayload(report) {
  const lines = [
    "# Antigravity Status",
    "",
    `**Workspace:** \`${report.workspaceRoot}\``,
    ""
  ];

  if (report.running.length > 0) {
    lines.push(
      "## Active Jobs",
      "",
      "| ID | Type | Phase | Elapsed | Log |",
      "| --- | --- | --- | --- | --- |"
    );
    for (const job of report.running) {
      lines.push(
        `| \`${job.id}\` | ${escapeMarkdownCell(job.kindLabel)} | \`${escapeMarkdownCell(job.phase)}\` | ${escapeMarkdownCell(job.elapsed)} | \`${escapeMarkdownCell(job.logFile)}\` |`
      );
    }
    lines.push("");
  } else {
    lines.push("No active Antigravity jobs running.", "");
  }

  if (report.latestFinished) {
    const job = report.latestFinished;
    lines.push(
      "## Latest Finished Job",
      "",
      `- **ID:** \`${job.id}\` (${job.status})`,
      `- **Type:** ${job.kindLabel}`,
      `- **Duration:** ${job.duration || "n/a"}`,
      `- **Summary:** ${job.summary || "No summary provided"}`,
      ""
    );
  }

  if (report.recent.length > 0) {
    lines.push(
      "## Recent Jobs",
      "",
      "| ID | Type | Status | Duration | Summary |",
      "| --- | --- | --- | --- | --- |"
    );
    for (const job of report.recent) {
      lines.push(
        `| \`${job.id}\` | ${escapeMarkdownCell(job.kindLabel)} | \`${escapeMarkdownCell(job.status)}\` | ${escapeMarkdownCell(job.duration)} | ${escapeMarkdownCell(job.summary)} |`
      );
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

export function renderReviewResult(parsed, options = {}) {
  const data = parsed.data || {};
  const verdict = data.verdict || "approve";
  const isApproved = verdict === "approve";

  const lines = [
    `# Antigravity Code Review: ${isApproved ? "APPROVED" : "NEEDS ATTENTION"}`,
    "",
    `**Target:** ${options.targetLabel || "Code Diff"}`,
    `**Summary:** ${data.summary || "Review completed."}`,
    ""
  ];

  if (data.findings && data.findings.length > 0) {
    lines.push("## Findings", "");
    for (const f of data.findings) {
      const loc = f.file ? `\`${f.file}${formatLineRange(f)}\`` : "";
      lines.push(
        `### [${f.severity.toUpperCase()}] ${f.title}`,
        loc ? `- **Location:** ${loc}` : "",
        f.body,
        f.recommendation ? `> **Recommendation:** ${f.recommendation}` : "",
        ""
      );
    }
  } else if (isApproved) {
    lines.push("No blocking issues or defects found.", "");
  } else {
    lines.push("Review flagged attention, but no structured findings were itemized.", "");
  }

  if (data.next_steps && data.next_steps.length > 0) {
    lines.push("## Next Steps", "");
    for (const step of data.next_steps) {
      lines.push(`- ${step}`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}
