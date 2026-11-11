// Deferred test-only service ports. No real Very, session, wallet or financial action.
import { createSignal, Show } from "solid-js";
import { LiveRewardWallet } from "../src/live/rewards.tsx";
import { useRewardWalletController } from "../src/wallet/use-reward-wallet.ts";
import type { RewardsData } from "../src/live/rewards-data.ts";
import type {
  RewardCredit,
  RewardWalletView,
  VerificationIntent,
} from "../../../packages/rewards/contracts.ts";

export const verificationCreditId = "credit_0001";
type Controller = ReturnType<typeof useRewardWalletController>;
type Owner = "original" | "replacement";
type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
};
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function verificationPorts() {
  let owner: Owner = "original",
    controller: Controller | undefined;
  let accountChanges = 0,
    accepted = false,
    holdIntent = false,
    holdClaim = false;
  let holdWallet = false;
  const records = new Map<string, VerificationIntent & { owner: Owner }>();
  const polls: {
    id: string;
    pending: Deferred<VerificationIntent>;
    settled: boolean;
  }[] = [];
  const starts: {
    record: VerificationIntent;
    pending: Deferred<VerificationIntent>;
    settled: boolean;
  }[] = [];
  const claims: { id: string; owner: Owner }[] = [];
  const claimReplies: Deferred<Awaited<ReturnType<RewardsData["claim"]>>>[] =
    [];
  const walletReplies: Deferred<RewardWalletView>[] = [];
  const initialPoll = new Set<string>();
  const token = "0x" + "33".repeat(20);
  const wallet = (): RewardWalletView => ({
    schema: "pirate.learner-wallet/1",
    chainId: 6343,
    token,
    decimals: 18,
    address: "0x" + (owner === "original" ? "11" : "22").repeat(20),
    balanceAtomic: "30000000000000000",
    operator: false,
    practiceOnly: true,
    drawings: [],
  });
  const credit = (): RewardCredit => ({
    credit_id: verificationCreditId,
    offer_id: "offer_0001",
    account_id: "account_0001",
    chain_id: 6343,
    token_address: token,
    token_decimals: 18,
    amount_atomic: "30000000000000000",
    paid_atomic: "0",
    payment_id: null,
    claim: {
      status: accepted ? "accepted" : "unclaimed",
      payout_status: "awaiting_payment",
    },
  });
  const data: RewardsData = {
    wallet: async () => {
      if (!holdWallet) return wallet();
      const reply = deferred<RewardWalletView>();
      walletReplies.push(reply);
      return reply.promise;
    },
    credits: async () => (owner === "original" ? [credit()] : []),
    claim: async (id) => {
      claims.push({ id, owner });
      if (owner !== "original" || id !== verificationCreditId)
        throw Error("fixture-original-owner-required");
      const verified = [...records.values()].some(
        (r) => r.owner === owner && r.state === "verified",
      );
      if (verified) accepted = true;
      const result = {
        outcome: accepted
          ? ("accepted" as const)
          : ("verification_missing" as const),
        credit: credit(),
      };
      if (!holdClaim) return result;
      const reply = deferred<Awaited<ReturnType<RewardsData["claim"]>>>();
      claimReplies.push(reply);
      return reply.promise;
    },
    intent: async () => {
      const id = `intent_${String(records.size + 1).padStart(4, "0")}`;
      const record: VerificationIntent = {
        intent_id: id,
        state: "pending",
        expires_at: Date.now() + 300000,
        launch_url: `https://verify.example/fixture/${id}`,
      };
      records.set(id, { ...record, owner });
      if (!holdIntent) return record;
      const pending = deferred<VerificationIntent>();
      starts.push({ record, pending, settled: false });
      return pending.promise;
    },
    poll: async (id) => {
      const record = records.get(id);
      if (!record || record.owner !== owner)
        throw Error("fixture-original-owner-required");
      if (!initialPoll.has(id)) {
        initialPoll.add(id);
        return { ...record };
      }
      const pending = deferred<VerificationIntent>();
      polls.push({ id, pending, settled: false });
      return pending.promise;
    },
    operator: async () => {
      throw Error("not used");
    },
    operation: async () => {
      throw Error("not used");
    },
  };
  return {
    data,
    attach(next: Controller) {
      controller = next;
    },
    changed() {
      accountChanges++;
    },
    controls: {
      snapshot() {
        return {
          owner,
          accountChanges,
          accepted,
          claims: [...claims],
          records: [...records.values()].map((r) => ({
            id: r.intent_id,
            owner: r.owner,
            state: r.state,
          })),
          polls: polls.map((p) => ({ id: p.id, settled: p.settled })),
          starts: starts.map((s) => ({
            id: s.record.intent_id,
            settled: s.settled,
          })),
          walletReplies: walletReplies.length,
          claimReplies: claimReplies.length,
          state: controller
            ? {
                intent: controller.intent(),
                qr: controller.qr(),
                busy: controller.busy(),
                notice: controller.notice(),
                failedPolls: controller.failedPolls(),
                address: controller.view()?.address ?? null,
                credits: controller.credits(),
              }
            : null,
        };
      },
      settlePoll(
        index: number,
        state: VerificationIntent["state"] = "pending",
      ) {
        const request = polls[index];
        if (!request || request.settled) throw Error("fixture-no-pending-poll");
        request.settled = true;
        const record = records.get(request.id)!;
        record.state = state;
        request.pending.resolve({ ...record });
      },
      failPoll(index: number) {
        const request = polls[index];
        if (!request || request.settled) throw Error("fixture-no-pending-poll");
        request.settled = true;
        request.pending.reject(Error("fixture-private-stale-poll-error"));
      },
      holdIntent(value = true) {
        holdIntent = value;
      },
      releaseIntent(index: number, fail = false) {
        const request = starts[index];
        if (!request || request.settled)
          throw Error("fixture-no-pending-intent");
        request.settled = true;
        if (fail)
          request.pending.reject(Error("fixture-private-stale-intent-error"));
        else request.pending.resolve(request.record);
      },
      holdClaim() {
        holdClaim = true;
      },
      releaseClaim(index: number) {
        claimReplies[index].resolve({
          outcome: "verification_missing",
          credit: credit(),
        });
      },
      holdWallet() {
        holdWallet = true;
      },
      releaseWallet(index: number) {
        walletReplies[index].resolve(wallet());
      },
      switchAccount() {
        owner = "replacement";
      },
      start() {
        // Explicit fixture-only replacement; keep server records, start a new presentation.
        history.replaceState(null, "", "/wallet");
        void controller!.run(() => controller!.verify(verificationCreditId));
      },
      replace() {
        history.replaceState(null, "", "/wallet");
        void controller!.verify(verificationCreditId);
      },
      cancel() {
        controller!.cancelVerification();
      },
      refresh() {
        void controller!.run(controller!.refresh);
      },
      resume() {
        void controller!.run(controller!.resumeVerification);
      },
      async claim() {
        try {
          return {
            result: await controller!.claimFromRow(verificationCreditId),
          };
        } catch (error) {
          return { error: error instanceof Error ? error.message : "failed" };
        }
      },
    },
  };
}

