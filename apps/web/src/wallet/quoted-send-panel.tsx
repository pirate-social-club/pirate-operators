import { createSignal, Show, onSettled, onCleanup } from "solid-js";
import { Button, Type } from "../ui.ts";
import {
  dollars,
  dollarInput,
  signRewardPayment,
} from "../live/reward-wallet.ts";
import type { RewardWalletView } from "../../../../packages/rewards/contracts.ts";
import type { WalletSendAdapterV1, WalletSendIntentV1 } from "./contracts.ts";
import {
  sameSendIntent,
  sameSendQuote,
  sendRecipient,
  validateSendIntent,
  validateSendQuote,
} from "./quoted-send.ts";
const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "This step could not complete. Check the same Send before retrying.";
export function QuotedSendPanel(props: {
  view: RewardWalletView;
  adapter: WalletSendAdapterV1;
}) {
  const [recipient, setRecipient] = createSignal(""),
    [amount, setAmount] = createSignal(""),
    [intent, setIntent] = createSignal<WalletSendIntentV1 | null>(null),
    [busy, setBusy] = createSignal(false),
    [ready, setReady] = createSignal(false),
    [notice, setNotice] = createSignal("Loading Send status…");
  let stopped = false;
  onCleanup(() => {
    stopped = true;
  });
  async function run(work: () => Promise<void>) {
    if (busy()) return;
    setBusy(true);
    setNotice("");
    try {
      await work();
    } catch (error) {
      if (!stopped) setNotice(message(error));
    } finally {
      if (!stopped) setBusy(false);
    }
  }
  async function load() {
    if (props.adapter.schema !== "pirate.wallet-send-adapter/1")
      throw Error("Send is unavailable here.");
    const next = await props.adapter.current(props.view);
    if (!stopped) {
      setIntent(next ? validateSendIntent(props.view, next) : null);
      setReady(true);
    }
  }
  onSettled(() => {
    void Promise.resolve().then(() => run(load));
  });
  async function prepare(max: boolean) {
    const to = sendRecipient(recipient(), props.view),
      requested = max ? "max" : dollarInput(amount(), props.view.decimals);
    const quote = validateSendQuote(
      props.view,
      await props.adapter.quote(props.view, {
        recipient: to,
        amountAtomic: requested,
      }),
    );
    if (
      quote.recipient.toLowerCase() !== to ||
      (requested !== "max" && quote.amountAtomic !== requested)
    )
      throw Error(
        "The quoted recipient or amount changed. Review a fresh quote.",
      );
    if (stopped) return;
    // A lost prepare response might already have reserved an intent on the server.
    // Force a status read before another quote/prepare can be attempted.
    setReady(false);
    const next = validateSendIntent(
      props.view,
      await props.adapter.prepare(quote),
    );
    if (!sameSendQuote(next.quote, quote))
      throw Error("The prepared quote changed. Check Send status.");
    if (!stopped) {
      setIntent(next);
      setReady(true);
    }
  }
  async function approve(action: "pay" | "cancel" = "pay") {
    const current = intent();
    if (!current) return;
    validateSendIntent(props.view, current);
    const attemptId = crypto.randomUUID(),
      id = current.payment.paymentId;
    const result = await signRewardPayment(
      current.payment,
      action,
      attemptId,
      async () => {
        if (stopped) throw Error("Send was closed before dispatch.");
        const next = sameSendIntent(
          props.view,
          current,
          await props.adapter.begin(id, attemptId, action),
        );
        if (stopped)
          throw Error(
            "Send was closed before dispatch. Check this Send before retrying.",
          );
        if (!stopped) setIntent(next);
        return next.payment;
      },
      undefined,
      { maxGasAllowanceWei: current.quote.maxGasAllowanceWei },
    );
    const next = sameSendIntent(
      props.view,
      current,
      await props.adapter.outcome(id, attemptId, result),
    );
    if (!stopped) {
      setIntent(next);
      setNotice(
        result.outcome === "cancelled"
          ? "Approval declined. This same guarded Send is safe to review again."
          : "Check the chain proof for this same Send. It cannot pay twice.",
      );
    }
  }
  const field =
    "w-full min-w-0 rounded border border-border-soft bg-transparent p-2";
  return (
    <>
      <Show when={ready() && !intent()}>
        <form
          class="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => prepare(false));
          }}
        >
          <label class="flex flex-col gap-2">
            Recipient wallet address
            <input
              required
              class={field}
              value={recipient()}
              onInput={(e) => setRecipient(e.currentTarget.value)}
              autocomplete="off"
              spellcheck={false}
            />
          </label>
          <label class="flex flex-col gap-2">
            Amount, dollars
            <input
              required
              class={field}
              value={amount()}
              onInput={(e) => setAmount(e.currentTarget.value)}
              inputmode="decimal"
              autocomplete="off"
            />
          </label>
          <Button
            variant="outline"
            type="button"
            disabled={busy()}
            onClick={() => void run(() => prepare(true))}
          >
            Max
          </Button>
          <Button type="submit" disabled={busy()}>
            Review Send
          </Button>
        </form>
      </Show>
      <Show when={intent()}>
        {(current) => (
          <>
            <Type as="h3" variant="h3">
              Review Send
            </Type>
            <Type as="p">
              Recipient receives{" "}
              {dollars(current().quote.amountAtomic, current().quote.decimals)}{" "}
              test USDm.
            </Type>
            <Type as="p" class="break-all">
              To: {current().quote.recipient}
            </Type>
            <Type as="p" class="break-all" variant="caption">
              MegaETH testnet 6343 · Token: {current().quote.token}
            </Type>
            <Type as="p">
              Fee reserve:{" "}
              {dollars(
                current().quote.fee.reserveAtomic,
                current().quote.fee.decimals,
              ).slice(1)}{" "}
              {current().quote.fee.symbol}. Unused reserve returns to your
              wallet.
            </Type>
            <Show when={current().quote.fee.estimatedAtomic !== null}>
              <Type as="p" variant="caption">
                Estimated fee:{" "}
                {dollars(
                  current().quote.fee.estimatedAtomic!,
                  current().quote.fee.decimals,
                ).slice(1)}{" "}
                {current().quote.fee.symbol}. The final fee comes from the
                confirmed receipt.
              </Type>
            </Show>
            <Type as="p" role="status">
              Send {current().payment.state.replaceAll("_", " ")}.
            </Type>
            <Show when={current().payment.transactionHash}>
              <Type as="p" class="break-all">
                Transaction: {current().payment.transactionHash}
              </Type>
            </Show>
            <Show
              when={
                !["confirmed", "cancelled"].includes(current().payment.state)
              }
            >
              <Button
                disabled={busy()}
                onClick={() => void run(() => approve())}
              >
                {current().payment.everDispatched
                  ? "Review same guarded Send"
                  : "Approve Send in wallet"}
              </Button>
              <Button
                variant="outline"
                disabled={busy()}
                onClick={() =>
                  void run(async () => {
                    const next = sameSendIntent(
                      props.view,
                      current(),
                      await props.adapter.reconcile(
                        current().payment.paymentId,
                      ),
                    );
                    if (!stopped) setIntent(next);
                  })
                }
              >
                Check Send status
              </Button>
              <Show when={current().payment.everDispatched}>
                <Type as="p" variant="caption">
                  To stop an unresolved Send, approve cancellation of its nonce
                  in MOSS, then check its chain proof. An earlier completed
                  payment remains paid.
                </Type>
                <Button
                  variant="outline"
                  disabled={busy()}
                  onClick={() => void run(() => approve("cancel"))}
                >
                  Cancel Send through wallet
                </Button>
              </Show>
              <Show when={!current().payment.everDispatched}>
                <Button
                  variant="ghost"
                  disabled={busy()}
                  onClick={() =>
                    void run(async () => {
                      const next = sameSendIntent(
                        props.view,
                        current(),
                        await props.adapter.cancel(current().payment.paymentId),
                      );
                      if (next.payment.state !== "cancelled")
                        throw Error(
                          "Cancellation is not confirmed. Check this Send.",
                        );
                      if (!stopped) setIntent(null);
                    })
                  }
                >
                  Cancel prepared Send
                </Button>
              </Show>
            </Show>
            <Show
              when={["confirmed", "cancelled"].includes(
                current().payment.state,
              )}
            >
              <Button
                variant="outline"
                disabled={busy()}
                onClick={() => {
                  setIntent(null);
                  setAmount("");
                  setNotice("");
                }}
              >
                New Send
              </Button>
            </Show>
          </>
        )}
      </Show>
      <Show when={!ready()}>
        <Button
          variant="outline"
          disabled={busy()}
          onClick={() => void run(load)}
        >
          Refresh Send status
        </Button>
      </Show>
      <Show when={notice()}>
        <Type as="p" role="status">
          {notice()}
        </Type>
      </Show>
    </>
  );
}
