// State machine for the manual proof; the live entrypoint pins its chain,
// targets and budget. Tests run these same stages against local Anvil.
import {
  createPublicClient,
  encodeFunctionData,
  hashTypedData,
  http,
  keccak256,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { check, digest } from "../../packages/protocol/index.ts";
import {
  consentMessage,
  consentTypes,
  recordsAbi,
  recordsDomain,
  type Consent,
  type SongKey,
} from "../../packages/protocol/records.ts";
import {
  activationOf,
  acceptedByAccount,
  checkActivation,
  codeOf,
  designatorOf,
  nonceOf,
} from "../../services/accounts.ts";
import {
  dispatch,
  enqueue,
  maximumFee,
  type FeeLimits,
  type TxRow,
  type TxStore,
} from "../../services/operator-tx.ts";
import type { Env } from "../../services/runtime.ts";

export const LIVE_GAS = {
  record_activate: 300_000n,
  record_initialize: 300_000n,
  record_open: 400_000n,
} as const;
export interface ActivationRun {
  env: Env;
  consent: Consent;
  signature: Hex;
  song: SongKey;
  records: Address;
  operator: Address;
  chainId: number;
  limits: FeeLimits;
}
const attemptAbi = parseAbi([
  "function attempt(bytes32) view returns ((address learner,address grader,bytes32 activity,bytes32 songKey,bytes32 contentRevision,bytes32 linesRoot,bytes32 scoringPolicy,uint16 linesTotal,uint16 finalCount,uint32 completionRevision,uint64 completedAt,bytes32 qualificationPolicy,bytes32 recordsHash))",
]);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function bindRun(store: TxStore, config: ActivationRun) {
  check(
    config.limits.maxFeePerGas > 0n && config.limits.maxTotalFee > 0n,
    "invalid_fee_limits",
  );
  check(
    Object.values(LIVE_GAS).reduce((sum, gas) => sum + gas, 0n) *
      config.limits.maxFeePerGas <=
      config.limits.maxTotalFee,
    "insufficient_run_budget",
  );
  const profile = digest({
    chainId: config.chainId,
    records: config.records,
    operator: config.operator,
    consent: config.consent,
    signatureHash: keccak256(config.signature),
    song: config.song,
    delegate: config.env.ACCOUNT_DELEGATE,
    initializer: config.env.ACCOUNT_INITIALIZER,
    gas: Object.fromEntries(
      Object.entries(LIVE_GAS).map(([key, value]) => [key, value.toString()]),
    ),
    maxFeePerGas: config.limits.maxFeePerGas.toString(),
    maxTotalFee: config.limits.maxTotalFee.toString(),
  });
  const previous = store.get<string>("run:profile");
  check(!previous || previous === profile, "journal_profile_mismatch");
  if (!previous) store.set("run:profile", profile);
}
export const transactionSummary = (store: TxStore) =>
  store.entries("tx:").map(({ value }) => {
    const t = value as TxRow;
    return {
      step: t.kind,
      nonce: t.nonce,
      hash: t.hash,
      status: t.mined?.status ?? "pending",
      block: t.mined?.block,
      maximumFeeWei: maximumFee(t).toString(),
    };
  });

export async function runActivation(
  config: ActivationRun,
  store: TxStore,
  send: boolean,
) {
  const { env, consent, signature, song, records, operator, chainId, limits } =
    config;
  const chain = createPublicClient({
    transport: http(env.RPC_URL, { retryCount: 0 }),
  });
  check((await chain.getChainId()) === chainId, "activation_chain_mismatch");
  bindRun(store, config);
  const activation = activationOf(signature);
  check(activation, "not_an_activation");
  await checkActivation(env, consent.learner, activation, chainId);
  const typed = {
    domain: recordsDomain(chainId, records),
    types: consentTypes,
    primaryType: "Consent" as const,
    message: consentMessage(consent),
  };
  const hash = hashTypedData(typed);
  const openData = encodeFunctionData({
    abi: recordsAbi,
    functionName: "openAttempt",
    args: [
      consentMessage(consent),
      activation.inner,
      { ...song, chainId: BigInt(song.chainId) },
    ],
  });
  const state = (status: string, extra: Record<string, unknown> = {}) => ({
    status,
    learner: consent.learner,
    attemptId: consent.attemptId,
    transactions: transactionSummary(store),
    maxTotalFeeWei: limits.maxTotalFee.toString(),
    ...extra,
  });
  const step = async (
    kind: keyof typeof LIVE_GAS,
    data: Hex,
    to: Address,
    authorize = false,
  ) => {
    enqueue(
      store,
      kind,
      consent.attemptId,
      to,
      data,
      LIVE_GAS[kind],
      authorize ? [activation.authorization] : undefined,
    );
    const row = await dispatch(env, store, kind, consent.attemptId, limits);
    return row?.mined;
  };
  // Resolve every assigned nonce before deciding which stages are still needed.
  // A missing receipt or lost broadcast never causes a fresh transaction.
  if (send)
    for (const { value } of store.entries("tx:")) {
      const row = value as TxRow;
      if (
        !row.mined &&
        !(await dispatch(env, store, row.kind, row.ref, limits))?.mined
      )
        return state("pending");
    }
  const current = await chain.readContract({
    address: records,
    abi: attemptAbi,
    functionName: "attempt",
    args: [consent.attemptId],
  });
  if (current.learner !== zeroAddress) {
    check(
      same(current.learner, consent.learner) &&
        same(current.grader, consent.grader) &&
        current.activity === consent.activity &&
        current.songKey === consent.songKey &&
        current.contentRevision === consent.contentRevision &&
        current.linesRoot === consent.linesRoot &&
        current.scoringPolicy === consent.scoringPolicy &&
        current.linesTotal === consent.linesTotal,
      "opened_attempt_mismatch",
    );
    return state("complete", {
      accountAcceptsConsent: await acceptedByAccount(
        env,
        consent.learner,
        hash,
        activation.inner,
      ),
    });
  }
  check(
    consent.expiresAt > Number((await chain.getBlock()).timestamp) + 60,
    "consent_expired_or_expiring",
  );
  let code = await codeOf(env, consent.learner);
  if (code === "0x") {
    const nonce = await nonceOf(env, consent.learner);
    if (nonce !== activation.authorization.nonce) {
      // Another app may have activated the same MOSS account between these reads.
      code = await codeOf(env, consent.learner);
      check(code !== "0x", "authorization_nonce_stale");
    } else {
      check(
        await chain.verifyTypedData({
          ...typed,
          address: consent.learner,
          signature,
        }),
        "invalid_consent",
      );
      await chain.call({
        account: operator,
        to: activation.initializer,
        data: activation.data,
        authorizationList: [activation.authorization],
        gas: LIVE_GAS.record_activate,
      });
      if (!send)
        return state("prepared", {
          wouldSend: ["record_activate", "record_open"],
          possibleSetupRetry: true,
        });
      const activated = await step(
        "record_activate",
        activation.data,
        activation.initializer,
        true,
      );
      if (!activated) return state("pending");
      code = await codeOf(env, consent.learner);
    }
  }
  check(
    code === designatorOf(activation.authorization.address),
    "unexpected_account_delegate",
  );
  if (
    !(await acceptedByAccount(env, consent.learner, hash, activation.inner))
  ) {
    if (!send) {
      await chain.call({
        account: operator,
        to: activation.initializer,
        data: activation.data,
        gas: LIVE_GAS.record_initialize,
      });
      return state("prepared", {
        wouldSend: ["record_initialize", "record_open"],
      });
    }
    const initialized = await step(
      "record_initialize",
      activation.data,
      activation.initializer,
    );
    if (!initialized) return state("pending");
    check(
      await acceptedByAccount(env, consent.learner, hash, activation.inner),
      "account_not_initialized",
    );
  }
  if (!send) {
    await chain.call({
      account: operator,
      to: records,
      data: openData,
      gas: LIVE_GAS.record_open,
    });
    return state("prepared", { wouldSend: ["record_open"] });
  }
  const opened = await step("record_open", openData, records);
  if (!opened) return state("pending");
  check(opened.status === "success", "open_reverted");
  // Read the stored identity and every consent binding before reporting success.
  return runActivation(config, store, false);
}
