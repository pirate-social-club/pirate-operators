import type {
  CommunityJobView,
  CommunityUploadView,
  CommunityFeed,
} from "../api-contract.ts";
import type { SongSubmissionView } from "./reference/src/features/posts/media-submission/projection.ts";
import type { SongObservationSource } from "./reference/src/features/posts/song-submission/song-observation-machine.ts";
import {
  OWNER_RELEASE_POLICY,
  fileHash,
  mp3Issue,
  songCapability,
  type CommunityOwner,
} from "./community-contracts.ts";
import { jsonWrite, type CommunityHttp } from "./community-http.ts";
import {
  createScopedBrowserStorage,
  type ScopedStorage,
  type BrowserStoragePlatform,
} from "./community-browser-storage.ts";

export interface SongReleaseInput {
  title: string;
  lyrics: string;
  language: string;
  file: File;
  instrumental: File;
  vocals: File;
  originalConsent: boolean;
  rating: "general" | "adult" | null;
}
export type SongCommand =
  | "reserve"
  | "audio"
  | "instrumental-reserve"
  | "instrumental-upload"
  | "vocals-reserve"
  | "vocals-upload"
  | "seal"
  | "resume";
export interface CommunitySongDraft {
  version: "pirate.community-song-draft/1";
  accountId: string;
  communityId: string;
  authorId: string;
  requestId: string;
  body: {
    title: string;
    language: string;
    lyrics: string;
    original: true;
    acceptedPolicy: string;
    audioSha256: string;
    audioBytes: number;
    rating?: "general" | "adult";
  };
  bodyDigest: string;
  files: { audio: File; instrumental: File; vocals: File };
  hashes: { audio: string; instrumental: string; vocals: string };
  submissionId?: string;
  postId?: string;
  jobId?: string;
  master: boolean;
  stems: { instrumental: boolean; vocals: boolean };
  pending: SongCommand | null;
  job?: CommunityJobView;
}
export function createBrowserSongStorage(
  owner: CommunityOwner,
  platform?: BrowserStoragePlatform,
) {
  return createScopedBrowserStorage<CommunitySongDraft>({
    accountId: owner.accountId,
    communityId: owner.communityId,
    kind: "song",
    signal: owner.signal,
    platform,
    validate: (draft) => {
      if (
        draft.version !== "pirate.community-song-draft/1" ||
        draft.authorId !== owner.authorId ||
        ![
          draft.files.audio,
          draft.files.instrumental,
          draft.files.vocals,
        ].every((file) => file instanceof File)
      )
        throw new Error("Saved release File/authority is unavailable.");
    },
  });
}
const id = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(value);
const digest = (body: object) => fileHash(new Blob([JSON.stringify(body)]));
const phases = [
  "admission",
  "pin_audio",
  "pin_lyrics",
  "registration",
  "pin_manifest",
  "publication",
  "published",
  "uncertain",
  "held",
  "failed",
];

/** Same decentralized protocol as live/upload.tsx, draft.ts and stem-upload.tsx;
 * no legacy form runtime, creator provider or synthesized receipt. */
