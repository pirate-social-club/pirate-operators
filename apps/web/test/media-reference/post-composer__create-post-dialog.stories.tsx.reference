// The product-path composer stories. The community page renders exactly this
// component (CreatePostDialog), so every flow reviewed here is the shipped
// surface; the Parts stories demonstrate the inner components in isolation.
import { createSignal, Show } from "solid-js";
import { expect, userEvent, waitFor, within } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import type {
  PostCommunitiesCommunityIdMediaUploadReservationsInput,
  PostCommunitiesCommunityIdMediaUploadReservationsResponse,
  PostMediaPostSubmissionsSubmissionIdStemsInput,
} from "@pirate/api-client";

import type { ActivePersonaPublicProjection } from "../../../api/session";
import type { ActiveSongMediaPostSubmissionPage, MediaSubmissionSnapshot } from "../media-submission/contracts";
import { mediaCommandBody, type PersistedMediaCommand } from "../media-submission/pending";
import type { MediaCommandResult, MediaSubmissionTransport } from "../media-submission/transport";
import { CreatePostDialog } from "./create-post-dialog";
import { MobileFooterNav } from "../../shell/app-shell-chrome/app-shell-chrome";
import { toneWavUrl } from "../video-submission/story-fixtures-media";

const personas = (count: 1 | 2 = 1): ActivePersonaPublicProjection[] => [
  { personaId: "persona-one", displayName: "Persona One", avatarRef: null, primaryPublicHandle: "salt-cove.pirate", communityBinding: null },
  ...(count === 2
    ? [{ personaId: "persona-two", displayName: "Persona Two", avatarRef: null, primaryPublicHandle: "drift-reef.pirate", communityBinding: null }]
    : []),
];

const reservation: PostCommunitiesCommunityIdMediaUploadReservationsResponse = {
  reservation_id: "reservation-story",
  track: "song",
  slot: "primary_audio",
  status: "awaiting_upload",
  upload: {
    method: "PUT",
    url: "https://upload.test/song",
    required_headers: [{ name: "content-type", value: "audio/mpeg" }],
    expires_at: "2027-01-01T00:00:00Z",
  },
};

function snapshot(patch: Partial<MediaSubmissionSnapshot> = {}): MediaSubmissionSnapshot {
  const base = {
    submission_id: "submission-story",
    author_persona: { persona_id: "persona-one", object: "persona", display_name: "Persona One", avatar_ref: null, primary_public_handle: "salt-cove.pirate" },
    href: "/media-post-submissions/submission-story",
    track: "song",
    creation_revision: 1,
    audio_revision: 0,
    lyrics_state: { current: { status: "not_bound" } },
    updated_at: "2026-09-01T00:00:00Z",
    status: "processing",
    phase: "awaiting_upload",
    ...patch,
  };
  // SAFETY: the base fixture supplies every generated snapshot field and
  // patches only supply fields belonging to a reachable submission state.
  return base as MediaSubmissionSnapshot;
}

type StoryOutcome = "published" | "manual_review" | "blocked" | "processing_failed";

function outcomeSnapshot(outcome: StoryOutcome, current: MediaSubmissionSnapshot): MediaSubmissionSnapshot {
  if (outcome === "published") return snapshot({ ...current, status: "published", published_resource: { post_id: "post-story", href: "/posts/story-song-title" } });
  if (outcome === "manual_review") return snapshot({ ...current, status: "manual_review", reason_code: "review_required", review_ref: "review-story" });
  if (outcome === "blocked") return snapshot({ ...current, status: "blocked", reason_code: "policy_violation" });
  return snapshot({ ...current, status: "processing_failed", reason_code: "transform_failed", retry_count: 1, retryable: true });
}

/** In-memory song transport: one reserve/start/upload/finalize pipeline that
 * accepts lyrics and terms and settles on the requested outcome. */
