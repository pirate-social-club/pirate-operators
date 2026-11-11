import { createSavedStudyHistory } from "../study/saved-history.ts";
import { createCommunityProfileIntegration } from "../shell/profiles/integration.ts";
import { MountedCommunityProfiles } from "../shell/profiles/mounted-routes.tsx";
import { publicProfileAuthor } from "../shell/profiles/pages.tsx";
import { render } from "@solidjs/web";
import { createMemo, createSignal, onCleanup, Show } from "solid-js";
import { Button } from "../ui.ts";
import {
  get,
  post,
  type CommunityCapabilities,
  type CommunityClientConfig,
  type CommunityFeed,
  type CommunitySessionView,
} from "./api.ts";
import "./style.css";
import {
  CommunityComposerHost,
  CommunityPendingSongs,
  type CommunityHostContext,
} from "../media/community-host.tsx";
import { createCommunityComposerScope } from "../media/community-composer-scope.ts";
import { LearningPageMount } from "./learning-pages.tsx";
import { createLearningActionOwner } from "./learning-action-owner.ts";
import { StudyLoading } from "../study/screen.tsx";
import { KaraokeRouteLoadingState } from "../karaoke/route-states.tsx";
import { LiveRewardWallet } from "./rewards.tsx";
import { LiveRewardOperator } from "./reward-operator.tsx";
import type { RewardAvailableOffers } from "../../../../packages/rewards/contracts.ts";
import type { KaraokeWallet, LearningActions } from "../karaoke/page.tsx";

import { CommunityAppShell } from "./app-shell.tsx";
import {
  appView,
  activityRoute,
  activityUrl,
  withoutActivity,
} from "../shell/routing.ts";
import { CommunityPages } from "../shell/community-pages.tsx";
import type {
  ShellFeatureContext,
  ShellIntegrations,
} from "../shell/interfaces.ts";

