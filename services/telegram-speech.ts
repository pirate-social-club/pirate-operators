import { sha256 } from "viem";
import { digest } from "../packages/protocol/index.ts";
import { readStudyAudio } from "./study-spoken.ts";
import {
  StudySpeechError,
  type StudyTranscript,
  type StudyTranscriber,
} from "../packages/study/speech-transcriber.ts";
import {
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
import {
  telegramWorkAuthorityLost,
  telegramWorkClaim,
} from "./telegram-work-claim.ts";

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
    | "releasing"
    | "settling"
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
  reservation?: { keyGeneration: string; started: boolean };
  resolution?: { state: "succeeded" | "refused"; evidenceDigest: string };
  releaseTo?: "cancelled" | "refused";
  retryOnRefusal?: boolean;
}
type SpeechReceipt =
  | { state: "assessed"; transcript: StudyTranscript }
  | { state: "unavailable"; error: string };

const activeSubmission = (job: TelegramSpeechJob) =>
  job.state === "dispatching" || job.state === "uncertain";
export const hasTelegramReservationIntent = (job: TelegramSpeechJob) =>
  job.reservation?.started ??
  (job.state !== "retry_wait" &&
    (job.state === "queued" || job.audioDigest !== null));
const capacityRefused = (error: unknown) =>
  error instanceof Error &&
  [
    "speech_trial_budget_exhausted",
    "speech_budget_exhausted",
    "speech_website_capacity_reserved",
  ].includes(error.message);
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
  private advance(job: TelegramSpeechJob, change: Partial<TelegramSpeechJob>) {
    return this.store.transaction(() => {
      const current = this.get(job.id);
      if (
        current.state !== job.state ||
        current.retry !== job.retry ||
        current.dispatchToken !== job.dispatchToken ||
        current.submissionStarted !== job.submissionStarted ||
        current.reservation?.started !== job.reservation?.started ||
        current.resolution?.evidenceDigest !== job.resolution?.evidenceDigest
      )
        return current;
      const next = { ...current, ...change };
      this.store.set("speech-job:" + job.id, next);
      return next;
    });
  }
  private requestId(job: TelegramSpeechJob) {
    return "telegram:" + job.id + ":" + job.retry;
  }
  private sameAdmissionScope(job: TelegramSpeechJob) {
    return (
      job.actor.communityId === this.config.communityId &&
      (!job.reservation ||
        job.reservation.keyGeneration === this.config.keyGeneration)
    );
  }
  private async reservationStatus(job: TelegramSpeechJob) {
    if (!this.sameAdmissionScope(job)) return null;
    try {
      const row = (await this.admission.get(this.requestId(job))) as {
        state?: string;
        evidenceDigest?: string | null;
        payloadDigest?: string;
        communityId?: string;
        keyGeneration?: string;
      } | null;
      if (
        !row ||
        (job.audioDigest &&
          row.payloadDigest !== undefined &&
          row.payloadDigest !== job.audioDigest) ||
        (row.communityId !== undefined &&
          row.communityId !== this.config.communityId) ||
        (row.keyGeneration !== undefined &&
          row.keyGeneration !== this.config.keyGeneration)
      )
        return null;
      return row;
    } catch {
      return null;
    }
  }
  private context(job: TelegramSpeechJob) {
    return {
      lessonId: job.lessonId,
      attemptId: job.id,
      lineId: job.line.lineId,
      presentationNumber: job.presentation,
      takeNumber: job.take,
      durationMs: job.durationMs,
    };
  }
  private async release(job: TelegramSpeechJob) {
    const row = await this.reservationStatus(job);
    if (!row) {
      // Absence is inconclusive while a reserve RPC may still commit.
      return this.get(job.id);
    }
    let evidenceDigest = row.evidenceDigest ?? undefined;
    if (row.state === "reserved" || row.state === "dispatched") {
      const requestId = this.requestId(job);
      evidenceDigest = digest({
        requestId,
        reason: "telegram_submission_not_started",
      });
      try {
        await this.admission.resolve(requestId, "refused", evidenceDigest);
      } catch {
        return this.get(job.id);
      }
    } else if (row.state !== "refused" && row.state !== "cancelled") {
      // A charged attempted outcome conflicts with unsent evidence. Keep it
      // for reconciliation without issuing a refund or another submission.
      return this.get(job.id);
    }
    return this.advance(job, {
      state: job.releaseTo ?? "cancelled",
      finishedAt: this.now(),
      voice: null,
      resolution: evidenceDigest
        ? { state: "refused", evidenceDigest }
        : undefined,
    });
  }
  private stopUnsent(
    job: TelegramSpeechJob,
    state: "refused" | "cancelled",
    failure: string,
  ) {
    const next = this.advance(
      job,
      hasTelegramReservationIntent(job)
        ? {
            state: "releasing",
            releaseTo: state,
            voice: null,
            failure,
          }
        : {
            state,
            voice: null,
            failure,
            finishedAt: this.now(),
          },
    );
    return next.state === "releasing" ? this.release(next) : next;
  }
  cancel(id: string) {
    const job = this.get(id);
    if (
      ["applied", "cancelled", "settling", "releasing"].includes(job.state) ||
      (activeSubmission(job) && job.submissionStarted !== false)
    )
      return job;
    if (job.state === "assessed" || job.state === "refused")
      return this.advance(job, {
        state: "cancelled",
        grade: null,
        voice: null,
        failure: "telegram_authority_changed",
      });
    return this.stopUnsent(job, "cancelled", "telegram_authority_changed");
  }
  private async settle(job: TelegramSpeechJob) {
    const resolution = job.resolution!;
    try {
      await this.admission.resolve(
        this.requestId(job),
        resolution.state,
        resolution.evidenceDigest,
      );
    } catch {
      // The receiver may have committed. Replay the same outcome and digest.
      return this.get(job.id);
    }
    try {
      await this.permit(job);
      this.beforeSubmission(job);
    } catch (error) {
      if (!telegramWorkAuthorityLost(error)) throw error;
      return this.advance(job, {
        state: "cancelled",
        grade: null,
        voice: null,
        failure: "telegram_authority_changed",
      });
    }
    if (job.retryOnRefusal)
      return this.advance(job, {
        state: "retry_wait",
        retry: job.retry + 1,
        nextAt: this.now() + 1000,
        submissionStarted: false,
        reservation: undefined,
        resolution: undefined,
        retryOnRefusal: undefined,
        finishedAt: null,
      });
    return this.advance(job, {
      state: resolution.state === "succeeded" ? "assessed" : "refused",
    });
  }
  private async recordOutcome(
    job: TelegramSpeechJob,
    receipt: SpeechReceipt,
    retryOnRefusal = false,
  ) {
    const current = this.get(job.id);
    if (
      current.retry !== job.retry ||
      current.dispatchToken !== job.dispatchToken
    )
      return current;
    if (current.state === "settling") return this.settle(current);
    if (!activeSubmission(current) || current.submissionStarted === false)
      return current;
    const assessed = receipt.state === "assessed";
    const next = this.advance(current, {
      state: "settling",
      resolution: {
        state: assessed ? "succeeded" : "refused",
        evidenceDigest: digest(
          assessed ? receipt.transcript : { failure: receipt.error },
        ),
      },
      finishedAt: this.now(),
      grade: assessed
        ? this.grading.grade({
            line: job.line,
            transcript: receipt.transcript,
            policy: job.policy,
            take: job.take,
          })
        : null,
      failure: assessed ? null : receipt.error,
      retryOnRefusal,
    });
    return next.state === "settling" ? this.settle(next) : next;
  }
  private async recover(job: TelegramSpeechJob) {
    let receipt: SpeechReceipt | null = null;
    if (job.audioDigest && this.transcriber.recover) {
      try {
        receipt = await this.transcriber.recover(
          this.context(job),
          job.audioDigest,
        );
      } catch {
        // The status port can fail independently of the original submission.
      }
    }
    if (receipt) return this.recordOutcome(job, receipt);
    return this.advance(job, { state: "uncertain" });
  }
  private async submit(
    job: TelegramSpeechJob,
    audio: Awaited<ReturnType<typeof readStudyAudio>>,
  ) {
    let transcript: StudyTranscript;
    try {
      transcript = await this.transcriber.transcribe(
        audio.audio,
        audio.contentType,
        job.line.language,
        this.context(job),
      );
    } catch (error) {
      if (
        error instanceof StudySpeechError &&
        error.outcome === "known_failed"
      ) {
        return this.recordOutcome(
          job,
          { state: "unavailable", error: error.code },
          error.code === "speech_rate_limited" && job.retry < 1,
        );
      }
      const failure =
        error instanceof StudySpeechError ? error.code : "speech_unavailable";
      const pending = this.advance(job, { state: "uncertain", failure });
      if (
        pending.state === "uncertain" &&
        pending.dispatchToken === job.dispatchToken
      ) {
        try {
          await this.admission.resolve(
            this.requestId(job),
            "unknown",
            digest({ failure }),
          );
        } catch {
          // Dispatched and unknown both retain the charge. The job stays
          // available for status recovery even if this acknowledgement is lost.
        }
      }
      return this.get(job.id);
    }
    return this.recordOutcome(job, { state: "assessed", transcript });
  }
  async work(id: string): Promise<TelegramSpeechJob> {
    let job = this.get(id);
    if (
      ["assessed", "refused", "applied", "cancelled"].includes(job.state) ||
      job.nextAt > this.now() ||
      !this.sameAdmissionScope(job)
    )
      return job;
    if (job.state === "releasing") return this.release(job);
    if (job.state === "settling") return this.settle(job);
    if (activeSubmission(job) && job.submissionStarted !== false) {
      if (
        job.submissionStarted !== undefined ||
        (await this.reservationStatus(job))?.state !== "reserved"
      )
        return this.recover(job);
      job = this.advance(job, { submissionStarted: false });
      if (!activeSubmission(job) || job.submissionStarted !== false) return job;
    }
    try {
      await this.permit(job);
      this.beforeSubmission(job);
    } catch (error) {
      if (!telegramWorkAuthorityLost(error)) throw error;
      return this.stopUnsent(job, "cancelled", "telegram_authority_changed");
    }
    if (!job.voice)
      return this.stopUnsent(job, "cancelled", "telegram_recording_expired");
    const ownership = telegramWorkClaim<TelegramSpeechJob>(this.store, id);
    if (activeSubmission(job)) {
      job = ownership.resetUnsent(job) ?? this.get(id);
      if (job.state !== "queued") return job;
    }
    const audio = await readStudyAudio(
      await this.files.read(job.actor, job.voice!),
    );
    const audioDigest = sha256(audio.audio);
    telegramCheck(
      !job.audioDigest || job.audioDigest === audioDigest,
      "telegram_audio_changed",
      409,
    );
    const hadReservation = hasTelegramReservationIntent(job);
    const claimed = ownership.claim({
      ...job,
      audioDigest,
      reservation: {
        keyGeneration: this.config.keyGeneration,
        started: hadReservation,
      },
    });
    if (!claimed) return this.get(id);
    job = claimed;
    const requestId = this.requestId(job);
    try {
      await this.permit(job);
      if (!ownership.owns(job.dispatchToken)) return this.get(id);
      this.beforeSubmission(job);
      // Persist before calling reserve. A lost reply cannot erase the work
      // needed to observe and release a row that may still commit.
      job = this.advance(job, {
        reservation: { ...job.reservation!, started: true },
      });
      try {
        await this.admission.reserve({
          ...this.config,
          channel: "telegram-trial",
          requestId,
          payloadDigest: audioDigest,
          units: 1,
        });
      } catch (error) {
        if (!hadReservation && capacityRefused(error)) {
          const current = this.get(id);
          if (
            current.dispatchToken !== job.dispatchToken ||
            current.retry !== job.retry ||
            current.submissionStarted !== false ||
            (current.state !== "dispatching" && current.state !== "releasing")
          )
            return current;
          // A definitive rejection of the first reserve proves this attempt
          // created no row, even if cancellation started while it was pending.
          return this.advance(current, {
            state:
              current.state === "releasing"
                ? (current.releaseTo ?? "cancelled")
                : "refused",
            reservation: { ...job.reservation!, started: false },
            finishedAt: this.now(),
            failure: current.failure ?? "speech_capacity_unavailable",
          });
        }
        if (!ownership.owns(job.dispatchToken)) return this.get(id);
        if (!(await this.reservationStatus(job)))
          return this.advance(job, {
            state: "uncertain",
            failure: "speech_pending",
          });
      }
      if (!ownership.owns(job.dispatchToken)) return this.get(id);
      await this.permit(job);
      if (!ownership.owns(job.dispatchToken)) return this.get(id);
      this.beforeSubmission(job);
      const permit = await this.admission.dispatch(requestId);
      if (!ownership.owns(job.dispatchToken)) return this.get(id);
      if (!permit.dispatch) {
        if (
          permit.reservation.state === "cancelled" ||
          permit.reservation.state === "refused"
        )
          return this.advance(job, {
            state: "refused",
            finishedAt: this.now(),
            failure: "speech_capacity_unavailable",
          });
        if (permit.reservation.state !== "dispatched")
          return this.advance(job, {
            state: "uncertain",
            submissionStarted: undefined,
            failure: "speech_pending",
          });
      }
      await this.permit(job);
      if (
        !ownership.beginSubmission(job.dispatchToken!, () =>
          this.beforeSubmission(job),
        )
      )
        return this.get(id);
    } catch (error) {
      if (!ownership.owns(job.dispatchToken)) return this.get(id);
      const revoked = telegramWorkAuthorityLost(error);
      return this.stopUnsent(
        job,
        revoked ? "cancelled" : "refused",
        revoked ? "telegram_authority_changed" : "speech_unavailable",
      );
    }
    // The provider call and accounting have separate error paths. Once this
    // marker is true, no failure can turn the job back into unsent work.
    return this.submit(this.get(id), audio);
  }
}