const STEM_RESERVATION: Extract<PostCommunitiesCommunityIdMediaUploadReservationsResponse, { readonly track: "song" }> = {
  reservation_id: "stem-reservation",
  track: "song",
  slot: "vocal_audio",
  status: "awaiting_upload",
  upload: { method: "PUT", url: "https://upload.test/stem", required_headers: [{ name: "content-type", value: "audio/mpeg" }], expires_at: "2027-01-01T00:00:00Z" },
};

class StoryMediaTransport implements MediaSubmissionTransport {
  readonly stemCalls: string[] = [];
  async reserveStem(input: PostCommunitiesCommunityIdMediaUploadReservationsInput): Promise<PostCommunitiesCommunityIdMediaUploadReservationsResponse> {
    if (input.body.track !== "song") throw new Error("stems are song audio");
    const slot = input.body.slot;
    this.stemCalls.push(`reserve:${slot}`);
    return { ...STEM_RESERVATION, reservation_id: `stem-reservation-${slot}`, slot };
  }
  async attachStem(input: PostMediaPostSubmissionsSubmissionIdStemsInput): Promise<MediaSubmissionSnapshot> {
    this.stemCalls.push(`attach:${input.body.slot}`);
    const current = this.snapshot;
    if (current === null) throw new Error("missing stem submission");
    const stems = { instrumental_audio: current.stems?.instrumental_audio ?? null, vocal_audio: current.stems?.vocal_audio ?? null };
    stems[input.body.slot] = { status: "sealed", content_type: "audio/mpeg", size_bytes: 16 };
    const next = { ...current, stems };
    this.snapshot = next;
    return next;
  }
  async listActive(): Promise<ActiveSongMediaPostSubmissionPage> { return { object: "active_song_media_post_submission_page", items: [], next_cursor: null }; }
  snapshot: MediaSubmissionSnapshot | null = null;
  readonly commands: PersistedMediaCommand[] = [];
  uploadCount = 0;
  readonly outcome: StoryOutcome;

  constructor(outcome: StoryOutcome = "published") {
    this.outcome = outcome;
  }

  async dispatch(command: PersistedMediaCommand): Promise<MediaCommandResult> {
    this.commands.push(command);
    if (command.kind === "reserve") return reservation;
    if (command.kind === "start") {
      this.snapshot = snapshot();
      return this.snapshot;
    }
    if (this.snapshot === null) throw new Error("missing story submission");
    if (command.kind === "terms") {
      this.snapshot = outcomeSnapshot(this.outcome, this.snapshot);
      return this.snapshot;
    }
    if (command.kind === "finalize") {
      this.snapshot = snapshot({ creation_revision: this.snapshot.creation_revision, audio_revision: 1, phase: "analysis" });
      if (this.outcome === "blocked" || this.outcome === "processing_failed") this.snapshot = outcomeSnapshot(this.outcome, this.snapshot);
      return this.snapshot;
    }
    if (command.kind === "lyrics") {
      const bodyValue: unknown = JSON.parse(new TextDecoder().decode(await mediaCommandBody(command)));
      // SAFETY: mediaCommandBody digest-checks generated request bytes; this
      // fixture reads only the lyrics field needed to model the API response.
      const body = bodyValue as { lyrics: string };
      const creationRevision = this.snapshot.creation_revision + 1;
      this.snapshot = snapshot({
        ...this.snapshot,
        creation_revision: creationRevision,
        audio_revision: 1,
        lyrics_state: { current: { status: "ready", text: body.lyrics, lyrics_revision: creationRevision, audio_revision: 1 } },
      });
    }
    return this.snapshot;
  }

  async read(): Promise<MediaSubmissionSnapshot | null> {
    return this.snapshot;
  }

  async upload(_reservation: PostCommunitiesCommunityIdMediaUploadReservationsResponse, audio: Blob): Promise<void> {
    if (audio.size === 0) throw new Error("story audio must not be empty");
    this.uploadCount += 1;
  }
}

/** A song transport whose audio upload never completes, so Next fails. */
class FailingUploadStoryTransport extends StoryMediaTransport {
  override async upload(): Promise<void> {
    throw new Error("The audio upload did not finish. Try again.");
  }
}

