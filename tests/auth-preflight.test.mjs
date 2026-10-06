import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import {
  AUTH_EXIT_CODE,
  AgyAuthError,
  assertAgyAuthenticated,
  isAuthRequiredText
} from "../plugins/antigravity/scripts/lib/agy.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = path.join(ROOT_DIR, "plugins", "antigravity", "scripts", "agy-companion.mjs");
const POSIX_ONLY = process.platform === "win32" ? "POSIX shell fake agy" : false;

const USAGE = "Gemini Models\tFive Hour Limit Remaining\t90%\t2026-10-05T21:16:24Z\n";

// Fake agy that records every invocation; `turn` controls the non-/usage call.
// loggedIn: true (agy 1.2 token file), "keyring" (agy 1.3: no file, `agy models`
// works) or false (`agy models` asks to sign in).
function withFakeAgy({ loggedIn, turnStderr = "", turnExit = 0 }, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-auth-"));
  const bin = path.join(dir, "bin");
  const home = path.join(dir, "home");
  const calls = path.join(dir, "calls.log");
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(home, ".gemini", "antigravity-cli"), { recursive: true });
  if (loggedIn === true) {
    fs.writeFileSync(
      path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
      JSON.stringify({ token: { access_token: "fake" } })
    );
  }
  fs.writeFileSync(path.join(dir, "usage.txt"), USAGE);
  fs.writeFileSync(
    path.join(bin, "agy"),
    [
      "#!/bin/sh",
      `echo "$*" >> "${calls}"`,
      `if [ "$1" = "-p" ] && [ "$2" = "/usage" ]; then cat "${path.join(dir, "usage.txt")}"; exit 0; fi`,
      loggedIn
        ? `if [ "$1" = "models" ]; then echo "Fetching available models..."; echo "gemini-3.8-flash-low"; exit 0; fi`
        : `if [ "$1" = "models" ]; then echo "Fetching available models..."; echo "Error: Please sign in to view available models. Launch the CLI without arguments to sign in."; exit 0; fi`,
      "cat >/dev/null",
      turnStderr ? `echo "${turnStderr}" >&2` : "",
      `exit ${turnExit}`
    ].join("\n"),
    { mode: 0o755 }
  );
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agy-auth-ws-"));
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    CLAUDE_PLUGIN_DATA: path.join(dir, "data")
  };
  delete env.AGY_COMPANION_SESSION_ID;
  delete env.AGY_SKIP_AUTH_CHECK;
  try {
    return fn({ env, workspace, invocations: () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n") : []) });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

test("isAuthRequiredText recognises agy's login prompt only", () => {
  assert.equal(isAuthRequiredText("Authentication required. Please visit the URL to log in:"), true);
  assert.equal(isAuthRequiredText("Waiting for authentication (timeout 60s)..."), true);
  assert.equal(isAuthRequiredText("Refactored the authentication middleware"), false);
});

test("assertAgyAuthenticated throws AgyAuthError unless logged in or bypassed", () => {
  assert.throws(() => assertAgyAuthenticated({ authenticated: false }, {}), AgyAuthError);
  assert.doesNotThrow(() => assertAgyAuthenticated({ authenticated: true }, {}));
  assert.doesNotThrow(() => assertAgyAuthenticated({ authenticated: null }, {}), "an inconclusive check must not block");
  assert.doesNotThrow(() => assertAgyAuthenticated({ authenticated: false }, { AGY_SKIP_AUTH_CHECK: "1" }));
  assert.deepEqual(Object.keys(new AgyAuthError().toJSON()).sort(), ["authRequired", "code", "error"]);
});

test("task fails fast with exit 77 and only asks `agy models` when not logged in", { skip: POSIX_ONLY }, () => {
  withFakeAgy({ loggedIn: false }, ({ env, workspace, invocations }) => {
    const started = Date.now();
    const run = spawnSync(process.execPath, [SCRIPT, "task", "--cwd", workspace, "hello"], { encoding: "utf8", cwd: workspace, env });
    assert.equal(run.status, AUTH_EXIT_CODE);
    assert.match(run.stderr, /not logged in to Google/);
    assert.match(run.stderr, /--skip-auth-check/);
    assert.ok(Date.now() - started < 10_000);
    assert.ok(invocations().every((line) => line === "models"), invocations().join("|"));
  });
});

test("agy 1.3 without a token file is accepted when `agy models` works", { skip: POSIX_ONLY }, () => {
  withFakeAgy({ loggedIn: "keyring" }, ({ env, workspace, invocations }) => {
    const run = spawnSync(process.execPath, [SCRIPT, "task", "--cwd", workspace, "hello"], { encoding: "utf8", cwd: workspace, env });
    assert.notEqual(run.status, AUTH_EXIT_CODE, run.stderr);
    assert.ok(invocations().some((line) => line.startsWith("--disable-slash-commands")), "the turn ran");
    const setup = JSON.parse(spawnSync(process.execPath, [SCRIPT, "setup", "--json"], { encoding: "utf8", cwd: workspace, env }).stdout);
    assert.equal(setup.ready, true);
    assert.equal(setup.auth.authenticated, true);
  });
});

test("setup --skip-auth-check persists the bypass for later runs (subagents)", { skip: POSIX_ONLY }, () => {
  withFakeAgy({ loggedIn: false }, ({ env, workspace }) => {
    const setup = spawnSync(process.execPath, [SCRIPT, "setup", "--skip-auth-check"], { encoding: "utf8", cwd: workspace, env });
    assert.equal(setup.status, 0, setup.stderr);
    assert.match(setup.stdout, /Token files checked/);
    assert.match(setup.stdout, /Check skipped:\*\* yes/);
    const run = spawnSync(process.execPath, [SCRIPT, "task", "--cwd", workspace, "hello"], { encoding: "utf8", cwd: workspace, env });
    assert.notEqual(run.status, AUTH_EXIT_CODE, run.stderr);
    spawnSync(process.execPath, [SCRIPT, "setup", "--enforce-auth-check"], { encoding: "utf8", cwd: workspace, env });
    const again = spawnSync(process.execPath, [SCRIPT, "task", "--cwd", workspace, "hello"], { encoding: "utf8", cwd: workspace, env });
    assert.equal(again.status, AUTH_EXIT_CODE);
  });
});

test("task --json reports authRequired", { skip: POSIX_ONLY }, () => {
  withFakeAgy({ loggedIn: false }, ({ env, workspace }) => {
    const run = spawnSync(process.execPath, [SCRIPT, "task", "--json", "--cwd", workspace, "hello"], { encoding: "utf8", cwd: workspace, env });
    assert.equal(run.status, AUTH_EXIT_CODE);
    const data = JSON.parse(run.stdout);
    assert.equal(data.authRequired, true);
    assert.equal(data.code, "AGY_NOT_AUTHENTICATED");
  });
});

test("an agy login prompt during the turn becomes the auth error", { skip: POSIX_ONLY }, () => {
  withFakeAgy(
    { loggedIn: true, turnStderr: "Authentication required. Please visit the URL to log in:", turnExit: 1 },
    ({ env, workspace }) => {
      const run = spawnSync(process.execPath, [SCRIPT, "task", "--cwd", workspace, "hello"], { encoding: "utf8", cwd: workspace, env });
      assert.equal(run.status, AUTH_EXIT_CODE);
      assert.match(run.stderr, /not logged in to Google/);
    }
  );
});

test("setup skips the /usage probe when not logged in", { skip: POSIX_ONLY }, () => {
  withFakeAgy({ loggedIn: false }, ({ env, workspace, invocations }) => {
    const run = spawnSync(process.execPath, [SCRIPT, "setup", "--json"], { encoding: "utf8", cwd: workspace, env });
    assert.equal(run.status, 0, run.stderr);
    const data = JSON.parse(run.stdout);
    assert.equal(data.ready, false);
    assert.equal(data.quota, null);
    assert.ok(!invocations().some((line) => line.includes("/usage")));
  });
});
