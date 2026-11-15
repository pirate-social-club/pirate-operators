/** UNRUN. Fresh-document browser diagnostic of the ACTUAL default entry.
 * HTTP bodies are explicitly simulated. No producer, controller, IDB, URL or
 * machine replacement; this cannot qualify backend/camera/provider acceptance. */
import { scope, hash, consent, captureFixture, reviewFixture, mediaFixture } from "./dance-source-fixtures.ts";
import { danceUrl, withoutActivity } from "../src/shell/routing.ts";
import type { DanceProductionRoute } from "../src/dance/production.tsx";
import { createBrowserDanceRecordingStorage } from "../src/dance/source/dance-recording-storage.ts";
import { createBrowserDanceJourneyStore } from "../src/dance/source/journey-store.ts";
import { danceRecordingDigest } from "../src/dance/source/dance-recording.ts";
import { danceTargetKey } from "../src/dance/source/ports.ts";
import { MAX_MEDIA_BYTES } from "../../../packages/community-media/validation.ts";

let started = false;
function ensure(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
export async function runDanceProductionNormalEntryBrowserCase(host: HTMLElement, options: {
  direct?: DanceProductionRoute;
  invalid?: string;
  owner?: boolean;
  savedOriginal?: Blob;
  resumeExisting?: boolean;
} = {}) {
  ensure(!started, "Use a fresh document for the real default entry");
  started = true;
  ensure(host.ownerDocument === document && !document.getElementById("app"), "Fresh App host required");
  host.id = "app";
  const postId = hash(90), authorA = hash(91), authorB = hash(92);
  let c = captureFixture(Date.now()), review = reviewFixture(c);
  review.receipt.mediaId = "22222222-2222-4222-8222-222222222222";
  const original = createBrowserDanceRecordingStorage(scope.accountId);
  let expectedOriginal: { metadataJson: string; blob: Blob } | null = null;
  if (options.savedOriginal) {
    ensure(innerWidth < 768, "Original recovery uses the real mobile posting viewport");
    ensure(options.savedOriginal.type === "video/mp4", "Coordinator supplies an encoded MP4 fixture");
    const digest = await danceRecordingDigest(options.savedOriginal);
    if (options.resumeExisting) {
      const retainedJourney = await createBrowserDanceJourneyStore().read(scope, () => {});
      ensure(retainedJourney.capture, "Reload must retain the same capture receipt");
      c = retainedJourney.capture;
      review = reviewFixture(c);
      review.receipt.mediaId = "22222222-2222-4222-8222-222222222222";
      expectedOriginal = await original.load(c.captureId, () => {});
      ensure(expectedOriginal && await danceRecordingDigest(expectedOriginal.blob) === digest,
        "Fresh document must see the exact prior original");
    } else {
      ensure(await original.load(c.captureId, () => {}) === null, "Never replace a prior original");
      expectedOriginal = { blob: options.savedOriginal, metadataJson: JSON.stringify({
        version: 1, accountId: scope.accountId, targetKey: danceTargetKey(scope),
        sessionId: c.captureId, termsHash: c.termsHash, captureHash: c.captureHash,
        consentReceiptId: c.consent!.receiptId, durationMs: c.durationSamples / 48,
        byteLength: options.savedOriginal.size, sha256: digest,
        storedAtMs: c.reservedAtMs, expiresAtMs: c.expiresAtMs,
      }) };
      await original.add(expectedOriginal, () => {});
      await createBrowserDanceJourneyStore().exclusive(scope, () => {}, h => h.save({
        capture: c, upload: {
          requestId: "11111111-1111-4111-8111-111111111111",
          recordingSha256: digest, bytes: options.savedOriginal!.size,
          mediaId: null, put: "unknown", status: null,
        },
      }));
    }
  }
  let role: "a" | "b" = "a", writes = 0;
  const requests: { path: string; account: string | null; signal?: AbortSignal | null }[] = [];
  const held: { signal?: AbortSignal | null; release(response: Response): void }[] = [];
  const account = () => role === "a" ? scope.accountId : "private_role_b";
  const author = () => role === "a" ? authorA : authorB;
  const profile = () => ({ schema: "pirate.community-profile/1", communityId: scope.communityId,
    authorId: author(), revision: 0, displayName: null, bio: null, avatarRef: null, coverRef: null });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), location.href);
    ensure(url.origin === location.origin, "Diagnostic refuses external networking");
    const privateAccount = new Headers(init.headers).get("x-dance-account");
    requests.push({ path: url.pathname, account: privateAccount, signal: init.signal });
    if (init.method && init.method !== "GET") {
      writes++; throw Error("Normal navigation/recovery must not invent a write");
    }
    const reply = (value: unknown) => Response.json(value);
    if (url.pathname === "/api/session") return reply({
      authenticated: true, authorId: author(), mossAddress: "0x" + (role === "a" ? "01" : "04").repeat(20),
      csrf: "role-csrf-" + role, creator: null, pendingConnection: null,
      publicResults: "on", publisher: false,
    });
    if (url.pathname === "/.well-known/pirate-client.json") return reply({
      schema: "pirate.community-client-config/1", communityId: scope.communityId,
      canonicalOrigin: location.origin, apiBase: "/api", protocolVersions: [5],
      defaultLanguage: "en", supportedLanguages: ["en"], mirrors: [],
    });
    if (url.pathname === "/api/public/community") return reply({ name: "Diagnostic community" });
    if (url.pathname === "/api/capabilities") return reply({
      schema: "pirate.community-capabilities/1", signIn: true, creatorConnection: false,
      study: true, upload: false, publication: false, policyVersion: "diagnostic",
      dance: { version: "pirate.dance-capability/1", communityId: scope.communityId,
        media: { version: "pirate.community-media/1", purpose: "private-review",
          policyVersion: "pirate.dance-private/1", maximumBytes: MAX_MEDIA_BYTES } },
    });
    if (url.pathname === "/api/feed") return reply({
      schema: "pirate.community-feed/1", communityId: scope.communityId, posts: [{
        manifest: { schema: "pirate.community-post/3", postId, authorId: authorA,
          title: "Diagnostic song", language: "en", rating: "general" },
        audioUrl: "/api/public/posts/" + postId + "/audio",
        postUrl: "/api/public/posts/" + postId, transactionHash: hash(93),
      }],
    });
    if (url.pathname === "/api/profile/owner") return reply({
      schema: "pirate.community-profile-owner/1", communityId: scope.communityId,
      accountId: account(), profile: profile(),
      capabilities: { metadata: true, publicMedia: false, handles: false },
    });
    if (url.pathname === "/api/public/authors") return reply({
      schema: "pirate.community-profile-list/1", communityId: scope.communityId, profiles: [],
    });
    if (url.pathname.startsWith("/api/dance/")) {
      ensure(privateAccount === account(), "Actual producer must use private account lookup");
      if (url.pathname === "/api/dance/songs/" + postId) return reply({
        version: "pirate.dance-song-key/1", communityId: scope.communityId,
        accountId: account(), postId, songKey: scope.songKey, bindingOnly: true,
      });
      if (url.pathname === "/api/dance/catalogue") return reply({
        version: "pirate.dance-catalogue/1", communityId: scope.communityId,
        accountId: account(), owner: options.owner === true, consent, cursor: null,
        choices: [{ ...scope, durationMs: c.durationSamples / 48, title: "Diagnostic dance",
          playback: "ready", recordingAllowed: true }],
      });
      if (url.pathname === "/api/dance/latest")
        return reply(options.savedOriginal || options.owner || role === "b" ? null : review);
      if (url.pathname === "/api/dance/reference") return reply({
        target: { communityId: scope.communityId, songKey: scope.songKey,
          songRevision: scope.songRevision, audioSha256: scope.audioSha256,
          reference: scope.reference, offerId: null },
        url: location.origin + "/__diagnostic/reference.mp4",
        renewAt: Date.now() + 30000, expiresAt: Date.now() + 60000,
      });
      if (url.pathname === "/api/dance/reviews/" + review.reviewId) {
        if (role === "b") return new Response("denied", { status: 403 });
        if (!options.direct) return new Promise<Response>(release => held.push({ signal: init.signal, release }));
        return reply(review);
      }
      if (url.pathname === "/api/dance/captures/" + c.captureId + "/access")
        return reply({ version: "pirate.dance-capture-access/1", capture: c });
      return new Response("Unavailable diagnostic capability", { status: 503 });
    }
    if (url.pathname === "/api/media/" + review.receipt.mediaId) {
      const status = mediaFixture(c);
      status.id = review.receipt.mediaId;
      status.ready!.id = review.receipt.mediaId;
      status.playbackUrl = "/api/media/" + review.receipt.mediaId + "/playback";
      return reply(status);
    }
    return new Response("No diagnostic media/provider supplied", { status: 404 });
  };
  const baseUrl = new URL("/?filter=a%20b&language=en#song-" + postId, location.origin);
  ensure(!(options.direct && options.invalid), "Choose one direct-entry diagnostic");
  const initial = options.invalid ? new URL(options.invalid, baseUrl) :
    options.direct ? danceUrl(baseUrl, scope.communityId, options.direct) : baseUrl;
  ensure(initial.origin === location.origin, "Diagnostic entry must remain same-origin");
  history.replaceState(null, "", initial);
  const created = new Set<string>(), released = new Set<string>();
  const createObjectURL = URL.createObjectURL, revokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = blob => {
    const url = createObjectURL.call(URL, blob); created.add(url); return url;
  };
  URL.revokeObjectURL = url => {
    if (created.has(url)) released.add(url);
    revokeObjectURL.call(URL, url);
  };
  let app: { disposeApplication(): void } | undefined;
  const settle = async (condition: () => boolean, label: string) => {
    const deadline = performance.now() + 15000;
    while (!condition()) {
      if (performance.now() >= deadline) throw Error(label);
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    }
  };
  const button = (label: string, root: ParentNode = host) => {
    const found = [...root.querySelectorAll<HTMLButtonElement>("button")]
      .filter(b => b.textContent?.trim() === label || b.getAttribute("aria-label") === label);
    ensure(found.length === 1, "Expected one actual control: " + label);
    return found[0]!;
  };
  try {
    // This invokes the existing render(() => <App/>) with NO integrations prop.
    app = await import("../src/live/entry.tsx");
    if (options.invalid) {
      await settle(() => host.textContent?.includes("This dance link is invalid.") === true,
        "Malformed route did not render a refusal");
      ensure(!requests.some(r => r.path.startsWith("/api/dance/") || r.path.startsWith("/api/media/")),
        "Malformed route constructed private Dance services");
    } else if (options.direct) {
      await settle(() => requests.some(r => r.path === "/api/dance/reviews/" + review.reviewId) ||
        requests.some(r => r.path === "/api/dance/catalogue"), "Direct route did not reach actual producer");
      if (options.direct.kind === "result") {
        await settle(() => [...host.querySelectorAll("button")].some(b =>
          b.textContent?.trim() === "Manage recording"), "Result callback missing");
        button("Manage recording").click();
        await settle(() => location.pathname.endsWith("/recording"), "Manage did not reach actual review route");
      }
    } else {
      await settle(() => !!host.querySelector('nav[aria-label="Song activities"] a[href*="/dance/"]'),
        "Normal App song action did not expose Dance");
      const link = host.querySelector<HTMLAnchorElement>('nav[aria-label="Song activities"] a[href*="/dance/"]')!;
      link.click();
      await settle(() => host.querySelector("[data-dance-song]")?.getAttribute("data-dance-song") === "ready",
        "Real post-to-song/private catalogue did not settle");
      ensure(location.search === baseUrl.search && location.hash === baseUrl.hash,
        "Dance lost exact public query/fragment context");
      const card = host.querySelector<HTMLButtonElement>('button[aria-label^="Open Dance 1"]');
      ensure(card, "Real Paper dance choice absent"); card.click();
      await settle(() => !!host.querySelector('[data-dance-selection="ready"]'), "Actual selection did not settle");
      if (options.owner) {
        await settle(() => host.textContent?.includes("You review recordings for this community.") === true,
          "Actual owner catalogue restriction missing");
        ensure(![...host.querySelectorAll("button")].some(b => b.textContent?.trim() === "Do this dance"),
          "Owner was allowed a fresh learner recording");
        ensure(!host.querySelector("[data-dance-recorder]"), "Owner initialized private capture");
      } else if (options.savedOriginal) {
        button("Do this dance").click();
        await settle(() => !!host.querySelector("[data-dance-recorder]") &&
          host.textContent?.includes("original upload details") === true, "Retained-original recovery did not refuse a missing command");
        ensure(writes === 0, "Recovery invented a replacement command");
        button("Back to dance").click();
        await settle(() => !host.querySelector("[data-dance-recorder]"), "Recorder/controller disposal did not complete");
        const retained = await original.load(c.captureId, () => {});
        ensure(retained && retained.metadataJson === expectedOriginal!.metadataJson &&
          await danceRecordingDigest(retained.blob) === await danceRecordingDigest(expectedOriginal!.blob),
          "Navigation changed or erased the retained original");
      } else {
        const latest = host.querySelector<HTMLAnchorElement>('a[href*="/reviews/"][href$="/recording"]');
        ensure(latest, "Real latest-review callback absent"); latest.click();
        await settle(() => held.length > 0, "Review route did not start a private producer read");
        ensure(!held[0]!.signal?.aborted, "Read was already obsolete before account switch");
        role = "b"; window.dispatchEvent(new Event("focus"));
        await settle(() => held[0]!.signal?.aborted === true, "Account generation did not abort original private read");
        held[0]!.release(Response.json(review));
        await settle(() => requests.some(r => r.path.startsWith("/api/dance/") && r.account === "private_role_b"),
          "Successor used no fresh private account projection");
        await settle(() => host.textContent?.includes("Sign in to view your recording.") === true,
          "Successor refusal did not mask the private view");
        ensure(!host.querySelector("[data-dance-review]"),
          "Late original response mounted a private review after account change");
        button("Back to song").click();
        await settle(() => location.pathname.includes("/posts/"), "Back/popstate did not restore previous post route");
        history.back();
        await settle(() => !host.querySelector("[data-dance-normal-entry]"), "Back did not dispose normal Dance route");
        ensure(location.href === baseUrl.href, "Back changed feed context");
      }
    }
    ensure(writes === 0, "Navigation performed an authenticated content write");
    return { diagnostic: true, defaultEntry: true, requests: requests.map(({path, account}) => ({path, account})),
      direct: options.direct?.kind ?? null, invalid: options.invalid ?? null,
      savedOriginal: !!options.savedOriginal, mediaUrlsCreated: created.size,
      mediaUrlPositiveWitness: created.size > 0,
      limits: "HTTP simulated; no server/physical camera/provider/visual parity acceptance" };
  } finally {
    app?.disposeApplication();
    const leaked = [...created].filter(url => !released.has(url));
    URL.createObjectURL = createObjectURL; URL.revokeObjectURL = revokeObjectURL;
    for (const pending of held) pending.release(new Response("closed", { status: 503 }));
    globalThis.fetch = originalFetch;
    host.removeAttribute("id");
    ensure(leaked.length === 0, "Default App disposal retained an owned media URL");
  }
}
