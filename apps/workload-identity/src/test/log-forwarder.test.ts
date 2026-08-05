import assert from "node:assert/strict";
import test from "node:test";
import { parseJournalRecord } from "../log-forwarder.js";

test("journal records map to bounded structured CloudWatch events", () => {
  const parsed = parseJournalRecord(
    JSON.stringify({
      __REALTIME_TIMESTAMP: "1785945000123000",
      _SYSTEMD_USER_UNIT: "t3code.service",
      PRIORITY: "3",
      MESSAGE: "healthy"
    })
  );
  assert.deepEqual(parsed, {
    group: "t3",
    event: {
      timestamp: 1785945000123,
      message: JSON.stringify({ unit: "t3code.service", priority: "3", message: "healthy" })
    }
  });
});

test("unrelated and malformed journal records are ignored", () => {
  assert.equal(parseJournalRecord("not-json"), null);
  assert.equal(
    parseJournalRecord(JSON.stringify({ _SYSTEMD_UNIT: "sshd.service", MESSAGE: "secret" })),
    null
  );
});
