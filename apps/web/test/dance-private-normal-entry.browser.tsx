/** Simulated HTTP bodies over the ACTUAL default App, production producer,
 * client/controller and IndexedDB journal. No camera/recorder/producer override.
 * Profile replacement is additionally exercised at the actual page-mount seam;
 * this makes no server, managed provider or physical playback acceptance claim. */
import { render } from "@solidjs/web";
import { createSignal } from "solid-js";
import { DancePageMount } from "../src/live/dance-pages.tsx";
import {
  createDanceSessionOwner,
  selectedDanceCapability,
  type CommunityCapabilities,
} from "../src/live/api.ts";
import { scope, hash, consent } from "./dance-source-fixtures.ts";
import { createBrowserDanceJourneyStore } from "../src/dance/source/journey-store.ts";
import { MAX_MEDIA_BYTES } from "../../../packages/community-media/validation.ts";

export type PrivateDanceEntryScenario =
  | "private"
  | "legacy"
  | "malformed"
  | "denied"
  | "profile-change";
function ensure(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
let started = false;
export async function runDancePrivateNormalEntryBrowserCase(
  host: HTMLElement,
  scenario: PrivateDanceEntryScenario,
) {
  ensure(!started, "Actual default entry requires a fresh fixture document");
  started = true;
  ensure(
    innerWidth < 768,
    "Fresh capture requests use the existing mobile posting policy",
  );
  const originalRoot = document.getElementById("app");
  ensure(
    originalRoot && originalRoot !== host,
    "Existing owner-ui fixture root required",
  );
  originalRoot.removeAttribute("id");
  host.id = "app";
  const postId = hash(90),
    authorId = hash(91),
    privateId = "22222222-2222-4222-8222-222222222222";
  const target = {
    communityId: scope.communityId,
    songKey: scope.songKey,
    songRevision: scope.songRevision,
    audioSha256: scope.audioSha256,
    reference: scope.reference,
    offerId: null,
  };
  const ownerScope = { ...scope, accountId: privateId };
  const capability = (version: "private" | "legacy" | "malformed") => ({
    schema: "pirate.community-capabilities/1",
    signIn: true,
    creatorConnection: false,
    study: false,
    upload: false,
    publication: false,
    policyVersion: "simulated-normal-private-policy",
    dance: {
      version:
        version === "legacy"
          ? "pirate.dance-capability/1"
          : "pirate.dance-capability/2",
      communityId: scope.communityId,
      ...(version === "legacy"
        ? {}
        : {
            captureProfile: version === "malformed" ? "public" : "private-v2",
          }),
      media: {
        version: "pirate.community-media/1",
        purpose: "private-review",
        policyVersion: "pirate.dance-private/1",
        maximumBytes: MAX_MEDIA_BYTES,
      },
    },
  });
  const pending: {
    body: Record<string, unknown>;
    signal?: AbortSignal | null;
    release(response: Response): void;
  }[] = [];
  const reads: {
    path: string;
    signal?: AbortSignal | null;
    release?: (response: Response) => void;
  }[] = [];
  let writes = 0,
    publicReviewCalls = 0,
    denialBodyReads = 0,
    ownerDenials = 0,
    cameraCalls = 0;
  let holdProfileCatalogue = false;
  const catalogue = () => ({
    version: "pirate.dance-catalogue/1",
    communityId: scope.communityId,
    accountId: privateId,
    owner: false,
    consent,
    cursor: null,
    choices: [
      {
        ...target,
        durationMs: 8000,
        title: "Normal private dance",
        playback: "ready",
        recordingAllowed: true,
      },
    ],
  });
  const media = navigator.mediaDevices,
    getUserMedia = media?.getUserMedia;
  if (media && typeof getUserMedia === "function")
    media.getUserMedia = async () => {
      cameraCalls++;
      throw Error(
        "Physical camera is outside this HTTP capture-request fixture",
      );
    };
  const originalFetch = globalThis.fetch;
  const json = (value: unknown) => Response.json(value);
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      location.href,
    );
    ensure(
      url.origin === location.origin,
      "Normal entry fixture refuses external networking",
    );
    const headers = new Headers(init.headers);
    if ((init.method ?? "GET") !== "GET") {
      writes++;
      if (url.pathname.includes("/reviews")) publicReviewCalls++;
      ensure(
        url.pathname === "/api/dance/captures" && init.method === "POST",
        "Unexpected private/public mutation: " + url.pathname,
      );
      ensure(
        headers.get("x-dance-account") === privateId &&
          headers.get("x-csrf-token") === "normal-csrf",
        "Actual private owner and CSRF required",
      );
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Promise<Response>((release) =>
        pending.push({ body, signal: init.signal, release }),
      );
    }
    if (url.pathname === "/api/session")
      return json({
        authenticated: true,
        authorId,
        mossAddress: "0x" + "01".repeat(20),
        csrf: "normal-csrf",
        creator: null,
        pendingConnection: null,
        publicResults: "off",
        publisher: false,
      });
    if (url.pathname === "/.well-known/pirate-client.json")
      return json({
        schema: "pirate.community-client-config/1",
        communityId: scope.communityId,
        canonicalOrigin: location.origin,
        apiBase: "/api",
        protocolVersions: [5],
        defaultLanguage: "en",
        supportedLanguages: ["en"],
        mirrors: [],
      });
    if (url.pathname === "/api/public/community")
      return json({ name: "Normal private fixture" });
    if (url.pathname === "/api/capabilities")
      return json(
        capability(
          scenario === "legacy"
            ? "legacy"
            : scenario === "malformed"
              ? "malformed"
              : "private",
        ),
      );
    if (url.pathname === "/api/feed")
      return json({
        schema: "pirate.community-feed/1",
        communityId: scope.communityId,
        posts: [
          {
            manifest: {
              schema: "pirate.community-post/3",
              postId,
              authorId,
              title: "Normal private song",
              language: "en",
              rating: "general",
            },
            audioUrl: "/api/public/posts/" + postId + "/audio",
            postUrl: "/api/public/posts/" + postId,
            transactionHash: hash(93),
          },
        ],
      });
    if (url.pathname === "/api/public/authors")
      return json({
        schema: "pirate.community-profile-list/1",
        communityId: scope.communityId,
        profiles: [],
      });
    if (url.pathname === "/api/profile/owner") {
      if (scenario === "denied") {
        ownerDenials++;
        const denied = new Response("private denial body", { status: 401 });
        denied.json = async () => {
          denialBodyReads++;
          throw Error("Denial JSON must never be consumed");
        };
        return denied;
      }
      return json({
        schema: "pirate.community-profile-owner/1",
        communityId: scope.communityId,
        accountId: privateId,
        profile: {
          schema: "pirate.community-profile/1",
          communityId: scope.communityId,
          authorId,
          revision: 0,
          displayName: null,
          bio: null,
          avatarRef: null,
          coverRef: null,
        },
        capabilities: { metadata: true, handles: false, publicMedia: false },
      });
    }
    if (url.pathname.startsWith("/api/dance/")) {
      ensure(
        headers.get("x-dance-account") === privateId,
        "Producer must resolve the genuine simulated private UUID",
      );
      const observation: (typeof reads)[number] = {
        path: url.pathname,
        signal: init.signal,
      };
      reads.push(observation);
      if (url.pathname === "/api/dance/songs/" + postId)
        return json({
          version: "pirate.dance-song-key/1",
          communityId: scope.communityId,
          accountId: privateId,
          postId,
          songKey: scope.songKey,
          bindingOnly: true,
        });
      if (url.pathname === "/api/dance/catalogue") {
        if (holdProfileCatalogue) {
          holdProfileCatalogue = false;
          return new Promise<Response>((release) => {
            observation.release = release;
          });
        }
        return json(catalogue());
      }
      if (url.pathname === "/api/dance/latest") return json(null);
      if (url.pathname === "/api/dance/reference")
        return json({
          target,
          url: location.origin + "/normal-reference.mp4",
          renewAt: Date.now() + 30000,
          expiresAt: Date.now() + 60000,
        });
      return new Response("Unavailable simulated private source", {
        status: 503,
      });
    }
    return new Response("No camera/playback/provider supplied", {
      status: 404,
    });
  };
  const settle = async (check: () => boolean, message: string) => {
    const end = performance.now() + 15000;
    while (!check()) {
      if (performance.now() >= end) throw Error(message);
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }
  };
  const button = (name: string) => {
    const matches = [
      ...host.querySelectorAll<HTMLButtonElement>("button"),
    ].filter((b) => b.textContent?.trim() === name);
    ensure(matches.length === 1, "Expected actual button: " + name);
    return matches[0]!;
  };
  let app: { disposeApplication(): void } | undefined,
    disposePage: (() => void) | undefined;
  const session = createDanceSessionOwner();
  try {
    history.replaceState(null, "", "/?fixture-context=private#song-" + postId);
    app = await import("../src/live/entry.tsx");
    await settle(
      () =>
        !!host.querySelector(
          'nav[aria-label="Song activities"] a[href*="/dance/"]',
        ),
      "Normal song Dance action missing",
    );
    host
      .querySelector<HTMLAnchorElement>(
        'nav[aria-label="Song activities"] a[href*="/dance/"]',
      )!
      .click();
    if (scenario === "malformed") {
      await settle(
        () =>
          host.textContent?.includes(
            "Dance is unavailable in this community.",
          ) === true,
        "Malformed capability did not refuse normal entry",
      );
      ensure(
        !reads.length && !pending.length,
        "Unavailable capability constructed a private producer",
      );
    } else if (scenario === "denied") {
      await settle(
        () =>
          ownerDenials > 0 &&
          host.textContent?.includes("Sign in to view this dance.") === true,
        "Actual private owner denial did not mask normal entry",
      );
      ensure(
        !reads.length && !pending.length && denialBodyReads === 0,
        "Denied private projection reached capture or decoded body",
      );
    } else {
      await settle(
        () =>
          host
            .querySelector("[data-dance-song]")
            ?.getAttribute("data-dance-song") === "ready",
        "Actual private catalogue did not settle",
      );
      const card = host.querySelector<HTMLButtonElement>(
        'button[aria-label^="Open Dance 1"]',
      );
      ensure(card, "Normal Dance card missing");
      card.click();
      await settle(
        () => !!host.querySelector('[data-dance-selection="ready"]'),
        "Actual selection did not settle",
      );
      button("Do this dance").click();
      await settle(
        () => !!host.querySelector('[aria-label="Captured Dance terms"]'),
        "Actual private media terms did not open",
      );
      ensure(
        pending.length === 0 && cameraCalls === 0,
        "Capture or camera started before explicit private media acceptance",
      );
      button("Accept and continue").click();
      await settle(
        () => pending.length === 1,
        "Actual production stack did not prepare a capture request",
      );
      const body = pending[0]!.body;
      if (scenario === "legacy") {
        ensure(
          !("version" in body) &&
            !("publication" in body) &&
            body.songKey === scope.songKey,
          "V1 wire was rewritten as a fresh V2 request",
        );
      } else {
        ensure(
          body.version === "pirate.dance-capture-request/2" &&
            JSON.stringify(body.publication) ===
              JSON.stringify({ kind: "private" }),
          "Normal capability did not select private V2 capture",
        );
        ensure(
          JSON.stringify(body.target) ===
            JSON.stringify({
              ...target,
              reference: {
                id: scope.reference!.id,
                revision: scope.reference!.revision,
              },
            }),
          "Private request changed the chosen target",
        );
      }
      const original = await createBrowserDanceJourneyStore().read(
        ownerScope,
        () => {},
      );
      const command = original.commands?.capture;
      ensure(
        original.captureUnknown &&
          command &&
          command.commandId === body.commandId &&
          command.requestJson === JSON.stringify(body),
        "Actual IDB did not retain the original request before dispatch",
      );
      if (scenario === "profile-change") {
        // Default App's full capability refresh is Root-owned. Exercise its
        // existing reactive page seam directly, with the same real producer.
        app.disposeApplication();
        app = undefined;
        await settle(
          () => pending[0]!.signal?.aborted === true,
          "Default App disposal did not abort old V2 capture",
        );
        const originalBytes = command.requestJson;
        session.update({
          communityId: scope.communityId,
          authorId,
          csrf: "normal-csrf",
        });
        holdProfileCatalogue = true;
        const [cap, setCap] = createSignal(
          selectedDanceCapability(
            capability("private") as CommunityCapabilities,
            scope.communityId,
          ),
        );
        disposePage = render(
          () => (
            <DancePageMount
              communityId={scope.communityId}
              route={{ kind: "dance", route: { kind: "post", postId } }}
              session={session}
              capability={cap()}
              loading={false}
              onBack={() => {}}
              onSignIn={() => {}}
              onReview={() => {
                throw Error("Profile replacement cannot publish a review");
              }}
              onManage={() => {}}
              onAccessLost={() => {}}
            />
          ),
          host,
        );
        await settle(
          () => reads.some((r) => !!r.release),
          "Reactive actual mount did not start its own pending source read",
        );
        const oldRead = reads.find((r) => !!r.release)!;
        ensure(
          !oldRead.signal?.aborted,
          "Profile-change witness must begin with a live private read",
        );
        setCap(
          selectedDanceCapability(
            capability("legacy") as CommunityCapabilities,
            scope.communityId,
          ),
        );
        await settle(
          () => oldRead.signal?.aborted === true,
          "V2-to-V1 profile replacement did not abort the old producer",
        );
        oldRead.release!(json(catalogue()));
        await settle(
          () =>
            host
              .querySelector("[data-dance-song]")
              ?.getAttribute("data-dance-song") === "ready",
          "Replacement profile did not independently load its source",
        );
        ensure(
          !host.querySelector("[data-dance-recorder]"),
          "Late V2 read resurrected the original recorder",
        );
        setCap(null);
        await settle(
          () =>
            host.textContent?.includes(
              "Dance is unavailable in this community.",
            ) === true,
          "Removed profile retained its private view",
        );
        ensure(
          !host.querySelector("[data-dance-song]"),
          "Removed profile retained an actionable source",
        );
        pending[0]!.release(
          new Response("late private acknowledgement", { status: 503 }),
        );
        const retained = await createBrowserDanceJourneyStore().read(
          ownerScope,
          () => {},
        );
        ensure(
          retained.commands?.capture?.requestJson === originalBytes,
          "Profile replacement changed or erased original unknown command",
        );
        setCap(
          selectedDanceCapability(
            capability("private") as CommunityCapabilities,
            scope.communityId,
          ),
        );
        await settle(
          () =>
            host
              .querySelector("[data-dance-song]")
              ?.getAttribute("data-dance-song") === "ready",
          "Fresh V2 owner did not load after profile restoration",
        );
        ensure(
          Array.from(pending).length === 1 && !host.querySelector("[data-dance-recorder]"),
          "Profile restoration replayed an earlier capture",
        );
      }
      ensure(writes === 1, "Normal entry staged an additional mutation");
    }
    ensure(
      publicReviewCalls === 0,
      "Private capability staged a public review",
    );
    ensure(
      cameraCalls === 0,
      "HTTP request witness tried to open the physical camera",
    );
    return {
      scenario,
      defaultEntry: true,
      publicReviewCalls,
      cameraOpened: cameraCalls > 0,
      captureRequests: pending.length,
      requestVersion: pending[0]?.body.version ?? null,
      denialBodyReads,
    };
  } finally {
    disposePage?.();
    app?.disposeApplication();
    session.dispose();
    for (const held of pending)
      held.release(new Response("Fixture disposed", { status: 503 }));
    for (const held of reads)
      held.release?.(new Response("Fixture disposed", { status: 503 }));
    if (media && typeof getUserMedia === "function")
      media.getUserMedia = getUserMedia;
    globalThis.fetch = originalFetch;
    host.removeAttribute("id");
    originalRoot.id = "app";
  }
}
