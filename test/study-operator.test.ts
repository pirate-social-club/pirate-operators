import test from "node:test";
import assert from "node:assert/strict";
import { accounts, keys } from "../harness/runtime.ts";
import { learningBindingFixture } from "./learning-binding-fixture.ts";
import { acceptEnrollment } from "../services/learning-enrollment.ts";
import {
  studyOperatorRoute,
  studyBinding,
  expireStudySpeech,
} from "../services/study-operator.ts";
import {
  bindManagedStudy,
  managedStudyReceipt,
  managedStudyTranscriber,
  type StudyOperatorPorts,
} from "../services/study-operator-client.ts";
import {
  authorizeStudyRequest,
  STUDY_AUTH_HEADER,
} from "../packages/study/operator-auth.ts";
import {
  StudySpeechError,
  type StudyTranscriber,
} from "../packages/study/speech-transcriber.ts";
import type { StudyLessonOffer } from "../packages/study/operator-contract.ts";
import { resultsTarget } from "../services/learning-contract.ts";
import { digest } from "../packages/protocol/index.ts";
import type { Hex } from "viem";

const recording = () =>
  new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 1]);
async function fixture(port: number) {
  const f = await learningBindingFixture(port);
  f.env.RESULTS_V3_CONTRACT = f.v3;
  f.env.ISSUER = accounts[1].address;
  const enrollment = await f.enrollment(3);
  await acceptEnrollment(f.env, f.store, enrollment.e, enrollment.signature);
  let clock = Number((await f.evm.publicClient.getBlock()).timestamp),
    calls = 0,
    observations = 0;
  let behavior: () => Promise<{
    text: string;
    language: string | null;
  }> = async () => ({ text: "Hold me close", language: "en" });
  let claim: () => Promise<void> = async () => {
    observations++;
  };
  f.env.SPEECH_BUDGET = {
    getByName(name: string) {
      assert.equal(name, "elevenlabs-service");
      return { claim: () => claim() };
    },
  } as never;
  const provider: StudyTranscriber = {
    providerRetention: "stored",
    async transcribe() {
      calls++;
      return behavior();
    },
  };
  const store = { ...f.store, now: () => clock };
  const invoke = (request: Request) =>
    studyOperatorRoute(request, f.env, store, provider);
  let lastRequest: Request | undefined;
  const ports: StudyOperatorPorts = {
    binding: {
      async fetch(input: RequestInfo | URL, init?: RequestInit) {
        const request = new Request(input, init);
        lastRequest = request.clone() as Request;
        try {
          return (await invoke(request))!;
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : "failure" },
            { status: 400 },
          );
        }
      },
    } as Fetcher,
    authority: {
      chainId: 31337,
      communityId: f.env.COMMUNITY_ID as Hex,
      operator: f.env.OPERATOR_ADDRESS,
      contract: resultsTarget(f.env, 3).contract,
    },
    issuerKey: keys[1],
    now: () => clock * 1000,
  };
  const offer: StudyLessonOffer = {
    lessonId: "study-lesson-0000001",
    learner: accounts[5].address,
    sourceDigest: digest("published-source") as Hex,
    startedAt: clock * 1000,
    expiresAt: (clock + 3600) * 1000,
    exercises: [1, 4, 7, 9].map((ordinal) => ({
      ordinal,
      lineId: digest(`line-${ordinal}`) as Hex,
      language: "en",
    })),
  };
  const context = {
    lessonId: offer.lessonId,
    attemptId: "study-attempt-0000001",
    lineId: offer.exercises[0].lineId,
    presentationNumber: 1,
    takeNumber: 1,
    durationMs: 1000,
  };
  return {
    ...f,
    store,
    ports,
    offer,
    context,
    invoke,
    lastRequest: () => lastRequest!,
    counts: () => ({ calls, observations }),
    setBehavior: (next: typeof behavior) => {
      behavior = next;
    },
    setClaim: (next: typeof claim) => {
      claim = next;
    },
    advance: (seconds: number) => {
      clock += seconds;
    },
  };
}

