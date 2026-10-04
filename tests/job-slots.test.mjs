import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { tryAcquireJobSlot } from "../plugins/antigravity/scripts/lib/job-slots.mjs";

test("tryAcquireJobSlot enforces slot limit and releases properly", () => {
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "slot-test-"));
  try {
    const slot1 = tryAcquireJobSlot(tmpCwd, { maxSlots: 1, pid: process.pid });
    assert.equal(slot1.acquired, true);
    assert.equal(slot1.slotIndex, 0);

    // Second acquisition should fail because slot limit is 1
    const slot2 = tryAcquireJobSlot(tmpCwd, { maxSlots: 1, pid: process.pid });
    assert.equal(slot2.acquired, false);

    // Release slot 1
    slot1.release();

    // Now slot should be acquireable again
    const slot3 = tryAcquireJobSlot(tmpCwd, { maxSlots: 1, pid: process.pid });
    assert.equal(slot3.acquired, true);
    slot3.release();
  } finally {
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  }
});
