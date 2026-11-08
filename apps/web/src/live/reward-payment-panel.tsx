import { createSignal, For, Show } from "solid-js";
import { Button, Card, CardContent, CardHeader, Type } from "../ui.ts";
import { dollars, signRewardPayment } from "./reward-wallet.ts";
import type { RewardPayment } from "../../../../packages/rewards/contracts.ts";
import type { RewardsData } from "./rewards-data.ts";
export interface RewardSelection {
  payment: RewardPayment;
  action: "pay" | "cancel";
}
export function RewardPaymentPanel(props: {
  selected: RewardSelection | null;
  onSelect: (selection: RewardSelection | null) => void;
  payments: RewardPayment[];
  busy: boolean;
  data: RewardsData;
  run: (work: () => Promise<void>) => Promise<void>;
  sign?: typeof signRewardPayment;
}) {
  const [notice, setNotice] = createSignal("");
  async function sign() {
    const selected = props.selected;
    if (!selected) return;
    const { payment, action } = selected,
      attemptId = crypto.randomUUID();
    try {
      const result = await (props.sign ?? signRewardPayment)(
        payment,
        action,
        attemptId,
        () =>
          props.data.operation<RewardPayment>(
            `/payments/${payment.paymentId}/dispatch`,
            { action, attemptId },
          ),
      );
      await props.data.operation(`/payments/${payment.paymentId}/outcome`, {
        attemptId,
        ...result,
      });
      setNotice(
        result.outcome === "cancelled"
          ? "Wallet approval declined. Review this same payment to retry, or cancel its nonce through the wallet."
          : result.outcome === "approved"
            ? "Checking the account's payment proof."
            : "Wallet response is uncertain. Check the account proof, retry this guarded payment, or cancel its nonce through the wallet.",
      );
    } finally {
      props.onSelect(null);
    }
  }
  const active = (p: RewardPayment) =>
    !["confirmed", "cancelled"].includes(p.state);
  return (
    <>
      <Show when={notice()}>
        <Type as="p" role="status">
          {notice()}
        </Type>
      </Show>
      <Show when={props.selected}>
        {(selected) => (
          <Card>
            <CardHeader>
              <Type as="h2" variant="h3">
                {selected().action === "pay"
                  ? "Review payment"
                  : "Review cancellation"}
              </Type>
            </CardHeader>
            <CardContent class="flex flex-col gap-3">
              <Type as="p" variant="h2">
                {dollars(
                  selected().payment.amountAtomic,
                  selected().payment.decimals,
                )}
              </Type>
              <Type as="p" class="break-all">
                To: {selected().payment.recipient}
              </Type>
              <Type as="p" class="break-all">
                From: {selected().payment.sender}
              </Type>
              <Type as="p" class="break-all">
                Token: {selected().payment.token} · Chain:{" "}
                {selected().payment.chainId}
              </Type>
              <Type as="p">
                {selected().action === "pay"
                  ? "Approve the account batch containing the payment guard and this exact transfer. Repeating this same guarded payment can pay only once."
                  : "Approve the account batch that invalidates this payment's nonce. Its unpaid credits return to the queue only after the on-chain proof is checked."}
              </Type>
              <details>
                <summary>Account call details</summary>
                <Type as="p" class="break-all">
                  Payment: {selected().payment.paymentId}
                </Type>
                <Type as="p" class="break-all">
                  Frozen nonce: {selected().payment.guardNonce}
                </Type>
              </details>
              <Button
                disabled={props.busy}
                onClick={() => void props.run(sign)}
              >
                {selected().action === "pay"
                  ? "Approve in wallet"
                  : "Confirm cancellation in wallet"}
              </Button>
              <Show when={!selected().payment.everDispatched}>
                <Button
                  variant="outline"
                  disabled={props.busy}
                  onClick={() =>
                    void props.run(async () => {
                      await props.data.operation(
                        `/payments/${selected().payment.paymentId}/cancel`,
                        {},
                      );
                      props.onSelect(null);
                    })
                  }
                >
                  Cancel prepared payment
                </Button>
              </Show>
              <Button
                variant="ghost"
                disabled={props.busy}
                onClick={() => props.onSelect(null)}
              >
                Close review
              </Button>
            </CardContent>
          </Card>
        )}
      </Show>
      <Card>
        <CardHeader>
          <Type as="h2" variant="h3">
            Recorded payments
          </Type>
        </CardHeader>
        <CardContent class="flex flex-col gap-5">
          <For each={props.payments}>
            {(payment) => (
              <div class="flex flex-col gap-2 border-t border-border-soft pt-3">
                <Type as="p">
                  {dollars(payment.amountAtomic, payment.decimals)} ·{" "}
                  {payment.state.replaceAll("_", " ")}
                </Type>
                <Type as="p" class="break-all">
                  {payment.recipient}
                </Type>
                <Type as="p" variant="caption">
                  {payment.paymentId}
                </Type>
                <Show when={payment.transactionHash}>
                  <Type as="p" class="break-all">
                    Confirmed transaction: {payment.transactionHash}
                  </Type>
                </Show>
                <Show when={active(payment)}>
                  <Button
                    variant="outline"
                    disabled={props.busy}
                    onClick={() =>
                      void props.run(async () => {
                        await props.data.operation(
                          `/payments/${payment.paymentId}/reconcile`,
                          {},
                        );
                      })
                    }
                  >
                    Check account proof
                  </Button>
                  <Button
                    variant="outline"
                    disabled={props.busy}
                    onClick={() => props.onSelect({ payment, action: "pay" })}
                  >
                    {payment.everDispatched
                      ? "Review guarded retry"
                      : "Review payment"}
                  </Button>
                  <Show
                    when={payment.everDispatched}
                    fallback={
                      <Button
                        variant="ghost"
                        disabled={props.busy}
                        onClick={() =>
                          void props.run(async () => {
                            await props.data.operation(
                              `/payments/${payment.paymentId}/cancel`,
                              {},
                            );
                          })
                        }
                      >
                        Cancel prepared payment
                      </Button>
                    }
                  >
                    <Button
                      variant="outline"
                      disabled={props.busy}
                      onClick={() =>
                        props.onSelect({ payment, action: "cancel" })
                      }
                    >
                      Cancel through wallet
                    </Button>
                  </Show>
                </Show>
                <Show when={payment.attempts.length}>
                  <details>
                    <summary>
                      Recent wallet attempts ({payment.attempts.length})
                    </summary>
                    <For each={payment.attempts}>
                      {(attempt) => (
                        <div class="pt-2">
                          <Type as="p">
                            {attempt.action} · {attempt.outcome}
                          </Type>
                          <Type as="p" class="break-all">
                            {attempt.transactionHash ??
                              "No transaction hash received"}
                          </Type>
                        </div>
                      )}
                    </For>
                  </details>
                </Show>
              </div>
            )}
          </For>
        </CardContent>
      </Card>
    </>
  );
}
