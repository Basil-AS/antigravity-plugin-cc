import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  getConfig,
  listJobs,
  readJobFile,
  resolveJobFile,
  saveConfig,
  upsertJob,
  writeJobFile
} from "../plugins/antigravity/scripts/lib/state.mjs";

test("state module supports per-job isolation and atomic writes", () => {
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "state-test-"));
  try {
    saveConfig(tmpCwd, { stopReviewGate: true });
    const config = getConfig(tmpCwd);
    assert.equal(config.stopReviewGate, true);

    const job1 = {
      id: "test-job-1",
      status: "queued",
      createdAt: new Date().toISOString()
    };
    writeJobFile(tmpCwd, job1.id, job1);

    const jobFile = resolveJobFile(tmpCwd, job1.id);
    assert.equal(fs.existsSync(jobFile), true);
    const readBack = readJobFile(jobFile);
    assert.equal(readBack.id, "test-job-1");

    const jobs = listJobs(tmpCwd);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].id, "test-job-1");

    // Upsert update
    upsertJob(tmpCwd, { ...job1, status: "completed" });
    const updatedJobs = listJobs(tmpCwd);
    assert.equal(updatedJobs[0].status, "completed");
  } finally {
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  }
});
