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

const walletOrigin = "https://pirate-wallet-test.piratesocialclub.workers.dev";
const shortened = (address: string) =>
  `${address.slice(0, 8)}…${address.slice(-6)}`;
function App() {
  const [name, setName] = createSignal("Your community"),
    [boot, setBoot] = createSignal<CommunityClientConfig | null>(null),
    [session, setSession] = createSignal<CommunitySessionView | null>(null),
    [capabilities, setCapabilities] =
      createSignal<CommunityCapabilities | null>(null),
    [feed, setFeed] = createSignal<CommunityFeed | null>(null),
    [busy, setBusy] = createSignal(false),
    [status, setStatus] = createSignal("Loading community…"),
    [error, setError] = createSignal(false);
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
    const { mega } = await import("@megaeth-labs/wallet-sdk");
    await mega.initialise({
      network: "testnet",
      logging: "error",
      debug: false,
      handshakeTimeoutMs: 45000,
    });
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
    await refreshSession();
    setStatus("Signed in. Connect your creator wallet to begin a release.");
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
      <header class="live-header">
        <a href="/" class="live-brand">
          pirate<span>/ community</span>
        </a>
        <span class="live-testnet">TESTNET</span>
        <Show
          when={session()}
          fallback={
            <Button
              variant="outline"
              disabled={busy() || !boot()}
              onClick={() => void run(signIn)}
            >
              Sign in with MOSS
            </Button>
          }
        >
          {(current) => (
            <div class="live-account">
              <span title={current().mossAddress}>
                {shortened(current().mossAddress)}
              </span>
              <Button
                variant="ghost"
                disabled={busy()}
                onClick={() =>
                  void run(async () => {
                    await post("/api/logout", {}, current().csrf);
                    setSession(null);
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
      <main class="live-main">
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
                <article class="live-song" id={`song-${song.manifest.postId}`}>
                  <p class="live-kicker">
                    {song.manifest.rating === "adult" ? "EXPLICIT" : "SONG"}
                  </p>
                  <h3>
                    <a href={song.postUrl}>{song.manifest.title}</a>
                  </h3>
                  <p class="live-muted">
                    Creator {song.manifest.authorId.slice(2, 10)}
                  </p>
                  <audio controls preload="metadata" src={song.audioUrl} />
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
      <footer class="live-footer">
        A community of independent creators. Creator ownership stays with your
        wallet.
      </footer>
    </>
  );
}
render(() => <App />, document.getElementById("app")!);
