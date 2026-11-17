/** Labelled HTTP bodies over the ACTUAL default App, StudyPage and client.
 * No MOSS, microphone, backend/public-grant or genuine grade acceptance claim.
 * Mode replacement also exercises the real reactive LearningPageMount seam. */
import { render } from "@solidjs/web";
import { createSignal } from "solid-js";
import { LearningPageMount } from "../src/live/learning-pages.tsx";
import { createLearningActionOwner } from "../src/live/learning-action-owner.ts";
import type { StudyLesson, StudySong } from "../../../packages/study/lesson.ts";

export type PrivateStudyEntryScenario = "private" | "lost-ack" | "legacy-v3" | "legacy-v4" | "unknown" | "mode-change" | "pre-acceptance-mode-change";
function ensure(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
let started = false;
export async function runStudyPrivateNormalEntryBrowserCase(host: HTMLElement, scenario: PrivateStudyEntryScenario) {
  ensure(!started, "Default entry requires a fresh fixture document"); started = true;
  const outer = document.getElementById("app"); ensure(outer && outer !== host, "Existing owner-ui fixture root required");
  outer.removeAttribute("id"); host.id = "app";
  const word = (n: number) => "0x" + n.toString(16).padStart(64, "0");
  const communityId = word(1), postId = word(2), authorId = word(3), account = "0x" + "04".repeat(20);
  const song: StudySong = { chainId: 6343, postsContract: "0x" + "05".repeat(20), communityId, postId, lyricRevision: 1 };
  const id = "private_study_fixture_lesson", prompt = "Original private Study line";
  const completed: StudyLesson = { schema: "pirate.study.lesson/1", kind: "say-it-back", lessonId: id, song,
    startedAt: Date.now(), expiresAt: Number.MAX_SAFE_INTEGER, completedAt: Date.now(), status: "completed", completionReason: "all_resolved",
    current: null, lastAttempt: null, progress: { total: 4, resolved: 4, mastered: 4, presentations: 4, presentationCap: 12,
      firstPassGraded: 4, firstPassCorrect: 4 }, qualification: "not_evaluated" };
  const active: StudyLesson = { ...completed, status: "active", completedAt: null, completionReason: null,
    progress: { ...completed.progress, resolved: 0, mastered: 0, presentations: 0, firstPassGraded: 0, firstPassCorrect: 0 },
    current: { line: { ...song, lineId: word(6), lineVersion: 1, text: prompt, language: "en", manifestDigest: word(7) }, presentationNumber: 1, takeNumber: 1, attempt: null } };
  const preAcceptanceLesson: StudyLesson = { ...active, lessonId: id + "_pending" };
  const privateMode = ["private", "lost-ack", "mode-change", "pre-acceptance-mode-change"].includes(scenario);
  const requests: { path: string; method: string; body: string | null }[] = [], starts: string[] = [];
  let enrollmentCalls = 0, forbiddenCalls = 0, signatures = 0, physicalCaptureRequests = 0, receiptCalls = 0;
  let saved = false, holdProbeLesson = false, preAcceptanceProbe = false, preAccepted = false;
  let songReads = 0;
  const preAcceptanceLatest: (StudyLesson | null)[] = [];
  const heldStarts: ((response: Response) => void)[] = [], heldReads: ((response: Response) => void)[] = [];
  const originalFetch = globalThis.fetch, media = navigator.mediaDevices, getUserMedia = media?.getUserMedia;
  if (media && typeof getUserMedia === "function") media.getUserMedia = async () => {
    physicalCaptureRequests++; throw Error("Microphone/camera is outside this normal-start fixture");
  };
  const json = (value: unknown) => Response.json(value);
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href), method = init.method ?? "GET";
    ensure(url.origin === location.origin, "Fixture refuses external/provider networking");
    requests.push({ path: url.pathname, method, body: init.body === undefined ? null : String(init.body) });
    if (/enrollment|authorization|public-consent|publication-grant|sign-in|moss|wallet/.test(url.pathname) && url.pathname !== "/api/karaoke/enrollment") {
      forbiddenCalls++; throw Error("Unexpected public/provider authority request: " + url.pathname);
    }
    if (url.pathname === "/api/session") return json({ authenticated: true, authorId, mossAddress: account, csrf: "private-study-csrf",
      creator: null, pendingConnection: null, publicResults: scenario === "legacy-v4" ? "on" : "unavailable", publisher: false });
    if (url.pathname === "/.well-known/pirate-client.json") return json({ schema: "pirate.community-client-config/1", communityId,
      canonicalOrigin: location.origin, apiBase: "/api", protocolVersions: [5], defaultLanguage: "en", supportedLanguages: ["en"], mirrors: [] });
    if (url.pathname === "/api/public/community") return json({ name: "Normal private Study fixture" });
    if (url.pathname === "/api/capabilities") return json({ schema: "pirate.community-capabilities/1", signIn: true,
      creatorConnection: false, upload: false, publication: false, study: true, learningServiceMode: "internal", policyVersion: "offline-study-fixture",
      ...(privateMode ? { studyRuntime: "private-v5" } : scenario === "unknown" ? { studyRuntime: "private-v6" } : {}) });
    if (url.pathname === "/api/feed") return json({ schema: "pirate.community-feed/1", communityId, posts: [{
      manifest: { schema: "pirate.community-post/3", postId, authorId, title: "Normal private Study song", language: "en", rating: "general" },
      audioUrl: "/api/public/posts/" + postId + "/audio", postUrl: "/api/public/posts/" + postId, transactionHash: word(8),
    }] });
    if (url.pathname === "/api/public/authors") return json({ schema: "pirate.community-profile-list/1", communityId, profiles: [] });
    if (url.pathname === "/api/karaoke/enrollment") {
      enrollmentCalls++; ensure(!privateMode || preAcceptanceProbe, "Private Study requested a public enrollment");
      ensure(JSON.stringify(JSON.parse(String(init.body))) === JSON.stringify({ activity: "study" }), "Legacy enrollment request changed");
      return json({ active: true, activities: 2, target: { chainId: 6343, version: 3, contract: "0x" + "09".repeat(20) } });
    }
    if (url.pathname === "/api/study/song") { songReads++; return json(song); }
    if (url.pathname === "/api/study/lessons" && method === "GET") {
      if (preAcceptanceProbe) {
        const value = preAccepted ? preAcceptanceLesson : null;
        preAcceptanceLatest.push(value); return json(value);
      }
      return json(scenario === "mode-change" && saved ? active : null);
    }
    if (url.pathname === "/api/study/lessons" && method === "POST") {
      ensure(new Headers(init.headers).get("x-study-account") === account && new Headers(init.headers).get("x-csrf-token") === "private-study-csrf", "Actual captured Study account/CSRF missing");
      const bytes = String(init.body), body = JSON.parse(bytes); starts.push(bytes);
      ensure(JSON.stringify(body.song) === JSON.stringify(song) && typeof body.requestId === "string", "Start target/identity changed");
      // This witness holds the POST BEFORE acceptance; latest remains null.
      // A legacy successor is allowed to expose the old defect's enrollment/
      // second POST, so the assertions observe it rather than hiding the race.
      if (preAcceptanceProbe) return new Promise<Response>(resolve => heldStarts.push(resolve));
      saved = true;
      if (scenario === "mode-change") return new Promise<Response>(resolve => heldStarts.push(resolve));
      if (scenario === "lost-ack" && starts.length === 1) throw Error("fixture_lost_original_start_ack");
      return json(completed);
    }
    if (url.pathname === "/api/study/lessons/" + id && method === "GET") {
      if (holdProbeLesson) { holdProbeLesson = false; return new Promise<Response>(resolve => heldReads.push(resolve)); }
      return json(scenario === "mode-change" || preAcceptanceProbe ? active : completed);
    }
    if (url.pathname === "/api/study/lessons/" + id + "/publication") {
      receiptCalls++; return json({ state: "private", receipt: null });
    }
    return new Response("No offline Study endpoint supplied", { status: 404 });
  };
  const settle = async (condition: () => boolean, message: string) => {
    const deadline = performance.now() + 15000;
    while (!condition()) { if (performance.now() >= deadline) throw Error(message); await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); }
  };
  let app: { disposeApplication(): void } | undefined, disposeProbe: (() => void) | undefined;
  try {
    history.replaceState(null, "", "/?normal-study-context=private#song-" + postId);
    app = await import("../src/live/entry.tsx");
    await settle(() => !!host.querySelector('nav[aria-label="Song activities"] a[href*="?study="]'), "Normal Study action missing");
    host.querySelector<HTMLAnchorElement>('nav[aria-label="Song activities"] a[href*="?study="]')!.click();
    if (scenario === "lost-ack") {
      await settle(() => starts.length === 1 && host.textContent?.includes("Study unavailable") === true, "Lost ACK did not retain explicit retry state");
      const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "Try Again");
      ensure(retry, "Actual Study retry control missing"); retry.click();
      await settle(() => starts.length === 2, "Explicit retry did not reconcile the original start");
      ensure(starts[0] === starts[1], "Unknown retry changed original request ID, song or private choice");
    } else await settle(() => starts.length === 1, "Normal App did not reach actual Study start");
    for (const bytes of starts) {
      const body = JSON.parse(bytes);
      ensure(privateMode ? JSON.stringify(body.publication) === JSON.stringify({ kind: "private" }) : !("publication" in body), "Selected private/legacy request mode was not preserved");
      ensure(Object.keys(body).sort().join() === (privateMode ? "publication,requestId,song" : "requestId,song"), "Start envelope contains extra authority fields");
    }
    if (scenario === "pre-acceptance-mode-change") {
      await settle(() => receiptCalls > 0, "Normal App did not finish its original private fixture journey");
      app.disposeApplication(); app = undefined;
      const offset = starts.length, priorReceipts = receiptCalls;
      preAcceptanceProbe = true; preAccepted = false; saved = false;
      const [mode, setMode] = createSignal<"private-v5" | undefined>("private-v5");
      const actions = createLearningActionOwner(() => {});
      disposeProbe = render(() => <LearningPageMount communityId={communityId} route={{ kind: "study", postId, title: "Unaccepted original private start" }}
        account={account} csrf="private-study-csrf" wallet={{ signConsent: async () => { signatures++; throw Error("No pending-start signature allowed"); } }}
        studyRuntime={mode()} signInPermission={false} actions={actions} onExit={() => {}} onConnect={() => { signatures++; }} onLessonOpened={() => {}} />, host);
      await settle(() => starts.length === offset + 1 && heldStarts.length === 1, "Probe did not hold its first private start before acceptance");
      ensure(preAcceptanceLatest.length > 0 && preAcceptanceLatest.every(value => value === null) && !preAccepted,
        "Pre-acceptance witness must have a genuinely null latest reply, not an already accepted lesson");
      const originalBytes = starts[offset]!;
      ensure(JSON.parse(originalBytes).publication?.kind === "private", "Probe's original start must be private");
      for (const replacement of [undefined, "private-v5", undefined] as const) {
        const reads = songReads; setMode(replacement);
        await settle(() => songReads > reads, "Mode replacement did not construct a fresh actual Study owner");
        await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
        ensure(!preAccepted && starts.length === offset + 1 && enrollmentCalls === 0,
          "Unaccepted private POST lost its original handoff: successor enrolled or dispatched a new ID/mode");
      }
      preAccepted = true; saved = true;
      heldStarts[0]!(json(preAcceptanceLesson));
      await settle(() => host.textContent?.includes(prompt) === true, "Current owner did not receive the accepted original private start");
      ensure(starts.length === offset + 1 && starts[offset] === originalBytes && enrollmentCalls === 0,
        "Resolving original start changed its request ID/body/private choice");
      ensure(receiptCalls === priorReceipts, "Pending original response published a stale terminal result");
    } else if (scenario === "mode-change") {
      app.disposeApplication(); app = undefined;
      const [mode, setMode] = createSignal<"private-v5" | undefined>("private-v5");
      const actions = createLearningActionOwner(() => {});
      holdProbeLesson = true;
      disposeProbe = render(() => <LearningPageMount communityId={communityId} route={{ kind: "study", postId, title: "Private saved original", lessonId: id }}
        account={account} csrf="private-study-csrf" wallet={{ signConsent: async () => { signatures++; throw Error("No private signature allowed"); } }}
        studyRuntime={mode()} signInPermission={false} actions={actions} onExit={() => {}} onConnect={() => { signatures++; }} onLessonOpened={() => {}} />, host);
      await settle(() => heldReads.length === 1, "Actual private mount did not start its held original read");
      setMode(undefined);
      await settle(() => host.textContent?.includes(prompt) === true, "Mode replacement did not load the retained original under a fresh owner");
      heldReads[0]!(json(completed)); heldStarts[0]!(json(completed));
      await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      ensure(host.textContent?.includes(prompt), "Late old-mode body replaced the current original lesson");
      ensure(starts.length === 1 && receiptCalls === 0 && enrollmentCalls === 0, "Mode replacement upgraded/replayed private work or published a stale result");
    } else {
      await settle(() => receiptCalls > 0, "Terminal lesson did not read its actual private receipt");
      await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      const observed = receiptCalls;
      await new Promise<void>(resolve => setTimeout(resolve, 3200));
      ensure(receiptCalls === observed, "Private receipt scheduled another public publication poll");
    }
    ensure(forbiddenCalls === 0 && signatures === 0 && physicalCaptureRequests === 0, "Normal Study invoked public signature/provider/device authority");
    ensure(enrollmentCalls === (scenario === "legacy-v3" || scenario === "unknown" ? 1 : 0), "Missing/unknown private mode bypassed legacy enrollment or private mode enrolled");
    return { scenario, defaultEntry: true, enrollmentCalls, signatures, physicalCaptureRequests, starts: starts.length, receiptCalls,
      originalRequestBytes: starts[0], originalIdPreserved: scenario !== "lost-ack" || starts[0] === starts[1] };
  } finally {
    disposeProbe?.(); app?.disposeApplication();
    heldReads.forEach(resolve => resolve(new Response("Fixture disposed", { status: 503 })));
    heldStarts.forEach(resolve => resolve(new Response("Fixture disposed", { status: 503 })));
    if (media && typeof getUserMedia === "function") media.getUserMedia = getUserMedia;
    globalThis.fetch = originalFetch; host.removeAttribute("id"); outer.id = "app";
  }
}
