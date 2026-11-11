import { webcrypto } from "node:crypto";
import { ApiClientError } from "@pirate/api-client";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ORIGINAL_VIDEO_PENDING,
  isVideoUploadAccepted,
  VideoCoordinator,
  type PendingVideo,
  type VideoStorage,
} from "./coordinator";
import { SongReservationMismatch, type OriginalVideoReservation, type SongVideoReservation, type SongVideoSelection,
  type VideoReservation, type VideoSnapshot } from "./contracts";
import type { VideoCommand, VideoCommandResult, VideoTransport } from "./transport";

afterEach(() => vi.unstubAllGlobals());
const reservation: OriginalVideoReservation = {
  reservation_id: "reservation", track: "video", intent: "original_audio", slot: "primary_video",
  status: "awaiting_upload", author_persona_id: "persona", ingest_policy_revision: 1,
  upload: { method: "MULTIPART", upload_id: "upload", part_size_bytes: 10, part_count: 1,
    expires_at: "2099-01-01T00:00:00Z", parts: [{ part_number: 1, url: "https://upload.example/1", expires_at: "2099-01-01T00:00:00Z" }] },
};
const initial: VideoSnapshot = {
  submission_id: "submission", author_persona: { object: "persona", persona_id: "persona", display_name: null, avatar_ref: null, primary_public_handle: null },
  href: "/media-post-submissions/submission", track: "video", intent: "original_audio", creation_revision: 1,
  video_revision: 0, caption: "", updated_at: "2026-09-05T00:00:00Z", status: "processing", phase: "awaiting_upload",
};

type MutableVideoTestTransport = { -readonly [Key in keyof VideoTransport]: VideoTransport[Key] };

function setup(source: VideoReservation = reservation) {
  vi.stubGlobal("crypto", webcrypto);
  let stored: PendingVideo | null = null;
  let current = initial;
  let posts = 0;
  let loseFinalize = true;
  let key = 0;
  const commands: VideoCommand[] = [];
  let rejection: { kind: VideoCommand["kind"]; error: Error } | null = null;
  const results = new Map<string, VideoCommandResult>();
  const storage: VideoStorage = {
    async exclusive(work) { return work(); },
    async load() { return stored; }, async save(record) { stored = record; }, async remove() { stored = null; },
  };
  const transport: MutableVideoTestTransport = {
    async read() { return current; },
    async execute(command) {
      commands.push(command);
      if (rejection?.kind === command.kind) { const error = rejection.error; rejection = null; throw error; }
      const old = results.get(command.input.body.idempotency_key);
      if (old) return old;
      if (command.kind === "reserve") { results.set(command.input.body.idempotency_key, source); return source; }
      if (command.kind === "renew") return { ...source, upload: { ...source.upload,
        parts: source.upload.parts.filter(part => command.input.body.part_numbers.includes(part.part_number))
          .map(part => ({ ...part, expires_at: "2099-01-01T00:00:00Z" })),
      } };
      if (command.kind === "cancel") {
        current = { ...initial, status: "abandoned", reason_code: "author_abandoned_unresolved_provider" };
        results.set(command.input.body.idempotency_key, current);
        return current;
      }
      if (command.kind === "finalize") {
        posts++;
        current = { ...initial, status: "published", creation_revision: 2, video_revision: 1, published_resource: { post_id: "post", href: "/posts/post" } };
        results.set(command.input.body.idempotency_key, current);
        if (loseFinalize) { loseFinalize = false; throw new Error("Lost finalize response"); }
      }
      results.set(command.input.body.idempotency_key, current);
      return current;
    },
  };
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { headers: { etag: "part-etag" } }));
  const create = (principalId = "account") => new VideoCoordinator({ principalId, storage, transport, fetchImpl, createId: () => `key-${++key}` });
  const begin = (coordinator: VideoCoordinator, song?: SongVideoSelection) => {
    const attempt = { communityId: "community", personaId: "persona", caption: "", rating: "general" as const, file: new File(["video"], "take.mp4", { type: "video/mp4" }) };
    return coordinator.begin(song ? { ...attempt, song } : attempt);
  };
  return { create, begin, commands, fetchImpl, storage, transport, posts: () => posts,
    setCurrent: (snapshot: VideoSnapshot) => { current = snapshot; },
    rejectNext: (kind: VideoCommand["kind"], error: Error) => { rejection = { kind, error }; },
  };
}