const storyMp3 = (name = "midnight-waves.mp3") =>
  new File([new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])], name, { type: "audio/mpeg" });

async function uploadStorySong(canvas: ReturnType<typeof within>, withStems = true): Promise<void> {
  await userEvent.upload(await canvas.findByLabelText("Upload audio"), storyMp3());
  if (withStems) {
    await userEvent.upload(await canvas.findByLabelText("Upload instrumental"), storyMp3("instrumental.mp3"));
    await userEvent.upload(await canvas.findByLabelText("Upload vocals"), storyMp3("vocals.mp3"));
  }
  // Upload dispatch does not await metadata extraction. The field can exist
  // before its value settles, so presence alone is not a readiness assertion.
  await waitFor(async () => {
    await expect(canvas.getByRole("textbox", { name: "Song title" })).toHaveValue("midnight-waves");
  });
}

async function continueSongStep(canvas: ReturnType<typeof within>): Promise<void> {
  const button = await canvas.findByRole("button", { name: "Next" });
  await waitFor(async () => { await expect(button).toBeEnabled(); });
  await userEvent.click(button);
}

interface StoryOptions {
  readonly personaCount?: 1 | 2;
  readonly personaId?: string;
  readonly mediaTransport?: MediaSubmissionTransport;
}

function dialogHarness(options: StoryOptions = {}) {
  const mediaTransport = options.mediaTransport ?? new StoryMediaTransport();
  return {
    mediaTransport,
    render: (open = true) => (
      <CreatePostDialog
        communityContext={{ id: "community-one", name: "Pirate Harbor" }}
        mediaTransport={mediaTransport}
        onOpenChange={() => {}}
        onPublished={() => {}}
        open={open}
        personaId={options.personaId}
        personas={personas(options.personaCount ?? 1)}
        principalId="account-one"
      />
    ),
  };
}

const meta = {
  title: "Flows/Posts/CreatePostForm",
  component: CreatePostDialog,
  args: {
    open: true,
    onOpenChange: () => {},
  },
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "The song steps and video flow opened from the community composer. It adds no dialog chrome, profile choice, or audience policy; the app supplies that context. Deterministic in-memory transports stand in for the network.",
      },
    },
  },
} satisfies Meta<typeof CreatePostDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ContextualSong: Story = {
  name: "Contextual / Song",
  render: () => dialogHarness().render(),
};

/** A host that honours dismissal. The other stories pin `open` and ignore
 * `onOpenChange`, which is right for reviewing a surface but means closing can
 * only be assumed there. This one closes, and offers the way back, so dismissal
 * and reopening can be observed. */
export const ContextualSongDismissible: Story = {
  name: "Contextual / Song / Dismissible",
  render: () => {
    const [open, setOpen] = createSignal(true);
    const mediaTransport = new StoryMediaTransport();
    return (
      <>
        <Show when={!open()}>
          <button onClick={() => setOpen(true)} type="button">Open the composer</button>
        </Show>
        <CreatePostDialog
          communityContext={{ id: "community-one", name: "Pirate Harbor" }}
          mediaTransport={mediaTransport}
          onOpenChange={setOpen}
          onPublished={() => {}}
          open={open()}
          personas={personas(1)}
          principalId="account-one"
        />
      </>
    );
  },
};

export const ContextualSongMobile: Story = {
  ...ContextualSong,
  name: "Contextual / Song / Mobile",
  globals: { viewport: { value: "mobile1", isRotated: false } },
};

