import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setImmediate as yieldTurn } from "node:timers/promises";
import test from "node:test";
import { readWeb2DanceBindPrepareResponse } from "../deploy/linux/web2-dance-bind-prepare.ts";
import { canonical } from "../packages/community/common.ts";
import { maxWeb2DanceBindPrepareBytes } from "../packages/community/web2-dance-bind-intent.ts";

const cap = maxWeb2DanceBindPrepareBytes;
const prefix = Buffer.from(canonical({ value: "x".repeat(cap - Buffer.byteLength(canonical({ value: "" }))) }));
assert.equal(prefix.length, cap);

test("private Prepare accepts an exact-cap canonical response across chunks", async () => {
  const reply = new PassThrough();
  const bytes = readWeb2DanceBindPrepareResponse(reply, () => {
    throw Error("exact_cap_cancelled");
  });
  const midpoint = Math.floor(cap / 2);
  reply.write(prefix.subarray(0, midpoint));
  reply.end(prefix.subarray(midpoint));
  const result = await bytes;
  assert.deepEqual(result, prefix);
  assert.equal(canonical(JSON.parse(result.toString("utf8"))), prefix.toString("utf8"));
});

test("private Prepare refuses a canonical prefix plus overflow when EOF precedes request error", async () => {
  const reply = new PassThrough();
  const request = new EventEmitter();
  let eof = false, requestError = false;
  const notification = new Promise<Error>(resolve => request.once("error", error => {
    requestError = true;
    resolve(error);
  }));
  const bytes = readWeb2DanceBindPrepareResponse(reply, error => {
    reply.emit("end");
    eof = true;
    void yieldTurn().then(() => request.emit("error", error));
  });
  const refusal = assert.rejects(bytes, /web2_dance_bind_prepare_size/);
  reply.emit("data", prefix);
  reply.emit("data", Buffer.from(" "));
  assert(eof);
  await refusal;
  assert.equal(requestError, false);
  assert.equal((await notification).message, "web2_dance_bind_prepare_size");
});