function rejected(status = 400, retryable = false) {
  return new ApiClientError({ status, code: "bad_request", name: "BadRequest", retryable },
    { error: { code: "bad_request", message: "Request refused", retryable } });
}

describe("video operation replay", () => {
  test.each(["reserve", "start"] as const)("definitive %s rejection restores without replay and requires explicit editing", async kind => {
    const fixture = setup(); const first = fixture.create(); fixture.rejectNext(kind, rejected());
    if (kind === "reserve") await expect(fixture.begin(first)).rejects.toThrow("Request refused");
    else { await fixture.begin(first); await expect(first.submit()).rejects.toThrow("Request refused"); }
    expect(first.current?.pending).toBeNull();
    expect(first.current?.rejection?.command.kind).toBe(kind);
    const count = fixture.commands.length;
    const resumed = fixture.create(); await resumed.restore();
    expect(fixture.commands).toHaveLength(count);
    await expect(resumed.submit()).rejects.toThrow(/rejected/);
    expect(fixture.commands).toHaveLength(count);
    const draft = await resumed.discardRejected(); expect(draft.file.name).toBe("take.mp4");
    expect(await fixture.storage.load()).toBeNull();
    await fixture.begin(resumed);
    expect(fixture.commands.at(-1)?.input.body.idempotency_key).not.toBe(fixture.commands[0]?.input.body.idempotency_key);
  });
  test.each([new Error("offline"), rejected(409), rejected(429, true), rejected(503, true)])("uncertain/conflicting rejection is retained and cannot be discarded: %s", async error => {
    const fixture = setup(); const first = fixture.create(); fixture.rejectNext("reserve", error);
    await expect(fixture.begin(first)).rejects.toThrow();
    expect(first.current?.pending?.command.kind).toBe("reserve"); expect(first.current?.rejection).toBeUndefined();
    await expect(first.discardRejected()).rejects.toThrow(/definitively/);
    expect(await fixture.storage.load()).not.toBeNull();
  });
  test("a rejected finalize never authorizes discarding a server-owned operation", async () => {
    const fixture = setup(); const first = fixture.create(); await fixture.begin(first); fixture.rejectNext("finalize", rejected());
    await expect(first.submit()).rejects.toThrow("Request refused");
    await expect(first.discardRejected()).rejects.toThrow(/definitively/);
    expect(first.current?.snapshot?.submission_id).toBe("submission");
  });
  test("release forgets only a video whose upload is sealed and confirmed", async () => {
    const fixture = setup(); const first = fixture.create(); await fixture.begin(first);
    expect(await first.release()).toBe(false);
    // The fixture loses the first finalize response: it must stay replayable.
    await expect(first.submit()).rejects.toThrow("Lost finalize response");
    expect(await first.release()).toBe(false);
    expect(await fixture.storage.load()).not.toBeNull();
    await first.submit();
    expect(await first.release()).toBe(true);
    expect(await fixture.storage.load()).toBeNull();
    expect(first.current).toBeNull();
    expect(fixture.posts()).toBe(1);
  });
  test("partial renewal preserves the complete durable upload plan", async () => {
    const fixture = setup({ ...reservation, upload: { ...reservation.upload, part_size_bytes: 3, part_count: 2,
      parts: [1, 2].map(part_number => ({ part_number, url: `https://upload.example/${part_number}`,
        expires_at: part_number === 1 ? "2099-01-01T00:00:00Z" : "2000-01-01T00:00:00Z" })),
    } });
    const first = fixture.create(); await fixture.begin(first);
    await expect(first.submit()).rejects.toThrow("Lost finalize response");
    expect(first.current?.reservation?.upload.parts.map(part => part.part_number)).toEqual([1, 2]);
    expect(first.current?.receipts).toHaveLength(2);
    expect(fixture.commands.filter(command => command.kind === "renew")).toHaveLength(1);
  });
  test("lost finalize replays the exact command after restore without a second upload or post", async () => {
    const fixture = setup(); const first = fixture.create();
    await fixture.begin(first);
    await expect(first.submit()).rejects.toThrow("Lost finalize response");
    expect(first.current?.pending?.command.kind).toBe("finalize");
    const retained = JSON.stringify(first.current?.pending?.command);
    const resumed = fixture.create(); await resumed.restore();
    expect(resumed.current?.snapshot?.status).toBe("published");
    expect(JSON.stringify(fixture.commands.at(-1))).toBe(retained);
    expect(fixture.posts()).toBe(1); expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
    await resumed.submit(); expect(fixture.posts()).toBe(1);
  });
  test("a finalize lost after the server committed settles by reading, with no replay or second post", async () => {
    const fixture = setup(); const first = fixture.create(); await fixture.begin(first);
    await expect(first.submit()).rejects.toThrow("Lost finalize response");
    const sent = fixture.commands.length;
    expect(await first.settleFinalize()).toBe(true);
    expect(fixture.commands).toHaveLength(sent);
    expect(await fixture.storage.load()).toBeNull();
    expect(first.current).toBeNull();
    expect(fixture.posts()).toBe(1); expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
  });
  test("a finalize lost before the server committed stays retained and replays the same command", async () => {
    const fixture = setup(); const first = fixture.create(); await fixture.begin(first);
    fixture.rejectNext("finalize", new Error("offline"));
    await expect(first.submit()).rejects.toThrow("offline");
    const retained = JSON.stringify(first.current?.pending?.command);
    expect(await first.settleFinalize()).toBe(false);
    expect(JSON.stringify(first.current?.pending?.command)).toBe(retained);
    expect(fixture.posts()).toBe(0);
    await expect(first.submit()).rejects.toThrow("Lost finalize response");
    expect(JSON.stringify(fixture.commands.at(-1))).toBe(retained);
    expect(await first.settleFinalize()).toBe(true);
    expect(fixture.posts()).toBe(1); expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
  });
  test("settling never forgets a video on a read of another submission or a failed read", async () => {
    const fixture = setup(); const first = fixture.create(); await fixture.begin(first);
    await expect(first.submit()).rejects.toThrow("Lost finalize response");
    const published: VideoSnapshot = { ...initial, status: "published", creation_revision: 2, video_revision: 1,
      published_resource: { post_id: "post", href: "/posts/post" } };
    fixture.setCurrent({ ...published, submission_id: "other" });
    await expect(first.settleFinalize()).rejects.toThrow(/authority/);
    fixture.setCurrent({ ...published, author_persona: { ...published.author_persona, persona_id: "someone-else" } });
    await expect(first.settleFinalize()).rejects.toThrow(/authority/);
    fixture.transport.read = async () => { throw new Error("offline"); };
    await expect(first.settleFinalize()).rejects.toThrow("offline");
    expect((await fixture.storage.load())?.pending?.command.kind).toBe("finalize");
  });
  test("settling is a no-op without an unconfirmed finalize", async () => {
    const fixture = setup(); const first = fixture.create(); await fixture.begin(first);
    fixture.rejectNext("reserve", new Error("unused"));
    expect(await first.settleFinalize()).toBe(false);
    expect(await fixture.storage.load()).not.toBeNull();
  });
  test.each([
    { ...initial, phase: "finalize" as const },
    { ...initial, status: "abandoned" as const, reason_code: "author_abandoned_unresolved_provider" as const },
  ])("a $status snapshot without an immutable video never proves upload acceptance", async snapshot => {
    const fixture = setup(); const first = fixture.create(); await fixture.begin(first);
    fixture.rejectNext("finalize", new Error("offline"));
    await expect(first.submit()).rejects.toThrow("offline");
    const retained = first.current?.pending;
    const sent = fixture.commands.length;
    fixture.setCurrent(snapshot);
    expect(await first.settleFinalize()).toBe(false);
    expect(await first.release()).toBe(false);
    expect(first.current?.pending).toEqual(retained);
    expect(fixture.commands).toHaveLength(sent);
    expect(fixture.posts()).toBe(0);
  });
  test("a successful but unsealed finalize keeps the exact envelope across reload and explicit replay", async () => {
    const fixture = setup(); const first = fixture.create(); await fixture.begin(first);
    const execute = fixture.transport.execute;
    fixture.transport.execute = async command => {
      if (command.kind !== "finalize") return execute(command);
      fixture.commands.push(command);
      const finalizing: VideoSnapshot = { ...initial, phase: "finalize", creation_revision: 2 };
      fixture.setCurrent(finalizing);
      return finalizing;
    };
    await first.submit();
    const retained = first.current?.pending;
    expect(retained?.command.kind).toBe("finalize");
    expect(await first.release()).toBe(false);
    const resumed = fixture.create(); await resumed.restore();
    expect(resumed.current?.pending).toEqual(retained);
    await resumed.submit();
    expect(resumed.current?.pending).toEqual(retained);
    expect(fixture.commands.filter(command => command.kind === "finalize")).toEqual([
      retained?.command, retained?.command, retained?.command,
    ]);
    expect(fixture.commands.filter(command => command.kind === "reserve")).toHaveLength(1);
    expect(fixture.commands.filter(command => command.kind === "start")).toHaveLength(1);
    expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
    const sent = fixture.commands.length;
    expect(await resumed.settleFinalize()).toBe(false);
    expect(fixture.commands).toHaveLength(sent);
    fixture.setCurrent({ ...initial, phase: "analysis", creation_revision: 3, video_revision: 1 });
    expect(await resumed.settleFinalize()).toBe(true);
    expect(await fixture.storage.load()).toBeNull();
    expect(fixture.commands).toHaveLength(sent);
  });
  test("only a positive immutable revision in a post-seal state proves acceptance", () => {
    expect(isVideoUploadAccepted(null)).toBe(false);
    expect(isVideoUploadAccepted({ ...initial, phase: "finalize", video_revision: 1 })).toBe(false);
    expect(isVideoUploadAccepted({ ...initial, phase: "analysis", video_revision: 0 })).toBe(false);
    expect(isVideoUploadAccepted({ ...initial, phase: "analysis", video_revision: 1 })).toBe(true);
    expect(isVideoUploadAccepted({ ...initial, phase: "publish", video_revision: 1 })).toBe(true);
    expect(isVideoUploadAccepted({ ...initial, status: "manual_review", video_revision: 1, reason_codes: ["media_review_required"], review_ref: "review" })).toBe(true);
  });
  test("lost unresolved-abandonment response replays the exact cancel and remains terminal", async () => {
    const fixture = setup();
    const unresolved: VideoSnapshot = {
      ...initial,
      status: "processing_failed",
      reason_code: "provider_submission_unconfirmed",
      retryable: false,
      retry_count: 0,
    };
    fixture.setCurrent(unresolved);
    await fixture.storage.save({
      version: ORIGINAL_VIDEO_PENDING,
      principalId: "account",
      communityId: "community",
      personaId: "persona",
      file: new File(["video"], "take.mp4", { type: "video/mp4" }),
      caption: "",
      rating: "general",
      reservation,
      snapshot: unresolved,
      receipts: [{ part_number: 1, etag: "part-etag" }],
      pending: null,
    });
    const execute = fixture.transport.execute;
    let loseResponse = true;
    fixture.transport.execute = async command => {
      const result = await execute(command);
      if (command.kind === "cancel" && loseResponse) {
        loseResponse = false;
        throw new Error("Lost abandonment response");
      }
      return result;
    };
    const first = fixture.create(); await first.restore();
    await expect(first.revisionCommand("cancel")).rejects.toThrow("Lost abandonment response");
    const retained = JSON.stringify(first.current?.pending?.command);
    expect(first.current?.snapshot?.status).toBe("processing_failed");

    const resumed = fixture.create(); await resumed.restore();
    expect(resumed.current?.snapshot).toMatchObject({
      status: "abandoned",
      reason_code: "author_abandoned_unresolved_provider",
    });
    expect(JSON.stringify(fixture.commands.at(-1))).toBe(retained);
    expect(fixture.commands.filter(command => command.kind === "cancel")).toHaveLength(2);
  });
  test("another account cannot restore or dispatch the saved video", async () => {
    const fixture = setup(); await fixture.begin(fixture.create());
    const count = fixture.commands.length;
    await expect(fixture.create("other-account").restore()).rejects.toThrow(/different account/);
    expect(fixture.commands).toHaveLength(count);
  });
  test("a second draft cannot replace the retained attempt", async () => {
    const fixture = setup(); const first = fixture.create(); await fixture.begin(first);
    await expect(fixture.begin(fixture.create())).rejects.toThrow(/retained video/);
    expect(fixture.commands).toHaveLength(1);
  });
  test("a changed saved finalize command is rejected before replay", async () => {
    const fixture = setup(); const first = fixture.create(); await fixture.begin(first);
    await expect(first.submit()).rejects.toThrow();
    const saved = await fixture.storage.load();
    if (!saved?.pending) throw new Error("Missing test command");
    await fixture.storage.save({ ...saved, pending: { ...saved.pending, digest: "0".repeat(64) } });
    const count = fixture.commands.length;
    await expect(fixture.create().restore()).rejects.toThrow(/digest/);
    expect(fixture.commands).toHaveLength(count);
  });
});


