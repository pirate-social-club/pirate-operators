import { createSignal, Show, onCleanup, onSettled } from "solid-js";
import QRCode from "qrcode";
import { Button, Card, CardHeader, CardContent, Type } from "../ui.ts";
import type { RewardWalletView } from "../../../../packages/rewards/contracts.ts";
import { hostedSendKey } from "./hosted-send.ts";

export function WalletReceivePanel(props: {
  view: RewardWalletView;
  onClose: () => void;
}) {
  const [qr, setQr] = createSignal(""),
    [notice, setNotice] = createSignal("");
  let stopped = false;
  onCleanup(() => {
    stopped = true;
  });
  onSettled(() => {
    void Promise.resolve().then(async () => {
      try {
        hostedSendKey(props.view);
        const image = await QRCode.toDataURL(props.view.address, {
          width: 256,
          margin: 2,
        });
        if (!stopped) setQr(image);
      } catch {
        if (!stopped) setNotice("QR unavailable. Copy the address below.");
      }
    });
  });
  return (
    <Card aria-label="Receive dollars">
      <CardHeader>
        <Type as="h2" variant="h3">
          Receive
        </Type>
      </CardHeader>
      <CardContent class="flex flex-col gap-3">
        <Type as="p">Receive test USDm on MegaETH testnet (6343).</Type>
        <Type as="p" variant="caption">
          Use this exact network and token when sending to your wallet.
        </Type>
        <Show when={qr()}>
          <img
            src={qr()}
            width="256"
            height="256"
            alt="Your wallet address QR code"
          />
        </Show>
        <label class="flex flex-col gap-2">
          Your wallet address
          <input
            class="w-full min-w-0 rounded border border-border-soft bg-transparent p-2"
            readonly
            value={props.view.address}
            onFocus={(e) => e.currentTarget.select()}
          />
        </label>
        <Type as="p" variant="caption" class="break-all">
          Token contract: {props.view.token}
        </Type>
        <Button
          variant="outline"
          onClick={() =>
            void Promise.resolve()
              .then(() => navigator.clipboard.writeText(props.view.address))
              .then(
                () => setNotice("Address copied."),
                () =>
                  setNotice(
                    "Copy unavailable. Select the address and copy it manually.",
                  ),
              )
          }
        >
          Copy address
        </Button>
        <Show when={notice()}>
          <Type as="p" role="status">
            {notice()}
          </Type>
        </Show>
        <Button variant="ghost" onClick={props.onClose}>
          Close Receive
        </Button>
      </CardContent>
    </Card>
  );
}