export const ContextualVideoMobile: Story = {
  name: "Contextual / Video / Choose song first",
  globals: { viewport: { value: "mobile1", isRotated: false } },
  render: () => (
    <CreatePostDialog
      communityContext={{ id: "community-one", name: "Pirate Harbor" }}
      onOpenChange={() => {}}
      open
      initialMode="video"
      personaId="persona-one"
      personas={personas(1).map(persona => ({
        ...persona,
        communityBinding: { communityId: "community-one", bindingSource: "first_membership" as const },
      }))}
      principalId="account-one"
      videoSongPicker={async () => ({
        songs: [{ postId: "cadence", title: "Cadence", artist: "salt-cove.pirate", artworkSrc: null }],
        nextCursor: null,
      })}
      videoSongReader={async request => ({
        postId: request.kind === "post" ? request.postId : "cadence",
        audioUrl: toneWavUrl(120_000),
        title: "Cadence",
      })}
      videoSongPreflight={async input => ({
        state: "ready",
        song_post_id: input.body.song_post_id,
        audio_revision: 7,
        canonical_duration_samples: 120_000 * 48,
        interval_policy: {
          policy_revision: 1,
          sample_rate_hz: 48_000,
          min_clip_duration_samples: 3_000 * 48,
          max_clip_duration_samples: 120_000 * 48,
        },
        interval: input.body.interval ? { accepted: true } : null,
      })}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await canvas.findByRole("dialog", { name: "Choose a song" });
    await canvas.findByRole("searchbox", { name: "Search songs or paste a link" });
    expect(canvas.queryByRole("button", { name: "Start recording" })).toBeNull();
  },
};

/** The composer opens over a page whose mobile tab bar stays mounted, as on a
 * community page. The composer must cover that bar: on a Pixel the bar sat in
 * the same layer, rendered later, and took the tap meant for the publish button. */
export const ContextualSongOverMobileNavigation: Story = {
  name: "Contextual / Song / Over mobile navigation",
  globals: { viewport: { value: "mobile1", isRotated: false } },
  render: () => (
    <>
      {dialogHarness().render()}
      <MobileFooterNav
        forceMobile
        labels={{ home: "Home", songs: "Your songs", wallet: "Wallet", profile: "Profile", primaryNavAriaLabel: "Primary navigation" }}
      />
    </>
  ),
  play: async ({ canvasElement }) => {
    const form = await within(canvasElement).findByRole("form", { name: "Post a song" });
    const nav = canvasElement.ownerDocument.querySelector("nav[aria-label='Primary navigation']");
    await expect(nav).not.toBeNull();
    const box = nav!.getBoundingClientRect();
    await expect(box.height).toBeGreaterThan(0);
    const hit = canvasElement.ownerDocument.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    await expect(hit !== null && form.contains(hit)).toBe(true);
  },
};

export const ContextualSongMultiplePersonas: Story = {
  name: "Contextual / Song / App-selected persona",
  render: () => dialogHarness({ personaCount: 2, personaId: "persona-two" }).render(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await expect(await canvas.findByRole("button", { name: "Next" })).toBeInTheDocument();
    await waitFor(async () => {
      await expect(canvas.queryByRole("button", { name: /^Post as: / })).not.toBeInTheDocument();
    });
  },
};

export const SongStepSong: Story = {
  name: "Song / Step 1 — Song",
  render: () => dialogHarness().render(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await uploadStorySong(canvas);
  },
};

export const SongStepSongMobile: Story = {
  ...SongStepSong,
  name: "Song / Step 1 — Song / Mobile",
  globals: { viewport: { value: "mobile1", isRotated: false } },
};

/** The author adds the instrumental and vocals, which unlock Karaoke and
 * Study; both upload after the song on Next. */
