import { createSignal, For, Show, onCleanup } from "solid-js";
import { Button } from "../ui.ts";
import {
  get,
  post,
  putAudio,
  type CommunityJobView,
  type CommunityUploadView,
  type CommunitySessionView,
} from "./api.ts";
import {
  audioHash,
  clearDraft,
  readDraft,
  saveDraft,
  type SongDraft,
} from "./draft.ts";
import { StemUploads, uploadStemFiles } from "./stem-upload.tsx";

const phaseText: Record<string, string> = {
  reserved: "Draft saved. Continue to upload your recording.",
  uploading: "The upload was interrupted. Continue with the saved recording.",
  uploaded: "Recording uploaded. Continue to submit it for moderation.",
  sealed: "Recording submitted. Processing will continue after you leave.",
  admission: "Checking the recording and lyrics.",
  pin_audio: "Saving the admitted recording.",
  pin_lyrics: "Saving your lyrics.",
  registration: "Registering the release to your creator wallet.",
  pin_manifest: "Preparing the public release.",
  publication: "Publishing to the community.",
  published: "Published. Find your song in Latest songs.",
  uncertain:
    "Processing was interrupted. Its saved result must be checked before continuing.",
  held: "This release is held for review and has not been published.",
  failed: "This release was rejected and has not been published.",
};
export function SongUpload(props: {
  session: CommunitySessionView;
  policy: string;
  enabled: boolean;
  refreshFeed(): Promise<void>;
}) {
  const [draft, setDraft] = createSignal<SongDraft | null>(null),
    [title, setTitle] = createSignal(""),
    [lyrics, setLyrics] = createSignal(""),
    [file, setFile] = createSignal<File | null>(null),
    [instrumental, setInstrumental] = createSignal<File | null>(null),
    [vocals, setVocals] = createSignal<File | null>(null),
    [consent, setConsent] = createSignal(false),
    [uploads, setUploads] = createSignal<CommunityUploadView[]>([]),
    [jobs, setJobs] = createSignal<Record<string, CommunityJobView>>({}),
    [busy, setBusy] = createSignal(false),
    [message, setMessage] = createSignal("Loading saved releases…"),
    [error, setError] = createSignal(false);
  let stopped = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  async function refresh() {
    const result = await get<{ uploads: CommunityUploadView[] }>(
      "/api/uploads",
    );
    if (stopped) return;
    setUploads(result.uploads);
    const status: Record<string, CommunityJobView> = {};
    for (const upload of result.uploads)
      if (upload.jobId)
        status[upload.jobId] = await get<CommunityJobView>(
          `/api/jobs/${encodeURIComponent(upload.jobId)}`,
        );
    if (stopped) return;
    const newlyPublished = Object.values(status).some(
      (j) => j.phase === "published" && jobs()[j.jobId]?.phase !== "published",
    );
    setJobs(status);
    if (newlyPublished) await props.refreshFeed();
  }
  function schedule() {
    if (stopped) return;
    timer = setTimeout(() => {
      void refresh()
        .catch(() => {})
        .finally(schedule);
    }, 8000);
  }
  async function run(action: () => Promise<void>) {
    if (busy()) return;
    setBusy(true);
    setError(false);
    try {
      await action();
    } catch (failure) {
      setError(true);
      setMessage(
        failure instanceof Error
          ? failure.message
          : "This step could not complete. Your saved release can be resumed.",
      );
    } finally {
      if (!stopped) setBusy(false);
    }
  }
  async function release() {
    let saved = draft();
    if (!saved) {
      const recording = file();
      if (
        !recording ||
        !instrumental() ||
        !vocals() ||
        !title().trim() ||
        !consent()
      )
        throw new Error(
          "Add a title, recording, instrumental, vocals and your publication consent.",
        );
      if (
        !recording.size ||
        recording.size > 25 * 1024 * 1024 ||
        !recording.name.toLowerCase().endsWith(".mp3")
      )
        throw new Error("Choose an MP3 of up to 25 MiB.");
      setMessage("Saving your recording and release details…");
      saved = {
        authorId: props.session.authorId,
        idempotencyKey: crypto.randomUUID(),
        title: title().trim(),
        language: "en",
        lyrics: lyrics(),
        file: recording,
        instrumental: instrumental()!,
        vocals: vocals()!,
        audioSha256: await audioHash(recording),
        acceptedPolicy: props.policy,
      };
      await saveDraft(saved);
      setDraft(saved);
    }
    if (!saved.submissionId) {
      setMessage("Reserving your saved release…");
      const reserved = await post<{ submissionId: string }>(
        "/api/uploads",
        {
          title: saved.title,
          language: saved.language,
          lyrics: saved.lyrics,
          original: true,
          acceptedPolicy: saved.acceptedPolicy,
          audioSha256: saved.audioSha256,
          audioBytes: saved.file.size,
        },
        props.session.csrf,
        { "idempotency-key": saved.idempotencyKey },
      );
      saved = { ...saved, submissionId: reserved.submissionId };
      await saveDraft(saved);
      setDraft(saved);
    }
    if (!saved.jobId) {
      setMessage("Uploading your saved recording…");
      await putAudio(
        `/api/uploads/${saved.submissionId}/audio`,
        saved.file,
        props.session.csrf,
      );
      setMessage("Uploading your instrumental and vocal stems…");
      await uploadStemFiles(
        saved.submissionId!,
        { instrumental: saved.instrumental, vocals: saved.vocals },
        props.session.csrf,
      );
      setMessage("Submitting your recording for moderation…");
      const sealed = await post<{ jobId: string }>(
        `/api/uploads/${saved.submissionId}/seal`,
        {},
        props.session.csrf,
      );
      saved = { ...saved, jobId: sealed.jobId };
      await saveDraft(saved);
      setDraft(saved);
    }
    setMessage(
      "Submitted. Your progress is saved; processing continues after you leave.",
    );
    await refresh();
  }
  onCleanup(() => {
    stopped = true;
    if (timer) clearTimeout(timer);
  });
  void run(async () => {
    const saved = await readDraft(props.session.authorId);
    if (stopped) return;
    if (saved) {
      setDraft(saved);
      setTitle(saved.title);
      setLyrics(saved.lyrics);
      setConsent(true);
      setMessage(
        saved.jobId
          ? "Your release and its progress are saved."
          : "Your saved release is ready to resume.",
      );
    } else setMessage("Add your recording and lyrics.");
    await refresh();
    schedule();
  });
  return (
    <section class="live-upload">
      <h2>Release a song</h2>
      <Show
        when={
          !draft()?.jobId && !props.policy.startsWith("pirate-owner-curated/")
        }
      >
        <label>
          Song title
          <input
            aria-label="Song title"
            value={title()}
            maxlength={200}
            disabled={busy() || !!draft()}
            onInput={(e) => setTitle(e.currentTarget.value)}
          />
        </label>
        <label>
          Recording
          <input
            aria-label="Recording"
            type="file"
            accept="audio/mpeg,.mp3"
            disabled={busy() || !!draft()}
            onChange={(e) => setFile(e.currentTarget.files?.[0] ?? null)}
          />
        </label>
        <Show when={draft()}>
          {(saved) => (
            <p class="live-muted">Saved recording: {saved().file.name}</p>
          )}
        </Show>
        <Show when={!draft()}>
          <label>
            Instrumental
            <input
              aria-label="Instrumental"
              type="file"
              accept="audio/mpeg,.mp3"
              disabled={busy()}
              onChange={(e) =>
                setInstrumental(e.currentTarget.files?.[0] ?? null)
              }
            />
          </label>
          <label>
            Vocals
            <input
              aria-label="Vocals"
              type="file"
              accept="audio/mpeg,.mp3"
              disabled={busy()}
              onChange={(e) => setVocals(e.currentTarget.files?.[0] ?? null)}
            />
          </label>
          <p class="live-muted">
            Add both MP3 stems. Vocals are used to align your supplied lyrics.
          </p>
        </Show>
        <label>
          Lyrics
          <textarea
            aria-label="Lyrics"
            value={lyrics()}
            maxlength={32768}
            rows={6}
            disabled={busy() || !!draft()}
            onInput={(e) => setLyrics(e.currentTarget.value)}
          />
        </label>
        <label class="live-consent">
          <input
            type="checkbox"
            checked={consent()}
            disabled={busy() || !!draft()}
            onChange={(e) => setConsent(e.currentTarget.checked)}
          />
          I have the rights needed to publish this recording and accept the
          community release policy.
        </label>
        <p class="live-muted">
          Recordings and lyrics pass moderation before publication. English
          lyrics may be supplied without timing.
        </p>
        <Button
          disabled={
            busy() ||
            !props.enabled ||
            !props.session.creator ||
            (!draft() &&
              (!file() ||
                !instrumental() ||
                !vocals() ||
                !title().trim() ||
                !consent()))
          }
          onClick={() => void run(release)}
        >
          {draft() ? "Continue saved release" : "Submit song"}
        </Button>
      </Show>
      <p role="status" class={error() ? "live-error" : "live-muted"}>
        {message()}
      </p>
      <Show
        when={
          !props.policy.startsWith("pirate-owner-curated/") &&
          draft()?.jobId &&
          ["held", "failed", "published"].includes(
            jobs()[draft()!.jobId!]?.phase ?? "",
          )
        }
      >
        <Button
          disabled={busy()}
          onClick={() =>
            void run(async () => {
              await clearDraft(props.session.authorId);
              setDraft(null);
              setTitle("");
              setLyrics("");
              setFile(null);
              setInstrumental(null);
              setVocals(null);
              setConsent(false);
              setMessage(
                "Start a new release. Your earlier release and its status stay saved.",
              );
            })
          }
        >
          Start another release
        </Button>
      </Show>
      <For each={uploads()}>
        {(upload) => {
          const job = () => (upload.jobId ? jobs()[upload.jobId] : undefined);
          return (
            <article class="live-upload-progress">
              <h3>{upload.title}</h3>
              <p>
                {phaseText[job()?.phase ?? upload.state] ??
                  "Your release is saved."}
              </p>
              <StemUploads
                submissionId={upload.submissionId}
                authorId={props.session.authorId}
                csrf={props.session.csrf}
              />
              <Show when={job()?.resumable}>
                <Button
                  disabled={busy() || !props.enabled}
                  onClick={() =>
                    void run(async () => {
                      await post(
                        `/api/jobs/${encodeURIComponent(upload.jobId!)}/resume`,
                        {},
                        props.session.csrf,
                      );
                      setMessage(
                        "Checking the saved result and continuing the same release…",
                      );
                      await refresh();
                    })
                  }
                >
                  Check and resume
                </Button>
              </Show>
            </article>
          );
        }}
      </For>
    </section>
  );
}
