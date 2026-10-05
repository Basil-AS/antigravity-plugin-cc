import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import {
  AgyQuotaError,
  QUOTA_EXIT_CODE,
  assessGeminiQuota,
  ensureGeminiQuota,
  formatDuration,
  getQuotaSnapshot,
  isQuotaErrorText,
  parseDuration,
  parsePoolGauge
} from "../plugins/antigravity/scripts/lib/quota.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = path.join(ROOT_DIR, "plugins", "antigravity", "scripts", "agy-companion.mjs");
const NOW = Date.parse("2026-10-05T19:00:00Z");

function usageTable({ weekly = 73, fiveHour = 9, fiveHourReset = "2026-10-05T21:16:24Z" } = {}) {
  return [
    `Gemini Models\tWeekly Limit Remaining\t${weekly}%\t2026-10-11T19:29:21Z`,
    `Gemini Models\tFive Hour Limit Remaining\t${fiveHour}%\t${fiveHourReset}`,
    "Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-10-12T18:17:20Z",
    "Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-10-05T23:17:20Z"
  ].join("\n");
}

function quotaFrom(text) {
  return { available: true, gemini: parsePoolGauge(text, "gemini"), claude: parsePoolGauge(text, "claude") };
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("parsePoolGauge reports the tightest window of a pool", () => {
  const gemini = parsePoolGauge(usageTable(), "gemini");
  assert.equal(gemini.percent, 9);
  assert.equal(gemini.window, "five-hour");
  assert.equal(gemini.reset, "2026-10-05T21:16:24Z");
  assert.deepEqual(gemini.windows.map((w) => [w.window, w.percent]), [["weekly", 73], ["five-hour", 9]]);
  assert.equal(parsePoolGauge(usageTable(), "claude").percent, 100);
});

test("assessGeminiQuota flags exhaustion at the threshold and computes wait time", () => {
  const ok = assessGeminiQuota(quotaFrom(usageTable()), { now: NOW, minPercent: 2 });
  assert.equal(ok.exhausted, false);
  const low = assessGeminiQuota(quotaFrom(usageTable({ fiveHour: 2 })), { now: NOW, minPercent: 2 });
  assert.equal(low.exhausted, true);
  assert.equal(low.waitMs, Date.parse("2026-10-05T21:16:24Z") - NOW);
  const unknown = assessGeminiQuota({ available: false }, { now: NOW });
  assert.equal(unknown.known, false);
  assert.equal(unknown.exhausted, false);
});

test("duration helpers", () => {
  assert.equal(parseDuration("15m"), 900_000);
  assert.equal(parseDuration("90s"), 90_000);
  assert.equal(parseDuration("1h"), 3_600_000);
  assert.equal(parseDuration("20"), 1_200_000);
  assert.throws(() => parseDuration("soon"), /Invalid duration/);
  assert.equal(formatDuration(6_000_000), "1h 40m");
  assert.equal(formatDuration(30_000), "1m");
  assert.equal(formatDuration(0), "now");
});

test("isQuotaErrorText matches quota failures but not mere mentions of quota", () => {
  assert.equal(isQuotaErrorText("Error 429: RESOURCE_EXHAUSTED"), true);
  assert.equal(isQuotaErrorText("You have exceeded your current quota"), true);
  assert.equal(isQuotaErrorText("rate limit exceeded, retry later"), true);
  assert.equal(isQuotaErrorText("Updated lib/quota.mjs to parse the quota table"), false);
});

test("getQuotaSnapshot caches successful probes", () => {
  const dir = tempDir("agy-quota-cache-");
  const cacheFile = path.join(dir, "quota-cache.json");
  let calls = 0;
  const probe = () => { calls += 1; return quotaFrom(usageTable()); };
  try {
    getQuotaSnapshot({ cacheFile, probe, now: NOW });
    getQuotaSnapshot({ cacheFile, probe, now: NOW + 30_000 });
    assert.equal(calls, 1);
    getQuotaSnapshot({ cacheFile, probe, now: NOW + 120_000 });
    assert.equal(calls, 2);
    getQuotaSnapshot({ cacheFile, probe, now: NOW + 121_000, fresh: true });
    assert.equal(calls, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureGeminiQuota fails fast without a wait budget", async () => {
  const dir = tempDir("agy-quota-ensure-");
  try {
    await assert.rejects(
      ensureGeminiQuota({
        cacheFile: path.join(dir, "c.json"),
        probe: () => quotaFrom(usageTable({ fiveHour: 1 })),
        clock: () => NOW,
        minPercent: 2
      }),
      (error) => error instanceof AgyQuotaError && error.window === "five-hour" && /Resets at 2026-10-05T21:16:24Z/.test(error.message)
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureGeminiQuota waits for a reset inside the budget, then proceeds", async () => {
  const dir = tempDir("agy-quota-wait-");
  let now = NOW;
  const reset = new Date(NOW + 5 * 60_000).toISOString();
  const slept = [];
  let probes = 0;
  try {
    const result = await ensureGeminiQuota({
      cacheFile: path.join(dir, "c.json"),
      probe: () => (++probes === 1 ? quotaFrom(usageTable({ fiveHour: 0, fiveHourReset: reset })) : quotaFrom(usageTable({ fiveHour: 100 }))),
      clock: () => now,
      sleep: async (ms) => { slept.push(ms); now += ms; },
      maxWaitMs: 15 * 60_000,
      minPercent: 2
    });
    assert.equal(result.exhausted, false);
    assert.equal(slept.length, 1);
    assert.equal(slept[0], 5 * 60_000 + 15_000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureGeminiQuota does not wait when the reset is beyond the budget", async () => {
  const dir = tempDir("agy-quota-nowait-");
  try {
    await assert.rejects(
      ensureGeminiQuota({
        cacheFile: path.join(dir, "c.json"),
        probe: () => quotaFrom(usageTable({ fiveHour: 0 })),
        clock: () => NOW,
        sleep: async () => assert.fail("must not sleep"),
        maxWaitMs: 10 * 60_000,
        minPercent: 2
      }),
      AgyQuotaError
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// End-to-end through the companion with a fake `agy` on PATH (no Gemini calls).
function withFakeAgy({ usage, turnStderr = "", turnExit = 0 }, fn) {
  const dir = tempDir("agy-fake-");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(dir, "usage.txt"), usage);
  const script = [
    "#!/bin/sh",
    `if [ "$1" = "-p" ] && [ "$2" = "/usage" ]; then cat "${path.join(dir, "usage.txt")}"; exit 0; fi`,
    "cat >/dev/null",
    turnStderr ? `echo "${turnStderr}" >&2` : "",
    `exit ${turnExit}`
  ].join("\n");
  fs.writeFileSync(path.join(bin, "agy"), script, { mode: 0o755 });
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agy-fake-ws-"));
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    CLAUDE_PLUGIN_DATA: path.join(dir, "data"),
    AGY_QUOTA_MIN_PERCENT: "2"
  };
  delete env.AGY_COMPANION_SESSION_ID;
  try {
    return fn({ env, workspace });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

test("companion task refuses an exhausted pool with exit 75 and JSON details", {
  skip: process.platform === "win32" ? "POSIX shell fake agy" : false
}, () => {
  withFakeAgy({ usage: usageTable({ fiveHour: 1 }) }, ({ env, workspace }) => {
    const run = spawnSync(process.execPath, [SCRIPT, "task", "--json", "--cwd", workspace, "hello"], {
      encoding: "utf8", cwd: workspace, env
    });
    assert.equal(run.status, QUOTA_EXIT_CODE);
    const data = JSON.parse(run.stdout);
    assert.equal(data.code, "AGY_QUOTA_EXHAUSTED");
    assert.equal(data.quotaExhausted, true);
    assert.equal(data.window, "five-hour");
    assert.equal(data.resetAt, "2026-10-05T21:16:24Z");
  });
});

test("companion task maps agy's own quota failure to a quota error", {
  skip: process.platform === "win32" ? "POSIX shell fake agy" : false
}, () => {
  withFakeAgy({ usage: usageTable({ fiveHour: 50 }), turnStderr: "Error 429 RESOURCE_EXHAUSTED", turnExit: 1 }, ({ env, workspace }) => {
    const run = spawnSync(process.execPath, [SCRIPT, "task", "--cwd", workspace, "hello"], {
      encoding: "utf8", cwd: workspace, env
    });
    assert.equal(run.status, QUOTA_EXIT_CODE);
    assert.match(run.stderr, /Antigravity Gemini quota exhausted/);
    assert.match(run.stderr, /agy said: .*RESOURCE_EXHAUSTED/);
  });
});

test("companion task --dry-run shows the tightest Gemini window", {
  skip: process.platform === "win32" ? "POSIX shell fake agy" : false
}, () => {
  withFakeAgy({ usage: usageTable({ fiveHour: 9 }) }, ({ env, workspace }) => {
    const run = spawnSync(process.execPath, [SCRIPT, "task", "--dry-run", "--cwd", workspace, "hello"], {
      encoding: "utf8", cwd: workspace, env
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Gemini Quota: 9% \(five-hour limit/);
  });
});