export const SongStepStemsMobile: Story = {
  name: "Song / Step 1 — Song / Instrumental and vocals / Mobile",
  globals: { viewport: { value: "mobile1", isRotated: false } },
  render: () => dialogHarness().render(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await uploadStorySong(canvas, false);
    await expect(canvas.getByRole("button", { name: "Next" })).toBeDisabled();
    await userEvent.upload(await canvas.findByLabelText("Upload instrumental"), storyMp3("midnight-waves-instrumental.mp3"));
    await expect(canvas.getByRole("button", { name: "Next" })).toBeDisabled();
    await userEvent.upload(await canvas.findByLabelText("Upload vocals"), storyMp3("midnight-waves-vocals.mp3"));
    await expect(await canvas.findByText("midnight-waves-instrumental.mp3")).toBeInTheDocument();
    await expect(await canvas.findByText("midnight-waves-vocals.mp3")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Remove vocals" })).toBeInTheDocument();
    await waitFor(async () => { await expect(canvas.getByRole("button", { name: "Next" })).toBeEnabled(); });
  },
};

class StemUploadRetryStoryTransport extends StoryMediaTransport {
  private failed = false;
  override async upload(reservation: PostCommunitiesCommunityIdMediaUploadReservationsResponse, audio: Blob): Promise<void> {
    if (reservation.slot === "vocal_audio" && !this.failed) {
      this.failed = true;
      throw new Error("Vocals upload failed. Try again.");
    }
    return super.upload(reservation, audio);
  }
}

export const SongStemUploadRetry: Story = {
  name: "Song / Step 1 — Song / Retry vocals after primary sealing",
  render: () => dialogHarness({ mediaTransport: new StemUploadRetryStoryTransport() }).render(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await uploadStorySong(canvas);
    await continueSongStep(canvas);
    await expect(await canvas.findByRole("alert")).toHaveTextContent("Vocals upload failed");
    await expect(canvas.getByRole("button", { name: "Remove instrumental" })).toBeDisabled();
    await expect(canvas.getByRole("button", { name: "Remove vocals" })).toBeEnabled();
    await expect(canvas.queryByText("Your cut of remix sales")).not.toBeInTheDocument();
    await continueSongStep(canvas);
    await expect(await canvas.findByText("Your cut of remix sales")).toBeInTheDocument();
  },
};

class LostStemResponseStoryTransport extends StoryMediaTransport {
  override async attachStem(input: PostMediaPostSubmissionsSubmissionIdStemsInput): Promise<MediaSubmissionSnapshot> {
    const result = await super.attachStem(input);
    if (input.body.slot === "vocal_audio") throw new Error("Attachment response lost");
    return result;
  }
}

export const SongStemAttachmentResponseLost: Story = {
  name: "Song / Step 1 — Song / Reconcile lost attachment response",
  render: () => dialogHarness({ mediaTransport: new LostStemResponseStoryTransport() }).render(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await uploadStorySong(canvas);
    await continueSongStep(canvas);
    await expect(await canvas.findByText("Your cut of remix sales")).toBeInTheDocument();
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument();
  },
};

/** Long lyrics on a phone: after scrolling to the bottom of the form, the
 * header with Next stays on screen. */
export const SongStepLongLyricsMobile: Story = {
  name: "Song / Step 1 — Song / Long lyrics / Mobile",
  globals: { viewport: { value: "mobile1", isRotated: false } },
  render: () => dialogHarness().render(),
  play: async ({ canvasElement }) => {
    const doc = canvasElement.ownerDocument;
    const canvas = within(doc.body);
    await uploadStorySong(canvas);
    const lyrics = await canvas.findByLabelText("Lyrics");
    await waitFor(async () => {
      const field = canvas.getByLabelText<HTMLTextAreaElement>("Lyrics");
      if (field.value === "") {
        field.value = Array.from({ length: 80 }, (_, line) => `Line ${line + 1} of a very long song`).join("\n");
        field.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await expect(field.value.split("\n")).toHaveLength(80);
    });
    await expect(lyrics).toBeInTheDocument();
    const form = doc.querySelector<HTMLElement>("[data-create-post-form]")!;
    form.scrollTop = form.scrollHeight;
    await waitFor(async () => {
      const forward = doc.querySelector<HTMLElement>("[data-composer-forward]")!;
      const box = forward.getBoundingClientRect();
      await expect(form.scrollTop).toBeGreaterThan(0);
      await expect(box.top).toBeGreaterThanOrEqual(0);
      await expect(box.bottom).toBeLessThanOrEqual(doc.defaultView!.innerHeight);
      // Nothing scrolls visibly above the header: the top edge is the header.
      const topEdge = doc.elementFromPoint(doc.defaultView!.innerWidth / 2, 2);
      await expect(topEdge?.closest("[data-composer-sticky-header]")).not.toBeNull();
    });
  },
};

export const SongLyricsOnSongStep: Story = {
  name: "Song / Lyrics on the Song step",
  render: () => dialogHarness().render(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await uploadStorySong(canvas);
    const lyrics = await canvas.findByLabelText("Lyrics");
    await userEvent.type(lyrics, "A line carried on the tide");
    await waitFor(async () => { await expect(lyrics).toHaveValue("A line carried on the tide"); });
  },
};

export const SongStepRights: Story = {
  name: "Song / Step 2 — Royalties",
  render: () => dialogHarness().render(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await uploadStorySong(canvas);
    await continueSongStep(canvas);
    await expect(await canvas.findByText("Your cut of remix sales")).toBeInTheDocument();
    await expect(canvas.getByRole("radio", { name: "10%" })).toHaveAttribute("aria-checked", "true");
    await expect(await canvas.findByText("Earnings split")).toBeInTheDocument();
    await expect(canvas.getByText("100%")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Add collaborator" })).toBeVisible();
  },
};

/** A real observer request held while the author navigates the editable steps. */
export const SongStepsWithoutPolling: Story = {
  name: "Song / States / Editing without background reads",
  render: () => dialogHarness().render(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await uploadStorySong(canvas);
    await continueSongStep(canvas);
    await canvas.findByText("Your cut of remix sales");
    await expect(canvas.getByRole("button", { name: "Next" })).toBeEnabled();
    await expect(canvas.getByRole("button", { name: "Add collaborator" })).toBeEnabled();
    await userEvent.click(canvas.getByRole("button", { name: "Next" }));
    await canvas.findByRole("heading", { name: "Review" });
    await expect(canvas.getByRole("button", { name: "Post" })).toBeEnabled();
    await expect(canvas.getByRole("button", { name: "Post" })).not.toHaveAttribute("aria-busy", "true");
    await expect(canvas.getByRole("button", { name: "Back" })).toBeEnabled();
    await expect(canvasElement.querySelector("[data-media-composer-state]")).toBeNull();
    await expect(canvas.queryByRole("button", { name: "Save reviewed lyrics" })).not.toBeInTheDocument();
  },
};

export const SongTermsPending: Story = {
  name: "Song / States / Sending Post",
  render: () => {
    class HeldTermsTransport extends StoryMediaTransport {
      override async dispatch(command: PersistedMediaCommand): Promise<MediaCommandResult> {
        if (command.kind === "terms") return new Promise(() => {});
        return super.dispatch(command);
      }
    }
    return dialogHarness({ mediaTransport: new HeldTermsTransport() }).render();
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await uploadStorySong(canvas);
    await continueSongStep(canvas);
    await continueSongStep(canvas);
    await userEvent.click(await canvas.findByRole("button", { name: "Post" }));
    await waitFor(async () => { await expect(canvas.getByRole("button", { name: "Post" })).toHaveAttribute("aria-busy", "true"); });
    await expect(canvasElement.querySelector("[data-media-composer-state]")).toBeNull();
    await expect(canvas.queryByText("Checking on your song…")).not.toBeInTheDocument();
  },
};

export const SongAcceptedWhileStatusUnavailable: Story = {
  name: "Song / States / Accepted before status read",
  render: () => {
    class HeldAfterTermsTransport extends StoryMediaTransport {
      accepted = false;
      override async dispatch(command: PersistedMediaCommand): Promise<MediaCommandResult> {
        if (command.kind === "terms" && this.snapshot !== null) {
          this.accepted = true;
          this.snapshot = snapshot({ ...this.snapshot, creation_revision: this.snapshot.creation_revision + 1 });
          return this.snapshot;
        }
        return super.dispatch(command);
      }
      override async read(): Promise<MediaSubmissionSnapshot | null> {
        return this.accepted ? new Promise(() => {}) : super.read();
      }
    }
    return dialogHarness({ mediaTransport: new HeldAfterTermsTransport() }).render();
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await uploadStorySong(canvas);
    await continueSongStep(canvas);
    await continueSongStep(canvas);
    await userEvent.click(await canvas.findByRole("button", { name: "Post" }));
    await expect(await canvas.findByRole("heading", { name: "Processing your song" })).toBeVisible();
    await expect(canvas.queryByRole("heading", { name: "Review" })).not.toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: "Save reviewed lyrics" })).not.toBeInTheDocument();
    await expect(canvasElement.querySelector("[data-media-composer-state]")).toBeNull();
  },
};