test(
  "signed Study binding retains its grant and speech replays never repurchase, including after a lost response and restart",
  { timeout: 60000 },
  async () => {
    const f = await fixture(19851);
    try {
      const binding = await bindManagedStudy(f.ports, f.offer);
      assert.equal(binding.target.version, 3);
      assert.equal(binding.enrollment.activities, 3);
      const ledger = f.store.get("sponsor:ledger");
      assert.deepEqual(await bindManagedStudy(f.ports, f.offer), binding);
      assert.deepEqual(f.store.get("sponsor:ledger"), ledger);
      await assert.rejects(
        bindManagedStudy(f.ports, {
          ...f.offer,
          sourceDigest: digest("changed") as Hex,
        }),
        /binding_changed/,
      );
      const speech = managedStudyTranscriber(f.ports, binding);
      const result = await speech.transcribe(
        recording(),
        "audio/webm",
        "en",
        f.context,
      );
      assert.equal(result.text, "Hold me close");
      assert.deepEqual(f.counts(), { calls: 1, observations: 1 });
      f.restartJournal();
      assert.deepEqual(
        await speech.transcribe(recording(), "audio/webm", "en", f.context),
        result,
      );
      const recovered = await managedStudyReceipt(
        f.ports,
        f.offer.lessonId,
        f.context.attemptId,
      );
      assert.equal(recovered.receipt.state, "assessed");
      assert.deepEqual(f.counts(), { calls: 1, observations: 1 });
      const changed = recording();
      changed[11]++;
      await assert.rejects(
        speech.transcribe(changed, "audio/webm", "en", f.context),
        /request_changed/,
      );
      await assert.rejects(
        speech.transcribe(recording(), "audio/webm", "en", {
          ...f.context,
          attemptId: "different-attempt-id",
        }),
        /slot_spent/,
      );
      await assert.rejects(
        speech.transcribe(recording(), "audio/webm", "en", {
          ...f.context,
          presentationNumber: 13,
        }),
        /invalid_study_speech_request/,
      );
      await assert.rejects(
        speech.transcribe(recording(), "audio/webm", "en", {
          ...f.context,
          takeNumber: 4,
        }),
        /invalid_study_speech_request/,
      );
      assert.deepEqual(f.counts(), { calls: 1, observations: 1 });
      f.advance(30 * 86400 + 1);
      expireStudySpeech(f.store);
      assert.equal(f.store.entries("studySpeech:").length, 0);
      assert.ok(studyBinding(f.store, f.offer.lessonId));
      await assert.rejects(
        speech.transcribe(recording(), "audio/webm", "en", f.context),
        /lesson_expired/,
      );
      assert.deepEqual(f.counts(), { calls: 1, observations: 1 });
    } finally {
      await f.stop();
    }
  },
);

