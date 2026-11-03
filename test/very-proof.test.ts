import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BASE_FIELD,
  SCALAR_FIELD,
  boundSubject,
} from "../packages/very/proof.ts";
import { proofFixture } from "./very-fixture.ts";

test("Very proof shape and every request-bound signal fail closed", () => {
  const raw = proofFixture("1000001", "17");
  assert.equal(boundSubject(raw, "1000001", "17"), "12345");
  for (const index of [0, 1, 3, 4, 5, 8, 9]) {
    const altered = JSON.parse(raw);
    altered.publicSignals[index] = "999";
    assert.throws(() => boundSubject(JSON.stringify(altered), "1000001", "17"));
  }
  for (const subject of [
    "0",
    "01",
    "-1",
    "1.0",
    SCALAR_FIELD.toString(),
    "9".repeat(78),
    4,
  ]) {
    const altered = JSON.parse(raw);
    altered.publicSignals[2] = subject;
    assert.throws(() => boundSubject(JSON.stringify(altered), "1000001", "17"));
  }
  for (const mutate of [
    (v: any) => v.publicSignals.push("1"),
    (v: any) => v.proof.pi_b.pop(),
    (v: any) => v.proof.pi_a.push("1"),
    (v: any) => (v.proof.protocol = "other"),
    (v: any) => (v.proof.curve = "other"),
    (v: any) => (v.extra = true),
    (v: any) => (v.publicSignals[7] = "2"),
  ]) {
    const altered = JSON.parse(raw);
    mutate(altered);
    assert.throws(() => boundSubject(JSON.stringify(altered), "1000001", "17"));
  }
});

test("proof coordinates use the base field; signals use the scalar field", () => {
  const proof = JSON.parse(proofFixture("1000001", "17"));
  proof.proof.pi_a[0] = SCALAR_FIELD.toString();
  assert.equal(boundSubject(JSON.stringify(proof), "1000001", "17"), "12345");
  proof.proof.pi_a[0] = BASE_FIELD.toString();
  assert.throws(() => boundSubject(JSON.stringify(proof), "1000001", "17"));
  assert.throws(() => boundSubject(" ".repeat(1_048_577), "1000001", "17"));
});
