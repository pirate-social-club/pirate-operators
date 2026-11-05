import "./style.css";
import { walletOrigin, communityOrigin, hash, randomToken } from "../shared.ts";
import { api } from "./api.ts";

const app = document.querySelector<HTMLElement>("#app")!;
const inWallet = location.origin === walletOrigin;
app.innerHTML = `<header><a class="wordmark" href="${communityOrigin}">pirate<span> / lab</span></a><span class="badge">TESTNET ONLY</span></header>
<main><p class="eyebrow">CREATOR WALLET / FIRST TEST</p><h1>${inWallet ? "Your creator wallet." : "One song.<br>One creator identity."}</h1>
<p class="intro">${inWallet ? "Save a passkey to activate your wallet. Your private share stays encrypted and only your passkey can unlock it." : "Test the path from MOSS sign-in to an Ika creator wallet. Start a release, activate your wallet, then reopen it and sign."}</p>
${
  inWallet
    ? `<section class="panel"><h2>Set up or reopen</h2><p>Use your saved passkey to create, resume or reopen your wallet.</p><div class="actions"><button id="create">Save a new passkey</button><button id="unlock" class="secondary">Use saved passkey</button><button id="sign" hidden>Sign test message</button><button id="finish" hidden>Return to community</button><button id="retry" class="secondary" hidden>Retry this step</button></div></section>`
    : `<ol class="steps"><li id="step1"><span>01</span>MOSS sign-in</li><li id="step2"><span>02</span>Activate creator wallet</li><li id="step3"><span>03</span>Reopen and sign</li></ol><section class="panel"><h2 id="panel-title">Start with MOSS</h2><p id="panel-description">Sign in with your MOSS account on MegaETH testnet.</p><div class="actions"><button id="login">Sign in with MOSS</button><button id="release" hidden>Release a song</button><button id="reopen" hidden>Reopen wallet &amp; sign</button><button id="logout" class="secondary" hidden>Sign out</button></div></section>`
}
<p id="status" class="status" role="status" aria-live="polite">${inWallet ? "Your passkey belongs to this dedicated wallet site." : "Checking test availability…"}</p><pre id="details"></pre>
<footer>This test stops at a verified signature. Song upload and publishing come next.</footer></main>`;
if (inWallet) {
  void import("./wallet.ts");
} else {
  void community();
}
async function community() {
  const status = document.querySelector<HTMLElement>("#status")!,
    details = document.querySelector<HTMLElement>("#details")!;
  const button = (id: string) =>
    document.querySelector<HTMLButtonElement>(`#${id}`)!;
  let popup: Window | null = null,
    verifier = "",
    state = "";
  async function refresh() {
    try {
      const s = await api<{
        address: string;
        creator?: { evm_address: string };
      }>("session");
      button("login").hidden = true;
      button("logout").hidden = false;
      button("release").hidden = !!s.creator;
      button("reopen").hidden = !s.creator;
      document.querySelector("#step1")!.classList.add("done");
      document.querySelector("#panel-title")!.textContent = s.creator
        ? "Your creator wallet is active"
        : "Ready to start a release";
      document.querySelector("#panel-description")!.textContent = s.creator
        ? "Close the wallet page, then reopen it with your saved passkey to prove signing works."
        : "Choose Release a song to set up your creator wallet.";
      details.textContent = `MOSS account\n${s.address}${s.creator ? `\n\nCreator wallet\n${s.creator.evm_address}` : ""}`;
      if (s.creator) document.querySelector("#step2")!.classList.add("done");
    } catch {
      button("login").hidden = false;
      button("release").hidden = true;
      button("reopen").hidden = true;
      button("logout").hidden = true;
      details.textContent = "";
    }
  }
  async function login() {
    status.textContent = "Opening MOSS sign-in…";
    const { mega } = await import("@megaeth-labs/wallet-sdk");
    await mega.initialise({
      network: "testnet",
      logging: "error",
      debug: false,
      handshakeTimeoutMs: 45_000,
    });
    status.textContent = "Continue in MOSS to sign in.";
    const connected = await mega.connect();
    if (!connected?.address) throw new Error("MOSS sign-in was cancelled.");
    const c = await api<{ id: string; message: string }>("auth/challenge", {
      address: connected.address,
    });
    const signed = await mega.signMessage(c.message);
    if (signed.status !== "success" || !signed.signature)
      throw new Error("The sign-in message was not signed.");
    await api("auth/verify", { id: c.id, signature: signed.signature });
    status.textContent = "Signed in. Start a release when you are ready.";
    await refresh();
  }
  async function launch() {
    popup = window.open(
      "about:blank",
      "pirate-creator-wallet",
      "popup,width=540,height=820",
    );
    if (!popup)
      throw new Error(
        "Allow popups for this site, then try again. The wallet opens in its own secure browser window.",
      );
    verifier = randomToken();
    state = randomToken();
    const r = await api<{ url: string }>("launch", {
      state,
      verifierHash: await hash(verifier),
    });
    popup.location.href = r.url;
    status.textContent = "Continue in the creator wallet window.";
  }
  window.addEventListener("message", (event) => {
    if (
      event.origin !== walletOrigin ||
      event.source !== popup ||
      event.data?.type !== "pirate:creator" ||
      event.data.state !== state ||
      typeof event.data.code !== "string"
    )
      return;
    void run(async () => {
      const result = await api<{ signed: boolean }>("exchange", {
        code: event.data.code,
        state,
        verifier,
      });
      verifier = "";
      state = "";
      popup = null;
      status.textContent = result.signed
        ? "Success. Your reopened creator wallet signed the test message."
        : "Creator wallet connected. Reopen it to test signing.";
      await refresh();
      if (result.signed)
        document.querySelector("#step3")!.classList.add("done");
    });
  });
  async function run(fn: () => Promise<void>) {
    for (const b of document.querySelectorAll<HTMLButtonElement>("button"))
      b.disabled = true;
    status.dataset.error = "false";
    try {
      await fn();
    } catch (error) {
      status.textContent =
        error instanceof Error ? error.message : "The test could not complete.";
      status.dataset.error = "true";
    } finally {
      for (const b of document.querySelectorAll<HTMLButtonElement>("button"))
        b.disabled = false;
    }
  }
  button("login").onclick = () => void run(login);
  button("release").onclick = () => void run(launch);
  button("reopen").onclick = () => void run(launch);
  button("logout").onclick = () =>
    void run(async () => {
      await api("logout", {});
      await refresh();
      status.textContent = "Signed out.";
    });
  await refresh();
  try {
    const r = await api<{ ready: boolean; reason?: string }>("readiness");
    if (!button("login").disabled)
      status.textContent = r.ready
        ? "Testnet operator ready."
        : (r.reason ?? "Test operator is being prepared.");
  } catch {
    status.textContent =
      "The test operator is not available yet. Sign-in can still be tested.";
  }
}
