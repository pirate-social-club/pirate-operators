// Existing decentralized claim/session controller retained from reviewed af714492; composition port owns no economic authority.
import { createMemo, createSignal, onCleanup, onSettled } from "solid-js";
import QRCode from "qrcode";
import { rewardsData } from "../live/rewards-data.ts";
import { rewardSummary } from "./reward-status.ts";
import { rewardWalletIdentity } from "./hosted-send.ts";
import type {
  RewardCredit,
  RewardWalletView,
  VerificationIntent,
} from "../../../../packages/rewards/contracts.ts";
import type { LiveRewardWalletProps } from "./wallet-page-ports.ts";

export function useRewardWalletController(props: LiveRewardWalletProps) {
  const data = props.data ?? rewardsData(props.csrf);
  const [view, setView] = createSignal<RewardWalletView | null>(null),
    [credits, setCredits] = createSignal<RewardCredit[]>([]),
    [busy, setBusy] = createSignal(false),
    [notice, setNotice] = createSignal("Loading wallet…"),
    [intent, setIntent] = createSignal<VerificationIntent | null>(null),
    [qr, setQr] = createSignal(""),
    [failedPolls, setFailedPolls] = createSignal(0);
  let refreshSerial = 0,
    reloadingAccount = false,
    stopped = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  const summary = createMemo(() =>
    view() ? rewardSummary(view()!, credits()) : null,
  );
  onCleanup(() => {
    stopped = true;
    clearTimeout(timer);
  });
  async function refresh() {
    if (reloadingAccount) return;
    const serial = ++refreshSerial;
    const [wallet, rows] = await Promise.all([data.wallet(), data.credits()]);
    rewardSummary(wallet, rows);
    if (stopped || serial !== refreshSerial) return;
    const previous = view();
    if (
      previous &&
      rewardWalletIdentity(previous) !== rewardWalletIdentity(wallet)
    ) {
      reloadingAccount = true;
      clearTimeout(timer);
      setIntent(null);
      setView(null);
      setCredits([]);
      setNotice("Account changed. Reloading your wallet…");
      if (props.onAccountChanged) props.onAccountChanged();
      else location.replace("/wallet");
      return;
    }
    setView(wallet);
    setCredits(rows);
    setNotice("");
  }
  async function run(action: () => Promise<void>) {
    if (busy()) return;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      if (!stopped)
        setNotice(
          error instanceof Error
            ? error.message
            : "This step could not complete. Refresh to check again.",
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
    clearTimeout(timer);
    try {
      const next = await data.poll(id);
      if (stopped) return;
      setFailedPolls(0);
      setIntent(next);
      if (next.state === "verified") {
        history.replaceState(
          null,
          "",
          `/wallet?claim=${encodeURIComponent(creditId)}`,
        );
        setIntent(null);
        setQr("");
        // The copied WalletWinnings resume machine consumes this URL and claims once.
        // Keep the verified server intent; do not start a competing page-level claim.
        await refresh();
        return;
      }
      if (next.state === "subject_conflict") {
        setIntent(null);
        setQr("");
        history.replaceState(null, "", "/wallet");
        await refresh();
        setNotice(
          "This palm scan is linked to another reward account. Your amount stays held; contact support.",
        );
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
      if (!stopped) {
        setFailedPolls(failedPolls() + 1);
        setNotice("Verification is still pending. Your winnings stay held.");
        if (failedPolls() >= 5) {
          setNotice(
            "Verification could not be checked. Your winnings stay held. Press Check palm scan to resume this same verification.",
          );
          return;
        }
      }
    }
    if (!stopped) timer = setTimeout(() => void poll(id, creditId), 3000);
  }
  async function verify(creditId: string) {
    clearTimeout(timer);
    setFailedPolls(0);
    const url = new URL(location.href),
      candidate =
        url.pathname === "/verify/very" ? url.searchParams.get("intent") : null,
      existing =
        candidate && /^[a-zA-Z0-9_-]{8,128}$/.test(candidate)
          ? candidate
          : null;
    if (url.pathname === "/verify/very" && !existing) {
      history.replaceState(null, "", "/wallet");
      throw Error(
        "This palm verification link is incomplete. Press Verify to claim to start again.",
      );
    }
    const next = existing ? await data.poll(existing) : await data.intent();
    if (stopped) return;
    setIntent(next);
    const returnTo = `/wallet?claim=${encodeURIComponent(creditId)}`;
    history.replaceState(
      null,
      "",
      `/verify/very?purpose=reward_claim&return_to=${encodeURIComponent(returnTo)}&intent=${encodeURIComponent(next.intent_id)}`,
    );
    if (next.launch_url) {
      const image = await QRCode.toDataURL(next.launch_url, {
        width: 256,
        margin: 2,
      });
      if (stopped) return;
      setQr(image);
    }
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
        }
      }),
    );
  });
  return {
    view,
    credits,
    busy,
    notice,
    intent,
    qr,
    failedPolls,
    summary,
    refresh,
    run,
    claim,
    verify,
    creditFromUrl,
    consumeResume() {
      history.replaceState(null, "", "/wallet");
    },
    async claimFromRow(id: string) {
      if (stopped || reloadingAccount)
        throw Error("The account or wallet changed. Reopen your wallet.");
      const result = await data.claim(id);
      if (!stopped) await refresh();
      return result;
    },
    async resumeVerification() {
      const id = creditFromUrl(),
        current = intent();
      if (id && current) {
        setFailedPolls(0);
        await poll(current.intent_id, id);
      }
    },
    cancelVerification() {
      clearTimeout(timer);
      setIntent(null);
      setQr("");
      history.replaceState(null, "", "/wallet");
    },
  };
}
