import assert from "node:assert/strict";
import test from "node:test";

import {
  isStaleFileStateError,
  readJsonRecordsFromFileHandle,
  writeJsonRecordsToFileHandle
} from "../src/legacy/1688/json_file_store.js";

function createStaleFileStateError() {
  return new DOMException(
    "An operation that depends on state cached in an interface object was made but the state had changed since it was read from disk.",
    "InvalidStateError"
  );
}

test("detects Chrome file snapshot stale-state errors", () => {
  assert.equal(isStaleFileStateError(createStaleFileStateError()), true);
  assert.equal(isStaleFileStateError(new Error("ordinary failure")), false);
});

test("retries reading JSON records after a stale file snapshot", async () => {
  let attempts = 0;
  const handle = {
    async getFile() {
      attempts += 1;
      return {
        async text() {
          if (attempts === 1) {
            throw createStaleFileStateError();
          }
          return JSON.stringify([{ skc: "A-001" }]);
        }
      };
    }
  };

  const records = await readJsonRecordsFromFileHandle(handle);
  assert.deepEqual(records, [{ skc: "A-001" }]);
  assert.equal(attempts, 2);
});

test("retries writing JSON records after a stale writable stream", async () => {
  const writes = [];
  let attempts = 0;
  const handle = {
    async createWritable() {
      attempts += 1;
      return {
        async write(text) {
          if (attempts === 1) {
            throw createStaleFileStateError();
          }
          writes.push(text);
        },
        async close() {},
        async abort() {}
      };
    }
  };

  await writeJsonRecordsToFileHandle(handle, [{ skc: "A-001" }]);

  assert.equal(attempts, 2);
  assert.equal(writes.length, 1);
  assert.match(writes[0], /"skc": "A-001"/);
});

test("shows an actionable Chinese message if stale file state persists", async () => {
  const handle = {
    async getFile() {
      return {
        async text() {
          throw createStaleFileStateError();
        }
      };
    }
  };

  await assert.rejects(
    readJsonRecordsFromFileHandle(handle),
    /本地 JSON 文件刚被外部程序或同步工具改动/
  );
});