export class CommunitySongController {
  private record: CommunitySongDraft | null = null;
  private busy = false;
  private generation = 0;
  private operationGeneration = 0;
  private uploadAbort: AbortController | undefined;
  private readonly owner: CommunityOwner;
  private readonly store: ScopedStorage<CommunitySongDraft>;
  private readonly http: CommunityHttp;
  private readonly changed: (record: CommunitySongDraft | null) => void;
  constructor(ports: {
    owner: CommunityOwner;
    store: ScopedStorage<CommunitySongDraft>;
    http: CommunityHttp;
    onChange?: (record: CommunitySongDraft | null) => void;
  }) {
    this.owner = ports.owner;
    this.store = ports.store;
    this.http = ports.http;
    this.changed = ports.onChange ?? (() => {});
  }
  get current() {
    return this.record;
  }
  get working() {
    return this.busy;
  }
  pause() {
    this.generation++;
    this.uploadAbort?.abort();
  }
  private assertActive() {
    this.owner.assert();
    if (this.operationGeneration !== this.generation)
      throw new Error(
        "Release paused; continue the same saved release explicitly.",
      );
  }
  private require() {
    if (!this.record) throw new Error("No saved release.");
    return this.record;
  }
  private async save(next: CommunitySongDraft) {
    await this.store.save(next);
    this.record = next;
    if (this.owner.active() && this.operationGeneration === this.generation)
      this.changed(next);
  }
  private async exclusive<T>(work: () => Promise<T>) {
    if (this.busy) throw new Error("A release step is already in progress.");
    this.busy = true;
    this.operationGeneration = this.generation;
    try {
      return await this.store.exclusive(async () => {
        this.assertActive();
        this.record = await this.store.load();
        if (this.record) await this.validate(this.record);
        if (this.owner.active() && this.operationGeneration === this.generation)
          this.changed(this.record);
        this.assertActive();
        return await work();
      });
    } finally {
      this.busy = false;
    }
  }
  private async validate(draft: CommunitySongDraft) {
    if (
      draft.version !== "pirate.community-song-draft/1" ||
      draft.accountId !== this.owner.accountId ||
      draft.communityId !== this.owner.communityId ||
      draft.authorId !== this.owner.authorId ||
      draft.bodyDigest !== (await digest(draft.body)) ||
      draft.body.audioBytes !== draft.files.audio.size
    )
      throw new Error("Saved release authority or request changed.");
    if (!draft.jobId)
      for (const slot of ["audio", "instrumental", "vocals"] as const)
        if ((await fileHash(draft.files[slot])) !== draft.hashes[slot])
          throw new Error("Saved release recording changed.");
    if (draft.hashes.audio !== draft.body.audioSha256)
      throw new Error("Saved master digest changed.");
  }
  private async capture(input: SongReleaseInput) {
    if (!songCapability(this.owner.current).allowed)
      throw new Error(songCapability(this.owner.current).reason);
    for (const file of [input.file, input.instrumental, input.vocals]) {
      const issue = mp3Issue(file);
      if (issue) throw new Error(issue);
    }
    if (
      !input.originalConsent ||
      !input.title.trim() ||
      input.title.length > 200 ||
      input.lyrics.length > 32768 ||
      input.language.length > 35 ||
      !/^(und|[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/.test(input.language) ||
      input.lyrics.split(/\r?\n/).filter((line) => line.trim()).length > 2000
    )
      throw new Error("Check title, lyrics, language and publication consent.");
    const policy = this.owner.current.capabilities.policyVersion;
    if (policy === OWNER_RELEASE_POLICY && !input.rating)
      throw new Error("Declare the release rating before reserving it.");
    const hashes = {
      audio: await fileHash(input.file),
      instrumental: await fileHash(input.instrumental),
      vocals: await fileHash(input.vocals),
    };
    const body = {
      title: input.title.trim(),
      language: input.language,
      lyrics: input.lyrics,
      original: true as const,
      acceptedPolicy: policy,
      audioSha256: hashes.audio,
      audioBytes: input.file.size,
      ...(policy === OWNER_RELEASE_POLICY ? { rating: input.rating! } : {}),
    };
    return {
      body,
      bodyDigest: await digest(body),
      hashes,
      files: {
        audio: input.file,
        instrumental: input.instrumental,
        vocals: input.vocals,
      },
    };
  }
  private async command<T>(
    kind: SongCommand,
    request: () => Promise<T>,
    accept: (reply: T) => CommunitySongDraft,
  ) {
    this.assertActive();
    const context = this.owner.current;
    if (
      !context.session.publisher ||
      !context.capabilities.upload ||
      !context.capabilities.publication ||
      context.capabilities.policyVersion !== this.require().body.acceptedPolicy
    )
      throw new Error(
        "Publishing authority or captured release policy changed.",
      );
    await this.save({ ...this.require(), pending: kind });
    this.assertActive();
    const reply = await request();
    await this.save({ ...accept(reply), pending: null }); // Save even a late canonical reply.
    this.assertActive();
  }
  private async recoverUploads() {
    const draft = this.require();
    if (!draft.submissionId) return;
    const page = await this.http<{ uploads: CommunityUploadView[] }>(
      "/api/uploads",
    );
    this.assertActive();
    const matches = page.uploads.filter(
      (row) => row.submissionId === draft.submissionId,
    );
    if (
      matches.length !== 1 ||
      matches[0].postId !== draft.postId ||
      (draft.jobId && matches[0].jobId !== draft.jobId)
    )
      throw new Error(
        "The saved submission could not be confirmed in its account.",
      );
    const row = matches[0];
    if (row.jobId && !id(row.jobId))
      throw new Error("Canonical job identity is unavailable.");
    const stems = await this.http<{
      stems: {
        slot: string;
        state: string;
        sha256: string;
        byteLength: number;
      }[];
    }>(`/api/uploads/${draft.submissionId}/stems`);
    const sealed = (slot: "instrumental" | "vocals") =>
      stems.stems.some(
        (value) =>
          value.slot === slot &&
          value.state === "sealed" &&
          value.sha256 === draft.hashes[slot] &&
          value.byteLength === draft.files[slot].size,
      );
    const master =
      this.require().master ||
      ["uploaded", "sealed", ...phases].includes(row.state);
    const pending =
      (draft.pending === "audio" && master) ||
      (draft.pending === "seal" && row.jobId) ||
      (draft.pending?.startsWith("instrumental-") && sealed("instrumental")) ||
      (draft.pending?.startsWith("vocals-") && sealed("vocals"))
        ? null
        : draft.pending;
    await this.save({
      ...this.require(),
      master,
      pending,
      stems: { instrumental: sealed("instrumental"), vocals: sealed("vocals") },
      ...(row.jobId ? { jobId: row.jobId } : {}),
    });
    this.assertActive();
  }
  restore() {
    return this.exclusive(async () => {
      if (this.record?.submissionId) await this.recoverUploads();
      return this.record;
    });
  }
  private async prepareSaved() {
    let draft = this.require();
    if (!draft.submissionId)
      await this.command(
        "reserve",
        () =>
          this.http<{ submissionId: string; postId: string; state: string }>(
            "/api/uploads",
            jsonWrite(draft.body, { "idempotency-key": draft.requestId }),
          ),
        (reply) => {
          if (!id(reply.submissionId) || !/^0x[0-9a-f]{64}$/.test(reply.postId))
            throw new Error("Reservation reply identity is uncertain.");
          return {
            ...this.require(),
            submissionId: reply.submissionId,
            postId: reply.postId,
          };
        },
      );
    await this.recoverUploads();
    draft = this.require();
    if (!draft.master) {
      this.uploadAbort = new AbortController();
      try {
        await this.command(
          "audio",
          () =>
            this.http<{ uploaded: boolean }>(
              `/api/uploads/${draft.submissionId}/audio`,
              {
                method: "PUT",
                headers: { "content-type": "audio/mpeg" },
                body: draft.files.audio,
              },
              this.uploadAbort!.signal,
            ),
          (reply) => {
            if (reply.uploaded !== true)
              throw new Error("Master upload acknowledgement is uncertain.");
            return { ...this.require(), master: true };
          },
        );
      } finally {
        this.uploadAbort = undefined;
      }
    }
    for (const slot of ["instrumental", "vocals"] as const) {
      draft = this.require();
      if (draft.stems[slot]) continue;
      await this.command(
        `${slot}-reserve`,
        () =>
          this.http<{
            stem: {
              slot: string;
              sha256: string;
              byteLength: number;
              state: string;
            };
          }>(
            `/api/uploads/${draft.submissionId}/stems/${slot}`,
            jsonWrite({
              sha256: draft.hashes[slot],
              byteLength: draft.files[slot].size,
            }),
          ),
        (reply) => {
          if (
            reply.stem.slot !== slot ||
            reply.stem.sha256 !== draft.hashes[slot] ||
            reply.stem.byteLength !== draft.files[slot].size
          )
            throw new Error("Stem reservation changed immutable recording.");
          return this.require();
        },
      );
      this.uploadAbort = new AbortController();
      try {
        await this.command(
          `${slot}-upload`,
          () =>
            this.http<{ sealed: boolean }>(
              `/api/uploads/${draft.submissionId}/stems/${slot}`,
              {
                method: "PUT",
                headers: { "content-type": "audio/mpeg" },
                body: draft.files[slot],
              },
              this.uploadAbort!.signal,
            ),
          (reply) => {
            if (reply.sealed !== true)
              throw new Error("Stem seal acknowledgement is uncertain.");
            return {
              ...this.require(),
              stems: { ...this.require().stems, [slot]: true },
            };
          },
        );
      } finally {
        this.uploadAbort = undefined;
      }
    }
  }
  prepare(input?: SongReleaseInput) {
    return this.exclusive(async () => {
      if (!this.record) {
        if (!input) throw new Error("Choose the recording and stems first.");
        const captured = await this.capture(input);
        this.assertActive();
        await this.save({
          version: "pirate.community-song-draft/1",
          accountId: this.owner.accountId,
          communityId: this.owner.communityId,
          authorId: this.owner.authorId,
          requestId: crypto.randomUUID(),
          ...captured,
          master: false,
          stems: { instrumental: false, vocals: false },
          pending: null,
        });
      } else if (input) {
        const next = await this.capture(input);
        if (
          next.bodyDigest !== this.record.bodyDigest ||
          next.hashes.instrumental !== this.record.hashes.instrumental ||
          next.hashes.vocals !== this.record.hashes.vocals
        )
          throw new Error(
            "Finish the saved release before choosing another recording or policy.",
          );
      }
      if (this.require().jobId) return this.require();
      await this.prepareSaved();
      return this.require();
    });
  }
  publish() {
    return this.exclusive(async () => {
      if (!this.record) throw new Error("Prepare the saved release first.");
      if (!this.require().jobId) {
        await this.prepareSaved();
        const draft = this.require();
        if (!draft.jobId)
          await this.command(
            "seal",
            () =>
              this.http<{ jobId: string; postId: string }>(
                `/api/uploads/${draft.submissionId}/seal`,
                jsonWrite({}),
              ),
            (reply) => {
              if (!id(reply.jobId) || reply.postId !== draft.postId)
                throw new Error("Seal reply changed submission identity.");
              return { ...this.require(), jobId: reply.jobId };
            },
          );
      }
      return this.observeSaved();
    });
  }
  private async observeSaved(
    signal?: AbortSignal,
  ): Promise<SongSubmissionView> {
    const draft = this.require();
    if (!draft.jobId || !draft.submissionId)
      throw new Error("Publication job is not confirmed.");
    const job = await this.http<CommunityJobView>(
      `/api/jobs/${encodeURIComponent(draft.jobId)}`,
      {},
      signal,
    );
    if (
      job.schema !== "pirate.publication-job-view/1" ||
      job.jobId !== draft.jobId ||
      job.submissionId !== draft.submissionId ||
      job.postId !== draft.postId ||
      !phases.includes(job.phase) ||
      job.resumable !== (job.phase === "uncertain")
    )
      throw new Error("Job reply changed saved publication authority.");
    await this.save({
      ...this.require(),
      job,
      pending:
        draft.pending === "resume" && job.phase !== "uncertain"
          ? null
          : draft.pending,
    });
    this.assertActive();
    if (job.phase === "published") {
      const feed = await this.http<CommunityFeed>("/api/feed", {}, signal);
      this.assertActive();
      const matches = feed.posts.filter(
        (post) =>
          post.manifest.postId === draft.postId &&
          post.manifest.authorId === draft.authorId,
      );
      if (feed.communityId !== draft.communityId || matches.length !== 1)
        return { status: "reconciling", submissionId: draft.submissionId };
      const proof = await this.http<{
        schema: string;
        post: { communityId: string; postId: string; authorId: string };
        transactionHash: string;
      }>(`/api/public/posts/${draft.postId}/proof`, {}, signal);
      if (
        proof.schema !== "pirate.community-publication-proof/1" ||
        proof.post.communityId !== draft.communityId ||
        proof.post.postId !== draft.postId ||
        proof.post.authorId !== draft.authorId ||
        proof.transactionHash !== matches[0].transactionHash
      )
        throw new Error("Published feed/proof identity changed.");
      this.assertActive();
      return {
        status: "published",
        submissionId: draft.submissionId,
        postId: draft.postId!,
        postHref: `/#song-${draft.postId}`,
      };
    }
    if (job.phase === "uncertain")
      return { status: "reconciling", submissionId: draft.submissionId };
    if (["held", "failed"].includes(job.phase))
      return {
        status: "processing_failed",
        submissionId: draft.submissionId,
        reasonCode: job.errorCode ?? job.phase,
        retryable: false,
      };
    return {
      status: "processing",
      submissionId: draft.submissionId,
      phase: job.phase === "admission" ? "analysis" : "publish",
    };
  }
  observe(signal?: AbortSignal) {
    return this.exclusive(() => this.observeSaved(signal));
  }
  resume(signal?: AbortSignal) {
    return this.exclusive(async () => {
      const view = await this.observeSaved(signal),
        draft = this.require();
      if (
        view.status !== "reconciling" ||
        draft.job?.phase !== "uncertain" ||
        !draft.job.resumable
      )
        throw new Error("This job cannot be resumed by this action.");
      await this.command(
        "resume",
        () =>
          this.http<{ resuming: boolean }>(
            `/api/jobs/${encodeURIComponent(draft.jobId!)}/resume`,
            jsonWrite({}),
            signal,
          ),
        (reply) => {
          if (reply.resuming !== true)
            throw new Error("Resume acknowledgement is uncertain.");
          return this.require();
        },
      );
      return this.observeSaved(signal);
    });
  }
  source(): SongObservationSource {
    return {
      refresh: (signal) => this.observe(signal),
      retry: (signal) => this.resume(signal),
    };
  }
  close() {
    return this.exclusive(async () => {
      const draft = this.require();
      if (
        !draft.jobId ||
        !draft.job ||
        !["held", "failed", "published"].includes(draft.job.phase) ||
        draft.pending
      )
        throw new Error(
          "The saved release has not reached a known closure point.",
        );
      await this.store.remove();
      this.record = null;
      if (this.owner.active() && this.operationGeneration === this.generation)
        this.changed(null);
    });
  }
}
