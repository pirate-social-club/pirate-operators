// Established WalletPortfolio page composition with explicit decentralized account/reward/MOSS ports.
import { createMemo, Show } from "solid-js";
import { ErrorState, Type } from "../design-system.ts";
import { WalletHub } from "../wallet/established/wallet-hub.tsx";
import { WalletReceiveSheet } from "../wallet/established/wallet-receive-sheet.tsx";
import { WalletWinnings } from "../wallet/established/wallet-winnings.tsx";
import { VeryClaimPresentation } from "../wallet/established/very-claim-presentation.tsx";
import { WalletSendPanel } from "../wallet/send-panel.tsx";
import { walletPortfolioView } from "../wallet/wallet-portfolio-view.ts";
import { useRewardWalletController } from "../wallet/use-reward-wallet.ts";
import type { LiveRewardWalletProps } from "../wallet/wallet-page-ports.ts";
export type { LiveRewardWalletProps } from "../wallet/wallet-page-ports.ts";

/** Stable shell mount. No application shell, routing, profile authoring or operator redesign. */
export function LiveRewardWallet(props: LiveRewardWalletProps) {
  const wallet = useRewardWalletController(props);
  const presentation = createMemo(() =>
    wallet.view()
      ? walletPortfolioView(wallet.view()!, wallet.credits(), props.identity)
      : null,
  );
  const claimData = {
    async credits() {
      return { items: wallet.credits() };
    },
    claim: wallet.claimFromRow,
  };
  async function verifyFromReturn(url: string) {
    const target = new URL(url, location.origin),
      returnTo = target.searchParams.get("return_to");
    if (
      target.origin !== location.origin ||
      target.pathname !== "/verify/very" ||
      !returnTo
    )
      throw Error("This link is incomplete. Go back and try again.");
    const resume = new URL(returnTo, location.origin),
      id = resume.searchParams.get("claim");
    if (
      resume.origin !== location.origin ||
      resume.pathname !== "/wallet" ||
      !id ||
      !/^[a-zA-Z0-9_-]{8,128}$/.test(id)
    )
      throw Error("This link is incomplete. Go back and try again.");
    await wallet.run(() => wallet.verify(id));
  }
  return (
    <main data-learner-wallet>
      <Show
        when={wallet.intent()}
        fallback={
          <>
            <Show when={!wallet.view()}>
              <Type as="h1" variant="h1">
                {location.pathname === "/verify/very"
                  ? "Claim your winnings"
                  : "Wallet"}
              </Type>
              <Show
                when={
                  wallet.busy() ||
                  wallet.notice() === "Loading wallet…" ||
                  wallet.notice().startsWith("Account changed.")
                }
                fallback={
                  <ErrorState
                    title="Wallet unavailable"
                    description="Your wallets could not be loaded."
                    tone={wallet.authorityLost() ? "blocked" : "retryable"}
                    primaryAction={wallet.authorityLost()
                      ? {
                          label: "Sign in again",
                          href: "/wallet",
                        }
                      : {
                          label: "Try again",
                          onClick: () => void wallet.run(wallet.refresh),
                        }}
                  />
                }
              >
                <Type role="status">Loading wallets…</Type>
              </Show>
            </Show>
            <Show when={presentation()}>
              {(current) => (
                <>
                  <WalletHub
                  variant="pilot"
                  walletLabel={current().wallet.displayName}
                  walletAddress={current().wallet.address}
                  assetsUnavailable={wallet.busy()}
                  totalBalanceUsd={current().balance}
                  rewardsSummary={current().rewards}
                  showChangeWalletAction={false}
                  walletActionsPending={wallet.busy()}
                  onRefresh={() => void wallet.run(wallet.refresh)}
                  chainSections={current().sections}
                  renderReceiveSheet={(controls) => (
                    <WalletReceiveSheet
                      {...controls}
                      chainSections={current().sections}
                      walletAddress={current().wallet.address}
                    />
                  )}
                  renderSendSheet={(controls) =>
                    controls.open && wallet.view() ? (
                      <WalletSendPanel
                        view={wallet.view()!}
                        adapter={props.sendAdapter}
                        send={props.send}
                        onConfirmed={() => void wallet.run(wallet.refresh)}
                        onClose={() => controls.onOpenChange(false)}
                      />
                    ) : null
                  }
                />
                <WalletWinnings
                  data={claimData}
                  chainId={6343}
                  currentCredits={wallet.credits()}
                  drawings={wallet.view()?.drawings}
                  disabled={wallet.busy() || !!wallet.intent()}
                  resumeCreditId={
                    location.pathname === "/wallet"
                      ? (wallet.creditFromUrl() ?? undefined)
                      : undefined
                  }
                  onResumeConsumed={wallet.consumeResume}
                  navigate={verifyFromReturn}
                />
                </>
              )}
            </Show>
            <Show when={wallet.view() && wallet.notice()}>
              <Type role="status">{wallet.notice()}</Type>
            </Show>
          </>
        }
      >
        {(intent) => (
          <VeryClaimPresentation
            intent={intent()}
            qr={wallet.qr()}
            notice={wallet.notice()}
            busy={wallet.busy()}
            retrying={wallet.failedPolls() >= 5}
            onCheck={() => void wallet.run(wallet.resumeVerification)}
            onCancel={wallet.cancelVerification}
          />
        )}
      </Show>
    </main>
  );
}
