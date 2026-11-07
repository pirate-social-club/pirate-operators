import { createMemo, createSignal, For, Show, onSettled } from "solid-js";
import { Button, Card, CardContent, CardHeader, Type } from "../ui.ts";
import {
  rewardsData,
  type RewardOperatorView,
  type RewardsData,
} from "./rewards-data.ts";
import { dollars, dollarInput, signRewardPayment } from "./reward-wallet.ts";
import type { RewardPayment } from "../../../../packages/rewards/contracts.ts";

const field =
  "w-full rounded border border-border-soft bg-transparent p-2 text-foreground";
const localTime = (ms: number) => {
  const d = new Date(
    ms - Date.prototype.getTimezoneOffset.call(new Date(ms)) * 60000,
  );
  return d.toISOString().slice(0, 16);
};
export function LiveRewardOperator(props: {
  csrf: string;
  onExit: () => void;
  data?: RewardsData;
  sign?: typeof signRewardPayment;
}) {
  const data = props.data ?? rewardsData(props.csrf);
  const [view, setView] = createSignal<RewardOperatorView | null>(null),
    [busy, setBusy] = createSignal(false),
    [notice, setNotice] = createSignal("Loading reward operations…"),
    [selected, setSelected] = createSignal<RewardPayment | null>(null);
  const [purchase, setPurchase] = createSignal(""),
    [tickets, setTickets] = createSignal(""),
    [drawing, setDrawing] = createSignal(""),
    [song, setSong] = createSignal(""),
    [opens, setOpens] = createSignal(localTime(Date.now() + 120000)),
    [cutoff, setCutoff] = createSignal(localTime(Date.now() + 3600000));
  const [fundHash, setFundHash] = createSignal(""),
    [fundLog, setFundLog] = createSignal("0"),
    [fundKind, setFundKind] = createSignal("prefunding"),
    [sourceHash, setSourceHash] = createSignal(""),
    [sourceAmount, setSourceAmount] = createSignal("0"),
    [fee, setFee] = createSignal("0");
  const [claimHashes, setClaimHashes] = createSignal<Record<string, string>>(
      {},
    ),
    [paymentHashes, setPaymentHashes] = createSignal<Record<string, string>>(
      {},
    );
  async function refresh() {
    const next = await data.operator();
    setView(next);
    if (!song() && next.songs.length) setSong(next.songs[0].songKey);
  }
  async function run(action: () => Promise<void>) {
    if (busy()) return;
    setBusy(true);
    setNotice("");
    try {
      await action();
      await refresh();
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "The operation could not complete.",
      );
    } finally {
      setBusy(false);
    }
  }
  onSettled(() => {
    void Promise.resolve().then(() => run(refresh));
  });
  const ready = createMemo(() => {
    const rows = new Map<
      string,
      { accountId: string; wallet: string; amount: bigint; credits: number }
    >();
    for (const c of view()?.ready ?? []) {
      const row = rows.get(c.account_id) ?? {
        accountId: c.account_id,
        wallet: c.wallet,
        amount: 0n,
        credits: 0,
      };
      row.amount += BigInt(c.amount_atomic);
      row.credits++;
      rows.set(c.account_id, row);
    }
    return [...rows.values()];
  });
  async function sign() {
    const payment = selected();
    if (!payment) return;
    try {
      const hash = await (props.sign ?? signRewardPayment)(payment, () =>
        data.operation<RewardPayment>(
          `/payments/${payment.paymentId}/dispatch`,
          {},
        ),
      );
      await data.operation(`/payments/${payment.paymentId}/transaction`, {
        hash,
      });
      await data.operation(`/payments/${payment.paymentId}/reconcile`, {});
      setSelected(null);
    } catch {
      setSelected(null);
      setNotice(
        "Check this payment's recorded status. If approval was requested, keep it pending until its transaction is reconciled. Do not send it again.",
      );
    }
    await refresh();
  }
  return (
    <main
      class="mx-auto flex w-full max-w-[900px] flex-col gap-4 p-6"
      data-reward-operator
    >
      <header class="flex items-center justify-between">
        <Type as="h1" variant="h2">
          Reward payments
        </Type>
        <Button variant="ghost" onClick={props.onExit}>
          Back
        </Button>
      </header>
      <Show when={notice()}>
        <Type as="p" role="status">
          {notice()}
        </Type>
      </Show>
      <Show when={view()}>
        {(current) => (
          <>
            <Type as="p">
              Testnet operations. No real-money payout is enabled.
            </Type>
            <Show when={current().simulatedWinnings}>
              <Type as="p">Drawing outcomes are simulated.</Type>
            </Show>
            <Card>
              <CardHeader>
                <Type as="h2" variant="h3">
                  Payout inventory
                </Type>
              </CardHeader>
              <CardContent>
                <Type as="p">
                  Received:{" "}
                  {dollars(
                    current().inventory.received_atomic,
                    current().decimals,
                  )}{" "}
                  · Reserved:{" "}
                  {dollars(
                    current().inventory.reserved_atomic,
                    current().decimals,
                  )}{" "}
                  · Paid:{" "}
                  {dollars(current().inventory.paid_atomic, current().decimals)}
                </Type>
                <Type as="p" class="break-all">
                  Dedicated payout account: {current().payoutWallet}
                </Type>
                <Type as="p">
                  Observed balance:{" "}
                  {current().observedBalanceAtomic === null
                    ? "Unavailable"
                    : dollars(
                        current().observedBalanceAtomic!,
                        current().decimals,
                      )}{" "}
                  · Recorded network costs:{" "}
                  {dollars(current().inventory.cost_atomic, current().decimals)}
                </Type>
                <Button
                  variant="outline"
                  disabled={busy()}
                  onClick={() =>
                    void run(async () => {
                      await data.operation("/audit", {});
                    })
                  }
                >
                  Audit outgoing transfers
                </Button>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <Type as="h2" variant="h3">
                  Ready claims
                </Type>
              </CardHeader>
              <CardContent class="flex flex-col gap-3">
                <Show
                  when={ready().length}
                  fallback={
                    <Type as="p">No verified claims awaiting preparation.</Type>
                  }
                >
                  <For each={ready()}>
                    {(row) => (
                      <div class="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <Type as="p" class="break-all">
                            {row.wallet}
                          </Type>
                          <Type as="p">
                            {dollars(row.amount.toString(), current().decimals)}{" "}
                            across {row.credits} credits
                          </Type>
                        </div>
                        <Button
                          disabled={busy() || current().unmatched.length > 0}
                          onClick={() =>
                            void run(async () => {
                              setSelected(
                                await data.operation<RewardPayment>(
                                  "/payments",
                                  {
                                    id: crypto.randomUUID(),
                                    accountId: row.accountId,
                                  },
                                ),
                              );
                            })
                          }
                        >
                          Prepare payment
                        </Button>
                      </div>
                    )}
                  </For>
                </Show>
              </CardContent>
            </Card>
            <Show when={current().unmatched.length > 0}>
              <Card>
                <CardHeader>
                  <Type as="h2" variant="h3">
                    Unmatched outgoing transfers
                  </Type>
                </CardHeader>
                <CardContent class="flex flex-col gap-4">
                  <Type as="p">
                    Reconcile payments or identify network costs before
                    preparing another payment.
                  </Type>
                  <For each={current().unmatched}>
                    {(event) => (
                      <div class="flex flex-col gap-2">
                        <Type as="p">
                          {dollars(event.amountAtomic, current().decimals)}
                        </Type>
                        <Type as="p" class="break-all">
                          To: {event.recipient}
                        </Type>
                        <Type as="p" class="break-all">
                          Transaction: {event.transactionHash} · Log:{" "}
                          {event.logIndex}
                        </Type>
                        <Button
                          variant="outline"
                          disabled={busy()}
                          onClick={() =>
                            void run(async () => {
                              await data.operation("/costs", {
                                id: crypto.randomUUID(),
                                hash: event.transactionHash,
                                logIndex: event.logIndex,
                              });
                            })
                          }
                        >
                          Record as network cost
                        </Button>
                      </div>
                    )}
                  </For>
                </CardContent>
              </Card>
            </Show>
            <Show when={selected()}>
              {(payment) => (
                <Card>
                  <CardHeader>
                    <Type as="h2" variant="h3">
                      Review payment
                    </Type>
                  </CardHeader>
                  <CardContent class="flex flex-col gap-3">
                    <Type as="p" variant="h2">
                      {dollars(payment().amountAtomic, payment().decimals)}
                    </Type>
                    <Type as="p" class="break-all">
                      To: {payment().recipient}
                    </Type>
                    <Type as="p" class="break-all">
                      From: {payment().sender}
                    </Type>
                    <Type as="p" class="break-all">
                      Token: {payment().token} · Chain: {payment().chainId}
                    </Type>
                    <Type as="p">
                      Check the same recipient and amount in the wallet
                      approval. This payment covers {payment().creditIds.length}{" "}
                      credits.
                    </Type>
                    <Button disabled={busy()} onClick={() => void run(sign)}>
                      Approve in wallet
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy()}
                      onClick={() =>
                        void run(async () => {
                          await data.operation(
                            `/payments/${payment().paymentId}/cancel`,
                            {},
                          );
                          setSelected(null);
                        })
                      }
                    >
                      Cancel prepared payment
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
                <For each={current().payments}>
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
                          Transaction: {payment.transactionHash}
                        </Type>
                        <Button
                          variant="outline"
                          disabled={busy()}
                          onClick={() =>
                            void run(async () => {
                              await data.operation(
                                `/payments/${payment.paymentId}/reconcile`,
                                {},
                              );
                            })
                          }
                        >
                          Check payment
                        </Button>
                      </Show>
                      <Show when={payment.state === "prepared"}>
                        <Button
                          variant="outline"
                          disabled={busy()}
                          onClick={() => setSelected(payment)}
                        >
                          Review payment
                        </Button>
                        <Button
                          variant="ghost"
                          disabled={busy()}
                          onClick={() =>
                            void run(async () => {
                              await data.operation(
                                `/payments/${payment.paymentId}/cancel`,
                                {},
                              );
                            })
                          }
                        >
                          Cancel prepared payment
                        </Button>
                      </Show>
                      <Show
                        when={
                          payment.state === "awaiting_signature" ||
                          payment.state === "review_required"
                        }
                      >
                        <Type as="p">
                          Submission is unresolved. Attach the exact transaction
                          from wallet history to reconcile it.
                        </Type>
                        <input
                          aria-label={`Transaction for ${payment.paymentId}`}
                          class={field}
                          value={paymentHashes()[payment.paymentId] ?? ""}
                          onInput={(e) =>
                            setPaymentHashes({
                              ...paymentHashes(),
                              [payment.paymentId]: e.currentTarget.value,
                            })
                          }
                        />
                        <Button
                          disabled={busy()}
                          onClick={() =>
                            void run(async () => {
                              await data.operation(
                                `/payments/${payment.paymentId}/recover`,
                                { hash: paymentHashes()[payment.paymentId] },
                              );
                            })
                          }
                        >
                          Verify recovered transaction
                        </Button>
                      </Show>
                    </div>
                  )}
                </For>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <Type as="h2" variant="h3">
                  Reward participants
                </Type>
              </CardHeader>
              <CardContent class="flex flex-col gap-3">
                <Type as="p">
                  Approve one known reward account per participant before
                  opening an offer.
                </Type>
                <For each={current().participants}>
                  {(p) => (
                    <div class="flex flex-wrap items-center justify-between gap-3">
                      <Type as="p" class="break-all">
                        {p.wallet}
                      </Type>
                      <Show
                        when={p.approved_at === null}
                        fallback={<Type as="p">Approved</Type>}
                      >
                        <Button
                          variant="outline"
                          disabled={busy()}
                          onClick={() =>
                            void run(async () => {
                              await data.operation("/participants", {
                                wallet: p.wallet,
                              });
                            })
                          }
                        >
                          Approve participant
                        </Button>
                      </Show>
                    </div>
                  )}
                </For>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <Type as="h2" variant="h3">
                  Attach purchased tickets
                </Type>
              </CardHeader>
              <CardContent>
                <form
                  class="flex flex-col gap-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run(async () => {
                      await data.operation("/offers", {
                        offerId: crypto.randomUUID(),
                        drawingId: drawing(),
                        songKey: song(),
                        purchaseHash: purchase(),
                        ticketIds: tickets()
                          .split(",")
                          .map((x) => x.trim()),
                        opensAt: new Date(opens()).getTime(),
                        cutoffAt: new Date(cutoff()).getTime(),
                      });
                    });
                  }}
                >
                  <label class="flex flex-col gap-2">
                    Song
                    <select
                      class={field}
                      value={song()}
                      onChange={(e) => setSong(e.currentTarget.value)}
                    >
                      <For each={current().songs}>
                        {(s) => <option value={s.songKey}>{s.title}</option>}
                      </For>
                    </select>
                  </label>
                  <label class="flex flex-col gap-2">
                    Drawing number
                    <input
                      required
                      class={field}
                      value={drawing()}
                      onInput={(e) => setDrawing(e.currentTarget.value)}
                    />
                  </label>
                  <label class="flex flex-col gap-2">
                    Purchase transaction
                    <input
                      required
                      class={field}
                      value={purchase()}
                      onInput={(e) => setPurchase(e.currentTarget.value)}
                    />
                  </label>
                  <label class="flex flex-col gap-2">
                    Ticket IDs, separated by commas
                    <input
                      required
                      class={field}
                      value={tickets()}
                      onInput={(e) => setTickets(e.currentTarget.value)}
                    />
                  </label>
                  <label class="flex flex-col gap-2">
                    Entries open
                    <input
                      required
                      class={field}
                      type="datetime-local"
                      value={opens()}
                      onInput={(e) => setOpens(e.currentTarget.value)}
                    />
                  </label>
                  <label class="flex flex-col gap-2">
                    Entries close
                    <input
                      required
                      class={field}
                      type="datetime-local"
                      value={cutoff()}
                      onInput={(e) => setCutoff(e.currentTarget.value)}
                    />
                  </label>
                  <Button disabled={busy() || !song()} type="submit">
                    Attach tickets
                  </Button>
                </form>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <Type as="h2" variant="h3">
                  Drawing records
                </Type>
              </CardHeader>
              <CardContent class="flex flex-col gap-5">
                <For each={current().offers}>
                  {(offer) => (
                    <div class="flex flex-col gap-2">
                      <Type as="p">
                        Drawing {offer.drawingId} ·{" "}
                        {offer.state.replaceAll("_", " ")}
                      </Type>
                      <Type as="p" variant="caption">
                        {offer.offerId}
                      </Type>
                      <Show when={offer.state === "open"}>
                        <Button
                          variant="outline"
                          disabled={busy() || Date.now() < offer.cutoffAt}
                          onClick={() =>
                            void run(async () => {
                              await data.operation(
                                `/offers/${offer.offerId}/close`,
                                {},
                              );
                            })
                          }
                        >
                          Close entries
                        </Button>
                      </Show>
                      <Show when={offer.state === "closed"}>
                        <label class="flex flex-col gap-2">
                          Collection transaction, required for a win
                          <input
                            class={field}
                            value={claimHashes()[offer.offerId] ?? ""}
                            onInput={(e) =>
                              setClaimHashes({
                                ...claimHashes(),
                                [offer.offerId]: e.currentTarget.value,
                              })
                            }
                          />
                        </label>
                        <Button
                          variant="outline"
                          disabled={busy()}
                          onClick={() =>
                            void run(async () => {
                              await data.operation(
                                `/offers/${offer.offerId}/settle`,
                                {
                                  ...(claimHashes()[offer.offerId]
                                    ? {
                                        claimHash: claimHashes()[offer.offerId],
                                      }
                                    : {}),
                                },
                              );
                            })
                          }
                        >
                          Check settled winnings
                        </Button>
                      </Show>
                    </div>
                  )}
                </For>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <Type as="h2" variant="h3">
                  Record reserve funding
                </Type>
              </CardHeader>
              <CardContent>
                <form
                  class="flex flex-col gap-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run(async () => {
                      await data.operation("/funding", {
                        id: crypto.randomUUID(),
                        kind: fundKind(),
                        hash: fundHash(),
                        logIndex: Number(fundLog()),
                        sourceUsdcAtomic:
                          fundKind() === "prefunding"
                            ? "0"
                            : dollarInput(sourceAmount(), 6),
                        sourceTransactionHash:
                          fundKind() === "prefunding"
                            ? null
                            : sourceHash() || null,
                        feeUsdcAtomic:
                          fundKind() === "prefunding"
                            ? "0"
                            : dollarInput(fee(), 6),
                      });
                    });
                  }}
                >
                  <label class="flex flex-col gap-2">
                    Source
                    <select
                      class={field}
                      value={fundKind()}
                      onChange={(e) => setFundKind(e.currentTarget.value)}
                    >
                      <option value="prefunding">Prefunded reserve</option>
                      <option value="conversion">Manual conversion</option>
                    </select>
                  </label>
                  <label class="flex flex-col gap-2">
                    USDm incoming transaction
                    <input
                      required
                      class={field}
                      value={fundHash()}
                      onInput={(e) => setFundHash(e.currentTarget.value)}
                    />
                  </label>
                  <label class="flex flex-col gap-2">
                    Transfer log index
                    <input
                      required
                      class={field}
                      value={fundLog()}
                      onInput={(e) => setFundLog(e.currentTarget.value)}
                    />
                  </label>
                  <Show when={fundKind() === "conversion"}>
                    <label class="flex flex-col gap-2">
                      Base source transaction
                      <input
                        required
                        class={field}
                        value={sourceHash()}
                        onInput={(e) => setSourceHash(e.currentTarget.value)}
                      />
                    </label>
                    <label class="flex flex-col gap-2">
                      USDC input, dollars
                      <input
                        class={field}
                        value={sourceAmount()}
                        onInput={(e) => setSourceAmount(e.currentTarget.value)}
                      />
                    </label>
                    <label class="flex flex-col gap-2">
                      USDC conversion fee, dollars
                      <input
                        class={field}
                        value={fee()}
                        onInput={(e) => setFee(e.currentTarget.value)}
                      />
                    </label>
                  </Show>
                  <Button disabled={busy()} type="submit">
                    Verify incoming funds
                  </Button>
                </form>
              </CardContent>
            </Card>
          </>
        )}
      </Show>
      <Button
        variant="ghost"
        disabled={busy()}
        onClick={() => void run(refresh)}
      >
        Refresh records
      </Button>
    </main>
  );
}
