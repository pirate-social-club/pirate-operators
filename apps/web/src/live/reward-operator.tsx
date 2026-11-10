import {
  createMemo,
  createSignal,
  For,
  Show,
  onSettled,
  onCleanup,
} from "solid-js";
import { Button, Card, CardContent, CardHeader, Type } from "../ui.ts";
import {
  rewardsData,
  type RewardOperatorView,
  type RewardsData,
} from "./rewards-data.ts";
import { dollars, dollarInput, signRewardPayment } from "./reward-wallet.ts";
import {
  RewardPaymentPanel,
  type RewardSelection,
} from "./reward-payment-panel.tsx";
import { RewardOfferPanel } from "./reward-offer-panel.tsx";
import type { RewardPayment } from "../../../../packages/rewards/contracts.ts";

const field =
  "w-full rounded border border-border-soft bg-transparent p-2 text-foreground";
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
    [selected, setSelected] = createSignal<RewardSelection | null>(null);
  const [fundHash, setFundHash] = createSignal(""),
    [fundLog, setFundLog] = createSignal("0"),
    [fundKind, setFundKind] = createSignal("prefunding"),
    [sourceHash, setSourceHash] = createSignal(""),
    [sourceAmount, setSourceAmount] = createSignal("0"),
    [fee, setFee] = createSignal("0");
  let stopped = false,
    refreshing = false,
    refreshSerial = 0;
  const timer = setInterval(() => {
    if (
      busy() ||
      refreshing ||
      !view()?.offers.some((offer) => offer.state === "open")
    )
      return;
    refreshing = true;
    void refresh()
      .catch(() => {
        if (!stopped)
          setView((current) =>
            current ? { ...current, closeReadiness: undefined } : null,
          );
      })
      .finally(() => {
        refreshing = false;
      });
  }, 15000);
  onCleanup(() => {
    stopped = true;
    clearInterval(timer);
  });
  async function refresh() {
    const serial = ++refreshSerial;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const next = await Promise.race([
        data.operator(),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(
            () => reject(Error("Reward confirmation refresh timed out.")),
            15000,
          );
        }),
      ]);
      if (!stopped && serial === refreshSerial) setView(next);
    } finally {
      clearTimeout(deadline);
    }
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
          ? (error as Error & { code?: string }).code ===
            "reward_cutoff_not_confirmed"
            ? "Waiting for the chain to confirm the cutoff. Refresh in a few minutes; entries have not closed."
            : (error as Error & { code?: string }).code ===
                "reward_cutoff_not_reached"
              ? "Entries are still open until the cutoff."
              : error.message
          : "The operation could not complete.",
      );
    } finally {
      setBusy(false);
    }
  }
  onSettled(() => {
    void Promise.resolve().then(() => run(async () => {}));
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
                  · Prepared payments:{" "}
                  {dollars(
                    current().inventory.reserved_atomic,
                    current().decimals,
                  )}{" "}
                  · Paid:{" "}
                  {dollars(current().inventory.paid_atomic, current().decimals)}
                </Type>
                <Type as="p">
                  Unpaid learner winnings:{" "}
                  {dollars(current().liabilities.total, current().decimals)}.
                  Unclaimed:{" "}
                  {dollars(current().liabilities.unclaimed, current().decimals)}{" "}
                  · Held:{" "}
                  {dollars(current().liabilities.held, current().decimals)} ·
                  Verified, awaiting payment:{" "}
                  {dollars(current().liabilities.accepted, current().decimals)}.
                </Type>
                <Type as="p" variant="caption">
                  Unpaid winnings remain owed even when they are not yet funded
                  in this payout account.
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
                  · Recorded operator costs:{" "}
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
                              setSelected({
                                action: "pay",
                                payment: await data.operation<RewardPayment>(
                                  "/payments",
                                  {
                                    id: crypto.randomUUID(),
                                    accountId: row.accountId,
                                  },
                                ),
                              });
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
                    Reconcile payments or identify operator costs before
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
                          Record operator cost
                        </Button>
                      </div>
                    )}
                  </For>
                </CardContent>
              </Card>
            </Show>
            <RewardPaymentPanel
              selected={selected()}
              onSelect={setSelected}
              payments={current().payments}
              busy={busy()}
              data={data}
              run={run}
              sign={props.sign}
            />
            <RewardOfferPanel
              view={current()}
              data={data}
              busy={busy()}
              run={run}
            />
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
        onClick={() => void run(async () => {})}
      >
        Refresh records
      </Button>
    </main>
  );
}
