// Coordinator browser harness only: actual host/controller/HTTP/native IDB and
// copied observer lifetime. HTTP replies are explicit protocol fixtures.
import { render } from "@solidjs/web";
import { CommunityComposerHost } from "../src/media/community-host.tsx";
import {
  captureCommunityOwner,
  OWNER_RELEASE_POLICY,
  type CommunityHostContext,
} from "../src/media/community-contracts.ts";
import {
  CommunitySongController,
  createBrowserSongStorage,
} from "../src/media/community-song-controller.ts";
import { communityHttp } from "../src/media/community-http.ts";
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function until(condition: () => boolean) {
  const end = performance.now() + 5000;
  while (!condition()) {
    if (performance.now() > end) throw new Error("Host fixture timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
export async function runCommunityHostBrowserCase(root: HTMLElement) {
  const communityId = "0x" + "6".repeat(64),
    authorId = "0x" + "7".repeat(64),
    postId = "0x" + "8".repeat(64);
  const accountId = crypto.randomUUID(),
    submissionId = crypto.randomUUID(),
    jobId = "publication:" + submissionId,
    transactionHash = "0x" + "9".repeat(64);
  let current: CommunityHostContext | null = {
    community: { id: communityId, name: "Fixture", origin: location.origin },
    language: "en",
    owner: { accountId, communityId, authorId, generation: "original" },
    session: {
      authenticated: true,
      authorId,
      mossAddress: "fixture-moss",
      csrf: "fixture-csrf",
      publisher: true,
      creator: null,
      pendingConnection: null,
      publicResults: "off",
    },
    capabilities: {
      schema: "pirate.community-capabilities/1",
      signIn: true,
      creatorConnection: false,
      upload: true,
      publication: true,
      policyVersion: OWNER_RELEASE_POLICY,
    },
    feed: { schema: "pirate.community-feed/1", communityId, posts: [] },
  };
  let phase = "admission",
    gate = false,
    jobEntered = false,
    jobReleased = false,
    refreshes = 0,
    writes = 0,
    master = false,
    sealed = false;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stems: Record<
    string,
    { slot: string; state: string; sha256: string; byteLength: number }
  > = {};
  const transport: typeof fetch = async (url, init) => {
    const path = String(url),
      method = init?.method ?? "GET";
    check(path.startsWith("/api/"), "Unexpected fixture service");
    if (method !== "GET") writes++;
    if (path === "/api/uploads" && method === "POST")
      return Response.json({ submissionId, postId, state: "reserved" });
    if (path === "/api/uploads")
      return Response.json({
        uploads: [
          {
            submissionId,
            postId,
            title: "Fixture",
            state: master ? "uploaded" : "reserved",
            jobId: sealed ? jobId : null,
          },
        ],
      });
    if (path.endsWith("/audio")) {
      master = true;
      return Response.json({ uploaded: true });
    }
    if (path.endsWith("/stems"))
      return Response.json({ stems: Object.values(stems) });
    if (path.includes("/stems/")) {
      const slot = path.split("/").at(-1)!;
      if (method === "POST")
        stems[slot] = {
          slot,
          ...JSON.parse(String(init?.body)),
          state: "reserved",
        };
      else stems[slot].state = "sealed";
      return Response.json(
        method === "POST" ? { stem: stems[slot] } : { sealed: true },
      );
    }
    if (path.endsWith("/seal")) {
      sealed = true;
      return Response.json({ jobId, postId });
    }
    if (path.startsWith("/api/jobs/")) {
      if (gate) {
        gate = false;
        jobEntered = true;
        await barrier;
        jobReleased = true;
      }
      return Response.json({
        schema: "pirate.publication-job-view/1",
        jobId,
        submissionId,
        postId,
        phase,
        resumable: false,
        errorCode: null,
      });
    }
    if (path === "/api/feed")
      return Response.json({
        schema: "pirate.community-feed/1",
        communityId,
        posts: [
          {
            manifest: {
              schema: "pirate.community-post/3",
              postId,
              authorId,
              title: "Fixture",
              language: "en",
              rating: "general",
            },
            transactionHash,
            audioUrl: `/api/public/posts/${postId}/audio`,
            postUrl: `/#song-${postId}`,
          },
        ],
      });
    if (path.endsWith("/proof"))
      return Response.json({
        schema: "pirate.community-publication-proof/1",
        transactionHash,
        post: { communityId, postId, authorId },
      });
    throw new Error("Unexpected host fixture request: " + path);
  };
  const seedOwner = captureCommunityOwner(() => current);
  const file = new File(["fixture master"], "fixture.mp3", {
    type: "audio/mpeg",
  });
  const controller = new CommunitySongController({
    owner: seedOwner,
    store: createBrowserSongStorage(seedOwner),
    http: communityHttp(seedOwner, transport),
  });
  await controller.prepare({
    title: "Fixture",
    lyrics: "Fixture lyrics",
    language: "en",
    file,
    instrumental: file,
    vocals: file,
    originalConsent: true,
    rating: "general",
  });
  await controller.publish();
  seedOwner.dispose();
  const originalFetch = globalThis.fetch;
  let dispose: (() => void) | undefined;
  globalThis.fetch = transport;
  try {
    const before = writes;
    gate = true;
    dispose = render(
      () => (
        <CommunityComposerHost
          open
          current={() => current}
          onOpenChange={() => {}}
          refreshFeed={async () => {
            refreshes++;
          }}
        />
      ),
      root,
    );
    await until(() => jobEntered);
    dispose();
    dispose = undefined;
    current = null;
    phase = "published";
    release();
    await until(() => jobReleased);
    const restored = {
      community: { id: communityId, name: "Fixture", origin: location.origin },
      language: "en",
      owner: { accountId, communityId, authorId, generation: "reopened" },
      session: {
        authenticated: true as const,
        authorId,
        mossAddress: "fixture-moss",
        csrf: "fixture-csrf",
        publisher: true,
        creator: null,
        pendingConnection: null,
        publicResults: "off" as const,
      },
      capabilities: {
        schema: "pirate.community-capabilities/1" as const,
        signIn: true,
        creatorConnection: false,
        upload: true,
        publication: true,
        policyVersion: OWNER_RELEASE_POLICY,
      },
      feed: {
        schema: "pirate.community-feed/1" as const,
        communityId,
        posts: [],
      },
    };
    current = restored;
    const readOwner = captureCommunityOwner(() => current),
      store = createBrowserSongStorage(readOwner);
    await store.exclusive(async () => {
      const saved = await store.load();
      check(
        saved?.job?.phase === "published" && saved.files.audio instanceof File,
        "Disposed host lost late canonical receipt/File",
      );
    });
    readOwner.dispose();
    check(
      Number(refreshes) === 0 && writes === before,
      "Disposed host notified or automatically replayed a write",
    );
    dispose = render(
      () => (
        <CommunityComposerHost
          open
          current={() => current}
          onOpenChange={() => {}}
          refreshFeed={async () => {
            refreshes++;
          }}
        />
      ),
      root,
    );
    await until(() => refreshes === 1);
    check(writes === before, "Reopen posted a new command");
    dispose();
    dispose = undefined;
    const cleanupOwner = captureCommunityOwner(() => current),
      cleanup = createBrowserSongStorage(cleanupOwner);
    await cleanup.exclusive(async () => {
      await cleanup.load();
      await cleanup.remove();
    });
    cleanupOwner.dispose();
    return {
      cases: [
        "actual host native durable restore",
        "ignored abort late job receipt",
        "disposed host callback fence",
        "read-only reopen original observer/feed/proof",
        "single canonical feed refresh",
      ],
      acceptance: "protocol simulation; native browser execution required",
    };
  } finally {
    release();
    dispose?.();
    globalThis.fetch = originalFetch;
  }
}
