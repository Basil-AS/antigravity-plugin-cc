import test from "node:test";
import assert from "node:assert/strict";

import { checkRelease, compareSemver, readVersions } from "../tools/release-check.mjs";
import { nextVersion } from "../tools/bump-version.mjs";

const synced = (v) => ({
  "plugin.json": v,
  "marketplace.json metadata": v,
  "marketplace.json plugins[agy]": v,
  "package.json": v
});

test("repository manifests are in sync", () => {
  const result = checkRelease({ versions: readVersions() });
  assert.equal(result.ok, true, result.errors.join("; "));
});

test("out-of-sync manifests are reported by location", () => {
  const result = checkRelease({ versions: { ...synced("1.2.1"), "package.json": "1.2.0" } });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /package\.json is "1\.2\.0", expected "1\.2\.1"/);
});

test("tag must equal the plugin version", () => {
  assert.equal(checkRelease({ versions: synced("1.2.1"), tag: "v1.2.1" }).ok, true);
  assert.equal(checkRelease({ versions: synced("1.2.1"), tag: "v1.2.2" }).ok, false);
});

test("a plugin change without a version bump fails; a bump or no change passes", () => {
  const base = { ref: "origin/main", version: "1.2.1", pluginChanged: true };
  assert.match(checkRelease({ versions: synced("1.2.1"), base }).errors[0], /bump it/);
  assert.equal(checkRelease({ versions: synced("1.2.2"), base }).ok, true);
  assert.equal(checkRelease({ versions: synced("1.2.1"), base: { ...base, pluginChanged: false } }).ok, true);
  assert.match(checkRelease({ versions: synced("1.1.9"), base }).errors[0], /must be greater/);
});

test("version helpers", () => {
  assert.ok(compareSemver("1.10.0", "1.9.9") > 0);
  assert.equal(nextVersion("1.2.1", "patch"), "1.2.2");
  assert.equal(nextVersion("1.2.1", "minor"), "1.3.0");
  assert.equal(nextVersion("1.2.1", "major"), "2.0.0");
  assert.equal(nextVersion("1.2.1", "3.0.0"), "3.0.0");
  assert.throws(() => nextVersion("1.2.1", "huge"), /Unknown bump/);
});
