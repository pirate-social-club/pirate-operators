// Reuses issuer authentication, retained speech jobs, admission and recovery.
// Private V5 allocates no public grant, enrollment, sponsorship, fee or nonce.
import { sha256 } from "viem";
import { canonical, check, digest } from "../packages/protocol/index.ts";
import {
  studyId,
  type StudySpeechParameters,
} from "../packages/study/operator-contract.ts";
import { verifyStudyAuthorization } from "../packages/study/operator-auth.ts";
import {
  validatePrivateV5Offer,
  type StudyPrivateV5Binding,
  type StudyPrivateV5Offer,
} from "../packages/study/private-v5.ts";
import {
  STUDY_MAX_TAKES,
  STUDY_OPEN_LESSON_MAX_MS,
  studyPresentationCap,
} from "../packages/study/lesson.ts";
import { STUDY_SOURCE_MAX_BYTES } from "../packages/study/public-source.ts";
import {
  makeStudyTranscriber,
  StudySpeechError,
  type StudyTranscriber,
} from "../packages/study/speech-transcriber.ts";
import { withSafeStudySpeechRetries } from "../packages/study/speech-retries.ts";
import type { ResultStore } from "./learning-transactions.ts";
import type { Env } from "./runtime.ts";
import {
  privateStudyV5Profile,
  type StudyPrivateV5Env,
} from "./study-v5-profile.ts";
import { readStudyAudio } from "./study-spoken.ts";
import { dispatchStudySpeech } from "./study-speech-dispatch.ts";
import {
  completeStudySpeech,
  recoverStudySpeech,
  type StudySpeechJob,
} from "./study-speech-receipt.ts";
import { closedStudyPublication } from "./study-private-publication.ts";

