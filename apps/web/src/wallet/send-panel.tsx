import { createSignal, Show, onSettled, onCleanup } from "solid-js";
import { Button, Card, CardContent, CardHeader, Type } from "../ui.ts";
import { openRewardWallet } from "../live/reward-wallet.ts";
import type { RewardWalletView } from "../../../../packages/rewards/contracts.ts";
import type { WalletSendAdapterV1 } from "./contracts.ts";
import {
  browserSendLock,
  readHostedSend,
  sendHostedReward,
  type HostedSendRecord,
} from "./hosted-send.ts";
import { QuotedSendPanel } from "./quoted-send-panel.tsx";

export interface WalletSendPanelProps {
  view: RewardWalletView;
  adapter?: WalletSendAdapterV1;
  send?: (view: RewardWalletView) => Promise<void>;
  onClose: () => void;
}
/** No route/global CSS ownership. Lane 7's adapter is an explicit optional capability. */
export function WalletSendPanel(props: WalletSendPanelProps) {
  return (
    <Card aria-label="Send dollars">
      <CardHeader>
        <Type as="h2" variant="h3">
          Send
        </Type>
      </CardHeader>
      <CardContent class="flex flex-col gap-3">
        <Show
          when={props.adapter}
          fallback={<HostedSend view={props.view} send={props.send} />}
        >
          {(adapter) => (
            <QuotedSendPanel view={props.view} adapter={adapter()} />
          )}
        </Show>
        <Button variant="ghost" onClick={props.onClose}>
          Close Send
        </Button>
      </CardContent>
    </Card>
  );
}
function HostedSend(props: {
  view: RewardWalletView;
  send?: WalletSendPanelProps["send"];
}) {
  const controller = new AbortController();
  const [saved, setSaved] = createSignal<HostedSendRecord | null>(null),
    [busy, setBusy] = createSignal(false),
    [ready, setReady] = createSignal(false),
    [notice, setNotice] = createSignal("");
  function load() {
    try {
      setSaved(readHostedSend(props.view, localStorage));
      setReady(true);
    } catch (error) {
      setNotice(message(error));
      setReady(false);
    }
  }
  onSettled(() => {
    void Promise.resolve().then(load);
  });
  // Another tab can dispatch while this panel is visible; read again under the lock at dispatch.
  const storageChanged = () => load();
  window.addEventListener("storage", storageChanged);
  onCleanup(() => {
    controller.abort();
    window.removeEventListener("storage", storageChanged);
  });
  async function send() {
    if (busy()) return;
    setBusy(true);
    setNotice("");
    try {
      if (props.send) await props.send(props.view);
      else {
        const result = await sendHostedReward(
          props.view,
          localStorage,
          browserSendLock(),
          undefined,
          controller.signal,
        );
        setNotice(
          result.outcome === "cancelled"
            ? "Send declined. No new transfer was requested."
            : "Check this Send in MOSS history before sending again. A wallet response alone does not confirm payment.",
        );
      }
    } catch (error) {
      setNotice(message(error));
    } finally {
      load();
      setBusy(false);
    }
  }
  return (
    <>
      <Type as="p">
        Choose a recipient and amount in MOSS. Review the exact amount they
        receive and the fee before approval.
      </Type>
      <Type as="p" variant="caption">
        MOSS can pay gas in USDm when you have no ETH. Max reserves a fee
        allowance; unused allowance returns to your wallet. On small balances
        this can leave much less to send than expected.
      </Type>
      <Show when={saved()}>
        {(record) => (
          <>
            <Type as="p" role="status">
              Previous Send{" "}
              {record().outcome === "submitted"
                ? "submitted"
                : "needs checking"}
              . It will not be repeated automatically.
            </Type>
            <Show when={record().hash}>
              <Type as="p" class="break-all">
                Transaction to check: {record().hash}
              </Type>
            </Show>
          </>
        )}
      </Show>
      <Button
        disabled={busy() || !ready() || !!saved()}
        onClick={() => void send()}
      >
        Continue in MOSS
      </Button>
      <Button
        variant="outline"
        disabled={busy()}
        onClick={() => {
          if (busy()) return;
          setBusy(true);
          void openRewardWallet(props.view)
            .catch((error) => setNotice(message(error)))
            .finally(() => setBusy(false));
        }}
      >
        Open MOSS history
      </Button>
      <Show when={notice()}>
        <Type as="p" role="status">
          {notice()}
        </Type>
      </Show>
    </>
  );
}
function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : "This step could not complete. Check the same Send before retrying.";
}
