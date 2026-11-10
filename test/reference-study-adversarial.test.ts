import test from "node:test";
import assert from "node:assert/strict";
import { decodeEventLog, sha256, toHex } from "viem";
import { canonical } from "../packages/community/common.ts";
import {
  packStudyOutcomes,
  studyExercisesHash,
  enrollmentV3Id,
} from "../packages/protocol/learning-results-v3.ts";
import { referenceResults } from "../harness/reference-results/reduce.ts";
import {
  v3Abi,
  resultManifestUri,
} from "../harness/reference-results/facts.ts";
import { studyTrace } from "./fixtures/reference-study.ts";
import {
  rewriteLastStudy,
  rewriteStudyEvent,
} from "./fixtures/reference-study-rewrite.ts";

test("missing V3 ancestry and changed immutable context cannot retain an old favorable day", () => {
  for (const field of ["revision", "completedAt", "contentRevision"] as const) {
    const f = studyTrace(),
      id = f.publish(5);
    f.correct(id, [false, false, true, true]);
    rewriteLastStudy(f, (header, wire) => ({
      header: {
        ...header,
        ...(field === "revision"
          ? { revision: 3 }
          : field === "completedAt"
            ? { completedAt: header.completedAt + 1n }
            : { contentRevision: `0x${"f".repeat(64)}` }),
      },
      wire,
    }));
    const r = referenceResults(f.snapshot);
    assert.equal(r.records[0].verified, false);
    assert.deepEqual(r.days, []);
  }
});
test("complete self-consistent Study bytes still need eligible published source ordinals", () => {
  const f = studyTrace();
  f.publish(5);
  assert.match(f.source.lines[0].text.trim(), /^\[/);
  const ordinals = [...f.selected.slice(0, 3), 1];
  rewriteLastStudy(f, (header) => ({
    header: { ...header, exercisesHash: studyExercisesHash(ordinals) },
    wire: packStudyOutcomes(
      ordinals.map((sourceOrdinal) => ({ sourceOrdinal, status: "correct" })),
    ),
  }));
  const r = referenceResults(f.snapshot);
  assert.equal(r.records[0].verified, false);
  assert.deepEqual(r.days, []);
});
test("unknown or weakened Study policy bytes cannot lower the first-pass threshold", () => {
  const f = studyTrace(),
    doc = { ...f.policy, minCorrectNumerator: 6 },
    wire = toHex(canonical(doc)),
    hash = sha256(wire),
    uri = resultManifestUri(hash);
  f.snapshot.documents[uri] = wire;
  const activation = f.snapshot.logs.find(
    (log) =>
      log.address === f.address &&
      (() => {
        const e = decodeEventLog({
          abi: v3Abi,
          data: log.data,
          topics: log.topics,
        });
        return e.eventName === "PolicyActivated" && e.args.activity === 2;
      })(),
  )!;
  const a = decodeEventLog({
    abi: v3Abi,
    eventName: "PolicyActivated",
    data: activation.data,
    topics: activation.topics,
  }).args;
  rewriteStudyEvent(activation, "PolicyActivated", {
    ...a,
    policyHash: hash,
    policyURI: uri,
  });
  f.publish(5, [false, false, true, true]);
  rewriteLastStudy(f, (header, wire) => ({
    header: { ...header, qualificationPolicy: hash },
    wire,
  }));
  f.state.policies["2:5"] = hash;
  const r = referenceResults(f.snapshot);
  assert.equal(r.records[0].verified, true);
  assert.deepEqual(r.days, []);
  assert.equal(
    r.policies.find((policy) => policy.activity === 2)?.document,
    undefined,
  );
});
test("Karaoke-only V3 grant cannot authorize a fresh Study publication", () => {
  const f = studyTrace();
  const enrolled = f.snapshot.logs.find(
    (log) =>
      log.address === f.address &&
      decodeEventLog({ abi: v3Abi, data: log.data, topics: log.topics })
        .eventName === "Enrolled",
  )!;
  const a = decodeEventLog({
    abi: v3Abi,
    eventName: "Enrolled",
    data: enrolled.data,
    topics: enrolled.topics,
  }).args;
  const enrollment = { ...a.enrollment, activities: 1n },
    id = enrollmentV3Id(6343, f.address, enrollment);
  rewriteStudyEvent(enrolled, "Enrolled", {
    ...a,
    enrollmentId: id,
    enrollment,
  });
  f.publish(5);
  rewriteLastStudy(f, (header, wire) => ({
    header: { ...header, enrollmentId: id },
    wire,
  }));
  const r = referenceResults(f.snapshot);
  assert.equal(r.records[0].verified, false);
  assert.deepEqual(r.days, []);
});
test("only the controller can restore invalidated Study; revoked fresh work and version mismatch fail", () => {
  const f = studyTrace(),
    id = f.publish(5);
  f.correct(id, undefined, 5);
  f.correct(id, undefined, 1, f.original.grader);
  assert.deepEqual(referenceResults(f.snapshot).days, []);
  const revoked = studyTrace();
  revoked.revoke();
  revoked.publish(5);
  assert.equal(referenceResults(revoked.snapshot).records[0].verified, false);
  const wrong = studyTrace();
  wrong.publish(5);
  wrong.state.version = 2 as 3;
  assert.throws(() => referenceResults(wrong.snapshot), /context_changed/);
});