const bindingKey = (id: string) => "studyV5PrivateBinding:" + id;
export function privateStudyV5Binding(store: ResultStore, id: string) {
  return store.get<StudyPrivateV5Binding>(bindingKey(id));
}
/** At most the existing open + export windows, never an unbounded private copy. */
export function expirePrivateStudyV5Bindings(store: ResultStore) {
  for (const { key, value } of store.entries("studyV5PrivateBinding:")) {
    const binding = value as StudyPrivateV5Binding;
    if (
      binding.offer.startedAt + 2 * STUDY_OPEN_LESSON_MAX_MS <=
      store.now() * 1000
    )
      store.delete(key);
  }
}
export async function studyPrivateV5OperatorRoute(
  request: Request,
  env: Env & StudyPrivateV5Env,
  store: ResultStore,
  transcriber?: StudyTranscriber,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/study/v5/")) return null;
  const profile = privateStudyV5Profile(env, env.COMMUNITY_ID);
  check(
    Number(env.PAYMENT_CHAIN_ID) === profile.chainId,
    "study_private_v5_chain_changed",
  );
  const auth = await verifyStudyAuthorization(
    request,
    {
      chainId: profile.chainId,
      communityId: profile.communityId,
      contract: profile.contract,
      operator: env.OPERATOR_ADDRESS,
    },
    env.ISSUER,
    store.now(),
  );
  const current = () => {
    check(
      auth.expiresAt > store.now() &&
        canonical(privateStudyV5Profile(env, env.COMMUNITY_ID)) ===
          canonical(profile),
      "study_private_v5_authority_changed",
    );
  };
  current();
  const reply = (value: unknown) =>
    Response.json(value, { headers: { "cache-control": "no-store" } });
  function binding(id: string) {
    const bound = privateStudyV5Binding(store, id);
    check(
      bound &&
        bound.offer.profileHash === digest(profile) &&
        bound.offerHash === digest(bound.offer) &&
        !closedStudyPublication(store, id),
      "study_lesson_not_bound",
    );
    validatePrivateV5Offer(bound.offer, profile, store.now());
    return bound;
  }
  if (path === "/study/v5/private/speech") {
    const p = auth.parameters as unknown as StudySpeechParameters;
    check(
      p &&
        studyId(p.lessonId) &&
        studyId(p.attemptId) &&
        Object.keys(p).sort().join() ===
          [
            "lessonId",
            "attemptId",
            "lineId",
            "presentationNumber",
            "takeNumber",
            "contentType",
            "durationMs",
          ]
            .sort()
            .join(),
      "invalid_study_speech_request",
    );
    const bound = binding(p.lessonId),
      line = bound.offer.exercises.find((x) => x.lineId === p.lineId);
    check(
      line &&
        Number.isSafeInteger(p.presentationNumber) &&
        p.presentationNumber > 0 &&
        p.presentationNumber <=
          studyPresentationCap(bound.offer.exercises.length) &&
        Number.isSafeInteger(p.takeNumber) &&
        p.takeNumber > 0 &&
        p.takeNumber <= STUDY_MAX_TAKES,
      "invalid_study_speech_request",
    );
    const audio = await readStudyAudio(
      new Request(request.url, {
        method: "POST",
        body: request.body,
        headers: {
          "content-type": p.contentType,
          "x-study-duration-ms": String(p.durationMs),
        },
        duplex: "half",
      } as RequestInit),
    );
    current();
    check(sha256(audio.audio) === auth.bodyHash, "study_audio_changed");
    const hash = digest({ parameters: p, bodyHash: auth.bodyHash }),
      key = "studySpeech:" + p.attemptId;
    const prior = store.get<StudySpeechJob>(key);
    if (prior) {
      check(
        prior.expiresAt > store.now() &&
          prior.requestHash === hash &&
          prior.bindingHash === bound.offerHash &&
          prior.channel === "website-study",
        "study_speech_request_changed",
      );
      const safe = completeStudySpeech(store, key, hash, prior.receipt);
      check(safe, "study_history_expired");
      return reply(safe.receipt);
    }
    const slot = `studySpeechSlot:${p.lessonId}:${p.presentationNumber}:${p.takeNumber}`;
    const inserted = store.transaction(() => {
      current();
      check(
        binding(p.lessonId).offerHash === bound.offerHash,
        "study_binding_changed",
      );
      check(
        store.now() * 1000 < bound.offer.startedAt + STUDY_OPEN_LESSON_MAX_MS,
        "study_lesson_expired",
      );
      const concurrent = store.get<StudySpeechJob>(key);
      if (concurrent) {
        check(
          concurrent.requestHash === hash &&
            concurrent.bindingHash === bound.offerHash,
          "study_speech_request_changed",
        );
        return false;
      }
      const used = store.get<string>(slot);
      check(
        !used ||
          used === p.attemptId ||
          store.get<StudySpeechJob>("studySpeech:" + used)?.receipt.state ===
            "unavailable",
        "study_speech_slot_spent",
      );
      store.set(slot, p.attemptId);
      store.set(key, {
        bindingHash: bound.offerHash,
        requestHash: hash,
        audioDigest: auth.bodyHash,
        parameters: p,
        receipt: { state: "assessing", error: "speech_pending" },
        expiresAt: store.now() + STUDY_OPEN_LESSON_MAX_MS / 1000,
        channel: "website-study",
      } satisfies StudySpeechJob);
      return true;
    });
    if (!inserted) return reply(store.get<StudySpeechJob>(key)!.receipt);
    const provider =
      transcriber ?? makeStudyTranscriber(env.ELEVENLABS_API_KEY ?? "");
    // Admission awaits before provider dispatch. Recheck issuer lifetime,
    // reviewed policy and the exact original binding after that await too.
    const guarded: StudyTranscriber = {
      providerRetention: provider.providerRetention,
      async transcribe(...args) {
        try {
          current();
          check(
            binding(p.lessonId).offerHash === bound.offerHash,
            "study_binding_changed",
          );
        } catch {
          throw new StudySpeechError(
            "study_private_v5_authority_changed",
            "known_failed",
          );
        }
        return provider.transcribe(...args);
      },
    };
    return reply(
      await dispatchStudySpeech({
        env,
        store,
        parameters: p,
        key,
        requestHash: hash,
        bodyHash: auth.bodyHash,
        expiresAtMs: bound.offer.startedAt + STUDY_OPEN_LESSON_MAX_MS,
        channel: "website-study",
        audio: audio.audio,
        contentType: audio.contentType,
        language: line.language,
        // A proven rate-limit refusal permits a physical retry. The original
        // authority and binding must still hold after each backoff.
        provider: transcriber ? guarded : withSafeStudySpeechRetries(guarded),
      }),
    );
  }
  check(
    path === "/study/v5/private/bind" ||
      path === "/study/v5/private/speech/status",
    "study_v5_public_admission_unavailable",
  );
  check(canonical(auth.parameters) === "{}", "invalid_study_parameters");
  const reader = request.body?.getReader();
  check(reader, "invalid_study_request_body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const maximum = path.endsWith("/bind")
    ? STUDY_SOURCE_MAX_BYTES + 65536
    : 16000;
  try {
    while (true) {
      const next = await reader.read();
      current();
      if (next.done) break;
      size += next.value.length;
      check(size <= maximum, "invalid_study_request_body");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  current();
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  check(sha256(bytes) === auth.bodyHash, "invalid_study_request_body");
  const value = JSON.parse(new TextDecoder().decode(bytes));
  if (path === "/study/v5/private/bind") {
    const offer = value as StudyPrivateV5Offer;
    validatePrivateV5Offer(offer, profile, store.now());
    check(
      offer.startedAt + STUDY_OPEN_LESSON_MAX_MS > store.now() * 1000,
      "study_lesson_expired",
    );
    return reply(
      store.transaction(() => {
        current();
        check(
          !store.get("studyBinding:" + offer.lessonId) &&
            !store.get("studyPublication:" + offer.lessonId) &&
            !closedStudyPublication(store, offer.lessonId),
          "study_private_v5_entry_changed",
        );
        const old = privateStudyV5Binding(store, offer.lessonId),
          offerHash = digest(offer);
        if (old) {
          check(
            old.offerHash === offerHash &&
              canonical(old.offer) === canonical(offer),
            "study_lesson_binding_changed",
          );
          return old;
        }
        const bound: StudyPrivateV5Binding = {
          schema: "pirate.study-private-binding/5",
          version: 5,
          publication: { kind: "private" },
          offer,
          offerHash,
        };
        store.set(bindingKey(offer.lessonId), bound);
        return bound;
      }),
    );
  }
  check(
    value &&
      studyId(value.lessonId) &&
      studyId(value.attemptId) &&
      Object.keys(value).sort().join() === "attemptId,lessonId",
    "invalid_study_status_request",
  );
  const bound = binding(value.lessonId),
    key = "studySpeech:" + value.attemptId;
  let job = store.get<StudySpeechJob>(key);
  check(
    job &&
      job.parameters.lessonId === value.lessonId &&
      job.bindingHash === bound.offerHash &&
      job.channel === "website-study" &&
      job.expiresAt > store.now(),
    "study_speech_not_found",
  );
  current();
  job = await recoverStudySpeech(env, store, key, job, transcriber);
  current();
  return reply({
    parameters: job.parameters,
    audioDigest: job.audioDigest,
    receipt: job.receipt,
  });
}
