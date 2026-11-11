// Explicit protocol simulation only, shared by Node and native browser cases.
// Product adapters never import this file. No handler/provider conformance claim.
import {
  OWNER_RELEASE_POLICY,
  fileHash,
  type CommunityHostContext,
} from "../src/media/community-contracts.ts";
import type {
  CommunitySongDraft,
  SongReleaseInput,
} from "../src/media/community-song-controller.ts";
export function latch() {
  let resolve!: () => void;
  let done = false;
  const promise = new Promise<void>((yes) => {
    resolve = () => {
      done = true;
      yes();
    };
  });
  return {
    promise,
    resolve,
    get done() {
      return done;
    },
  };
}
export function shellFixture(origin = "https://fixture.invalid") {
  const communityId = "0x" + "6".repeat(64),
    authorId = "0x" + "7".repeat(64),
    postId = "0x" + "8".repeat(64),
    transactionHash = "0x" + "9".repeat(64);
  const accountId = crypto.randomUUID(),
    submissionId = crypto.randomUUID(),
    jobId = "publication:" + submissionId;
  const context: CommunityHostContext = {
    community: { id: communityId, name: "Fixture", origin },
    language: "en",
    owner: {
      accountId,
      communityId,
      authorId,
      generation: crypto.randomUUID(),
    },
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
  const file = new File(["fixture MP3 bytes"], "fixture.mp3", {
    type: "audio/mpeg",
    lastModified: 1234,
  });
  const input: SongReleaseInput = {
    title: "Fixture",
    lyrics: "Fixture lyrics",
    language: "en",
    file,
    instrumental: file,
    vocals: file,
    originalConsent: true,
    rating: "general",
  };
  let phase = "admission",
    master = false,
    sealed = false,
    reserved = false,
    jobFailures = false;
  let body: Record<string, unknown> | null = null,
    key: string | null = null;
  const stems: Record<
    string,
    { slot: string; state: string; sha256: string; byteLength: number }
  > = {};
  const calls: {
    path: string;
    method: string;
    key: string | null;
    csrf: string | null;
    body: BodyInit | null | undefined;
  }[] = [];
  let gate: {
    kind: "job-body" | "audio-ack" | "auth-headers";
    entered: ReturnType<typeof latch>;
    release: ReturnType<typeof latch>;
  } | null = null;
  const delay = (kind: "job-body" | "audio-ack" | "auth-headers") => {
    const next = { kind, entered: latch(), release: latch() };
    gate = next;
    return next;
  };
  const transport: typeof fetch = async (url, init) => {
    const path = String(url),
      method = init?.method ?? "GET",
      headers = new Headers(init?.headers);
    if (!path.startsWith("/api/")) throw new Error("Unexpected fixture path");
    calls.push({
      path,
      method,
      key: headers.get("idempotency-key"),
      csrf: headers.get("x-csrf-token"),
      body: init?.body,
    });
    if (path === "/api/uploads" && method === "POST") {
      const next = JSON.parse(String(init?.body));
      if (
        body &&
        (JSON.stringify(next) !== JSON.stringify(body) ||
          headers.get("idempotency-key") !== key)
      )
        throw new Error("Fixture envelope changed");
      body = next;
      key = headers.get("idempotency-key");
      reserved = true;
      return Response.json({ submissionId, postId, state: "reserved" });
    }
    if (path === "/api/uploads")
      return Response.json({
        uploads: reserved
          ? [
              {
                submissionId,
                postId,
                title: "Fixture",
                state: sealed ? phase : master ? "uploaded" : "reserved",
                jobId: sealed ? jobId : null,
              },
            ]
          : [],
      });
    if (path.endsWith("/audio")) {
      if (
        !(init?.body instanceof File) ||
        (await fileHash(init.body)) !== body?.audioSha256
      )
        throw new Error("Fixture master changed");
      master = true;
      if (gate?.kind === "audio-ack") {
        const waiting = gate;
        gate = null;
        waiting.entered.resolve();
        await waiting.release.promise;
      }
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
      else {
        if (
          !(init?.body instanceof File) ||
          (await fileHash(init.body)) !== stems[slot].sha256
        )
          throw new Error("Fixture stem changed");
        stems[slot].state = "sealed";
      }
      return Response.json(
        method === "POST" ? { stem: stems[slot] } : { sealed: true },
      );
    }
    if (path.endsWith("/seal")) {
      sealed = true;
      return Response.json({ jobId, postId });
    }
    if (path.endsWith("/resume")) {
      if (phase !== "uncertain")
        return Response.json(
          { error: "job_not_reconcilable" },
          { status: 409 },
        );
      phase = "admission";
      return Response.json({ resuming: true });
    }
    if (path.startsWith("/api/jobs/")) {
      if (jobFailures) throw new TypeError("Fixture read reply lost");
      const payload = {
        schema: "pirate.publication-job-view/1",
        jobId,
        submissionId,
        postId,
        phase,
        resumable: phase === "uncertain",
        errorCode: phase === "failed" ? "fixture_rejected" : null,
      };
      if (gate?.kind === "job-body" || gate?.kind === "auth-headers") {
        const waiting = gate;
        gate = null;
        const response = Response.json(payload, {
          status: waiting.kind === "auth-headers" ? 403 : 200,
        });
        response.json = async () => {
          waiting.entered.resolve();
          await waiting.release.promise;
          return payload;
        };
        if (waiting.kind === "auth-headers") waiting.entered.resolve();
        return response;
      }
      return Response.json(payload);
    }
    if (path === "/api/feed")
      return Response.json({
        schema: "pirate.community-feed/1",
        communityId,
        posts:
          phase === "published"
            ? [
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
              ]
            : [],
      });
    if (path.endsWith("/proof"))
      return Response.json({
        schema: "pirate.community-publication-proof/1",
        transactionHash,
        post: { communityId, postId, authorId },
      });
    throw new Error("Unexpected fixture request: " + method + " " + path);
  };
  return {
    context,
    input,
    transport,
    calls,
    submissionId,
    postId,
    jobId,
    delay,
    phase(next: string) {
      phase = next;
    },
    failReads(value: boolean) {
      jobFailures = value;
    },
  };
}
export function shellMemory() {
  let value: CommunitySongDraft | null = null,
    tail: Promise<unknown> = Promise.resolve();
  return {
    value: () => value,
    replace: (next: CommunitySongDraft | null) => {
      value = next;
    },
    store: {
      exclusive<T>(work: () => Promise<T>) {
        const next = tail.then(work);
        tail = next.catch(() => {});
        return next;
      },
      load: async () => value,
      save: async (next: CommunitySongDraft) => {
        value = next;
      },
      remove: async () => {
        value = null;
      },
    },
  };
}
