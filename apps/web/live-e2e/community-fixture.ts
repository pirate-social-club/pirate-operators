// Explicit HTTP protocol fixture for the actual built App. No SDK substitute,
// cryptography/D1/provider/publication acceptance, external audio or real funds.
import { expect, type Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CommunityFeed, PublicSongView } from "../src/api-contract.ts";

export const origin = "https://community.example";
export const communityId = "0x" + "2".repeat(64);
export const ownerAuthorId = "0x" + "1".repeat(64);
export const catalogPostId = "0x" + "3".repeat(64);
export const catalogAuthorId = "0x" + "4".repeat(64);
export const catalogAudioPath = `/api/public/posts/${catalogPostId}/audio`;
export const policy = "pirate-owner-curated/2026-11-08/1";
const hash = (body: Buffer | string) =>
  "0x" + createHash("sha256").update(body).digest("hex");
export type ReleasePhase =
  | "admission"
  | "publication"
  | "uncertain"
  | "held"
  | "failed"
  | "published";
interface Intent {
  title: string;
  lyrics: string;
  language: string;
  original: true;
  acceptedPolicy: string;
  audioSha256: string;
  audioBytes: number;
  rating: "general" | "adult";
}
interface Release {
  key: string;
  rawBody: string;
  bodyDigest: string;
  body: Intent;
  submissionId: string;
  postId: string;
  jobId: string;
  phase: ReleasePhase;
  master: Buffer | null;
  sealed: boolean;
  stems: Map<
    string,
    { slot: string; state: string; sha256: string; byteLength: number }
  >;
}
function wav() {
  const samples = 16000,
    bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    bytes.writeInt16LE(
      Math.round(Math.sin((i * 440 * Math.PI * 2) / 16000) * 1000),
      44 + i * 2,
    );
  return bytes;
}
export async function serveCommunity(
  page: Page,
  authenticated = false,
  directoryOutage = false,
  releasing = false,
  referrerPolicy = "strict-origin",
  options: {
    songs?: boolean;
    rewards?: boolean;
    feedOutage?: boolean;
    profile?: "loaded" | "unavailable";
  } = {},
) {
  const accountId = randomUUID(),
    releases: Release[] = [],
    byKey = new Map<string, Release>();
  const events: { path: string; method: string }[] = [],
    reservationRequests: { key: string; rawBody: string; digest: string }[] =
      [];
  const counts = {
    creator: 0,
    stored: 0,
    upload: 0,
    seals: 0,
    resumes: 0,
    logout: 0,
    proofs: 0,
    stems: 0,
  };
  let feedDown = !!options.feedOutage,
    exposePublished = true,
    loseMasterAck = true;
  const catalogBytes = wav();
  const current = () => releases.at(-1);
  const catalog: PublicSongView = {
    manifest: {
      schema: "pirate.community-post/3",
      postId: catalogPostId,
      authorId: catalogAuthorId,
      title: "Published fixture song",
      language: "en",
      rating: "general",
    },
    audioUrl: catalogAudioPath,
    postUrl: `/#song-${catalogPostId}`,
    transactionHash: "0x" + "5".repeat(64),
    lyricsText: "A fixture lyric line",
  };
  const publicRelease = (release: Release): PublicSongView => ({
    manifest: {
      schema: "pirate.community-post/3",
      postId: release.postId,
      authorId: ownerAuthorId,
      title: release.body.title,
      language: release.body.language,
      rating: release.body.rating,
      declarationSource: "operator_declared",
      automatedContent: "deferred",
    },
    audioUrl: `/api/public/posts/${release.postId}/audio`,
    postUrl: `/#song-${release.postId}`,
    transactionHash: hash("publication:" + release.jobId),
    lyricsText: release.body.lyrics,
  });
  const feed = (): CommunityFeed => ({
    schema: "pirate.community-feed/1",
    communityId,
    posts: [
      ...(exposePublished
        ? releases
            .filter((row) => row.phase === "published" && row.sealed)
            .map(publicRelease)
        : []),
      ...(options.songs ? [catalog] : []),
    ],
  });
  const profile = (authorId: string) => ({
    schema: "pirate.community-profile/1",
    communityId,
    authorId,
    revision: 1,
    displayName: authorId === ownerAuthorId ? "Fixture member" : null,
    bio: null,
    avatarRef: null,
    coverRef: null,
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === origin)
      events.push({ path: url.pathname, method: request.method() });
  });
  await page.route(`${origin}/**`, async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname,
      method = request.method();
    const json = (value: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(value),
      });
    const csrf = () => {
      expect(authenticated).toBe(true);
      expect(request.headers()["x-csrf-token"]).toBe("fixture-csrf");
    };
    if (path === "/.well-known/pirate-client.json")
      return directoryOutage
        ? json({ error: "fixture_directory_unavailable" }, 503)
        : json({
            schema: "pirate.community-client-config/1",
            communityId,
            canonicalOrigin: origin,
            apiBase: "/api",
            protocolVersions: [1],
            defaultLanguage: "en",
            supportedLanguages: ["en"],
            mirrors: [],
          });
    if (path === "/api/public/community")
      return json({ name: "Browser Fixture Community" });
    if (path === "/api/capabilities")
      return json({
        schema: "pirate.community-capabilities/1",
        signIn: true,
        creatorConnection: false,
        upload: releasing,
        publication: releasing,
        policyVersion: policy,
        rewards: !!options.rewards,
        study: false,
      });
    if (path === "/api/feed")
      return feedDown
        ? json({ error: "fixture_feed_unavailable" }, 503)
        : json(feed());
    if (path === "/api/rewards/offers") return json({ offers: [] });
    if (path === "/api/session")
      return authenticated
        ? json({
            authenticated: true,
            authorId: ownerAuthorId,
            mossAddress: "0x" + "2".repeat(40),
            csrf: "fixture-csrf",
            creator: null,
            pendingConnection: null,
            publisher: releasing,
            publicResults: "unavailable",
          })
        : json({ error: "session_required" }, 401);
    if (path === "/api/profile/owner") {
      if (!authenticated) return json({ error: "session_required" }, 401);
      if (options.profile === "unavailable")
        return json({ error: "fixture_profile_unavailable" }, 503);
      return json({
        schema: "pirate.community-profile-owner/1",
        communityId,
        accountId,
        profile: profile(ownerAuthorId),
        capabilities: { metadata: true, handles: false, publicMedia: false },
      });
    }
    if (path === "/api/public/authors") {
      const ids = (url.searchParams.get("ids") ?? "")
        .split(",")
        .filter(Boolean);
      expect(ids.every((id) => /^0x[0-9a-f]{64}$/.test(id))).toBe(true);
      return json({
        schema: "pirate.community-profile-list/1",
        communityId,
        profiles: ids.includes(ownerAuthorId) ? [profile(ownerAuthorId)] : [],
      });
    }
    const author =
      /^\/api\/public\/authors\/(0x[0-9a-f]{64})(\/activity)?$/.exec(path);
    if (author)
      return author[2]
        ? json({
            schema: "pirate.community-profile-activity/1",
            communityId,
            authorId: author[1],
            profile: profile(author[1]),
            items: feed().posts.filter(
              (post) => post.manifest.authorId === author[1],
            ),
            nextCursor: null,
            window: "current-public-catalogue",
          })
        : json(profile(author[1]));
    if (path === "/api/logout") {
      csrf();
      expect(method).toBe("POST");
      authenticated = false;
      counts.logout++;
      return json({ signedOut: true });
    }
    if (path.startsWith("/api/creator/")) {
      counts.creator++;
      return json({ error: "fixture_creator_unused" }, 410);
    }
    if (
      (path.startsWith("/api/uploads") || path.startsWith("/api/jobs/")) &&
      !authenticated
    )
      return json({ error: "session_required" }, 401);
    if (path === "/api/uploads" && method === "GET")
      return json({
        uploads: releases.toReversed().map((row) => ({
          submissionId: row.submissionId,
          postId: row.postId,
          title: row.body.title,
          state: row.sealed ? row.phase : row.master ? "uploaded" : "reserved",
          jobId: row.sealed ? row.jobId : null,
        })),
      });
    if (path === "/api/uploads" && method === "POST") {
      csrf();
      expect(releasing).toBe(true);
      const key = request.headers()["idempotency-key"]!,
        rawBody = request.postData()!,
        body = request.postDataJSON() as Intent;
      expect(Object.keys(body).sort()).toEqual(
        [
          "title",
          "language",
          "lyrics",
          "original",
          "acceptedPolicy",
          "audioSha256",
          "audioBytes",
          "rating",
        ].sort(),
      );
      expect(key).toMatch(/^[0-9a-f-]{36}$/);
      expect(body.original).toBe(true);
      expect(body.acceptedPolicy).toBe(policy);
      expect(body.rating).toBe("general");
      expect(body.audioSha256).toMatch(/^0x[0-9a-f]{64}$/);
      reservationRequests.push({ key, rawBody, digest: hash(rawBody) });
      const existing = byKey.get(key);
      if (existing) {
        expect(existing.rawBody).toBe(rawBody);
        return json(
          {
            submissionId: existing.submissionId,
            postId: existing.postId,
            state: "reserved",
          },
          201,
        );
      }
      if (current())
        expect(["failed", "published"]).toContain(current()!.phase);
      const submissionId = randomUUID(),
        row: Release = {
          key,
          rawBody,
          bodyDigest: hash(rawBody),
          body,
          submissionId,
          postId: hash(submissionId),
          jobId: "publication:" + submissionId,
          phase: "admission",
          master: null,
          sealed: false,
          stems: new Map(),
        };
      releases.push(row);
      byKey.set(key, row);
      return json({ submissionId, postId: row.postId, state: "reserved" }, 201);
    }
    const upload =
      /^\/api\/uploads\/([^/]+)\/(audio|seal|stems)(?:\/(instrumental|vocals))?$/.exec(
        path,
      );
    if (upload) {
      const row = releases.find((value) => value.submissionId === upload[1]);
      expect(row).toBeTruthy();
      if (!row) throw new Error("Foreign fixture submission");
      if (upload[2] === "audio") {
        csrf();
        expect(method).toBe("PUT");
        counts.upload++;
        expect(request.headers()["content-type"]).toBe("audio/mpeg");
        const bytes = request.postDataBuffer()!;
        expect(bytes.byteLength).toBe(row.body.audioBytes);
        expect(hash(bytes)).toBe(row.body.audioSha256);
        if (!row.master) {
          row.master = Buffer.from(bytes);
          counts.stored++;
          if (loseMasterAck) {
            loseMasterAck = false;
            return route.abort("connectionreset");
          }
        } else expect(bytes.equals(row.master)).toBe(true);
        return json({ uploaded: true });
      }
      if (upload[2] === "stems") {
        if (!upload[3]) {
          expect(method).toBe("GET");
          return json({ stems: [...row.stems.values()] });
        }
        csrf();
        const slot = upload[3],
          existing = row.stems.get(slot);
        if (method === "POST") {
          const input = request.postDataJSON();
          if (existing)
            expect({
              sha256: existing.sha256,
              byteLength: existing.byteLength,
            }).toEqual(input);
          else row.stems.set(slot, { slot, state: "reserved", ...input });
          return json({ stem: row.stems.get(slot) }, 201);
        }
        expect(method).toBe("PUT");
        expect(request.headers()["content-type"]).toBe("audio/mpeg");
        expect(existing).toBeTruthy();
        const bytes = request.postDataBuffer()!;
        expect(hash(bytes)).toBe(existing!.sha256);
        expect(bytes.byteLength).toBe(existing!.byteLength);
        existing!.state = "sealed";
        counts.stems++;
        return json({ sealed: true });
      }
      csrf();
      expect(method).toBe("POST");
      expect(row.master).toBeTruthy();
      expect(
        ["instrumental", "vocals"].every(
          (slot) => row.stems.get(slot)?.state === "sealed",
        ),
      ).toBe(true);
      counts.seals++;
      expect(request.postDataJSON()).toEqual({});
      row.sealed = true;
      return json({ jobId: row.jobId, postId: row.postId }, 202);
    }
    if (path.startsWith("/api/jobs/")) {
      const native = /^\/api\/jobs\/([^/]+)(\/resume)?$/.exec(path)!;
      const row = releases.find(
        (value) => value.jobId === decodeURIComponent(native[1]),
      );
      expect(row?.sealed).toBe(true);
      if (!row) throw new Error("Foreign fixture job");
      if (native[2]) {
        csrf();
        expect(method).toBe("POST");
        expect(row.phase).toBe("uncertain");
        expect(request.postDataJSON()).toEqual({});
        counts.resumes++;
        row.phase = "publication";
        return json({ resuming: true });
      }
      expect(method).toBe("GET");
      return json({
        schema: "pirate.publication-job-view/1",
        jobId: row.jobId,
        submissionId: row.submissionId,
        postId: row.postId,
        phase: row.phase,
        errorCode:
          row.phase === "failed"
            ? "fixture_rejected"
            : row.phase === "held"
              ? "fixture_held"
              : null,
        resumable: row.phase === "uncertain",
      });
    }
    const media =
      /^\/api\/public\/posts\/(0x[0-9a-f]{64})\/(audio|proof)$/.exec(path);
    if (
      path === "/fixture-song.wav" ||
      (media?.[1] === catalogPostId && media[2] === "audio")
    )
      return route.fulfill({ contentType: "audio/wav", body: catalogBytes });
    if (media?.[1] === catalogPostId && media[2] === "proof")
      return json({
        schema: "pirate.community-publication-proof/1",
        transactionHash: catalog.transactionHash,
        post: {
          ...catalog.manifest,
          communityId,
          revision: 1,
          media: [
            {
              role: "audio",
              sha256: hash(catalogBytes),
              byteLength: catalogBytes.byteLength,
            },
          ],
        },
      });
    if (media) {
      const row = releases.find((value) => value.postId === media[1]);
      if (!row || row.phase !== "published" || !row.sealed || !exposePublished)
        return json({ error: "post_not_published" }, 404);
      expect(row.master).toBeTruthy();
      if (media[2] === "audio")
        return route.fulfill({ contentType: "audio/mpeg", body: row.master! });
      counts.proofs++;
      const view = publicRelease(row);
      return json({
        schema: "pirate.community-publication-proof/1",
        transactionHash: view.transactionHash,
        post: {
          ...view.manifest,
          communityId,
          revision: 1,
          media: [
            {
              role: "audio",
              sha256: hash(row.master!),
              byteLength: row.master!.byteLength,
            },
          ],
        },
      });
    }
    if (path.startsWith("/api/"))
      throw new Error(`Unexpected fixture call: ${method} ${path}`);
    const filename = path.startsWith("/app/assets/")
        ? path.slice(1)
        : "index.html",
      file = resolve("dist/live", filename);
    expect(file.startsWith(resolve("dist/live") + "/")).toBe(true);
    return route.fulfill({
      contentType: filename.endsWith(".js")
        ? "application/javascript"
        : filename.endsWith(".css")
          ? "text/css"
          : "text/html",
      body: await readFile(file),
      headers: { "referrer-policy": referrerPolicy },
    });
  });
  return {
    accountId,
    events,
    reservationRequests,
    creatorCalls: () => counts.creator,
    reservations: () => releases.length,
    storedUploads: () => counts.stored,
    uploadCalls: () => counts.upload,
    counts,
    phase(value: ReleasePhase) {
      if (!current()) throw new Error("No fixture job");
      if (value === "published") {
        expect(current()!.sealed).toBe(true);
        expect(current()!.master).toBeTruthy();
      }
      current()!.phase = value;
    },
    publishedFacts(value: boolean) {
      exposePublished = value;
    },
    feedOutage(value: boolean) {
      feedDown = value;
    },
    feed,
    releases: () =>
      releases.map(({ stems, master, ...row }) => ({
        ...row,
        audioSha256: master ? hash(master) : null,
        audioBytes: master?.byteLength,
        stems: [...stems.values()],
      })),
    audioRequests: () =>
      events.filter(
        (event) =>
          event.path === catalogAudioPath || event.path === "/fixture-song.wav",
      ).length,
  };
}
