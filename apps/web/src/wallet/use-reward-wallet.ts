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
    verificationSerial = 0,
    busySerial = 0,
    reloadingAccount = false,
    stopped = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  const summary = createMemo(() =>
    view() ? rewardSummary(view()!, credits()) : null,
  );
  onCleanup(() => {
    stopped = true;
    invalidateVerification();
    ++busySerial;
  });
  const active = () => !stopped && !reloadingAccount;
  const currentVerification = (serial: number) =>
    active() && serial === verificationSerial;
  function invalidateVerification() {
    ++verificationSerial;
    clearTimeout(timer);
    timer = undefined;
    return verificationSerial;
  }
  async function refreshWallet(current = active) {
    if (!current()) return;
    const serial = ++refreshSerial;
    const [wallet, rows] = await Promise.all([data.wallet(), data.credits()]);
    if (!active() || !current() || serial !== refreshSerial) return;
    rewardSummary(wallet, rows);
    const previous = view();
    if (
      previous &&
      rewardWalletIdentity(previous) !== rewardWalletIdentity(wallet)
    ) {
      reloadingAccount = true;
      invalidateVerification();
      ++busySerial;
      setBusy(false);
      setIntent(null);
      setQr("");
      setFailedPolls(0);
      setView(null);
      setCredits([]);
      history.replaceState(null, "", "/wallet");
      setNotice("Account changed. Reloading your wallet…");
      if (props.onAccountChanged) props.onAccountChanged();
      else location.replace("/wallet");
      return;
    }
    setView(wallet);
    setCredits(rows);
    setNotice("");
  }
  async function refresh() {
    const serial = verificationSerial;
    await refreshWallet(() => currentVerification(serial));
  }
  async function perform(action: () => Promise<void>, current = active) {
    if (!current()) return;
    const serial = ++busySerial;
    const ownsBusy = () => current() && serial === busySerial;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      if (ownsBusy())
        setNotice(
          error instanceof Error
            ? error.message
            : "This step could not complete. Refresh to check again.",
        );
    } finally {
      if (ownsBusy()) setBusy(false);
    }
  }
  async function run(action: () => Promise<void>) {
    if (busy() || !active()) return;
    await perform(action);
  }
  function creditFromUrl() {
    if (!active()) return null;
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
  async function poll(id: string, creditId: string, serial: number) {
    if (!currentVerification(serial)) return;
    clearTimeout(timer);
    timer = undefined;
    try {
      const next = await data.poll(id);
      if (!currentVerification(serial)) return;
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
        await refreshWallet(() => currentVerification(serial));
        return;
      }
      if (next.state === "subject_conflict") {
        setIntent(null);
        setQr("");
        history.replaceState(null, "", "/wallet");
        await refreshWallet(() => currentVerification(serial));
        if (!currentVerification(serial)) return;
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
      if (currentVerification(serial)) {
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
    if (currentVerification(serial))
      timer = setTimeout(() => void poll(id, creditId, serial), 3000);
  }
  async function verify(creditId: string) {
    if (!active()) return;
    const serial = invalidateVerification();
    setFailedPolls(0);
    setIntent(null);
    setQr("");
    setNotice("");
    // Verification owns a fresh busy ticket, including when started inside run().
    // An older wrapper's catch/finally must not clear this request's busy state.
    await perform(
      async () => {
        const url = new URL(location.href),
          candidate =
            url.pathname === "/verify/very"
              ? url.searchParams.get("intent")
              : null,
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
        if (!currentVerification(serial)) return;
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
          if (!currentVerification(serial)) return;
          setQr(image);
        }
        await poll(next.intent_id, creditId, serial);
      },
      () => currentVerification(serial),
    );
  }
  async function claim(id: string, resumed = false) {
    if (!active()) return;
    const serial = verificationSerial;
    const outcome = await data.claim(id);
    if (!currentVerification(serial)) return;
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
    await refreshWallet(() => currentVerification(serial));
    if (!currentVerification(serial)) return;
    if (outcome.outcome === "subject_conflict")
      setNotice("Your amount stays held; contact support.");
  }
  onSettled(() => {
    void Promise.resolve().then(() =>
      run(async () => {
        const serial = verificationSerial;
        await refresh();
        if (!currentVerification(serial)) return;
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
      if (!active()) return;
      history.replaceState(null, "", "/wallet");
    },
    async claimFromRow(id: string) {
      if (!active())
        throw Error("The account or wallet changed. Reopen your wallet.");
      const serial = verificationSerial;
      const result = await data.claim(id);
      if (currentVerification(serial))
        await refreshWallet(() => currentVerification(serial));
      if (!currentVerification(serial))
        throw Error("The account or wallet changed. Reopen your wallet.");
      return result;
    },
    async resumeVerification() {
      const id = creditFromUrl(),
        current = intent();
      if (id && current) {
        const serial = invalidateVerification();
        setFailedPolls(0);
        await perform(
          () => poll(current.intent_id, id, serial),
          () => currentVerification(serial),
        );
      }
    },
    cancelVerification() {
      if (!active()) return;
      invalidateVerification();
      ++busySerial;
      setBusy(false);
      setIntent(null);
      setQr("");
      setFailedPolls(0);
      setNotice("");
      history.replaceState(null, "", "/wallet");
    },
  };
}
