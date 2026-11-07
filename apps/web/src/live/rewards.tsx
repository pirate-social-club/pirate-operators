// Independently owned learner presentation adapted from pirate-web-solid c7cb878:
// wallet-hub.tsx and rewards/winnings-model.ts. One dollar asset; no chain list or creator claims.
import { createSignal, For, Show, onCleanup, onSettled } from "solid-js";
import QRCode from "qrcode";
import { Button, Card, CardContent, CardHeader, Type } from "../ui.ts";
import { rewardsData, type RewardsData } from "./rewards-data.ts";
import { dollars, openRewardWallet } from "./reward-wallet.ts";
import type {
  RewardCredit,
  RewardWalletView,
  VerificationIntent,
} from "../../../../packages/rewards/contracts.ts";

export function LiveRewardWallet(props: {
  csrf: string;
  onExit: () => void;
  data?: RewardsData;
  send?: (view: RewardWalletView) => Promise<void>;
}) {
  const data = props.data ?? rewardsData(props.csrf);
  const [view, setView] = createSignal<RewardWalletView | null>(null),
    [credits, setCredits] = createSignal<RewardCredit[]>([]),
    [busy, setBusy] = createSignal(false),
    [notice, setNotice] = createSignal("Loading wallet…"),
    [intent, setIntent] = createSignal<VerificationIntent | null>(null),
    [qr, setQr] = createSignal("");
  let stopped = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    stopped = true;
    clearTimeout(timer);
  });
  async function refresh() {
    const [wallet, rows] = await Promise.all([data.wallet(), data.credits()]);
    if (!stopped) {
      setView(wallet);
      setCredits(rows);
      setNotice("");
    }
  }
  async function run(action: () => Promise<void>) {
    if (busy()) return;
    setBusy(true);
    try {
      await action();
    } catch {
      if (!stopped)
        setNotice(
          "This step could not complete. Your winnings stay held. Try again.",
        );
    } finally {
      if (!stopped) setBusy(false);
    }
  }
  function creditFromUrl() {
    const url = new URL(location.href);
    let path =
      url.pathname === "/verify/very"
        ? url.searchParams.get("return_to")
        : null;
    const target = path ? new URL(path, location.origin) : url;
    if (target.origin !== location.origin || target.pathname !== "/wallet")
      return null;
    const id = target.searchParams.get("claim");
    return id && /^[a-zA-Z0-9_-]{8,128}$/.test(id) ? id : null;
  }
  async function poll(id: string, creditId: string) {
    try {
      const next = await data.poll(id);
      if (stopped) return;
      setIntent(next);
      if (next.state === "verified") {
        history.replaceState(
          null,
          "",
          `/wallet?claim=${encodeURIComponent(creditId)}`,
        );
        setIntent(null);
        setQr("");
        await claim(creditId, true);
        return;
      }
      if (next.state === "subject_conflict") {
        setNotice(
          "This palm scan is linked to another reward account. Your amount stays held; contact support.",
        );
        await refresh();
        return;
      }
      if (next.state === "expired") {
        setNotice(
          "Verification expired. Your winnings stay held. Press Verify to claim again.",
        );
        setIntent(null);
        setQr("");
        history.replaceState(null, "", "/wallet");
        return;
      }
    } catch {
      if (!stopped)
        setNotice("Verification is still pending. Your winnings stay held.");
    }
    if (!stopped) timer = setTimeout(() => void poll(id, creditId), 3000);
  }
  async function verify(creditId: string) {
    const url = new URL(location.href),
      existing =
        url.pathname === "/verify/very" ? url.searchParams.get("intent") : null;
    const next = existing ? await data.poll(existing) : await data.intent();
    if (stopped) return;
    setIntent(next);
    const returnTo = `/wallet?claim=${encodeURIComponent(creditId)}`;
    history.replaceState(
      null,
      "",
      `/verify/very?purpose=reward_claim&return_to=${encodeURIComponent(returnTo)}&intent=${encodeURIComponent(next.intent_id)}`,
    );
    if (next.launch_url)
      setQr(await QRCode.toDataURL(next.launch_url, { width: 256, margin: 2 }));
    await poll(next.intent_id, creditId);
  }
  async function claim(id: string, resumed = false) {
    const outcome = await data.claim(id);
    if (stopped) return;
    if (
      outcome.outcome === "verification_missing" ||
      outcome.outcome === "verification_stale"
    ) {
      if (resumed) {
        setNotice(
          "Your palm scan could not be used to claim yet. Try verifying again.",
        );
        return;
      }
      await verify(id);
      return;
    }
    history.replaceState(null, "", "/wallet");
    await refresh();
    if (outcome.outcome === "subject_conflict")
      setNotice("Your amount stays held; contact support.");
  }
  onSettled(() => {
    void Promise.resolve().then(() =>
      run(async () => {
        await refresh();
        const id = creditFromUrl();
        if (id) {
          if (location.pathname === "/verify/very") await verify(id);
          else {
            history.replaceState(null, "", "/wallet");
            await claim(id, true);
          }
        }
      }),
    );
  });
  const detail = (c: RewardCredit) =>
    c.claim.status === "unclaimed"
      ? "Verify with a palm scan to claim it."
      : c.claim.status === "subject_conflict"
        ? "This amount stays held; contact support."
        : c.claim.payout_status === "confirmed"
          ? "Sent to your wallet."
          : c.claim.payout_status === "sending"
            ? "Sending to your wallet."
            : "Awaiting payment. Payments are processed daily.";
  return (
    <div
      class="mx-auto flex w-full max-w-[640px] flex-col gap-4 p-6"
      data-learner-wallet
    >
      <header class="flex items-center justify-between">
        <Type as="h1" variant="h2">
          Wallet
        </Type>
        <Button variant="ghost" onClick={props.onExit}>
          Back
        </Button>
      </header>
      <Card>
        <CardHeader>
          <Type as="p" variant="overline">
            Total balance
          </Type>
          <Type as="p" variant="display">
            {view()?.balanceAtomic === null || !view()
              ? "—"
              : dollars(view()!.balanceAtomic!, view()!.decimals)}
          </Type>
        </CardHeader>
        <CardContent>
          <Button
            class="w-full"
            variant="outline"
            disabled={busy() || !view()}
            onClick={() =>
              void run(() => (props.send ?? openRewardWallet)(view()!))
            }
          >
            Send
          </Button>
        </CardContent>
      </Card>
      <Show when={view()?.balanceAtomic === null}>
        <Type as="p">Balance unavailable. Refresh to check again.</Type>
      </Show>
      <Show when={view()?.practiceOnly}>
        <Type as="p" variant="caption">
          Practice balance and rewards. These amounts have no cash value.
        </Type>
      </Show>
      <Show when={notice()}>
        <Type as="p" role="status">
          {notice()}
        </Type>
      </Show>
      <Show when={intent()}>
        {(current) => (
          <Card>
            <CardHeader>
              <Type as="h2" variant="h3">
                Scan your palm to claim
              </Type>
            </CardHeader>
            <CardContent class="flex flex-col gap-3">
              <Show when={qr()}>
                <img
                  src={qr()}
                  width="256"
                  height="256"
                  alt="Scan with Very to verify this claim"
                />
              </Show>
              <Show when={current().launch_url}>
                <a href={current().launch_url!} rel="noreferrer">
                  Continue on this phone
                </a>
              </Show>
              <Type as="p" role="status">
                Waiting for verification…
              </Type>
            </CardContent>
          </Card>
        )}
      </Show>
      <Card>
        <CardHeader>
          <Type as="h2" variant="h3">
            Lottery winnings
          </Type>
        </CardHeader>
        <CardContent class="flex flex-col gap-4">
          <For each={view()?.drawings ?? []}>
            {(drawing) => (
              <Type as="p">
                {new Date(drawing.cutoffAt).toLocaleDateString()}
                {": "}
                {drawing.qualified === false
                  ? "You did not qualify for this drawing."
                  : drawing.state === "no_prize"
                    ? "This drawing had no prize."
                    : drawing.state === "open" || drawing.state === "closed"
                      ? "Drawing pending."
                      : "Lottery winnings recorded."}
              </Type>
            )}
          </For>
          <Show
            when={credits().length > 0}
            fallback={<Type as="p">No winnings to claim yet.</Type>}
          >
            <For each={credits()}>
              {(credit) => (
                <div class="flex flex-wrap items-center justify-between gap-3 border-t border-border-soft pt-3">
                  <div>
                    <Type as="p" variant="body-strong">
                      {dollars(credit.amount_atomic, credit.token_decimals)}
                    </Type>
                    <Type as="p">{detail(credit)}</Type>
                  </div>
                  <Show when={credit.claim.status === "unclaimed"}>
                    <Button
                      disabled={busy() || !!intent()}
                      onClick={() => void run(() => claim(credit.credit_id))}
                    >
                      Verify to claim
                    </Button>
                  </Show>
                </div>
              )}
            </For>
          </Show>
        </CardContent>
      </Card>
      <Button
        variant="ghost"
        disabled={busy()}
        onClick={() => void run(refresh)}
      >
        Refresh
      </Button>
      <Show when={view()?.operator}>
        <a href="/operator/rewards">Manage rewards</a>
      </Show>
    </div>
  );
}
