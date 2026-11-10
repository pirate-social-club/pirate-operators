import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { communityRuntime } from "./community-runtime.ts";
import { CommunityMedia } from "../services/community-media.ts";
import { communityMediaApi } from "../services/community-media-api.ts";
import {
  MediaRepository,
  MEDIA_COMMIT_GUARD,
  mediaCommitValues,
} from "../packages/community-media/repository.ts";
import {
  sha256,
  SAMPLE_RATE,
  validateIntent,
} from "../packages/community-media/validation.ts";
import { FFmpegMediaProcessor } from "../packages/community-media/ffmpeg.ts";
import {
  BoundMediaProcessor,
  communityMediaRender,
} from "../packages/community-media/processor-transport.ts";
import type {
  MediaIntent,
  MediaProcessor,
  PublishedMediaSong,
} from "../packages/community-media/contracts.ts";

export const exec = promisify(execFile),
  actor = { accountId: "learner-a" },
  reviewer = { accountId: "reviewer-a" };
export async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const runtime = await communityRuntime();
  t.after(() => runtime.dispose());
  const schema = await readFile(
    new URL("../packages/community-media/schema.sql", import.meta.url),
    "utf8",
  );
  await runtime.db.batch(
    schema
      .replace(/--[^\n]*/g, "")
      .split(";")
      .filter((s) => s.trim())
      .map((s) => runtime.db.prepare(s)),
  );
  const source = new TextEncoder().encode("local explicit processor fixture"),
    hash = await sha256(source);
  const song: PublishedMediaSong = {
    communityId: "community-a",
    songKey: "published-song-a",
    songRevision: 2,
    audioSha256: "a".repeat(64),
    durationSamples: SAMPLE_RATE * 30,
    title: "Fixture song",
  };
  let now = 1_800_000_000_000,
    publicAllowed = false,
    reviewAllowed = true,
    enabled = true,
    currentRevision = 2,
    sends = 0;
  const repository = new MediaRepository(runtime.db, song.communityId);
  const processor: MediaProcessor = {
    async render(_source, media) {
      return {
        bytes: source,
        facts: {
          sha256: hash,
          bytes: source.byteLength,
          durationMs: media.durationSamples / 48,
          width: 320,
          height: 240,
          videoCodec: "h264",
          audioCodec: "aac",
        },
      };
    },
  };
  const ports = {
    repository,
    bucket: runtime.media,
    now: () => now,
    quota: {
      perAccount: 5,
      perCommunity: 100,
      bytesPerCommunity: 1024 * 1024 * 1024,
    },
    privateReviewPolicy: {
      version: "pirate.dance-private/1",
      minSamples: 6 * SAMPLE_RATE,
      maxSamples: 30 * SAMPLE_RATE,
    } as
      | import("../packages/community-media/contracts.ts").MediaDurationPolicy
      | undefined,
    active: async () => enabled,
    song: async () => ({ ...song, songRevision: currentRevision }),
    publicPosting: async () => ({
      allowed: publicAllowed,
      reason: publicAllowed ? "fixture_policy" : "owner_decision_pending",
    }),
    reviewAuthority: async (who: { accountId: string }) =>
      reviewAllowed && who.accountId === reviewer.accountId,
    processor: processor as MediaProcessor | undefined,
    enqueue: async () => {
      sends++;
    },
  };
  const service = new CommunityMedia(ports);
  const intent: MediaIntent = {
    requestId: "request_0001",
    songKey: song.songKey,
    songRevision: 2,
    recordingSha256: hash,
    bytes: source.byteLength,
    startSample: 0,
    durationSamples: SAMPLE_RATE * 6,
    purpose: "private-review",
    publicConsent: false,
  };
  const reserve = (change: Partial<MediaIntent> = {}) =>
    service.reserve(actor, { ...intent, ...change });
  const ready = async (change: Partial<MediaIntent> = {}) => {
    const item = await reserve(change);
    await service.upload(item.id, actor, source);
    await service.process(item.id);
    return repository.get(item.id);
  };
  const http = (
    path: string,
    who: typeof actor | null = actor,
    init: RequestInit = {},
  ) =>
    communityMediaApi(
      new Request("https://community.example" + path, init),
      service,
      { origin: "https://community.example", actor: async () => who },
    );
  return {
    ...runtime,
    repository,
    source,
    hash,
    song,
    ports,
    service,
    intent,
    reserve,
    ready,
    http,
    setNow: (n: number) => {
      now = n;
    },
    now: () => now,
    allowPublic: () => {
      publicAllowed = true;
    },
    revokePublic: () => {
      publicAllowed = false;
    },
    revokeReview: () => {
      reviewAllowed = false;
    },
    deactivate: () => {
      enabled = false;
    },
    changeSong: () => {
      currentRevision++;
    },
    sends: () => sends,
  };
}