export type VerificationFixtureControls = ReturnType<
  typeof verificationPorts
>["controls"] & {
  dispose(): void;
  remount(): void;
};
declare global {
  interface Window {
    rewardVerificationFixture: VerificationFixtureControls;
  }
}

export function RewardWalletVerificationFixture() {
  const ports = verificationPorts();
  const [shown, setShown] = createSignal(true);
  const mounted = new URL(location.href).searchParams.get("case") === "mounted";
  Object.assign(window, {
    rewardVerificationFixture: {
      ...ports.controls,
      dispose() {
        setShown(false);
      },
      remount() {
        history.replaceState(null, "", "/wallet");
        setShown(true);
      },
    },
  });
  function ControllerHarness() {
    const controller = useRewardWalletController({
      csrf: "fixture-only",
      onExit() {},
      data: ports.data,
      onAccountChanged: ports.changed,
    });
    ports.attach(controller);
    return (
      <output data-verification-controller>
        Actual wallet controller fixture
      </output>
    );
  }
  return (
    <Show when={shown()}>
      {(_shown) =>
        mounted ? (
          <div class="p-5">
            <LiveRewardWallet
              csrf="fixture-only"
              onExit={() => {}}
              data={ports.data}
              onAccountChanged={ports.changed}
            />
          </div>
        ) : (
          <ControllerHarness />
        )
      }
    </Show>
  );
}
