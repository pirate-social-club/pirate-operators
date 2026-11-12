// Independently ported 2026-11-11; exact source/blob and adaptations: docs/v1-wallet-owner-parity-20261111.md.
import { For, Show, createSignal, onSettled } from "solid-js";
import { Button, Type } from "./design-system.ts";
import type {
  ClaimOutcome,
  RewardCredit,
  RewardWalletView,
} from "../../../../../packages/rewards/contracts.ts";
import { drawingStatus } from "../reward-status.ts";
type RewardClaimData = {
  credits(): Promise<{ items: readonly RewardCredit[] }>;
  claim(id: string): Promise<{ outcome: ClaimOutcome; credit: RewardCredit }>;
};
import { claimStep, verifyToClaimUrl, winningViews } from "./winnings-model.ts";

export type WalletWinningsProps = Readonly<{
  data: Pick<RewardClaimData, "credits" | "claim">;
  /** A claim to resume once, after returning from the palm scan. */
  resumeCreditId?: string;
  navigate?: (url: string) => void | Promise<void>;
  currentCredits?: readonly RewardCredit[];
  drawings?: RewardWalletView["drawings"];
  disabled?: boolean;
  /** Called once the resumed claim starts, so the caller can drop it from the URL. */
  onResumeConsumed?: () => void;
  /** Show only winnings belonging to the selected wallet persona. */
  personaId?: string;
  /** Show only winnings on this chain, the row's own. */
  chainId?: number;
}>;

/** Spec 015 §5.2a: held pool winnings and the verify-to-claim action. */
export function WalletWinnings(props: WalletWinningsProps) {
  const [credits, setCredits] = createSignal<readonly RewardCredit[]>();
  const [failed, setFailed] = createSignal(false);
  const [leaving, setLeaving] = createSignal(false);
  const [busy, setBusy] = createSignal<string>();
  const [notice, setNotice] = createSignal("");
  const navigate = (url: string) =>
    (props.navigate ?? ((next: string) => window.location.assign(next)))(url);

  // While rewards are disabled the API answers unavailable. Without known
  // winnings a failed load renders nothing rather than alarming every user.
  const load = async (): Promise<boolean> => {
    setFailed(false);
    try {
      setCredits((await props.data.credits()).items);
      return true;
    } catch {
      setFailed(credits() !== undefined);
      return false;
    }
  };

  const claim = async (creditId: string, resumed: boolean) => {
    setBusy(creditId);
    setNotice("");
    try {
      const result = await props.data.claim(creditId);
      setCredits((current) =>
        current?.map((item) =>
          item.credit_id === creditId ? result.credit : item,
        ),
      );
      const step = claimStep(result.outcome);
      if (step.kind === "verify") {
        if (resumed) {
          setNotice(
            "Your palm scan could not be used to claim yet. Try verifying again.",
          );
          return;
        }
        setLeaving(true);
        await navigate(verifyToClaimUrl(creditId));
        return;
      }
      if (step.kind === "support") {
        setNotice(
          "This amount stays held for you, but it cannot be claimed with your current verification. Contact support.",
        );
      }
      if (step.kind === "unavailable")
        setNotice("This amount cannot be claimed.");
    } catch {
      setNotice("Claiming failed. Try again.");
    } finally {
      setBusy(undefined);
      setLeaving(false);
    }
  };

  // Start after the settle callback returns: Solid 2 rejects signal writes
  // made synchronously inside effect callbacks.
  onSettled(() => {
    void Promise.resolve()
      .then(load)
      .then((loaded) => {
        const resume = props.resumeCreditId;
        if (resume === undefined || !loaded) return;
        props.onResumeConsumed?.();
        return claim(resume, true);
      });
  });

  const views = () =>
    winningViews(
      (props.currentCredits ?? credits() ?? []).filter(
        (credit) =>
          props.chainId === undefined || credit.chain_id === props.chainId,
      ),
    );
  return (
    <Show
      when={
        failed() ||
        views().length > 0 ||
        notice().length > 0 ||
        (props.drawings?.length ?? 0) > 0
      }
    >
      <div
        role="group"
        aria-label="Pool winnings"
        class="flex flex-col gap-3 border-t border-border-soft pt-3"
      >
        <Show when={failed()}>
          <Type role="alert">Your winnings could not be loaded.</Type>
          <Button variant="outline" onClick={() => void load()}>
            Try again
          </Button>
        </Show>
        <For each={props.drawings ?? []}>
          {(drawing) => (
            <Type variant="caption">
              {new Date(drawing.cutoffAt).toLocaleDateString()}:{" "}
              {drawingStatus(drawing)}
            </Type>
          )}
        </For>
        <For each={views()}>
          {(view) => (
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div class="flex flex-col gap-1">
                <Type class="font-semibold">{view.amount}</Type>
                <Type>{view.status}</Type>
                <Show when={view.detail}>
                  {(detail) => <Type class="text-sm">{detail()}</Type>}
                </Show>
              </div>
              <Show when={view.canClaim}>
                <Button
                  disabled={props.disabled || busy() !== undefined || leaving()}
                  onClick={() => void claim(view.creditId, false)}
                >
                  {busy() === view.creditId ? "Claiming…" : "Verify to claim"}
                </Button>
              </Show>
            </div>
          )}
        </For>
        <Show when={notice().length > 0}>
          <Type role="status">{notice()}</Type>
        </Show>
      </div>
    </Show>
  );
}