/** Two eligible profiles so the collaborator picker can be exercised. */
export const SongStepRightsCollaborators: Story = {
  name: "Song / Step 2 — Royalties / Collaborators",
  render: () => dialogHarness({ personaCount: 2 }).render(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await uploadStorySong(canvas);
    await continueSongStep(canvas);
    await userEvent.click(await canvas.findByRole("button", { name: "Add collaborator" }));
    await expect(await canvas.findByRole("button", { name: /Persona Two/u })).toBeInTheDocument();
    await expect(canvas.queryByText(/Only your profiles/u)).not.toBeInTheDocument();
  },
};

export const SongStepReview: Story = {
  name: "Song / Step 3 — Review",
  render: () => dialogHarness().render(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await uploadStorySong(canvas);
    await continueSongStep(canvas);
    // Both steps name their action Next. Confirm the new step before
    // looking up the next action, rather than clicking the old button twice.
    await expect(await canvas.findByText("Your cut of remix sales")).toBeInTheDocument();
    await continueSongStep(canvas);
    await expect(await canvas.findByText("Remix earnings")).toBeInTheDocument();
    await expect(await canvas.findByText("Earnings split")).toBeInTheDocument();
    await expect(await canvas.findByText("You 100%")).toBeInTheDocument();
    await expect(await canvas.findByText("No lyrics added")).toBeInTheDocument();
  },
};

