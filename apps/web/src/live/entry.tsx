import { render } from "@solidjs/web";
import { createSignal, onCleanup, Show } from "solid-js";
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
import { SongUpload } from "./upload.tsx";
import { LiveStudy } from "./study.tsx";
import { StudyLoading } from "../study/screen.tsx";
import { KaraokeRouteLoadingState } from "../karaoke/route-states.tsx";
import { LiveRewardWallet } from "./rewards.tsx";
import { LiveRewardOperator } from "./reward-operator.tsx";
import type { RewardAvailableOffers } from "../../../../packages/rewards/contracts.ts";
import {
  LiveKaraoke,
  type KaraokeWallet,
  type LearningActions,
} from "./karaoke.tsx";

import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/overlays/dropdown-menu/dropdown-menu";
import { buttonVariants } from "@/components/actions/button/button";
import { IconGearSix } from "@/components/media/icons";
import { CommunityAppShell } from "./app-shell.tsx";
import {
  appView,
  activityRoute,
  activityUrl,
  withoutActivity,
} from "../shell/routing.ts";
import { SongFeed } from "../shell/song-feed.tsx";
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
const shortened = (address: string) =>
  `${address.slice(0, 8)}…${address.slice(-6)}`;
export function App(props: { integrations?: ShellIntegrations } = {}) {
  const walletPage = ["/wallet", "/verify/very", "/operator/rewards"].includes(
    location.pathname,
  );
  const initialPractice = activityRoute(new URL(location.href));
  const [name, setName] = createSignal("Your community"),
    [view, setView] = createSignal(appView(location.hash)),
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
    [status, setStatus] = createSignal("Loading community…"),
    [error, setError] = createSignal(false);
  // Practice deep links hold their loading state until the community resolves
  // the song and permission. The requested activity stays in the address.
  const [opening, setOpening] = createSignal(initialPractice.kind !== "none");
  // True while sign-in is settling its permission. The wallet pages and the
  // practice buttons wait, so nothing mounts with the first of two sessions.
  const [settling, setSettling] = createSignal(false);
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
  function openStudy(song: { postId: string; title: string }) {
    setLearningActions(null);
    pauseFeed();
    const url = activityUrl(new URL(location.href), "study", song.postId);
    if (url.href !== location.href) history.pushState(null, "", url);
    lastLocation = location.href;
    setSinging(null);
    setStudying(song);
  }
  function openSing(song: { postId: string; title: string }) {
    setLearningActions(null);
    pauseFeed();
    const url = activityUrl(new URL(location.href), "sing", song.postId);
    if (url.href !== location.href) history.pushState(null, "", url);
    lastLocation = location.href;
    setStudying(null);
    setSinging(song);
  }
  function closeStudy() {
    setStudying(null);
    setSinging(null);
    setRouteNotice("");
    history.replaceState(null, "", withoutActivity(new URL(location.href)));
    lastLocation = location.href;
    requestAnimationFrame(() =>
      document.getElementById("app-content")?.focus(),
    );
  }
  function syncActivity(posts = feed(), caps = capabilities()) {
    const requested = activityRoute(new URL(location.href));
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
        else
          requestAnimationFrame(() =>
            document.getElementById(`song-${postId}`)?.scrollIntoView(),
          );
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
    if (!session()) {
      setRouteNotice(
        "Sign in with MOSS to open this song. Your practice link is saved.",
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
    if (requested.kind === "study") openStudy(selected);
    else openSing(selected);
  }
  const syncLocation = () => {
    // A fragment history traversal emits both events. Reconcile it once so a
    // resumed capture never mounts twice for one browser action.
    if (lastLocation === location.href) return;
    lastLocation = location.href;
    setView(appView(location.hash));
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
  async function refreshSession() {
    const before = session()?.mossAddress;
    let next: CommunitySessionView | null = null;
    try {
      next = await get<CommunitySessionView>("/api/session");
    } catch {
      next = null;
    }
    // Study is closed whenever this page refreshes its session (the header is
    // inert while practice is open), and closing Study drops its lesson link. A
    // download offered for another account is dropped here; the server would
    // refuse it anyway. A failed read keeps it.
    if (before && next && next.mossAddress !== before) setLearningActions(null);
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
    setStatus("Signed in. Choose a song to study or sing.");
  }
  // Owner-only publishing has no creator connection step. Preserved creator
  // connection routes stay on the server for the deferred integration.
  void run(async () => {
    try {
      await refresh();
    } finally {
      setOpening(false);
    }
    setStatus(
      session() ? "Your community is ready." : "Sign in to study or sing.",
    );
  });
  return (
    <CommunityAppShell
      name={name()}
      view={view()}
      walletPage={walletPage}
      rewards={capabilities()?.rewards === true}
      publisher={
        session()?.publisher === true ||
        (!!session() &&
          props.integrations?.publicPosting === "allowed" &&
          !!props.integrations.publicComposer)
      }
      practiceOpen={practiceOpen()}
      account={
        <Show
          when={session()}
          fallback={
            <div>
              <Button
                variant="outline"
                disabled={busy() || !boot() || capabilities()?.signIn !== true}
                onClick={() => void run(signIn)}
              >
                {boot() && capabilities()?.signIn === false
                  ? "Sign-in unavailable"
                  : "Sign in with MOSS"}
              </Button>
              <p class="live-muted">
                <a href="/terms" target="_blank" rel="noopener">
                  Terms
                </a>{" "}
                ·{" "}
                <a href="/privacy" target="_blank" rel="noopener">
                  Privacy
                </a>
                {/* Only a V4 sign-in accepts the learning documents. */}
                <Show
                  when={
                    capabilities()?.learningPolicy?.version === 4
                      ? capabilities()?.learningPolicy
                      : undefined
                  }
                >
                  {(policy) => (
                    <>
                      {" "}
                      ·{" "}
                      <a
                        href={policy().termsUrl}
                        target="_blank"
                        rel="noopener"
                      >
                        Learning terms
                      </a>{" "}
                      ·{" "}
                      <a
                        href={policy().privacyUrl}
                        target="_blank"
                        rel="noopener"
                      >
                        Learning privacy
                      </a>
                    </>
                  )}
                </Show>
              </p>
            </div>
          }
        >
          {(current) => (
            <div class="live-account">
              <Show when={capabilities()?.rewards}>
                <a href="/wallet">Wallet</a>
              </Show>
              <a href="/#/account">
                <span title={current().mossAddress}>
                  {shortened(current().mossAddress)}
                </span>
              </a>
              <Show
                when={
                  capabilities()?.learningServiceMode === "internal" &&
                  learningActions()
                }
              >
                <DropdownMenu placement="bottom-end">
                  <DropdownMenuTrigger
                    class={buttonVariants({ variant: "ghost" })}
                    aria-label="Learning settings"
                  >
                    <IconGearSix class="size-5" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    <Show when={learningActions()}>
                      <DropdownMenuItem
                        onSelect={() =>
                          void run(async () => {
                            await learningActions()!.download();
                            setStatus("Private history downloaded.");
                          })
                        }
                      >
                        Download private history
                      </DropdownMenuItem>
                    </Show>
                  </DropdownMenuContent>
                </DropdownMenu>
              </Show>
              <Button
                variant="ghost"
                disabled={busy()}
                onClick={() =>
                  void run(async () => {
                    await post("/api/logout", {}, current().csrf);
                    setSession(null);
                    setLearningActions(null);
                    setStatus("Signed out.");
                  })
                }
              >
                Sign out
              </Button>
            </div>
          )}
        </Show>
      }
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
      <Show when={singing() && session()}>
        <div class="live-karaoke-overlay">
          <LiveKaraoke
            account={session()!.mossAddress}
            postId={singing()!.postId}
            title={singing()!.title}
            csrf={session()!.csrf}
            wallet={mossWallet}
            serviceMode={capabilities()?.learningServiceMode}
            // A V4 community reports public results by sign-in.
            signInPermission={["on", "pending", "off"].includes(
              session()!.publicResults,
            )}
            onExit={closeStudy}
            onLearningActions={(actions) => setLearningActions(actions)}
          />
        </div>
      </Show>
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
      {/* Keyed by account: another sign-in remounts Study with no prior state. */}
      <Show when={studying() && session()?.mossAddress} keyed>
        {(account) => (
          <div class="live-study-overlay">
            <LiveStudy
              postId={studying()!.postId}
              title={studying()!.title}
              csrf={session()!.csrf}
              account={account}
              wallet={mossWallet}
              // A V4 community's Study needs no enrollment before a lesson.
              signInPermission={["on", "pending", "off"].includes(
                session()!.publicResults,
              )}
              onExit={closeStudy}
              onLearningActions={(actions) => setLearningActions(actions)}
            />
          </div>
        )}
      </Show>
      <Show when={!walletPage}>
        <main class="live-main app-main" inert={practiceOpen()}>
          <section
            class={`live-status${error() ? " live-error" : ""}`}
            role="status"
            aria-live="polite"
          >
            {status()}
          </section>
          <Show when={error()}>
            <Button
              variant="outline"
              disabled={busy()}
              onClick={() =>
                void run(async () => {
                  await refresh();
                  setStatus("Your community is ready.");
                })
              }
            >
              Try again
            </Button>
          </Show>
          <Show when={routeNotice()}>
            <p class="app-route-notice" role="status">
              {routeNotice()}{" "}
              <a href="/#/songs" onClick={closeStudy}>
                Browse songs
              </a>
            </p>
          </Show>
          <Show when={view() === "home" || view() === "songs"}>
            <section class="app-community-banner">
              <div class="app-community-avatar" aria-hidden="true">
                {name().slice(0, 1).toUpperCase()}
              </div>
              <div>
                <p class="live-kicker">MUSIC COMMUNITY</p>
                <h1>{view() === "songs" ? "Songs" : name()}</h1>
                <p>Play the songs. Learn the words. Sing along.</p>
              </div>
            </section>
            <div class="app-community-tabs" aria-label="Community views">
              <a
                href="/#/"
                aria-current={view() === "home" ? "page" : undefined}
              >
                Feed
              </a>
              <a
                href="/#/songs"
                aria-current={view() === "songs" ? "page" : undefined}
              >
                Songs
              </a>
            </div>
            <div class="app-community-body">
              <div class="app-feed-column">
                <Show when={view() === "home" && boot()}>
                  {props.integrations?.publicFeed?.(featureContext())}
                </Show>
                <section class="live-songs" aria-label="Published songs">
                  <div class="live-section-heading">
                    <h2>{view() === "songs" ? "All songs" : "Latest songs"}</h2>
                    <Button
                      variant="ghost"
                      disabled={busy()}
                      onClick={() => void run(refresh)}
                    >
                      Refresh
                    </Button>
                  </div>
                  <Show
                    when={feed()}
                    fallback={
                      <p class="live-empty">
                        {busy()
                          ? "Loading songs…"
                          : "Songs could not be loaded. Try again."}
                      </p>
                    }
                  >
                    {(songs) => (
                      <SongFeed
                        feed={songs()}
                        signedIn={!!session() && !settling()}
                        study={capabilities()?.study === true}
                        rewards={capabilities()?.rewards === true}
                        offers={rewardOffers()}
                        onStudy={openStudy}
                        onSing={openSing}
                      />
                    )}
                  </Show>
                </section>
              </div>
              <aside class="app-about" aria-label="About this community">
                <h2>About this community</h2>
                <p>
                  A home for songs and the people who make them. Listen here,
                  then sign in with your MOSS wallet to study or sing.
                </p>
                <p>
                  Study and Karaoke results are public. Reward offers, when
                  available, state their own qualification window.
                </p>
                <a href="/#/account">Your account and learning history</a>
                <Show when={session()?.publisher}>
                  <a href="/#/publish">Release a song</a>
                </Show>
              </aside>
            </div>
          </Show>
          <Show when={view() === "account"}>
            <section class="app-account-page">
              <p class="live-kicker">YOUR COMMUNITY</p>
              <h1>Account</h1>
              <Show
                when={session()}
                fallback={
                  <p>
                    Sign in with MOSS using the button above to study, sing and
                    access your wallet.
                  </p>
                }
              >
                {(current) => (
                  <>
                    <p>Your MOSS account</p>
                    <p class="app-address">{current().mossAddress}</p>
                    <Show when={capabilities()?.rewards}>
                      <a class="app-action-link" href="/wallet">
                        Open wallet and rewards
                      </a>
                    </Show>
                    <h2>Learning history</h2>
                    <Show
                      when={learningActions()}
                      fallback={
                        <p>
                          Open Study or Karaoke for a song to retrieve its
                          retained private history.
                        </p>
                      }
                    >
                      <Button
                        variant="outline"
                        disabled={busy()}
                        onClick={() =>
                          void run(async () => {
                            await learningActions()!.download();
                            setStatus("Private history downloaded.");
                          })
                        }
                      >
                        Download private history
                      </Button>
                    </Show>
                    <p>
                      Study and Karaoke results are public. Private recordings
                      and history have their own retention limits.
                    </p>
                    <a href="/#/songs">Choose a song</a>
                    <Show
                      when={boot() && !settling() && current().mossAddress}
                      keyed
                    >
                      {(_account) => (
                        <>
                          {props.integrations?.privateDance?.(featureContext())}
                          {props.integrations?.accountSettings?.(
                            featureContext(),
                          )}
                        </>
                      )}
                    </Show>
                  </>
                )}
              </Show>
            </section>
          </Show>
          <Show when={view() === "publish"}>
            <h1>Create</h1>
            <Show
              when={session()?.publisher ? session() : null}
              fallback={
                <p>
                  Song publishing is available to the authorized community
                  publisher. Sign in with that account to continue.
                </p>
              }
            >
              {(current) => (
                <SongUpload
                  session={current()}
                  policy={capabilities()?.policyVersion ?? ""}
                  enabled={capabilities()?.upload === true}
                  refreshFeed={refresh}
                />
              )}
            </Show>
            <Show
              when={
                session() &&
                !settling() &&
                boot() &&
                props.integrations?.publicPosting === "allowed" &&
                session()!.mossAddress
              }
              keyed
            >
              {(_account) =>
                props.integrations?.publicComposer?.(featureContext())
              }
            </Show>
          </Show>
          <Show when={view() === "missing"}>
            <h1>Page not found</h1>
            <p>This community link is unavailable.</p>
            <a href="/#/">Return to the community</a>
          </Show>
        </main>
      </Show>
      {/* Normal site navigation: the documents stay reachable while signed
          in, outside the Study and Karaoke overlays. */}
      <footer class="live-footer" inert={practiceOpen()}>
        <span>A community of independent creators.</span>
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
