// The public operator accepts Study work only from its existing community issuer.
import { sha256, type Hex } from "viem";
import { canonical, check, digest } from "../packages/protocol/index.ts";
import {
  STUDY_MAX_TAKES,
  studyPresentationCap,
} from "../packages/study/lesson.ts";
import { verifyStudyAuthorization } from "../packages/study/operator-auth.ts";
import {
  validateStudyOffer,
  studyId,
  type StudyLessonOffer,
  type StudySpeechParameters,
  type StudySpeechReceipt,
} from "../packages/study/operator-contract.ts";
import {
  StudySpeechError,
  makeStudyTranscriber,
  type StudyTranscriber,
} from "../packages/study/speech-transcriber.ts";
import { readStudyAudio } from "./study-spoken.ts";
import { publishStudyTerminal } from "./study-publication.ts";
import { STUDY_SOURCE_MAX_BYTES } from "../packages/study/public-source.ts";
import {
  activeEnrollment,
  type BoundEnrollment,
} from "./learning-enrollment.ts";
import {
  resultsTarget,
  retainedTarget,
  type ResultsTarget,
} from "./learning-contract.ts";
import { reserveSponsorship, sponsorLimits } from "./sponsor-budget.ts";
import type { ResultStore } from "./learning-transactions.ts";
import type { Env } from "./runtime.ts";

export interface StudyOperatorBinding {
  offer: StudyLessonOffer;
  offerHash: Hex;
  exercisesHash: Hex;
  target: ResultsTarget;
  enrollment: BoundEnrollment;
}
interface SpeechJob {
  bindingHash: Hex;
  requestHash: Hex;
  audioDigest: Hex;
  parameters: StudySpeechParameters;
  receipt: StudySpeechReceipt;
  expiresAt: number;
}
export const studyBinding = (store: ResultStore, id: string) =>
  store.get<StudyOperatorBinding>(`studyBinding:${id}`);

async function bindStudyLesson(
  env: Env,
  store: ResultStore,
  offer: StudyLessonOffer,
) {
  const target = resultsTarget(env, 3),
    key = `studyBinding:${offer.lessonId}`;
  const old = studyBinding(store, offer.lessonId),
    hash = digest(offer) as Hex;
  if (old) {
    retainedTarget(env, old.target);
    check(old.offerHash === hash, "study_lesson_binding_changed");
    return old;
  }
  const exercisesHash = validateStudyOffer(offer, store.now());
  const enrollment = await activeEnrollment(env, offer.learner, target, 2);
  check(
    enrollment.issuedAt * 1000 <= offer.startedAt &&
      enrollment.expiresAt * 1000 >= offer.expiresAt + 60000,
    "study_enrollment_window_too_short",
  );
  return store.transaction(() => {
    const concurrent = studyBinding(store, offer.lessonId);
    if (concurrent) {
      check(concurrent.offerHash === hash, "study_lesson_binding_changed");
      return concurrent;
    }
    reserveSponsorship(
      store,
      sponsorLimits(env),
      `record_result:study:${offer.lessonId}:1`,
    );
    reserveSponsorship(
      store,
      sponsorLimits(env),
      `record_result:study:${offer.lessonId}:2`,
    );
    const binding = {
      offer,
      offerHash: hash,
      exercisesHash,
      target,
      enrollment,
    };
    store.set(key, binding);
    return binding;
  });
}