/** A failed upload shows the retained file, its real error, and a retry. */
export const SongUploadFailed: Story = {
  name: "Song / States / Upload failed on Continue",
  render: () => dialogHarness({ mediaTransport: new FailingUploadStoryTransport() }).render(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await uploadStorySong(canvas);
    await continueSongStep(canvas);
    await expect(await canvas.findByRole("alert")).toHaveTextContent("The audio upload did not finish. Try again.");
    await expect(canvas.getByRole("heading", { name: "Audio upload needs another try" })).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Try upload again" })).toBeInTheDocument();
    await expect(canvas.queryByText(/awaiting upload/i)).not.toBeInTheDocument();
    await expect(canvas.queryByText("Your cut of remix sales")).not.toBeInTheDocument();
  },
};

export const SongUploadFailedMobile: Story = {
  ...SongUploadFailed,
  name: "Song / States / Upload failed on Continue / Mobile",
  globals: { viewport: { value: "mobile1", isRotated: false } },
};

export const SongManualReview: Story = {
  name: "Song / States / Manual review",
  render: () => dialogHarness({ mediaTransport: new StoryMediaTransport("manual_review") }).render(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await uploadStorySong(canvas);
    await continueSongStep(canvas);
    await continueSongStep(canvas);
    await userEvent.click(await canvas.findByRole("button", { name: "Post" }));
    await expect(await canvas.findByRole("heading", { name: "Waiting for review" })).toBeVisible();
    await expect(canvas.queryByRole("heading", { name: "Review" })).not.toBeInTheDocument();
  },
};

export const SongBlocked: Story = {
  name: "Song / States / Blocked",
  render: () => dialogHarness({ mediaTransport: new StoryMediaTransport("blocked") }).render(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await uploadStorySong(canvas);
    await continueSongStep(canvas);
    await expect(await canvas.findByText("This song was blocked by policy.")).toBeInTheDocument();
  },
};

export const SongRetryableFailure: Story = {
  name: "Song / States / Retryable failure",
  render: () => dialogHarness({ mediaTransport: new StoryMediaTransport("processing_failed") }).render(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await uploadStorySong(canvas);
    await continueSongStep(canvas);
    await expect(await canvas.findByText(/Song processing failed/)).toBeInTheDocument();
    await expect(await canvas.findByRole("button", { name: "Retry processing" })).toBeInTheDocument();
  },
};
