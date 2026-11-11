import { botFixture } from "./telegram-bot-fixture.ts";
import type { TelegramStudyWork } from "../packages/telegram/work.ts";
import { TelegramTrialSpeech } from "../services/telegram-speech.ts";
import { TelegramSqlJournal } from "../services/telegram-store.ts";

/** Controlled suspension only; no sleeps, files, sockets, workers or providers. */
export function barrier() {
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    waiting,
    release,
    async pause() {
      entered();
      await released;
    },
  };
}
export async function queuedVoice(f: Awaited<ReturnType<typeof botFixture>>) {
  await f.webhook(f.voiceUpdate());
  for (const row of f.store.entries<string>("update-ready:"))
    await f.bot.processUpdate(row.value);
  return f.store.entries<TelegramStudyWork>("speech-job:").at(-1)!.value;
}
export function restartedSpeech(
  f: Awaited<ReturnType<typeof botFixture>>,
  pause?: ReturnType<typeof barrier>,
) {
  let once = true;
  return new TelegramTrialSpeech({
    store: new TelegramSqlJournal(f.storage),
    config: f.speech.config,
    admission: f.speech.admission,
    transcriber: f.speech.transcriber,
    files: f.files,
    now: f.now,
    beforeSubmission: (job) =>
      f.study.beforeSubmission(job as TelegramStudyWork),
    async permit(job) {
      if (pause && once && job.state === "dispatching") {
        once = false;
        await pause.pause();
      }
      await f.study.permit(job as TelegramStudyWork);
    },
  });
}
export async function connect(f: Awaited<ReturnType<typeof botFixture>>) {
  const flow = await f.begin();
  return f.complete(flow, await f.verify(flow));
}
