import test from "node:test";
import assert from "node:assert/strict";
import { createRunDate, formatUuidV7 } from "../src/domains/ci/models.ts";

test("UUIDv7 형식으로 식별자를 만든다", () => {
  // Given:
  // When:
  // Then:
  const id = formatUuidV7(0x019ab1234567, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));

  assert.equal(id.length, 36);
  assert.equal(id[14], "7");
  assert.match(id[19], /[89ab]/);
});

test("시간 기반 run date를 만든다", () => {
  // Given:
  // When:
  // Then:
  const runDate = createRunDate(new Date("2026-05-11T12:34:56.789Z"));

  assert.equal(runDate, "20260511T123456Z");
});