test.each(["start", "read"] as const)("pause during deferred %s saves the response but prevents upload and finalize", async boundary => {
  const fixture = setup(); const coordinator = fixture.create(); await fixture.begin(coordinator);
  let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  const execute = fixture.transport.execute; const read = fixture.transport.read;
  if (boundary === "start") fixture.transport.execute = async command => {
    if (command.kind === "start") { entered(); await waiting; } return execute(command);
  };
  else fixture.transport.read = async id => { entered(); await waiting; return read(id); };
  const operation = coordinator.submit(); const stopped = expect(operation).rejects.toThrow(/paused/);
  await started; coordinator.pauseUpload(); release(); await stopped;
  expect(coordinator.current?.snapshot?.submission_id).toBe("submission");
  expect(coordinator.current?.pending).toBeNull(); expect(fixture.fetchImpl).not.toHaveBeenCalled();
  expect(fixture.commands.some(command => command.kind === "finalize")).toBe(false);
  fixture.transport.execute = execute; fixture.transport.read = read;
  await expect(coordinator.submit()).rejects.toThrow("Lost finalize response");
  expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
});

const selection: SongVideoSelection = {
  songPostId: "song-post", audioRevision: 7, clipStartSamples: 1_488_000, clipDurationSamples: 576_000, selectedFrom: { kind: "library" },
};
const songReservation: SongVideoReservation = {
  ...reservation, intent: "song_reference",
  song_reference: { song_post_id: "song-post", audio_revision: 7, song_asset_id: "song-asset" },
  reservation_policy_snapshot: { observed_at_transition: "media_reservation_issued", owner_policy_revision: 3,
    owner_policy_hash: "a".repeat(64), derivative_video: "allowed", observed_at: "2026-09-11T00:00:00Z" },
  interval: { clip_start_samples: 1_488_000, clip_duration_samples: 576_000, song_duration_samples: 10_080_047 },
};
function refused(status: number, reasonCode: string) {
  const code = status === 409 ? "conflict" : "bad_request";
  return new ApiClientError({ status, code, name: "Declared", retryable: false },
    { error: { code, message: "Song refused", retryable: false, details: { reason_code: reasonCode } } });
}

