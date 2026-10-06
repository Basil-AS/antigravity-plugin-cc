#!/usr/bin/env node
// Release guardrails. Claude Code resolves an installed plugin's version from
// plugins/antigravity/.claude-plugin/plugin.json first; clients only pick up a
// new release (and refresh ~/.claude/plugins/cache/<mkt>/agy/<version>) when
// that string changes. So: every manifest must agree, a tag must match it, and
// any change to the shipped plugin must bump it.
//
//   node tools/release-check.mjs                 versions in sync
//   node tools/release-check.mjs --tag v1.2.3    ...and equal to the tag
//   node tools/release-check.mjs --base origin/main
//                                                ...and bumped if plugins/ changed
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MANIFESTS = {
  plugin: "plugins/antigravity/.claude-plugin/plugin.json",
  marketplace: ".claude-plugin/marketplace.json",
  package: "package.json"
};
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function readVersions(read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8")) {
  const plugin = JSON.parse(read(MANIFESTS.plugin));
  const market = JSON.parse(read(MANIFESTS.marketplace));
  const pkg = JSON.parse(read(MANIFESTS.package));
  const entry = (market.plugins ?? []).find((p) => p.name === plugin.name);
  return {
    "plugin.json": plugin.version,
    "marketplace.json metadata": market.metadata?.version,
    [`marketplace.json plugins[${plugin.name}]`]: entry?.version,
    "package.json": pkg.version
  };
}

export function compareSemver(a, b) {
  const pa = SEMVER.exec(a)?.slice(1).map(Number);
  const pb = SEMVER.exec(b)?.slice(1).map(Number);
  if (!pa || !pb) return NaN;
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

export function checkRelease({ versions, tag = null, base = null }) {
  const errors = [];
  const values = Object.values(versions);
  const version = versions["plugin.json"];
  if (!SEMVER.test(version ?? "")) errors.push(`plugin.json version "${version}" is not MAJOR.MINOR.PATCH`);
  for (const [where, value] of Object.entries(versions)) {
    if (value !== version) errors.push(`${where} is "${value}", expected "${version}" (plugin.json)`);
  }
  if (tag && tag.replace(/^v/, "") !== version) {
    errors.push(`tag ${tag} does not match plugin.json version ${version}`);
  }
  if (base && base.pluginChanged) {
    if (base.version === version) {
      errors.push(
        `plugins/ changed since ${base.ref} but plugin.json is still ${version}; bump it (feat → minor, fix → patch) ` +
          "or installed clients will keep the cached copy"
      );
    } else if (!(compareSemver(version, base.version) > 0)) {
      errors.push(`version ${version} must be greater than ${base.ref}'s ${base.version}`);
    }
  }
  return { ok: errors.length === 0 && values.length > 0, version, errors };
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function main(argv) {
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : null;
  };
  const tag = opt("--tag");
  const baseRef = opt("--base");
  let base = null;
  if (baseRef) {
    const changed = git(["diff", "--name-only", `${baseRef}...HEAD`, "--", "plugins/"]);
    const baseVersion = JSON.parse(git(["show", `${baseRef}:${MANIFESTS.plugin}`])).version;
    base = { ref: baseRef, version: baseVersion, pluginChanged: changed.length > 0 };
  }
  const result = checkRelease({ versions: readVersions(), tag, base });
  if (!result.ok) {
    for (const e of result.errors) console.error(`✖ ${e}`);
    process.exit(1);
  }
  console.log(`✔ release check passed: ${result.version}${tag ? ` (tag ${tag})` : ""}${base ? ` (vs ${base.ref} ${base.version}${base.pluginChanged ? ", plugin changed" : ""})` : ""}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
