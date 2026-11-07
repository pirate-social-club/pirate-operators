import { render } from "@solidjs/web";
import { createSignal, For, Show, onCleanup } from "solid-js";
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
import { LiveRewardWallet } from "./rewards.tsx";
import { LiveRewardOperator } from "./reward-operator.tsx";
import type { RewardAvailableOffers } from "../../../../packages/rewards/contracts.ts";
import {
  stopPublicEnrollment,
  type LearningEnrollments,
} from "./learning-revocation.ts";
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

const walletOrigin = "https://pirate-wallet-test.piratesocialclub.workers.dev";
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
  const practiceOpen = () => singing() !== null || studying() !== null;
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
  let popup: Window | null = null,
    timer: ReturnType<typeof setTimeout> | undefined,
    stopped = false;
  async function refreshSession() {
    try {
      setSession(await get<CommunitySessionView>("/api/session"));
    } catch {
      setSession(null);
    }
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
    if (session() && caps.rewards && !walletPage) {
      setRewardOffers(
        await get<RewardAvailableOffers>("/api/rewards/offers").catch(
          () => null,
        ),
      );
    }
    const requested = new URL(location.href).searchParams.get("study");
    const song = posts.posts.find((post) => post.manifest.postId === requested);
    if (session() && caps.study && song)
      openStudy({ postId: song.manifest.postId, title: song.manifest.title });
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
  async function signIn() {
    setStatus("Opening MOSS…");
    const mega = await moss();
    setStatus("Continue in MOSS to sign in.");
    const account = await mega.connect();
    if (!account?.address) throw new Error("MOSS sign-in was cancelled.");
    const challenge = await post<{ id: string; message: string }>(
        "/api/auth/challenge",
        { address: account.address },
      ),
      signed = await mega.signMessage(challenge.message);
    if (signed.status !== "success" || !signed.signature)
      throw new Error("The sign-in message was not signed.");
    await post("/api/auth/verify", {
      id: challenge.id,
      signature: signed.signature,
    });
    await refresh();
    setStatus("Signed in. Choose a song to study or sing.");
  }
  async function revokeLearning() {
    const current = session();
    if (!current) return;
    setStatus(
      await stopPublicEnrollment({
        list: () =>
          post<LearningEnrollments>(
            "/api/karaoke/enrollments",
            {},
            current.csrf,
          ),
        request: (target) =>
          post<import("./karaoke.tsx").KaraokeConsentRequest>(
            "/api/karaoke/enrollment/revoke",
            { target },
            current.csrf,
          ),
        submit: (request, signature) =>
          post<{ state: string }>(
            "/api/karaoke/enrollment/revoke",
            { message: request.message, signature, target: request.target },
            current.csrf,
          ),
        wallet: mossWallet,
        status: setStatus,
      }),
    );
  }
  async function finishConnection(connectionId: string, state: string) {
    const current = session();
    if (!current) return false;
    const result = await post<{ state: string; requiresReconnect?: boolean }>(
      "/api/creator/complete",
      { connectionId, state },
      current.csrf,
    );
    if (result.state === "waiting") return false;
    await refreshSession();
    if (result.state === "connected")
      setStatus("Creator wallet connected. Your progress is saved.");
    else if (result.state === "verification_expired")
      setStatus(
        "The wallet verification expired. Reopen your saved wallet for a fresh check.",
      );
    else if (result.state === "choose_another_wallet")
      setStatus(
        "This wallet is already linked to another account in this community. Reopen the connection and choose another wallet.",
      );
    return true;
  }
  async function connectWallet() {
    const current = session();
    if (!current) return;
    // Open from the button's user gesture, before the asynchronous launch.
    popup = window.open("about:blank", "_blank", "popup,width=560,height=820");
    try {
      const connection = await post<{
          connectionId: string;
          state: string;
          url: string;
        }>("/api/creator/connect", {}, current.csrf),
        target = new URL(connection.url);
      if (target.origin !== walletOrigin || target.pathname !== "/wallet")
        throw new Error("The wallet address could not be verified.");
      await refreshSession();
      if (popup) popup.location.href = target.href;
      else location.assign(target.href);
      setStatus(
        "Use your saved passkey in the wallet window, then confirm Return to community.",
      );
      schedule();
    } catch (failure) {
      popup?.close();
      popup = null;
      throw failure;
    }
  }
  async function pollConnection() {
    const pending = session()?.pendingConnection;
    if (!pending?.state) return;
    try {
      await finishConnection(pending.connectionId, pending.state);
    } catch {
      /* The server retains the request. The next poll reuses it. */
    }
  }
  function schedule() {
    if (timer) clearTimeout(timer);
    if (stopped || !session()?.pendingConnection) return;
    timer = setTimeout(() => {
      void pollConnection().finally(schedule);
    }, 10000);
  }
  const receiver = (event: MessageEvent) => {
    const pending = session()?.pendingConnection;
    if (
      event.origin !== walletOrigin ||
      event.source !== popup ||
      event.data?.type !== "pirate:creator" ||
      event.data.state !== pending?.state ||
      !pending?.state
    )
      return;
    void run(async () => {
      await finishConnection(pending.connectionId, pending.state!);
      popup = null;
      schedule();
    });
  };
  window.addEventListener("message", receiver);
  onCleanup(() => {
    stopped = true;
    if (timer) clearTimeout(timer);
    window.removeEventListener("message", receiver);
  });
  void run(async () => {
    await refresh();
    const returning = new URL(location.href),
      pending = session()?.pendingConnection;
    if (
      returning.pathname === "/creator/complete" &&
      pending?.state &&
      returning.searchParams.get("connection") === pending.connectionId &&
      returning.searchParams.get("state") === pending.state
    ) {
      history.replaceState(null, "", "/");
      await finishConnection(pending.connectionId, pending.state);
    } else
      setStatus(
        session()
          ? "Your community is ready."
          : "Sign in to release your song.",
      );
    schedule();
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
              <Show when={capabilities()?.learningServiceMode === "internal"}>
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
                    <DropdownMenuItem onSelect={() => void run(revokeLearning)}>
                      Stop public enrollment
                    </DropdownMenuItem>
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
            onExit={() => setSinging(null)}
            onLearningActions={(actions) => setLearningActions(actions)}
          />
        </div>
      </Show>
      <Show when={studying() && session()}>
        <div class="live-study-overlay">
          <LiveStudy
            postId={studying()!.postId}
            title={studying()!.title}
            csrf={session()!.csrf}
            wallet={mossWallet}
            onExit={closeStudy}
            onLearningActions={(actions) => setLearningActions(actions)}
          />
        </div>
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
          <Show when={session()}>
            {(current) => (
              <section class="live-release">
                <div>
                  <p class="live-kicker">YOUR NEXT RELEASE</p>
                  <h2>
                    {current().creator
                      ? "Your creator wallet is connected."
                      : "Bring your first song."}
                  </h2>
                  <p>
                    {current().creator
                      ? `Creator wallet ${shortened(current().creator!.evmAddress)}`
                      : "Use your saved creator passkey. Creator setup is covered by capped operator funding."}
                  </p>
                  <p class="live-muted">
                    {capabilities()?.publication
                      ? "Upload your recording and lyrics to begin."
                      : "Release processing is being prepared. Your wallet connection will stay saved."}
                  </p>
                </div>
                <Button
                  disabled={busy() || !capabilities()?.creatorConnection}
                  onClick={() => void run(connectWallet)}
                >
                  {current().creator
                    ? "Reopen creator wallet"
                    : "Connect creator wallet"}
                </Button>
              </section>
            )}
          </Show>
          <Show when={session()}>
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
                            <Show when={!available().approved}>
                              <p class="live-muted">
                                Practice is open. Ask the operator to add your
                                account for lottery rewards.
                              </p>
                            </Show>
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
                                    lines measured. One entry per approved
                                    account.
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
      <footer class="live-footer" inert={practiceOpen()}>
        A community of independent creators. Creator ownership stays with your
        wallet.
      </footer>
    </>
  );
}
render(() => <App />, document.getElementById("app")!);
