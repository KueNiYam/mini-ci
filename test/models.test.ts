import test from "node:test";
import assert from "node:assert/strict";
import { branchRef, formatUuidV7, parsePostReceiveInput } from "../src/domains/ci/models.ts";

test("UUIDv7 형식으로 식별자를 만든다", () => {
  // Given:
  // When:
  // Then:
  const id = formatUuidV7(0x019ab1234567, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));

  assert.equal(id.length, 36);
  assert.equal(id[14], "7");
  assert.match(id[19], /[89ab]/);
});

test("post-receive 입력을 업데이트 목록으로 파싱한다", () => {
  // Given:
  // When:
  // Then:
  const updates = parsePostReceiveInput("old new refs/heads/main\n");

  assert.deepEqual(updates, [{ oldCommit: "old", newCommit: "new", ref: "refs/heads/main" }]);
  assert.equal(branchRef("main"), "refs/heads/main");
});
