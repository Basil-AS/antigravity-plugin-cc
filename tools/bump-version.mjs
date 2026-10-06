#!/usr/bin/env node
// Set the plugin version in every manifest at once:
//   node tools/bump-version.mjs patch|minor|major|X.Y.Z
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { MANIFESTS, readVersions } from "./release-check.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function nextVersion(current, spec) {
  if (/^\d+\.\d+\.\d+$/.test(spec)) return spec;
  const [major, minor, patch] = current.split(".").map(Number);
  if (spec === "major") return `${major + 1}.0.0`;
  if (spec === "minor") return `${major}.${minor + 1}.0`;
  if (spec === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`Unknown bump "${spec}". Use patch, minor, major or X.Y.Z.`);
}

function rewrite(rel, mutate) {
  const file = path.join(ROOT, rel);
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  mutate(data);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const spec = process.argv[2];
  if (!spec) {
    console.error("Usage: node tools/bump-version.mjs patch|minor|major|X.Y.Z");
    process.exit(2);
  }
  const current = readVersions()["plugin.json"];
  const next = nextVersion(current, spec);
  rewrite(MANIFESTS.plugin, (d) => { d.version = next; });
  rewrite(MANIFESTS.package, (d) => { d.version = next; });
  rewrite(MANIFESTS.marketplace, (d) => {
    if (d.metadata) d.metadata.version = next;
    for (const p of d.plugins ?? []) p.version = next;
  });
  console.log(`${current} → ${next}`);
}
