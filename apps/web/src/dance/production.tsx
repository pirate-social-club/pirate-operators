import { createMemo, createSignal, onCleanup, onSettled, Show } from "solid-js";
import type { DanceConsentPolicy, DanceReview } from "../../../../packages/dance/contracts.ts";
import { DanceClientError, privateAccessLost } from "./client.ts";
import { DanceSongPage } from "./source/dance-song-page.tsx";
import { DanceReviewPage } from "./source/dance-review-page.tsx";
import { DanceResultPage } from "./source/dance-result-page.tsx";
import { createProductionDanceAccount, type DanceSessionProducer } from "./source/production-account.ts";
import { createProductionDanceApi } from "./source/production-api.ts";
import { createDancePrivateMediaPort } from "./source/media-adapter.ts";
import { createDancePlaybackPort } from "./source/playback-adapter.ts";
import { createDanceSourceServices } from "./source/services.ts";
import { createBrowserDanceRecordingStorage } from "./source/dance-recording-storage.ts";
import { assertCapture, captureTarget, danceScopeKey, type DanceScope, type DanceSourcePorts } from "./source/ports.ts";
import { Button } from "./design-system.ts";

/** Construct per Root owner generation; dispose on route-owner teardown. This
 * composes the existing machine/controllers/IDB original and command stores.
 * maximumBytes is the selected source3 policy, not inferred readiness. */
export function createProductionDanceProducer(input: {
  session: DanceSessionProducer;
  maximumBytes: number;
  fetcher?: typeof fetch;
}) {
  const owner = createProductionDanceAccount({ session: input.session, fetcher: input.fetcher });
  const api = createProductionDanceApi({ owner, fetcher: input.fetcher });
  const active = new Set<DanceSourcePorts>();
  let disposed = false;
  const check = (scope: DanceScope) => {
    const current = owner.currentOwner();
    if (disposed || !current || current.communityId !== scope.communityId ||
      current.accountId !== scope.accountId || current.sessionKey !== scope.sessionKey)
      throw new DanceClientError("dance_account_changed");
  };
  const playback = createDancePlaybackPort({
    songGrant: (c, signal) => api.guide(c, signal), reference: (target, signal) => api.reference(target, signal),
    fetcher: input.fetcher,
  });
  function source(scope: DanceScope, consent: DanceConsentPolicy,
    current: () => DanceScope | null): DanceSourcePorts {
    check(scope);
    const lifetime = new AbortController();
    const currentScope = () => {
      try { check(scope); } catch { return null; }
      const fresh = current();
      return !lifetime.signal.aborted && fresh && danceScopeKey(fresh) === danceScopeKey(scope) ? fresh : null;
    };
    const send: typeof fetch = async (url, init = {}) => {
      if (!currentScope()) throw new DanceClientError("dance_account_changed");
      const response = await (input.fetcher ?? fetch)(url, { ...init,
        signal: init.signal ? AbortSignal.any([lifetime.signal, init.signal]) : lifetime.signal });
      if (!currentScope()) throw new DanceClientError("dance_account_changed");
      if (response.status === 401 || response.status === 403) {
        owner.deny();
        throw new DanceClientError("dance_request_denied", false, response.status);
      }
      return response;
    };
    const sourcePlayback = createDancePlaybackPort({
      songGrant: async (c, signal) => { assertCapture(c, scope); return api.guide(c, signal); },
      reference: (target, signal) => api.reference(target, signal), fetcher: send,
      isCurrent: () => !!currentScope(),
    });
    const result = createDanceSourceServices({
      account: scope, target: scope, current: currentScope, consent,
      csrf: owner.currentOwner()!.csrf, fetcher: send,
      media: createDancePrivateMediaPort({ scope, currentScope,
        csrf: () => owner.currentOwner()?.csrf ?? "", maximumBytes: input.maximumBytes, fetcher: send }),
      playback: sourcePlayback,
      captureAccess: async (c, signal) => { assertCapture(c, scope); await api.captureAccess(c, signal); check(scope); },
    });
    const owned: DanceSourcePorts = { ...result,
      recordingStorage: createBrowserDanceRecordingStorage(scope.accountId),
      dispose() { lifetime.abort(); result.dispose?.(); active.delete(owned); } };
    active.add(owned);
    return owned;
  }
  const unsubscribe = owner.account.subscribe(() => { for (const value of [...active]) value.dispose?.(); });
  return { account: owner.account, catalogue: api.catalogue, playback, source,
    async songKeyForPost(postId: string, signal: AbortSignal) {
      if (!await owner.account.load(signal)) throw new DanceClientError("dance_request_denied", false, 401);
      return api.songKeyForPost(postId, signal);
    },
    async reviewSource(id: string, signal: AbortSignal) {
      const account = await owner.account.load(signal);
      if (!account) throw new DanceClientError("dance_request_denied", false, 401);
      const review = await api.review(id, signal);
      const scope = { ...captureTarget(review.capture), ...account };
      const receipt = review.capture.consent;
      if (!receipt) throw Error("dance_consent_receipt_missing");
      // Historical review does not imply current permission to create a take.
      const provided = source(scope, { version: receipt.version, termsHash: receipt.termsHash,
        publicityPolicyHash: receipt.publicityPolicyHash, text: "", admission: "review_pending" },
        () => owner.account.current() ? { ...scope, ...owner.account.current()! } : null);
      const held = async (): Promise<never> => { throw Error("dance_fresh_capture_requires_catalogue"); };
      return { review, source: { ...provided, client: { ...provided.client,
        capture: held, prepareCapture: held } } };
    },
    dispose() { if (disposed) return; disposed = true; unsubscribe();
      for (const value of [...active]) value.dispose?.(); api.dispose(); owner.dispose(); },
  };
}

