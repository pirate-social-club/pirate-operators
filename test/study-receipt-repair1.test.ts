import test from "node:test";
import assert from "node:assert/strict";
import { sha256 } from "viem";
import { accounts, keys } from "../harness/runtime.ts";
import { digest } from "../packages/protocol/index.ts";
import {
  authorizeStudyRequest,
  STUDY_AUTH_HEADER,
} from "../packages/study/operator-auth.ts";
import type {
  StudySpeechReceipt,
  StudySpeechParameters,
} from "../packages/study/operator-contract.ts";
import {
  StudySpeechError,
  type StudyTranscriber,
} from "../packages/study/speech-transcriber.ts";
import { dispatchStudySpeech } from "../services/study-speech-dispatch.ts";
import { studyOperatorRoute } from "../services/study-operator.ts";
import type { StudySpeechJob } from "../services/study-speech-receipt.ts";
import type { Env } from "../services/runtime.ts";
import { speechRepairFixture } from "./karaoke-admission-repair1-fixture.ts";

test("controlled late dispatch/recovery interleaving preserves the first terminal receipt and its admission outcome", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw Error("unexpected network in focused receipt test");
  });
  for (const terminal of ["assessed", "unavailable"] as const) {
    for (const late of [
      "timeout",
      "error",
      "known-refusal",
      "success",
    ] as const) {
      const f = speechRepairFixture();
      const parameters: StudySpeechParameters = {
        lessonId: "repair1-lesson-0001",
        attemptId: "repair1-attempt-001",
        lineId: digest("line"),
        presentationNumber: 1,
        takeNumber: 1,
        contentType: "audio/webm",
        durationMs: 1000,
      };
      const bytes = new Uint8Array([1, 2, 3]);
      const key = `studySpeech:${parameters.attemptId}`,
        requestHash = digest({ parameters, bytes: [...bytes] });
      const recovered: StudySpeechReceipt =
        terminal === "assessed"
          ? {
              state: "assessed",
              transcript: { text: "frozen recovered words", language: "en" },
            }
          : { state: "unavailable", error: "speech_rate_limited" };
      f.store.set(key, {
        bindingHash: digest("binding"),
        requestHash,
        audioDigest: sha256(bytes),
        parameters,
        receipt: { state: "assessing", error: "speech_pending" },
        expiresAt: f.store.now() + 3600,
      } satisfies StudySpeechJob);
      let began!: () => void, finish!: () => void;
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const started = new Promise<void>((resolve) => {
        began = resolve;
      });
      let speechCalls = 0;
      const provider: StudyTranscriber = {
        providerRetention: "stored",
        async transcribe() {
          speechCalls++;
          began();
          await pending;
          if (late === "timeout")
            throw new StudySpeechError("speech_timeout", "unknown");
          if (late === "error") throw Error("fixture response lost");
          if (late === "known-refusal")
            throw new StudySpeechError("speech_rate_limited", "known_failed");
          return { text: "late different transcript", language: "en" };
        },
        async recover(context, audioDigest) {
          assert.equal(context.attemptId, parameters.attemptId);
          assert.equal(audioDigest, sha256(bytes));
          return recovered as Awaited<
            ReturnType<NonNullable<StudyTranscriber["recover"]>>
          >;
        },
      };
      const dispatch = dispatchStudySpeech({
        env: f.env,
        store: f.store,
        parameters,
        key,
        requestHash,
        bodyHash: sha256(bytes),
        expiresAtMs: (f.store.now() + 3600) * 1000,
        channel: "website-study",
        audio: bytes,
        contentType: "audio/webm",
        language: "en",
        provider,
      });
      try {
        await started;
        const authority = {
          chainId: 31337 as const,
          communityId: f.policy.communityId as `0x${string}`,
          operator: accounts[2].address,
          contract: accounts[3].address,
        };
        const body = new TextEncoder().encode(
          JSON.stringify({
            lessonId: parameters.lessonId,
            attemptId: parameters.attemptId,
          }),
        );
        const authorization = await authorizeStudyRequest(
          authority,
          "/study/speech/status",
          body,
          {},
          keys[1],
          f.store.now(),
        );
        const env = {
          ...f.env,
          PAYMENT_CHAIN_ID: "31337",
          RESULTS_V3_CONTRACT: authority.contract,
          OPERATOR_ADDRESS: authority.operator,
          COMMUNITY_ID: authority.communityId,
          ISSUER: accounts[1].address,
        } as Env;
        const response = await studyOperatorRoute(
          new Request("http://fixture/study/speech/status", {
            method: "POST",
            headers: { [STUDY_AUTH_HEADER]: authorization },
            body,
          }),
          env,
          f.store,
          provider,
        );
        assert.equal(response?.status, 200);
        assert.deepEqual(
          ((await response!.json()) as { receipt: StudySpeechReceipt }).receipt,
          recovered,
        );
        finish();
        assert.deepEqual(
          await dispatch,
          recovered,
          `${terminal} / late ${late}`,
        );
        assert.deepEqual(f.store.get<StudySpeechJob>(key)?.receipt, recovered);
        assert.equal(
          f.admission.get(`study:${parameters.attemptId}`)?.state,
          terminal === "assessed" ? "succeeded" : "refused",
        );
        assert.equal(f.resolutions.length, 2);
        assert.ok(
          f.resolutions.every(
            (row) =>
              row.evidenceDigest === digest(recovered) &&
              row.state === (terminal === "assessed" ? "succeeded" : "refused"),
          ),
        );
        assert.equal(speechCalls, 1);
      } finally {
        finish();
        await dispatch;
        f.close();
      }
    }
  }
});