describe("song-backed video attempts", () => {
  test("reserve the exact selection, keep it with the attempt, and start and finalize as any video", async () => {
    const fixture = setup(songReservation); const coordinator = fixture.create();
    await fixture.begin(coordinator, selection);
    expect(fixture.commands[0]?.input.body).toMatchObject({
      intent: "song_reference", song_post_id: "song-post", audio_revision: 7,
      clip_start_samples: 1_488_000, clip_duration_samples: 576_000, selected_from: { kind: "library" },
    });
    const saved = await fixture.storage.load();
    expect(saved?.version).toBe("song-video-pending-v1");
    expect(saved?.song).toEqual(selection);
    expect(saved?.reservation?.intent).toBe("song_reference");
    await expect(coordinator.submit()).rejects.toThrow("Lost finalize response");
    expect(fixture.commands.map(command => command.kind)).toEqual(["reserve", "start", "finalize"]);
  });

  test("an unavailable capability is a definitive refusal that keeps its reason and allows editing", async () => {
    const fixture = setup(songReservation); const coordinator = fixture.create();
    fixture.rejectNext("reserve", refused(400, "capability_unavailable"));
    await expect(fixture.begin(coordinator, selection)).rejects.toThrow("Song refused");
    expect(coordinator.current?.rejection).toMatchObject({ status: 400, code: "bad_request", reasonCode: "capability_unavailable" });
    await coordinator.discardRejected();
    const original = setup(); await original.begin(original.create());
    expect(original.commands[0]?.input.body).toMatchObject({ intent: "original_audio" });
  });

  test("a changed song revision is definitive although it is a conflict", async () => {
    const fixture = setup(songReservation); const coordinator = fixture.create();
    fixture.rejectNext("reserve", refused(409, "song_audio_revision_changed"));
    await expect(fixture.begin(coordinator, selection)).rejects.toThrow("Song refused");
    expect(coordinator.current?.pending).toBeNull();
    expect(coordinator.current?.rejection?.reasonCode).toBe("song_audio_revision_changed");
  });

  test("a reservation that froze a different excerpt is recorded, never uploaded, and can be edited", async () => {
    const fixture = setup(songReservation); const coordinator = fixture.create();
    fixture.rejectNext("reserve", new SongReservationMismatch("The server froze a different excerpt than the one chosen"));
    await expect(fixture.begin(coordinator, selection)).rejects.toThrow(SongReservationMismatch);
    expect(coordinator.current?.rejection).toMatchObject({ status: 0, code: "contract", reasonCode: "song_reference_mismatch" });
    expect(fixture.fetchImpl).not.toHaveBeenCalled();
    const draft = await coordinator.discardRejected(); expect(draft.song).toEqual(selection);
  });

  test("a response that drops the song is refused rather than published as original sound", async () => {
    const fixture = setup(reservation); const coordinator = fixture.create();
    await expect(fixture.begin(coordinator, selection)).rejects.toThrow(/posted to a song/);
    expect(coordinator.current?.reservation).toBeNull();
    expect(coordinator.current?.pending?.command.kind).toBe("reserve");
  });

  test("a song-backed record without its selection is not restored", async () => {
    const fixture = setup(songReservation); await fixture.begin(fixture.create(), selection);
    const saved = await fixture.storage.load();
    if (!saved) throw new Error("Missing saved attempt");
    const { song: _song, ...withoutSong } = saved;
    // SAFETY: deliberately not a valid record — a song-backed version with its
    // selection removed — to prove that restoring refuses it.
    await fixture.storage.save(withoutSong as PendingVideo);
    await expect(fixture.create().restore()).rejects.toThrow(/version/);
  });
});