export type DanceProductionRoute = { kind: "song"; songKey: string } | { kind: "post"; postId: string } |
  { kind: "review" | "result"; reviewId: string };

/** Root keys this composition by owner generation + route identity. It owns
 * normal App mounting/history/Back; this is the real feature composition. */
export function DanceProductionPage(props: {
  producer: ReturnType<typeof createProductionDanceProducer>;
  communityId: string;
  route: DanceProductionRoute;
  onBack(): void;
  onSignIn(): void;
  onReview(review: DanceReview): void;
  onManage(reviewId: string): void;
  onAccessLost(): void;
}) {
  const route = props.route;
  const [loaded, setLoaded] = createSignal<{ source: DanceSourcePorts; review: DanceReview }>();
  const [songKey, setSongKey] = createSignal(route.kind === "song" ? route.songKey : "");
  const [status, setStatus] = createSignal(route.kind === "post" ? "Loading dance…" : "Loading your recording…");
  const [denied, setDenied] = createSignal(false);
  const request = new AbortController();
  const clear = () => { loaded()?.source.dispose?.(); setLoaded(undefined); setSongKey(""); };
  const unsubscribe = props.producer.account.subscribe(() => {
    request.abort(); clear(); setDenied(true); setStatus("Sign in to view your recording."); props.onAccessLost();
  });
  onSettled(() => {
    if (route.kind === "song") return;
    if (route.kind === "post") {
      void props.producer.songKeyForPost(route.postId, request.signal).then(key => {
        if (!request.signal.aborted) setSongKey(key);
      }).catch(error => {
        if (request.signal.aborted) return;
        if (privateAccessLost(error)) { setDenied(true); setStatus("Sign in to view this dance."); props.onAccessLost(); }
        else setStatus("This dance could not be loaded. Go back and try again.");
      });
      return;
    }
    void props.producer.reviewSource(route.reviewId, request.signal).then(value => {
      if (request.signal.aborted) { value.source.dispose?.(); return; }
      setLoaded(value);
    }).catch(error => {
      if (request.signal.aborted) return;
      clear();
      if (privateAccessLost(error)) { setDenied(true); setStatus("Sign in to view your recording."); props.onAccessLost(); }
      else setStatus("Your recording could not be loaded. Go back and try again.");
    });
  });
  onCleanup(() => { unsubscribe(); request.abort(); clear(); });
  if (route.kind === "song" || route.kind === "post") return <Show when={songKey()}
    fallback={<main><p role="status">{status()}</p><Show when={denied()}><Button onClick={props.onSignIn}>Sign in</Button></Show><Button onClick={props.onBack}>Back to song</Button></main>}>
    <DanceSongPage communityId={props.communityId} songKey={songKey()}
    account={props.producer.account} catalogue={props.producer.catalogue} playback={props.producer.playback}
    source={props.producer.source} onBack={props.onBack} onSignIn={props.onSignIn} onReview={props.onReview} /></Show>;
  return <Show when={loaded()} fallback={<main><p role="status">{status()}</p><Show when={denied()}><Button onClick={props.onSignIn}>Sign in</Button></Show><Button onClick={props.onBack}>Back to song</Button></main>} keyed>
    {value => route.kind === "result" ? <DanceResultPage source={value.source} reviewId={route.reviewId}
      onBack={props.onBack} onManage={() => props.onManage(route.reviewId)} onSignIn={props.onSignIn} onAccessLost={props.onAccessLost} /> :
      <DanceReviewPage source={value.source} reviewId={route.reviewId} onBack={props.onBack}
        onSignIn={props.onSignIn} onAccessLost={props.onAccessLost} />}
  </Show>;
}

/** Normal-entry adapter. Root supplies reactive route/session getters and real
 * invalidation notifications. A keyed owner disposes every private controller
 * on navigation/session change while durable command/original bytes remain. */
export function DanceProductionMount(props: {
  session: DanceSessionProducer;
  communityId: string;
  route: DanceProductionRoute | null;
  maximumBytes: number;
  onBack(): void;
  onSignIn(): void;
  onReview(review: DanceReview): void;
  onManage(reviewId: string): void;
  onAccessLost(): void;
}) {
  const snapshot = createMemo(() => {
    const route = props.route, session = props.session.current();
    if (!route || !props.communityId || (session && session.communityId !== props.communityId)) return null;
    // Read every owner-lifetime signal before freezing the route owner.
    return { route: { ...route }, communityId: props.communityId, sessionKey: session ?
      JSON.stringify([session.generation, session.csrf, session.authorId]) : "anonymous",
      maximumBytes: props.maximumBytes };
  });
  return <Show when={snapshot()} keyed>{owner => {
    const producer = createProductionDanceProducer({ session: props.session, maximumBytes: owner.maximumBytes });
    onCleanup(producer.dispose);
    return <DanceProductionPage producer={producer} communityId={owner.communityId} route={owner.route}
      onBack={props.onBack} onSignIn={props.onSignIn} onReview={props.onReview}
      onManage={props.onManage} onAccessLost={props.onAccessLost} />;
  }}</Show>;
}