test(
  "public Study operator refuses missing, foreign, expired and body-altered authority before recording or dispatch",
  { timeout: 60000 },
  async () => {
    const f = await fixture(19852);
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(f.offer));
      const header = await authorizeStudyRequest(
        f.ports.authority,
        "/study/bind",
        bytes,
        {},
        keys[1],
        f.store.now(),
      );
      const make = (h?: string, b: Uint8Array = bytes, path = "/study/bind") =>
        new Request(`http://operator${path}`, {
          method: "POST",
          headers: h ? { [STUDY_AUTH_HEADER]: h } : {},
          body: new Uint8Array(b).buffer,
        });
      await assert.rejects(f.invoke(make()), /authorization_required/);
      const foreign = await authorizeStudyRequest(
        f.ports.authority,
        "/study/bind",
        bytes,
        {},
        keys[5],
        f.store.now(),
      );
      await assert.rejects(
        f.invoke(make(foreign)),
        /invalid_study_authorization/,
      );
      await assert.rejects(
        f.invoke(make(header, bytes, "/study/speech/status")),
        /invalid_study_authorization/,
      );
      await assert.rejects(
        f.invoke(make(header, new TextEncoder().encode("{}"))),
        /invalid_study_request_body/,
      );
      await assert.rejects(
        f.invoke(make(header, new Uint8Array(16001))),
        /invalid_study_request_body/,
      );
      f.advance(61);
      await assert.rejects(
        f.invoke(make(header)),
        /invalid_study_authorization/,
      );
      assert.equal(f.store.entries("studyBinding:").length, 0);
      assert.deepEqual(f.counts(), { calls: 0, observations: 0 });
      const binding = await bindManagedStudy(f.ports, f.offer);
      const speech = managedStudyTranscriber(f.ports, binding);
      await speech.transcribe(recording(), "audio/webm", "en", f.context);
      const original = f.lastRequest();
      const altered = recording();
      altered[11]++;
      await assert.rejects(
        f.invoke(
          new Request(original.url, {
            method: "POST",
            headers: original.headers,
            body: altered,
          }),
        ),
        /study_audio_changed/,
      );
      const auth = JSON.parse(original.headers.get(STUDY_AUTH_HEADER)!);
      auth.request.parameters.durationMs = 60000;
      await assert.rejects(
        f.invoke(
          new Request(original.url, {
            method: "POST",
            headers: { [STUDY_AUTH_HEADER]: JSON.stringify(auth) },
            body: recording(),
          }),
        ),
        /invalid_study_authorization/,
      );
      assert.deepEqual(f.counts(), { calls: 1, observations: 1 });
    } finally {
      await f.stop();
    }
  },
);

test(
  "concurrent requests, known failure, unknown dispatch and usage refusal retain separate durable outcomes",
  { timeout: 60000 },
  async () => {
    const f = await fixture(19853);
    try {
      const binding = await bindManagedStudy(f.ports, f.offer),
        speech = managedStudyTranscriber(f.ports, binding);
      let release!: () => void, entered!: () => void;
      const began = new Promise<void>((r) => {
        entered = r;
      });
      f.setBehavior(async () => {
        entered();
        await new Promise<void>((r) => {
          release = r;
        });
        return { text: "Hold me close", language: "en" };
      });
      const original = speech.transcribe(
        recording(),
        "audio/webm",
        "en",
        f.context,
      );
      await began;
      await assert.rejects(
        speech.transcribe(recording(), "audio/webm", "en", f.context),
        (e: Error) => e instanceof StudySpeechError && e.outcome === "unknown",
      );
      assert.deepEqual(f.counts(), { calls: 1, observations: 1 });
      release();
      await original;
      const next = {
        ...f.context,
        attemptId: "study-attempt-0000002",
        presentationNumber: 2,
      };
      f.setBehavior(async () => {
        throw new StudySpeechError("speech_rate_limited", "known_failed");
      });
      await assert.rejects(
        speech.transcribe(recording(), "audio/webm", "en", next),
        (e: Error) =>
          e instanceof StudySpeechError && e.outcome === "known_failed",
      );
      f.restartJournal();
      await assert.rejects(
        speech.transcribe(recording(), "audio/webm", "en", next),
        /speech_rate_limited/,
      );
      f.setBehavior(async () => {
        throw new Error("connection lost");
      });
      const third = {
        ...next,
        attemptId: "study-attempt-0000003",
        takeNumber: 2,
      };
      await assert.rejects(
        speech.transcribe(recording(), "audio/webm", "en", third),
        /speech_unavailable/,
      );
      assert.equal(
        (await managedStudyReceipt(f.ports, f.offer.lessonId, third.attemptId))
          .receipt.state,
        "uncertain",
      );
      f.setClaim(async () => {
        throw new Error("observation storage unavailable");
      });
      const fourth = {
        ...next,
        attemptId: "study-attempt-0000004",
        takeNumber: 3,
      };
      await assert.rejects(
        speech.transcribe(recording(), "audio/webm", "en", fourth),
        (e: Error) =>
          e instanceof StudySpeechError && e.outcome === "known_failed",
      );
      assert.deepEqual(f.counts(), { calls: 3, observations: 3 });
    } finally {
      await f.stop();
    }
  },
);
