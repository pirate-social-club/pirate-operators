import { render } from "@solidjs/web";
import { createSignal, For, Show } from "solid-js";
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
function App() {
  const walletPage = ["/wallet", "/verify/very", "/operator/rewards"].includes(
    location.pathname,
  );
  const [name, setName] = createSignal("Your community"),
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
  // A Study link shows the Study loading state from the first paint, not the
  // home page, until the community has loaded and Study opens or is refused.
  const [opening, setOpening] = createSignal(
    new URL(location.href).searchParams.has("study"),
  );
  const practiceOpen = () =>
    singing() !== null || studying() !== null || opening();
  function openStudy(song: { postId: string; title: string }) {
    setLearningActions(null);
    const url = new URL(location.href);
    if (url.searchParams.get("study") !== song.postId)
      url.searchParams.delete("lesson");
    url.searchParams.set("study", song.postId);
    history.replaceState(null, "", url);
    setStudying(song);
  }
  function closeStudy() {
    setStudying(null);
    const url = new URL(location.href);
    url.searchParams.delete("study");
    url.searchParams.delete("lesson");
    history.replaceState(null, "", url);
  }
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
    const requested = new URL(location.href).searchParams.get("study");
    const song = posts.posts.find((post) => post.manifest.postId === requested);
    if (session() && caps.study && song)
      openStudy({ postId: song.manifest.postId, title: song.manifest.title });
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
    await refresh();
  }
  async function signIn() {
    setStatus("Opening MOSS…");
    const mega = await moss();
    await signInOnce(mega);
    // Results are always public; there is no setting to turn them off. An
    // account withdrawn before that rule is restored by signing in: clear the
    // old withdrawal, then sign the same sign-in text once more.
    const current = session();
    if (current?.publicResults === "off") {
      await post("/api/learning/public-results/on", {}, current.csrf);
      await signInOnce(mega);
    }
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
      session()
        ? "Your community is ready."
        : "Sign in to study or sing.",
    );
  });
  return (
    <>
      <header class="live-header" inert={practiceOpen()}>
        <a href="/" class="live-brand">
          pirate<span>/ community</span>
        </a>
        <span class="live-testnet">
          Disposable testnet, permanently unlisted · recovery incomplete
        </span>
        <Show
          when={session()}
          fallback={
            <div>
              <Button
                variant="outline"
                disabled={busy() || !boot()}
                onClick={() => void run(signIn)}
              >
                Sign in with MOSS
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
              <span title={current().mossAddress}>
                {shortened(current().mossAddress)}
              </span>
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
      </header>
      <Show when={walletPage && session()}>
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
      <Show when={walletPage && !session()}>
        <main class="live-main">
          <h1>Sign in to view your wallet</h1>
          <p role="status">{status()}</p>
        </main>
      </Show>
      <Show when={singing() && session()}>
        <div class="live-karaoke-overlay">
          <LiveKaraoke
            postId={singing()!.postId}
            title={singing()!.title}
            csrf={session()!.csrf}
            wallet={mossWallet}
            serviceMode={capabilities()?.learningServiceMode}
            // A V4 community reports public results by sign-in.
            signInPermission={["on", "pending", "off"].includes(
              session()!.publicResults,
            )}
            onExit={() => setSinging(null)}
            onLearningActions={(actions) => setLearningActions(actions)}
          />
        </div>
      </Show>
      <Show when={opening() && !studying()}>
        <div class="live-study-overlay">
          <StudyLoading />
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
        <main class="live-main" inert={practiceOpen()}>
          <section class="live-intro">
            <p class="live-kicker">INDEPENDENT MUSIC</p>
            <h1>{name()}</h1>
            <p>A home for songs and the people who make them.</p>
          </section>
          <section
            class={`live-status${error() ? " live-error" : ""}`}
            role="status"
            aria-live="polite"
          >
            {status()}
          </section>
          <Show when={session()?.publisher ? session() : null}>
            {(current) => (
              <SongUpload
                session={current()}
                policy={capabilities()?.policyVersion ?? ""}
                enabled={capabilities()?.upload === true}
                refreshFeed={refresh}
              />
            )}
          </Show>
          <section class="live-songs">
            <div class="live-section-heading">
              <h2>Latest songs</h2>
              <Button
                variant="ghost"
                disabled={busy()}
                onClick={() => void run(refresh)}
              >
                Refresh
              </Button>
            </div>
            <Show
              when={(feed()?.posts.length ?? 0) > 0}
              fallback={
                <div class="live-empty">
                  <span>♪</span>
                  <h3>The first release starts here.</h3>
                  <p>Published songs will appear in this community feed.</p>
                </div>
              }
            >
              <For each={feed()?.posts}>
                {(song) => (
                  <article
                    class="live-song"
                    id={`song-${song.manifest.postId}`}
                  >
                    <p class="live-kicker">
                      {song.manifest.rating === "adult" ? "EXPLICIT" : "SONG"}
                    </p>
                    <h3>
                      <a href={song.postUrl}>{song.manifest.title}</a>
                    </h3>
                    <p class="live-muted">
                      Creator {song.manifest.authorId.slice(2, 10)}
                    </p>
                    <Show
                      when={
                        song.manifest.declarationSource === "operator_declared"
                      }
                    >
                      <p class="live-muted">
                        Rating and language declared by the operator. Automated
                        content moderation is deferred.
                      </p>
                    </Show>
                    <audio controls preload="metadata" src={song.audioUrl} />
                    <Show when={session() && capabilities()?.rewards}>
                      <Show
                        when={rewardOffers()}
                        fallback={
                          <p class="live-muted">
                            Reward details are unavailable.
                          </p>
                        }
                      >
                        {(available) => (
                          <>
                            <For
                              each={available().offers.filter(
                                (o) => o.postId === song.manifest.postId,
                              )}
                            >
                              {(offer) => (
                                <details>
                                  <summary>
                                    Lottery reward · {offer.ticketCount}{" "}
                                    {offer.ticketCount === 1
                                      ? "ticket"
                                      : "tickets"}
                                  </summary>
                                  <p>
                                    Practice rewards have no cash value in this
                                    pilot. Complete Study with at least 70%
                                    correct on the first try, or Karaoke with a
                                    score of at least 70% and at least 90% of
                                    lines measured. One entry per account.
                                  </p>
                                  <p>
                                    Complete and publish your result between{" "}
                                    {new Date(offer.opensAt).toLocaleString()}{" "}
                                    and{" "}
                                    {new Date(offer.cutoffAt).toLocaleString()}.
                                    Winnings are shared equally among qualifying
                                    accounts. There may be no prize. Any
                                    remainder stays with the operator.
                                  </p>
                                  <p>
                                    Winning shares appear in your wallet. Scan
                                    your palm to claim; payments are approved
                                    daily. Unclaimed shares stay available. If
                                    nobody qualifies, winnings stay with the
                                    operator.
                                  </p>
                                </details>
                              )}
                            </For>
                          </>
                        )}
                      </Show>
                    </Show>
                    <Show when={session()}>
                      <Button
                        variant="outline"
                        onClick={() =>
                          setSinging({
                            postId: song.manifest.postId,
                            title: song.manifest.title,
                          })
                        }
                      >
                        Sing
                      </Button>
                    </Show>
                    <Show when={session() && capabilities()?.study}>
                      <Button
                        variant="outline"
                        onClick={() =>
                          openStudy({
                            postId: song.manifest.postId,
                            title: song.manifest.title,
                          })
                        }
                      >
                        Study
                      </Button>
                    </Show>
                    <Show when={song.lyricsText}>
                      <details>
                        <summary>Lyrics</summary>
                        <p class="live-lyrics">{song.lyricsText}</p>
                      </details>
                    </Show>
                    <a
                      class="live-receipt"
                      href={`/api/public/posts/${song.manifest.postId}/proof`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Publication receipt ↗
                    </a>
                  </article>
                )}
              </For>
            </Show>
          </section>
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
    </>
  );
}
render(() => <App />, document.getElementById("app")!);