async function moss() {
  const { mega } = await import("@megaeth-labs/wallet-sdk");
  await mega.initialise({
    network: "testnet",
    logging: "error",
    debug: false,
    handshakeTimeoutMs: 45000,
  });
  return mega;
}
/** The learner's consent, signed by their MOSS account. */
const mossWallet: KaraokeWallet = {
  async signConsent(request) {
    const mega = await moss();
    await mega.connect();
    // MOSS validates typed data itself; the SDK README names the payload "value".
    const { message, domain, types, primaryType } = request;
    const typed = { domain, types, primaryType };
    let signed = await mega.signData({ data: { ...typed, message } });
    if (signed.status === "error")
      signed = await mega.signData({ data: { ...typed, value: message } });
    if (signed.status !== "success" || !signed.signature)
      throw new Error("Your score wasn't signed.");
    return signed.signature;
  },
};
export function App(props: { integrations?: ShellIntegrations } = {}) {
  const walletPage = ["/wallet", "/verify/very", "/operator/rewards"].includes(
    location.pathname,
  );
  const initialPractice = activityRoute(new URL(location.href));
  const [name, setName] = createSignal(""),
    [view, setView] = createSignal(appView(location.hash)),
    [fragment, setFragment] = createSignal(location.hash),
    [routeNotice, setRouteNotice] = createSignal(""),
    [boot, setBoot] = createSignal<CommunityClientConfig | null>(null),
    [session, setSession] = createSignal<CommunitySessionView | null>(null),
    [capabilities, setCapabilities] =
      createSignal<CommunityCapabilities | null>(null),
    [feed, setFeed] = createSignal<CommunityFeed | null>(null),
    [rewardOffers, setRewardOffers] =
      createSignal<RewardAvailableOffers | null>(null),
    [busy, setBusy] = createSignal(false),
    [learningActions, setLearningActions] =
      createSignal<LearningActions | null>(null),
    [singing, setSinging] = createSignal<{
      postId: string;
      title: string;
    } | null>(null),
    [studying, setStudying] = createSignal<{
      postId: string;
      title: string;
    } | null>(null),
    [status, setStatus] = createSignal(""),
    [error, setError] = createSignal(false);
  // Practice deep links hold their loading state until the community resolves
  // the song and permission. The requested activity stays in the address.
  const [opening, setOpening] = createSignal(initialPractice.kind !== "none");
  const [studyLesson, setStudyLesson] = createSignal<string | undefined>();
  // True while sign-in is settling its permission. The wallet pages and the
  // practice buttons wait, so nothing mounts with the first of two sessions.
  const [settling, setSettling] = createSignal(false);
  const actionOwner = createLearningActionOwner(setLearningActions);
  onCleanup(actionOwner.clear);
  const learningRoute = createMemo(() => {
    const study = studying(),
      sing = singing();
    return study
      ? { kind: "study" as const, ...study, lessonId: studyLesson() }
      : sing
        ? { kind: "sing" as const, ...sing }
        : null;
  });
  const learningAccount = createMemo(() =>
    settling() ? null : (session()?.mossAddress ?? null),
  );
  const learningPermission = createMemo(
    () =>
      !settling() &&
      ["on", "pending", "off"].includes(session()?.publicResults ?? ""),
  );
  const practiceOpen = () =>
    singing() !== null || studying() !== null || opening();
  let lastLocation = location.href;
  const featureContext = (): ShellFeatureContext => ({
    version: 1,
    communityId: boot()?.communityId ?? "",
    session: settling() ? null : session(),
    songs: feed()?.posts ?? [],
  });
  function pauseFeed() {
    for (const media of document.querySelectorAll<HTMLMediaElement>(
      "audio, video",
    ))
      media.pause();
  }
  function openStudy(
    song: { postId: string; title: string },
    lessonId?: string,
  ) {
    composerRuntime.viewClosed();
    actionOwner.clear();
    pauseFeed();
    const url = activityUrl(new URL(location.href), "study", song.postId);
    url.searchParams.delete("lesson");
    if (lessonId) url.searchParams.set("lesson", lessonId);
    if (url.href !== location.href) history.pushState(null, "", url);
    lastLocation = location.href;
    setSinging(null);
    setStudyLesson(lessonId);
    setStudying(song);
  }
  function openSing(song: { postId: string; title: string }) {
    composerRuntime.viewClosed();
    actionOwner.clear();
    pauseFeed();
    const url = activityUrl(new URL(location.href), "sing", song.postId);
    if (url.href !== location.href) history.pushState(null, "", url);
    lastLocation = location.href;
    setStudying(null);
    setStudyLesson(undefined);
    setSinging(song);
  }
  function closeStudy() {
    actionOwner.clear();
    setStudying(null);
    setSinging(null);
    setStudyLesson(undefined);
    setRouteNotice("");
    history.replaceState(null, "", withoutActivity(new URL(location.href)));
    lastLocation = location.href;
    requestAnimationFrame(() =>
      document.getElementById("app-content")?.focus(),
    );
  }
  function syncActivity(posts = feed(), caps = capabilities()) {
    const requested = activityRoute(new URL(location.href));
    actionOwner.clear();
    setStudying(null);
    setSinging(null);
    setStudyLesson(undefined);
    setRouteNotice("");
    if (requested.kind === "none") {
      setStudying(null);
      setSinging(null);
      if (location.hash.startsWith("#song-")) {
        const postId = location.hash.slice(6);
        if (!posts?.posts.some((song) => song.manifest.postId === postId))
          setRouteNotice(
            "This song is unavailable in this community. Choose another song.",
          );
        else requestAnimationFrame(() => window.scrollTo({ top: 0, left: 0 }));
      }
      return;
    }
    if (requested.kind === "invalid") {
      setRouteNotice(
        "This practice link is invalid. Choose a song to continue.",
      );
      return;
    }
    const song = posts?.posts.find(
      (post) => post.manifest.postId === requested.postId,
    );
    if (!song) {
      setRouteNotice(
        "This song is unavailable in this community. Choose another song.",
      );
      return;
    }
    if (requested.kind === "study" && !caps?.study) {
      setRouteNotice(
        "Study is unavailable in this community. You can still play this song.",
      );
      return;
    }
    const selected = {
      postId: song.manifest.postId,
      title: song.manifest.title,
    };
    if (requested.kind === "study") openStudy(selected, requested.lessonId);
    else openSing(selected);
  }
  const syncLocation = () => {
    // A fragment history traversal emits both events. Reconcile it once so a
    // resumed capture never mounts twice for one browser action.
    if (lastLocation === location.href) return;
    lastLocation = location.href;
    if (view() === "publish") composerRuntime.viewClosed();
    setView(appView(location.hash));
    setFragment(location.hash);
    actionOwner.clear();
    setStudying(null);
    setSinging(null);
    if (boot() && feed()) syncActivity();
    if (!practiceOpen())
      requestAnimationFrame(() =>
        document.getElementById("app-content")?.focus(),
      );
  };
  window.addEventListener("hashchange", syncLocation);
  window.addEventListener("popstate", syncLocation);
  onCleanup(() => {
    window.removeEventListener("hashchange", syncLocation);
    window.removeEventListener("popstate", syncLocation);
  });
  function navigateLearning(href: string) {
    const requested = activityRoute(new URL(href, location.origin));
    if (requested.kind !== "study" && requested.kind !== "sing") {
      location.assign(href);
      return;
    }
    const song = feed()?.posts.find(
      (item) => item.manifest.postId === requested.postId,
    );
    if (
      !song ||
      (requested.kind === "study" && !capabilities()?.study) ||
      settling()
    )
      return;
    if (session()) {
      const selected = {
        postId: song.manifest.postId,
        title: song.manifest.title,
      };
      if (requested.kind === "study") openStudy(selected, requested.lessonId);
      else openSing(selected);
      return;
    }
    if (!boot() || capabilities()?.signIn !== true || busy()) return;
    const next = activityUrl(
      new URL(location.href),
      requested.kind,
      requested.postId,
    );
    if (requested.kind === "study") {
      next.searchParams.delete("lesson");
      if (requested.lessonId)
        next.searchParams.set("lesson", requested.lessonId);
    }
    history.pushState(null, "", next);
    lastLocation = location.href;
    void run(signIn);
  }
  async function refreshSession() {
    const before = session();
    let next: CommunitySessionView | null = null;
    try {
      next = await get<CommunitySessionView>("/api/session");
    } catch {
      next = null;
    }
    if (
      before?.mossAddress !== next?.mossAddress ||
      before?.authorId !== next?.authorId ||
      before?.csrf !== next?.csrf
    ) {
      composerRuntime.invalidate();
      actionOwner.clear();
    }
    setSession(next);
  }
  async function refresh() {
    await refreshSession();
    const [config, community, caps, posts] = await Promise.all([
      get<CommunityClientConfig>("/.well-known/pirate-client.json"),
      get<{ name: string }>("/api/public/community"),
      get<CommunityCapabilities>("/api/capabilities"),
      get<CommunityFeed>("/api/feed"),
    ]);
    if (
      config.schema !== "pirate.community-client-config/1" ||
      config.canonicalOrigin !== location.origin ||
      config.fixture === true
    )
      throw new Error(
        "This is not the live community. Open its canonical address.",
      );
    setBoot(config);
    setName(community.name);
    document.title = `${community.name} · Pirate`;
    setCapabilities(caps);
    setFeed(posts);
    if (!walletPage) syncActivity(posts, caps);
    // Reward offers are optional. Study must never wait for them.
    if (session() && caps.rewards && !walletPage) void loadRewardOffers();
    else {
      offersRequest++;
      setRewardOffers(null);
    }
  }
  let offersRequest = 0;
  async function loadRewardOffers() {
    const current = ++offersRequest;
    const offers = await get<RewardAvailableOffers>("/api/rewards/offers", {
      timeoutMs: 10000,
    }).catch(() => null);
    if (current === offersRequest) setRewardOffers(offers);
  }
  async function run(action: () => Promise<void>) {
    if (busy()) return;
    setBusy(true);
    setError(false);
    try {
      await action();
    } catch (failure) {
      setError(true);
      setStatus(
        failure instanceof Error
          ? failure.message
          : "This step could not complete.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function signInOnce(mega: Awaited<ReturnType<typeof moss>>) {
    setStatus("Continue in MOSS to sign in.");
    const account = await mega.connect();
    if (!account?.address) throw new Error("MOSS sign-in was cancelled.");
    // Plain SIWE, or the V4 sign-in: one SIWE text that is both the sign-in
    // and the standing publication permission. Either is signed as text.
    const challenge = await post<{
      id: string;
      message: string;
      kind?: "sign-in-v4";
    }>("/api/auth/challenge", { address: account.address });
    const signed = await mega.signMessage(challenge.message);
    if (signed.status !== "success" || !signed.signature)
      throw new Error("The sign-in message was not signed.");
    await post("/api/auth/verify", {
      id: challenge.id,
      signature: signed.signature,
    });
    // Only the session here: the page (and any Study link) opens once, after
    // the permission below is settled.
    await refreshSession();
  }
  async function signIn() {
    composerRuntime.invalidate();
    setSettling(true);
    try {
      await settleSignIn();
    } finally {
      setSettling(false);
    }
  }
  async function settleSignIn() {
    setStatus("Opening MOSS…");
    const mega = await moss();
    await signInOnce(mega);
    // Results are always public. A session still reads "off" when an old
    // withdrawal is on record, or when a slow check meant this sign-in was not
    // yet recorded as the publication permission. Either way, clear any old
    // withdrawal and sign the same text once more. If that check is still
    // unavailable, stay signed in; signing in again later completes it.
    const current = session();
    if (current?.publicResults === "off") {
      const cleared = await post(
        "/api/learning/public-results/on",
        {},
        current.csrf,
      ).then(
        () => true,
        () => false,
      );
      // Declining this second prompt leaves the first sign-in in place.
      if (cleared) await signInOnce(mega).catch(() => undefined);
    }
    await refresh();
    setStatus(session() ? "Signed in. Choose a song to study or sing." : "");
  }
  // Owner-only publishing has no creator connection step. Preserved creator
  // connection routes stay on the server for the deferred integration.
  void run(async () => {
    try {
      await refresh();
    } finally {
      setOpening(false);
    }
    setStatus("");
  });
  const profileIntegration = createCommunityProfileIntegration({
    communityId: () => boot()?.communityId ?? "",
    identity: () =>
      !settling() && session()
        ? {
            authorId: session()!.authorId,
            csrf: session()!.csrf,
            scopeKey: session()!.csrf,
          }
        : null,
    ready: () => !walletPage && !!boot() && !settling(),
  });
  const historySession = () => {
    const current = settling() ? null : session(),
      config = boot();
    return current && config
      ? {
          communityId: config.communityId,
          wallet: current.mossAddress,
          authorId: current.authorId,
          csrf: current.csrf,
        }
      : null;
  };
  const savedStudyHistory = createSavedStudyHistory(historySession, () => {
    const auth = historySession(),
      state = profileIntegration.state().view;
    return auth &&
      state.kind === "ready" &&
      state.owner.communityId === auth.communityId &&
      state.owner.profile.authorId === auth.authorId
      ? { ...auth, accountId: state.owner.accountId }
      : null;
  });
  let composerScope = "",
    composerGeneration = "";
  const composerContext = (): CommunityHostContext | null => {
    const config = boot(),
      current = settling() ? null : session();
    const accountId = profileIntegration.ownerAccountId();
    const caps = capabilities(),
      songs = feed();
    if (!config || !current || !accountId || !caps || !songs) {
      composerScope = "";
      return null;
    }
    const scope = JSON.stringify([
      config.communityId,
      accountId,
      current.authorId,
      current.csrf,
    ]);
    if (scope !== composerScope) {
      composerScope = scope;
      composerGeneration = crypto.randomUUID();
    }
    return {
      community: {
        id: config.communityId,
        name: name(),
        origin: config.canonicalOrigin,
      },
      language: config.defaultLanguage,
      session: current,
      owner: {
        accountId,
        authorId: current.authorId,
        communityId: config.communityId,
        generation: composerGeneration,
      },
      capabilities: caps,
      feed: songs,
    };
  };
  // One application Solid owner. No route/renderer/getter constructs a scope.
  const composerRuntime = createCommunityComposerScope({
    current: composerContext,
    refreshFeed: async () => {
      const owner = composerRuntime.runtime();
      if (!owner) return;
      const posts = await get<CommunityFeed>("/api/feed");
      if (!owner.active()) return;
      if (
        posts.schema !== "pirate.community-feed/1" ||
        posts.communityId !== owner.owner.communityId
      )
        throw new Error("The published feed changed community.");
      setFeed(posts);
    },
  });
  const profileSignIn = async () => {
    await run(signIn);
    if (!session()) throw new Error("Sign in was not completed.");
    await profileIntegration.controller()?.load();
  };
  const profileLogout = async () => {
    const current = session();
    if (!current || busy() || settling())
      throw new Error("Sign out is unavailable.");
    setBusy(true);
    composerRuntime.invalidate();
    profileIntegration.controller()?.clear();
    try {
      await post("/api/logout", {}, current.csrf);
      setSession(null);
      actionOwner.clear();
      setStatus("Signed out.");
    } finally {
      setBusy(false);
      // The private owner controller resolves a lost response on its next read;
      // no account/wallet is inferred from the transport outcome.
      await profileIntegration.controller()?.load();
    }
  };
  return (
    <CommunityAppShell
      name={name()}
      communityId={boot()?.communityId ?? ""}
      publicProfileAuthor={publicProfileAuthor(fragment())}
      ownPublicProfile={publicProfileAuthor(fragment()) === session()?.authorId}
      view={view()}
      walletPage={walletPage}
      rewards={capabilities()?.rewards === true}
      practiceOpen={practiceOpen()}
      signedIn={!!session()}
      ready={!!boot()}
      busy={busy() || settling()}
      canSignIn={capabilities()?.signIn === true}
      accountSeed={session()?.mossAddress}
      composing={view() === "publish"}
      onSignIn={() => void run(signIn)}
    >
      <Show when={walletPage && session() && !settling()}>
        <Show
          when={location.pathname === "/operator/rewards"}
          fallback={
            <LiveRewardWallet
              csrf={session()!.csrf}
              onExit={() => location.assign("/")}
            />
          }
        >
          <LiveRewardOperator
            csrf={session()!.csrf}
            onExit={() => location.assign("/wallet")}
          />
        </Show>
      </Show>
      <Show when={walletPage && (!session() || settling())}>
        <main class="live-main">
          <h1>Sign in to view your wallet</h1>
          <p role="status">{status()}</p>
        </main>
      </Show>
      <LearningPageMount
        communityId={boot()?.communityId ?? ""}
        route={learningRoute()}
        account={learningAccount()}
        csrf={session()?.csrf ?? ""}
        wallet={mossWallet}
        serviceMode={capabilities()?.learningServiceMode}
        signInPermission={learningPermission()}
        actions={actionOwner}
        onExit={closeStudy}
        onConnect={() => void run(signIn)}
        onLessonOpened={(lessonId) => {
          const current = studying();
          if (!current) return;
          savedStudyHistory.remember(lessonId, current.postId);
          if (studyLesson() === lessonId) return;
          const url = activityUrl(
            new URL(location.href),
            "study",
            current.postId,
          );
          url.searchParams.set("lesson", lessonId);
          if (activityRoute(url).kind !== "study") return;
          history.replaceState(null, "", url);
          lastLocation = location.href;
          setStudyLesson(lessonId);
        }}
      />
      <Show when={opening() && !studying() && !singing()}>
        <div class="live-study-overlay">
          <Show
            when={initialPractice.kind === "sing"}
            fallback={<StudyLoading />}
          >
            <KaraokeRouteLoadingState label="Loading karaoke" />
          </Show>
        </div>
      </Show>
      <Show when={!walletPage && !practiceOpen()}>
        <Show when={status()}>
          <p
            class={`live-status${error() ? " live-error" : ""}`}
            role="status"
            aria-live="polite"
          >
            {status()}
          </p>
        </Show>
        <Show when={error() && feed()}>
          <Button
            variant="outline"
            disabled={busy()}
            onClick={() =>
              void run(async () => {
                await refresh();
                setStatus("");
              })
            }
          >
            Try again
          </Button>
        </Show>
        <Show when={routeNotice()}>
          <p role="status" class="px-5 py-3 text-sm">
            {routeNotice()}{" "}
            <a href="/#/songs" onClick={closeStudy}>
              Browse songs
            </a>
          </p>
        </Show>
        <MountedCommunityProfiles
          integration={profileIntegration}
          view={view()}
          hash={fragment()}
          communityId={boot()?.communityId ?? ""}
          authorityKey={session()?.csrf ?? "anonymous"}
          authorIds={feed()?.posts.map((song) => song.manifest.authorId) ?? []}
          navigate={(href) => location.assign(href)}
          signIn={profileSignIn}
          logout={profileLogout}
          canSignIn={capabilities()?.signIn === true}
          canSignOut={!!session() && !settling()}
          walletAvailable={capabilities()?.rewards === true}
          services={{
            privateHistory: savedStudyHistory.available()
              ? savedStudyHistory.download
              : undefined,
            publicResults: props.integrations?.accountSettings
              ? () => props.integrations!.accountSettings!(featureContext())
              : undefined,
            // No default recording deletion or Telegram management port.
          }}
          privateDance={() =>
            session() && !settling()
              ? props.integrations?.privateDance?.(featureContext())
              : undefined
          }
        >
          {(authors) => (
            <CommunityPages
              view={view()}
              hash={fragment()}
              name={name()}
              communityId={boot()?.communityId ?? ""}
              feed={feed()}
              session={session()}
              settling={settling()}
              busy={busy()}
              error={error()}
              study={capabilities()?.study === true}
              publisher={session()?.publisher === true}
              canSignIn={capabilities()?.signIn === true}
              rewards={capabilities()?.rewards === true}
              offers={rewardOffers()}
              integrations={{
                ...props.integrations,
                version: 1,
                postAuthors: authors,
              }}
              context={featureContext}
              onNavigate={(href) => location.assign(href)}
              onLearningLink={navigateLearning}
              onSignIn={() => void run(signIn)}
              onSignOut={() =>
                void run(async () => {
                  const current = session();
                  if (!current) return;
                  composerRuntime.invalidate();
                  await post("/api/logout", {}, current.csrf);
                  setSession(null);
                  actionOwner.clear();
                  setStatus("Signed out.");
                })
              }
              onRefresh={() => void run(refresh)}
              onDownload={
                learningActions()
                  ? () =>
                      void run(async () => {
                        const actions = learningActions();
                        if (!actions) return;
                        await actions.download();
                        if (actionOwner.current() === actions)
                          setStatus("Private history downloaded.");
                      })
                  : undefined
              }
              pendingSongs={() => (
                <CommunityPendingSongs
                  scope={composerRuntime}
                  onOpenStatus={() => location.assign("/#/publish")}
                />
              )}
              pendingSongCount={composerRuntime.count()}
              composer={() => (
                <CommunityComposerHost
                  open={view() === "publish"}
                  scope={composerRuntime}
                  onOpenChange={(open) => {
                    if (!open) location.assign("/#/");
                  }}
                />
              )}
            />
          )}
        </MountedCommunityProfiles>
      </Show>
      {/* Normal site navigation: the documents stay reachable while signed
          in, outside the Study and Karaoke overlays. */}
      <footer
        class="flex flex-wrap gap-4 px-5 py-4 text-sm text-muted-foreground"
        inert={practiceOpen()}
      >
        <nav class="live-footer-links" aria-label="Community documents">
          <a href="/terms" target="_blank" rel="noopener">
            Terms
          </a>
          <a href="/privacy" target="_blank" rel="noopener">
            Privacy
          </a>
          {/* The learning documents of the community's own version, V3 or
              V4; exercise surfaces carry no links in any mode. */}
          <Show when={capabilities()?.learningPolicy}>
            {(policy) => (
              <>
                <a href={policy().termsUrl} target="_blank" rel="noopener">
                  Learning terms
                </a>
                <a href={policy().privacyUrl} target="_blank" rel="noopener">
                  Learning privacy
                </a>
              </>
            )}
          </Show>
        </nav>
      </footer>
    </CommunityAppShell>
  );
}
render(() => <App />, document.getElementById("app")!);
