import { sha256 } from "viem";
import { digest } from "../packages/protocol/index.ts";
import { readStudyAudio } from "./study-spoken.ts";
import {
  StudySpeechError,
  type StudyTranscriber,
} from "../packages/study/speech-transcriber.ts";
import {
  gradeTranscriptV2,
  type StudyTranscriptGradeV2,
  type StudyTranscriptGraderPolicyRevision,
} from "../packages/study/transcript-grading.ts";
import type { StudyLine } from "../packages/study/contracts.ts";
import {
  telegramCheck,
  type ChatActor,
} from "../packages/telegram/contracts.ts";
import type { TelegramVoiceInput } from "../packages/telegram/study-contracts.ts";
import type { TelegramJournal } from "./telegram-store.ts";
import {
  releasedTelegramGrading,
  type TelegramTrialGradingPort,
} from "../packages/telegram/grading.ts";
import { telegramWorkClaim } from "./telegram-work-claim.ts";

/** Structural lane5 CommunitySpeechAdmission RPC. No legacy global budget
 * fallback is accepted by this adapter. Configure the same key generation as
 * website Study; concurrency qualification remains a shared admission gate. */
export interface TelegramSpeechAdmission {
  reserve(input: {
    communityId: string;
    keyGeneration: string;
    channel: "telegram-trial";
    requestId: string;
    payloadDigest: string;
    units: number;
  }): unknown | Promise<unknown>;
  dispatch(
    id: string,
  ):
    | { dispatch: boolean; reservation: { state: string } }
    | Promise<{ dispatch: boolean; reservation: { state: string } }>;
  get(id: string): unknown | Promise<unknown>;
  resolve(
    id: string,
    state: "succeeded" | "refused" | "unknown",
    evidenceDigest: string,
  ): unknown | Promise<unknown>;
}
export interface TelegramVoiceFiles {
  read(actor: ChatActor, voice: TelegramVoiceInput): Promise<Request>;
}
export interface TelegramSpeechJob {
  id: string;
  actor: ChatActor;
  lessonId: string;
  promptKey: string;
  line: StudyLine;
  policy: StudyTranscriptGraderPolicyRevision;
  presentation: number;
  take: number;
  voice: TelegramVoiceInput | null;
  audioDigest: string | null;
  reservedDay: number;
  acceptedAt: number;
  durationMs: number;
  state:
    | "queued"
    | "dispatching"
    | "uncertain"
    | "retry_wait"
    | "assessed"
    | "refused"
    | "applied"
    | "cancelled";
  retry: number;
  nextAt: number;
  finishedAt: number | null;
  grade: StudyTranscriptGradeV2 | null;
  failure: string | null;
  dispatchToken?: string;
  submissionStarted?: boolean;
}
export class TelegramTrialSpeech {
  readonly store: TelegramJournal;
  readonly config: { communityId: string; keyGeneration: string };
  readonly admission: TelegramSpeechAdmission;
  readonly transcriber: StudyTranscriber;
  readonly files: TelegramVoiceFiles;
  readonly permit: (job: TelegramSpeechJob) => void | Promise<void>;
  readonly beforeSubmission: (job: TelegramSpeechJob) => void;
  readonly now: () => number;
  readonly grading: TelegramTrialGradingPort;
  constructor(options: {
    store: TelegramJournal;
    config: { communityId: string; keyGeneration: string };
    admission: TelegramSpeechAdmission;
    transcriber: StudyTranscriber;
    files: TelegramVoiceFiles;
    permit: (job: TelegramSpeechJob) => void | Promise<void>;
    beforeSubmission: (job: TelegramSpeechJob) => void;
    now?: () => number;
    grading?: TelegramTrialGradingPort;
  }) {
    this.store = options.store;
    this.config = options.config;
    this.admission = options.admission;
    this.transcriber = options.transcriber;
    this.files = options.files;
    this.permit = options.permit;
    this.beforeSubmission = options.beforeSubmission;
    this.now = options.now ?? Date.now;
    this.grading = options.grading ?? releasedTelegramGrading;
    telegramCheck(
      /^0x[0-9a-f]{64}$/.test(options.config.communityId) &&
        /^[A-Za-z0-9_-]{1,64}$/.test(options.config.keyGeneration),
      "telegram_speech_scope_required",
    );
  }
  get(id: string) {
    const job = this.store.get<TelegramSpeechJob>(`speech-job:${id}`);
    telegramCheck(job, "telegram_job_not_found", 404);
    return job;
  }
  private save(job: TelegramSpeechJob) {
    this.store.set(`speech-job:${job.id}`, job);
    return job;
  }
  async work(id: string): Promise<TelegramSpeechJob> {
    let job = this.get(id);
    const ownership = telegramWorkClaim<TelegramSpeechJob>(this.store, id);
    const save = (change: Partial<TelegramSpeechJob>) =>
      ownership.save(job, change) ?? this.get(id);
    if (
      ["assessed", "refused", "applied", "cancelled"].includes(job.state) ||
      job.nextAt > this.now()
    )
      return job;
    await this.permit(job);
    telegramCheck(
      job.actor.communityId === this.config.communityId,
      "telegram_speech_wrong_community",
      403,
    );
    const requestId = `telegram:${job.id}:${job.retry}`;
    if (job.state === "dispatching" || job.state === "uncertain") {
      const reservation = (await Promise.resolve(
        this.admission.get(requestId),
      ).catch(() => null)) as { state?: string } | null;
      if (
        job.submissionStarted === false ||
        (job.submissionStarted === undefined &&
          reservation?.state === "reserved")
      ) {
        job = ownership.resetUnsent(job) ?? this.get(id);
      }
    }
    if (job.state === "dispatching" || job.state === "uncertain") {
      const receipt =
        job.audioDigest && this.transcriber.recover
          ? await this.transcriber
              .recover(
                {
                  lessonId: job.lessonId,
                  attemptId: job.id,
                  lineId: job.line.lineId,
                  presentationNumber: job.presentation,
                  takeNumber: job.take,
                  durationMs: job.durationMs,
                },
                job.audioDigest,
              )
              .catch(() => null)
          : null;
      if (!receipt) return save({ state: "uncertain" });
      const state = receipt.state === "assessed" ? "succeeded" : "refused";
      await this.admission.resolve(requestId, state, digest(receipt));
      await this.permit(job);
      return save({
        state: receipt.state === "assessed" ? "assessed" : "refused",
        finishedAt: this.now(),
        grade:
          receipt.state === "assessed"
            ? this.grading.grade({
                line: job.line,
                transcript: receipt.transcript,
                policy: job.policy,
                take: job.take,
              })
            : null,
        failure: receipt.state === "unavailable" ? receipt.error : null,
      });
    }
    telegramCheck(job.voice, "telegram_audio_erased", 410);
    // A refused or crashed file download has no paid side effect. It can be
    // fetched again while bounded; raw bytes never enter the durable journal.
    const audio = await readStudyAudio(
      await this.files.read(job.actor, job.voice),
    );
    const audioDigest = sha256(audio.audio);
    telegramCheck(
      !job.audioDigest || job.audioDigest === audioDigest,
      "telegram_audio_changed",
      409,
    );
    try {
      await this.admission.reserve({
        ...this.config,
        channel: "telegram-trial",
        requestId,
        payloadDigest: audioDigest,
        units: 1,
      });
    } catch {
      return save({
        state: "refused",
        failure: "speech_capacity_unavailable",
        finishedAt: this.now(),
      });
    }
    const claimed = ownership.claim({ ...job, audioDigest });
    if (!claimed) return this.get(id);
    job = claimed;
    let dispatched = false;
    try {
      await this.permit(job);
      if (!ownership.owns(job.dispatchToken)) return this.get(id);
      const permit = await this.admission.dispatch(requestId);
      if (!permit.dispatch) {
        if (
          permit.reservation.state === "cancelled" ||
          permit.reservation.state === "refused"
        )
          return save({
            state: "refused",
            failure: "speech_capacity_unavailable",
            finishedAt: this.now(),
          });
        if (permit.reservation.state !== "dispatched")
          return save({ state: "uncertain", failure: "speech_pending" });
      }
      // Admission is awaited; authority may have changed while its reply was
      // in flight. Do this for both a new permit and a proven-unsent reclaim.
      if (!ownership.owns(job.dispatchToken)) return this.get(id);
      await this.permit(job);
      // No await between this CAS and invoking the transcriber. A paused old
      // owner cannot call it after a reclaim or local authority change.
      if (
        !ownership.beginSubmission(job.dispatchToken!, () =>
          this.beforeSubmission(job),
        )
      )
        return this.get(id);
      dispatched = true;
      const transcript = await this.transcriber.transcribe(
        audio.audio,
        audio.contentType,
        job.line.language,
        {
          lessonId: job.lessonId,
          attemptId: job.id,
          lineId: job.line.lineId,
          presentationNumber: job.presentation,
          takeNumber: job.take,
          durationMs: audio.durationMs,
        },
      );
      await this.admission.resolve(requestId, "succeeded", digest(transcript));
      await this.permit(job);
      return save({
        state: "assessed",
        finishedAt: this.now(),
        grade: this.grading.grade({
          line: job.line,
          transcript,
          policy: job.policy,
          take: job.take,
        }),
        failure: null,
      });
    } catch (error) {
      if (!ownership.owns(job.dispatchToken)) return this.get(id);
      const known =
        !dispatched ||
        (error instanceof StudySpeechError && error.outcome === "known_failed");
      const failure =
        error instanceof StudySpeechError ? error.code : "speech_unavailable";
      await Promise.resolve(
        this.admission.resolve(
          requestId,
          known ? "refused" : "unknown",
          digest({ failure }),
        ),
      ).catch(() => undefined);
      if (known && failure === "speech_rate_limited" && job.retry < 1)
        return save({
          state: "retry_wait",
          retry: job.retry + 1,
          nextAt: this.now() + 1000,
          failure,
        });
      return save({
        state: known ? "refused" : "uncertain",
        finishedAt: known ? this.now() : null,
        failure,
      });
    }
  }
}
