import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

test("shared snapshot preserves the existing data-only input boundary", async () => {
  const url = new URL("../src/plain-record-snapshot.mjs", import.meta.url);
  assert.ok(existsSync(url), "shared record snapshot module must exist");
  const { snapshotPlainRecord } = await import(url);
  for (const value of [null, undefined, [], new Date(), 1, "text", Object.create({})]) {
    assert.equal(snapshotPlainRecord(value), null);
  }
  const source = Object.create(null);
  Object.defineProperty(source, "hidden", { value: 7 });
  source.visible = "before";
  const snapshot = snapshotPlainRecord(source);
  assert.equal(Object.getPrototypeOf(snapshot), null);
  assert.equal(snapshot.hidden, 7);
  source.visible = "after";
  assert.equal(snapshot.visible, "before");
  assert.equal(snapshotPlainRecord({ ordinary: 1 }).ordinary, 1);
  assert.equal(snapshotPlainRecord({ [Symbol("not-data")]: 1 }), null);
  let getterCalls = 0;
  const accessor = { get text() { getterCalls += 1; return "untrusted"; } };
  assert.equal(snapshotPlainRecord(accessor), null);
  assert.equal(getterCalls, 0);
  for (const trap of ["getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor"]) {
    const hostile = new Proxy({ x: 1 }, { [trap]() { throw new Error("trap"); } });
    assert.equal(snapshotPlainRecord(hostile), null);
  }
});
