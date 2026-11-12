// Independently ported 2026-11-11; exact source/blob and adaptations: docs/v1-wallet-owner-parity-20261111.md.
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";

import {
  Button,
  cn,
  IconCheck,
  IconCopy,
  Modal,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  Type,
} from "./design-system.ts";
import {
  buildWalletReceiveSheetView,
  resolveReceiveChainId,
} from "./wallet-receive-sheet-view-model.ts";
import type { WalletReceiveSheetProps } from "./wallet-receive-sheet.types";
import type { WalletHubChainId } from "./wallet-hub.types";
import { ChainIcon } from "./wallet-visuals.tsx";

export function WalletReceiveSheet(props: WalletReceiveSheetProps) {
  const [selectedChainId, setSelectedChainId] = createSignal<
    WalletHubChainId | undefined
  >(resolveReceiveChainId(props));
  const [copied, setCopied] = createSignal(false);

  let wasOpen = false;
  let lastWalletAddress = props.walletAddress;
  createEffect(
    () => ({
      chainSections: props.chainSections,
      open: props.open,
      walletAddress: props.walletAddress,
    }),
    (next) => {
      const reset = !wasOpen || next.walletAddress !== lastWalletAddress;
      wasOpen = next.open;
      lastWalletAddress = next.walletAddress;
      if (!next.open) return;
      setSelectedChainId(
        resolveReceiveChainId(props, reset ? undefined : selectedChainId()),
      );
      setCopied(false);
    },
  );

  const view = createMemo(() =>
    buildWalletReceiveSheetView(props, selectedChainId()),
  );

  const selectChain = (chainId: WalletHubChainId) => {
    setCopied(false);
    setSelectedChainId(chainId);
  };

  const copyAddress = async () => {
    const address = view().address;
    if (!address || typeof navigator === "undefined" || !navigator.clipboard)
      return;
    try {
      await navigator.clipboard.writeText(address);
      // A late clipboard response for the old account cannot confirm the new address.
      if (props.open && view().address === address) setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  // Paper (Screens/Wallet/Portfolio 202, 204): a bottom sheet on a phone and
  // a 480px dialog on desktop, as Send and Claim open. The network list and
  // the full address carry the meaning, so there is no description line.
  return (
    <Modal
      forceMobile={props.forceMobile}
      open={props.open}
      onOpenChange={props.onOpenChange}
    >
      <ModalContent
        class="flex max-h-[88dvh] min-h-0 flex-col gap-4 overflow-y-auto md:w-[min(100%-2rem,480px)] md:max-w-[480px]"
        aria-label="Receive tokens"
        mobileSide="bottom"
      >
        <ModalHeader>
          <ModalTitle>Receive</ModalTitle>
        </ModalHeader>

        <ul class="flex flex-col gap-1" aria-label="Chains">
          <For each={view().chains}>
            {(chain) => (
              <li>
                <button
                  type="button"
                  class={cn(
                    "flex w-full items-center justify-between gap-3 rounded-[var(--radius-md)] px-3 py-2 text-start transition-colors",
                    chain.selected
                      ? "bg-primary-subtle text-primary-text"
                      : "hover:bg-muted",
                    chain.disabled && "cursor-not-allowed opacity-50",
                  )}
                  disabled={chain.disabled}
                  aria-pressed={chain.selected ? "true" : "false"}
                  onClick={() => selectChain(chain.chainId)}
                >
                  <span class="flex min-w-0 items-center gap-3">
                    <ChainIcon chainId={chain.chainId} class="size-8" />
                    <span class="flex min-w-0 flex-col">
                      <Type variant="body-strong">{chain.title}</Type>
                      <Show when={chain.note}>
                        {(note) => <Type variant="caption">{note()}</Type>}
                      </Show>
                    </span>
                  </span>
                  <Type variant="caption" class="shrink-0">
                    {chain.fiatLabel}
                  </Type>
                </button>
              </li>
            )}
          </For>
        </ul>

        <Show
          when={view().address}
          fallback={
            <Type variant="caption">
              {view().chains.some((chain) => !chain.disabled)
                ? "Choose a network to see its receive address."
                : "No address is available for the supported chains yet."}
            </Type>
          }
        >
          <div class="flex flex-col gap-2 rounded-[var(--radius-md)] border border-border-soft p-4">
            <Type variant="overline">{view().selectedTitle} address</Type>
            <Type variant="body" class="break-all font-mono">
              {view().addressLabel}
            </Type>
            <Button
              variant="outline"
              size="sm"
              class="self-start"
              leadingIcon={
                copied() ? (
                  <IconCheck class="size-4" />
                ) : (
                  <IconCopy class="size-4" />
                )
              }
              onClick={() => void copyAddress()}
            >
              {copied() ? "Copied" : "Copy address"}
            </Button>
          </div>
        </Show>

        <ModalFooter>
          <Button
            class="w-full"
            size="lg"
            variant="secondary"
            onClick={() => props.onOpenChange(false)}
          >
            Done
          </Button>
        </ModalFooter>
        <Show when={copied()}>
          <Type aria-live="polite" class="sr-only" variant="caption">
            Address copied
          </Type>
        </Show>
      </ModalContent>
    </Modal>
  );
}