async function speak(
  env: Env & { ELEVENLABS_API_KEY?: string },
  store: ResultStore,
  parameters: StudySpeechParameters,
  request: Request,
  bodyHash: Hex,
  transcriber?: StudyTranscriber,
) {
  check(
    parameters && studyId(parameters.lessonId) && studyId(parameters.attemptId),
    "invalid_study_speech_request",
  );
  const binding = studyBinding(store, parameters.lessonId);
  check(binding, "study_lesson_not_bound");
  retainedTarget(env, binding.target);
  const line = binding.offer.exercises.find(
    (line) => line.lineId === parameters.lineId,
  );
  check(
    line &&
      Number.isSafeInteger(parameters.presentationNumber) &&
      parameters.presentationNumber > 0 &&
      parameters.presentationNumber <=
        studyPresentationCap(binding.offer.exercises.length) &&
      Number.isSafeInteger(parameters.takeNumber) &&
      parameters.takeNumber > 0 &&
      parameters.takeNumber <= STUDY_MAX_TAKES,
    "invalid_study_speech_request",
  );
  const audioRequest = new Request(request.url, {
    method: "POST",
    body: request.body,
    headers: {
      "content-type": parameters.contentType,
      "x-study-duration-ms": String(parameters.durationMs),
    },
    duplex: "half",
  } as RequestInit);
  const audio = await readStudyAudio(audioRequest);
  check(sha256(audio.audio) === bodyHash, "study_audio_changed");
  const requestHash = digest({ parameters, bodyHash }) as Hex,
    key = `studySpeech:${parameters.attemptId}`;
  const previous = store.get<SpeechJob>(key);
  if (previous) {
    check(
      previous.requestHash === requestHash &&
        previous.bindingHash === binding.offerHash,
      "study_speech_request_changed",
    );
    return previous.receipt;
  }
  check(store.now() * 1000 < binding.offer.expiresAt, "study_lesson_expired");
  const active = await activeEnrollment(
    env,
    binding.offer.learner,
    binding.target,
    2,
  );
  check(active.id === binding.enrollment.id, "enrollment_changed");
  check(env.SPEECH_BUDGET, "speech_budget_unconfigured");
  const provider =
    transcriber ?? makeStudyTranscriber(env.ELEVENLABS_API_KEY ?? "");
  const slot = `studySpeechSlot:${parameters.lessonId}:${parameters.presentationNumber}:${parameters.takeNumber}`;
  const inserted = store.transaction(() => {
    const concurrent = store.get<SpeechJob>(key);
    if (concurrent) {
      check(
        concurrent.requestHash === requestHash,
        "study_speech_request_changed",
      );
      return false;
    }
    const used = store.get<string>(slot);
    check(!used || used === parameters.attemptId, "study_speech_slot_spent");
    check(store.now() * 1000 < binding.offer.expiresAt, "study_lesson_expired");
    store.set(slot, parameters.attemptId);
    store.set(key, {
      bindingHash: binding.offerHash,
      requestHash,
      audioDigest: bodyHash,
      parameters,
      receipt: { state: "assessing", error: "speech_pending" },
      expiresAt: store.now() + 30 * 86400,
    } satisfies SpeechJob);
    return true;
  });
  if (!inserted) return store.get<SpeechJob>(key)!.receipt;
  let receipt: StudySpeechReceipt;
  let dispatched = false;
  try {
    // The same object used by Karaoke and alignment, with no separate quota.
    await env.SPEECH_BUDGET.getByName("elevenlabs-service").claim();
    dispatched = true;
    const transcript = await provider.transcribe(
      audio.audio,
      audio.contentType,
      line.language,
    );
    receipt = { state: "assessed", transcript };
  } catch (error) {
    receipt = {
      state:
        !dispatched ||
        (error instanceof StudySpeechError && error.outcome === "known_failed")
          ? "unavailable"
          : "uncertain",
      error:
        error instanceof StudySpeechError ? error.code : "speech_unavailable",
    };
  }
  const job = store.get<SpeechJob>(key)!;
  store.set(key, { ...job, receipt });
  return receipt;
}

export async function studyOperatorRoute(
  request: Request,
  env: Env,
  store: ResultStore,
  transcriber?: StudyTranscriber,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/study/")) return null;
  const reply = (value: unknown) =>
    Response.json(value, {
      headers: { "cache-control": "no-store" },
    });
  const target = resultsTarget(env, 3);
  const auth = await verifyStudyAuthorization(
    request,
    {
      chainId: target.chainId,
      communityId: env.COMMUNITY_ID as Hex,
      operator: env.OPERATOR_ADDRESS,
      contract: target.contract,
    },
    env.ISSUER,
    store.now(),
  );
  if (path === "/study/speech")
    return reply(
      await speak(
        env,
        store,
        auth.parameters as unknown as StudySpeechParameters,
        request,
        auth.bodyHash,
        transcriber,
      ),
    );
  const reader = request.body?.getReader();
  check(reader, "invalid_study_request_body");
  const chunks: Uint8Array[] = [];
  const maximum =
    path === "/study/terminal" ? STUDY_SOURCE_MAX_BYTES + 65536 : 16000;
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      check(size <= maximum, "invalid_study_request_body");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  check(
    bytes.length <= maximum && sha256(bytes) === auth.bodyHash,
    "invalid_study_request_body",
  );
  check(canonical(auth.parameters) === "{}", "invalid_study_parameters");
  const value = JSON.parse(new TextDecoder().decode(bytes));
  if (path === "/study/bind")
    return reply(await bindStudyLesson(env, store, value));
  if (path === "/study/terminal")
    return reply(await publishStudyTerminal(env, store, value));
  check(
    path === "/study/speech/status" &&
      studyId(value.lessonId) &&
      studyId(value.attemptId),
    "invalid_study_status_request",
  );
  const job = store.get<SpeechJob>(`studySpeech:${value.attemptId}`);
  check(
    job &&
      job.parameters.lessonId === value.lessonId &&
      job.expiresAt > store.now(),
    "study_speech_not_found",
  );
  return reply({
    parameters: job.parameters,
    audioDigest: job.audioDigest,
    receipt: job.receipt,
  });
}

export function expireStudySpeech(store: ResultStore) {
  for (const { key, value } of store.entries("studySpeech:"))
    if ((value as SpeechJob).expiresAt <= store.now()) store.delete(key);
}
