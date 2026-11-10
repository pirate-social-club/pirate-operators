import { sha256 } from "viem";
import { readStudyAudio } from "./study-spoken.ts";
import { telegramCheck } from "../packages/telegram/contracts.ts";
import type { TelegramLinkedStudyPort } from "../packages/telegram/study-contracts.ts";
import type { TelegramStudyWork } from "../packages/telegram/work.ts";
import { linkedLessonView } from "./telegram-linked-study.ts";
import type { TelegramVoiceFiles } from "./telegram-speech.ts";
import type { TelegramJournal } from "./telegram-store.ts";
import { telegramWorkClaim } from "./telegram-work-claim.ts";

/** The existing Study service owns attempts, provider admission, policy,
 * publication and economic uniqueness. This layer only journals chat work. */
export async function workTelegramLinked(
  options: {
    store: TelegramJournal;
    linked: TelegramLinkedStudyPort;
    files: TelegramVoiceFiles;
    permit(job: TelegramStudyWork): Promise<void>;
    beforeSubmission(job: TelegramStudyWork): void;
    now(): number;
  },
  input: TelegramStudyWork,
) {
  let job = input;
  const ownership = telegramWorkClaim<TelegramStudyWork>(options.store, job.id);
  const read = () =>
    options.store.get<TelegramStudyWork>(`speech-job:${job.id}`)!;
  const save = (value: TelegramStudyWork) => {
    return ownership.save(job, value) ?? read();
  };
  await options.permit(job);
  telegramCheck(job.grant, "telegram_connection_required", 403);
  if (
    ["dispatching", "uncertain"].includes(job.state) &&
    job.submissionStarted === false
  )
    job = ownership.resetUnsent(job) ?? read();
  if (job.state === "dispatching" || job.state === "uncertain") {
    telegramCheck(job.audioDigest, "telegram_audio_missing", 409);
    const result = await options.linked.recover(
      job.actor,
      job.grant!,
      job.lessonId,
      job.expected,
      job.audioDigest,
    );
    if (
      !result.attempt ||
      !["assessed", "unavailable"].includes(result.attempt.state)
    )
      return save({ ...read(), state: "uncertain" });
    await options.permit(job);
    return save({
      ...read(),
      state: result.attempt.state === "assessed" ? "assessed" : "refused",
      finishedAt: result.attempt.completedAt ?? options.now(),
      grade: result.attempt.grade,
      failure: result.attempt.failure,
      resultView: linkedLessonView(result.lesson, job.songKey),
    });
  }
  telegramCheck(
    job.state === "queued" && job.voice,
    "telegram_work_not_queued",
    409,
  );
  const audio = await readStudyAudio(
      await options.files.read(job.actor, job.voice),
    ),
    audioDigest = sha256(audio.audio);
  const claimed = ownership.claim({ ...job, audioDigest });
  if (!claimed) return read();
  job = claimed;
  try {
    await options.permit(job);
    if (
      !ownership.beginSubmission(job.dispatchToken!, () =>
        options.beforeSubmission(job),
      )
    )
      return read();
    const result = await options.linked.answer(
      job.actor,
      job.grant!,
      job.lessonId,
      job.expected,
      new Request("https://telegram-study.invalid/audio", {
        method: "PUT",
        headers: {
          "content-type": audio.contentType,
          "x-study-duration-ms": String(audio.durationMs),
        },
        body: new Uint8Array(audio.audio),
      }),
    );
    await options.permit(job);
    return save({
      ...read(),
      state:
        result.attempt.state === "assessed"
          ? "assessed"
          : result.attempt.state === "unavailable"
            ? "refused"
            : "uncertain",
      grade: result.attempt.grade,
      failure: result.attempt.failure,
      finishedAt: result.attempt.completedAt,
      resultView: linkedLessonView(result.lesson, job.songKey),
    });
  } catch (error) {
    // A submitted request may have crossed the service boundary. Recover its
    // exact attempt/audio receipt, never upload it as another counted take.
    save({ ...read(), state: "uncertain", failure: "speech_pending" });
    throw error;
  }
}
