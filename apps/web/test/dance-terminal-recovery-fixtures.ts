/** SIMULATED HTTP/current owner/media authority and memory transactions.
 * Real client, journal operations, codec and original controllers; no runtime
 * authority, browser, network, device or canonical verification evidence. */
import { createDanceClient } from "../src/dance/client.ts";
import type {
  DanceCapture,
  DanceReview,
} from "../../../packages/dance/contracts.ts";
import { danceTargetKey, type DanceScope } from "../src/dance/source/ports.ts";
import { createDancePreparationController } from "../src/dance/source/dance-preparation-controller.ts";
import { createDanceReviewController } from "../src/dance/source/dance-review-controller.ts";
import { simulatedCommandStorage } from "./dance-command-storage.ts";
import {
  simulatedSource,
  captureFixture,
  mediaFixture,
  reviewFixture,
  simulatedCanonicalReview,
  scope,
  consent,
  hash,
  sha,
} from "./dance-source-fixtures.ts";
export const terminalSignal = () => new AbortController().signal;
export const terminalUpload = {
  requestId: "original_media_request",
  recordingSha256: sha(16),
  bytes: 4,
  mediaId: "media",
  put: "acknowledged" as const,
  status: null,
};
export function simulatedTerminalJourney() {
  const f = simulatedSource(),
    durable = simulatedCommandStorage(),
    reviews = new Map<string, DanceReview>(),
    captures = new Map<string, DanceCapture>();
  const cA = captureFixture(),
    scopeB = { ...scope, songKey: hash(61) },
    cB = captureFixture();
  cB.captureId = "capture_B";
  cB.songKey = scopeB.songKey;
  cB.captureHash = hash(62);
  cB.consent = {
    ...cB.consent!,
    captureId: cB.captureId,
    captureHash: cB.captureHash,
  };
  captures.set(danceTargetKey(scope), cA);
  captures.set(danceTargetKey(scopeB), cB);
  let current = scope,
    alive = true,
    nowMs = 11000;
  const requests: { path: string; body: string | null }[] = [];
  const transport = {
    mode: "accepted" as
      | "accepted"
      | "lost_before_acceptance"
      | "expired"
      | "auth401"
      | "auth403"
      | "server500"
      | "other410"
      | "text410",
    outcomeBoundary: (() => {}) as () => void,
  };
  const clientFor = (s: DanceScope) =>
    createDanceClient({
      communityId: s.communityId,
      accountId: s.accountId,
      csrf: "SIMULATED fresh session",
      isCurrent: () => alive && current.accountId === s.accountId,
      journal: durable.journal(),
      fetcher: (async (url, init) => {
        const path = String(url);
        requests.push({ path, body: init?.body ? String(init.body) : null });
        if (!init?.method) {
          const id = decodeURIComponent(path.split("/").at(-1)!);
          return reviews.has(id)
            ? Response.json(reviews.get(id))
            : Response.json({ error: "not_found" }, { status: 404 });
        }
        const body = JSON.parse(String(init.body));
        if (path.endsWith("captures")) {
          const c = captures.get(danceTargetKey(s));
          if (!c) throw Error("SIMULATED capture missing");
          c.consent = { ...c.consent!, receiptId: body.commandId };
          return Response.json(c);
        }
        if (transport.mode === "lost_before_acceptance")
          throw TypeError("SIMULATED transport before acceptance");
        if (transport.mode === "expired") {
          transport.outcomeBoundary();
          return Response.json(
            { error: "dance_capture_expired" },
            { status: 410 },
          );
        }
        if (transport.mode === "auth401" || transport.mode === "auth403")
          return new Response("refused", {
            status: transport.mode === "auth401" ? 401 : 403,
          });
        if (transport.mode === "server500")
          return Response.json({ error: "unavailable" }, { status: 500 });
        if (transport.mode === "other410")
          return Response.json({ error: "different_policy" }, { status: 410 });
        if (transport.mode === "text410")
          return new Response("expired", { status: 410 });
        const c = [...captures.values()].find(
          (c) => c.captureId === body.captureId,
        );
        if (!c) throw Error("SIMULATED original capture missing");
        reviews.set(c.captureId, reviewFixture(c));
        return Response.json({
          version: "pirate.dance/1",
          commandId: body.commandId,
          reviewId: c.captureId,
          revision: 1,
          state: "awaiting_review",
          intentId: null,
        });
      }) as typeof fetch,
    });
  const portsFor = (s: DanceScope) => ({
    ...f.ports,
    scope: s,
    currentScope: () =>
      alive && danceTargetKey(current) === danceTargetKey(s) ? current : null,
    nowMs: () => nowMs,
    client: clientFor(s),
    media: {
      ...f.ports.media,
      status: async (c: DanceCapture) => mediaFixture(c),
    },
  });
  const select = (s: DanceScope) => {
    current = s;
    return portsFor(s);
  };
  const prepareTake = async (s = scope) => {
    const ports = select(s),
      c = captures.get(danceTargetKey(s))!;
    await createDancePreparationController(ports).start(
      consent.termsHash,
      terminalSignal(),
    );
    await f.journey.store.exclusive(
      s,
      () => {},
      async (h) => {
        await h.save({ upload: terminalUpload });
      },
    );
    return { ports, c };
  };
  const submit = async (ports: ReturnType<typeof portsFor>) => {
    const controller = createDanceReviewController(ports),
      view = await controller.observe(terminalSignal());
    return controller.act(
      view.result,
      { operation: "submit" },
      terminalSignal(),
    );
  };
  const canonical = (c: DanceCapture) => {
    reviews.set(c.captureId, simulatedCanonicalReview(c, "not_passed"));
  };
  return {
    f,
    durable,
    requests,
    transport,
    reviews,
    captures,
    scopeB,
    cA,
    cB,
    select,
    portsFor,
    prepareTake,
    submit,
    canonical,
    clock: (n: number) => {
      nowMs = n;
    },
    lifetime: (value: boolean) => {
      alive = value;
    },
    current: (s: DanceScope) => {
      current = s;
    },
  };
}
