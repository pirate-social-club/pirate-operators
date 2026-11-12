// Independently ported 2026-11-11; exact source/blob and adaptations: docs/v1-wallet-owner-parity-20261111.md.
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";

import {
  Button,
  Card,
  CardContent,
  CardHeader,
  IconArrowDown,
  IconArrowUp,
  IconWallet,
  Type,
} from "./design-system.ts";
import { buildWalletHubView } from "./wallet-hub-view-model.ts";
import type { WalletHubChainSection, WalletHubProps } from "./wallet-hub.types";
import { TokenChainIcon } from "./wallet-visuals.tsx";

function ChainSection(props: {
  fiatByTokenId: Record<string, string | null>;
  section: WalletHubChainSection;
  renderAssetSupplement?: WalletHubProps["renderAssetSupplement"];
}) {
  return (
    <section aria-label={props.section.title} class="flex flex-col gap-2">
      <div class="flex items-baseline justify-between gap-2">
        <Type variant="overline">{props.section.title}</Type>
        <Show when={props.section.availability === "later"}>
          <Type variant="caption">
            {props.section.note ?? "Available later"}
          </Type>
        </Show>
      </div>
      <Show when={props.section.availability === "ready"}>
        <ul class="flex flex-col divide-y divide-border-soft">
          <For each={props.section.tokens}>
            {(token) => {
              const fiatValue = () =>
                props.fiatByTokenId[`${props.section.chainId}:${token.id}`];
              return (
                <li class="flex flex-col gap-2 py-3">
                  <div class="flex items-center justify-between gap-3">
                    <div class="flex min-w-0 items-center gap-3">
                      <TokenChainIcon
                        chainId={props.section.chainId}
                        chainLabel={props.section.title}
                        showChainBadge
                        token={token}
                        size="sm"
                      />
                      <div class="flex min-w-0 flex-col">
                        <Type variant="body-strong">{token.symbol}</Type>
                        <Type variant="caption" class="truncate">
                          {token.name}
                        </Type>
                      </div>
                    </div>
                    <div class="flex shrink-0 flex-col items-end">
                      <Type variant="body-strong">
                        {token.balance ??
                          (props.section.balancesUnavailable
                            ? "Unavailable"
                            : "0")}
                      </Type>
                      <Show when={fiatValue()}>
                        {(value) => <Type variant="caption">{value()}</Type>}
                      </Show>
                    </div>
                  </div>
                  {props.renderAssetSupplement?.(props.section.chainId, token)}
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
    </section>
  );
}

export function WalletHub(props: WalletHubProps) {
  const view = createMemo(() => buildWalletHubView(props));
  // The controlled identity effect closes sheets when the wallet or network changes.
  const [receiveOpen, setReceiveOpen] = createSignal(false, {
    ownedWrite: true,
  });
  const [sendOpen, setSendOpen] = createSignal(false, { ownedWrite: true });

  createEffect(
    () =>
      `${props.walletAddress ?? ""}:${props.chainSections.map((section) => section.title).join(",")}`,
    () => {
      setReceiveOpen(false);
      setSendOpen(false);
    },
  );

  const openReceive = () => {
    if (props.renderReceiveSheet) setReceiveOpen(true);
    view().actions.receive.onSelect?.();
  };
  const openSend = () => {
    if (props.renderSendSheet) setSendOpen(true);
    view().actions.send.onSelect?.();
  };
  const receiveSheet = createMemo(() =>
    props.renderReceiveSheet?.({
      open: receiveOpen(),
      onOpenChange: setReceiveOpen,
    }),
  );
  const sendSheet = createMemo(() =>
    props.renderSendSheet?.({ open: sendOpen(), onOpenChange: setSendOpen }),
  );

  return (
    <div
      class="mx-auto flex w-full max-w-[640px] flex-col gap-4"
      data-variant={props.variant ?? "route"}
      data-wallet-hub
    >
      <header class="flex flex-wrap items-center justify-between gap-3">
        <Type variant="h2" as="h1">
          {view().title}
        </Type>
        <div class="flex items-center gap-2">
          <span class="inline-flex items-center gap-1.5 text-base text-muted-foreground">
            <IconWallet class="size-[18px]" />
            {view().walletLabel}
          </span>
          <Show when={props.showChangeWalletAction !== false}>
            <Button
              variant="ghost"
              size="sm"
              disabled={view().actions.changeWallet.disabled}
              loading={view().actions.changeWallet.pending}
              onClick={() => view().actions.changeWallet.onSelect?.()}
            >
              {props.changeWalletLabel ?? view().actions.changeWallet.label}
            </Button>
          </Show>
        </div>
      </header>

      <Card>
        <CardHeader>
          <Type variant="overline">Total balance</Type>
          <Type variant="display" as="p" class="break-all">
            {view().totalBalanceLabel ?? "—"}
          </Type>
        </CardHeader>
        <CardContent class="flex gap-3">
          <Button
            class="flex-1"
            leadingIcon={<IconArrowDown class="size-[18px]" />}
            disabled={view().actions.receive.disabled}
            onClick={openReceive}
          >
            {view().actions.receive.label}
          </Button>
          <Show when={props.onSend || props.renderSendSheet}>
            <Button
              class="flex-1"
              variant="outline"
              leadingIcon={<IconArrowUp class="size-[18px]" />}
              disabled={view().actions.send.disabled}
              onClick={openSend}
            >
              {view().actions.send.label}
            </Button>
          </Show>
        </CardContent>
      </Card>

      <Show when={view().claim}>
        {(claim) => (
          <Card>
            <CardContent class="flex items-center justify-between gap-3 p-6">
              <div class="flex min-w-0 flex-col">
                <Type variant="overline">Claimable royalties</Type>
                <Type variant="body-strong">{claim().amountLabel}</Type>
                <Show when={claim().supportingLabel}>
                  {(supporting) => (
                    <Type variant="caption">{supporting()}</Type>
                  )}
                </Show>
              </div>
              <Button
                disabled={claim().action.disabled}
                loading={claim().action.pending}
                onClick={() => claim().action.onSelect?.()}
              >
                {claim().action.label}
              </Button>
            </CardContent>
          </Card>
        )}
      </Show>

      <Show when={view().rewards}>
        {(rewards) => (
          <Card>
            <CardContent class="flex items-center justify-between gap-3 p-6">
              <div class="flex min-w-0 flex-col">
                <Type variant="overline">Rewards</Type>
                <Type variant="body-strong">
                  {rewards().amountLabel} {rewards().assetLabel}
                </Type>
                <Show when={rewards().supportingLabel}>
                  {(supporting) => (
                    <Type variant="caption">{supporting()}</Type>
                  )}
                </Show>
              </div>
              <Show when={rewards().action}>
                {(action) => (
                  <Button
                    variant="secondary"
                    disabled={action().disabled}
                    loading={action().pending}
                    onClick={() => action().onSelect?.()}
                  >
                    {action().label}
                  </Button>
                )}
              </Show>
            </CardContent>
          </Card>
        )}
      </Show>

      <Card>
        <CardHeader>
          <Type as="h2" variant="h3">
            Assets
          </Type>
        </CardHeader>
        <CardContent class="flex flex-col gap-4">
          <Show
            when={!view().isEmpty}
            fallback={
              <Type variant="caption">
                {props.assetsUnavailable
                  ? "Balances are unavailable. You can still receive tokens to your selected profile wallet."
                  : view().connected
                    ? "No assets yet. Receive tokens to get started."
                    : "Connect a wallet to see your assets."}
              </Type>
            }
          >
            <For each={view().readySections}>
              {(section) => (
                <ChainSection
                  section={section}
                  fiatByTokenId={view().fiatByTokenId}
                  renderAssetSupplement={props.renderAssetSupplement}
                />
              )}
            </For>
          </Show>
          <For each={view().laterSections}>
            {(section) => (
              <ChainSection
                section={section}
                fiatByTokenId={view().fiatByTokenId}
                renderAssetSupplement={props.renderAssetSupplement}
              />
            )}
          </For>
        </CardContent>
      </Card>

      {receiveSheet()}
      {sendSheet()}
    </div>
  );
}
