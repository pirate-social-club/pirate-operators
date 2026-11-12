// Ported from pinned Flows/Wallet/Send; provenance and service departures: docs/v1-wallet-owner-parity-20261111.md.
import {
  createEffect,
  createSignal,
  Match,
  onCleanup,
  onSettled,
  Show,
  Switch,
} from "solid-js";
import { formatUnits, getAddress, parseUnits } from "viem";
import {
  Button,
  Modal,
  ModalContent,
  ModalDescription,
  ModalHeader,
  ModalTitle,
  TextField,
  TextFieldInput,
  TextFieldLabel,
  Type,
} from "./design-system.ts";
import {
  WalletPortResponseValidationError as ApiClientResponseValidationError,
  WalletPortInputError,
  type WalletSponsoredSendDependencies,
  type WalletSponsoredSendRecord,
  type WalletSendDraft,
  type SigningWallet,
  type RewardTokenTransfer,
} from "../sponsored-send-ports.ts";
import { checkRecipient } from "./winnings-send-model.ts";
import { sameSendQuote } from "../quoted-send.ts";
import type { WalletSendQuoteV1 } from "../contracts.ts";
import type { RewardWalletOutcome } from "../../live/reward-wallet.ts";
export type { WalletSponsoredSendDependencies } from "../sponsored-send-ports.ts";
type Sender = Readonly<{ address: string }>;
type Step =
  | "loading"
  | "unavailable"
  | "details"
  | "authorization"
  | "verification"
  | "review"
  | "status";

type WalletSponsoredSendSheetProps = Readonly<{
  accountId: string;
  personaId: string;
  walletAddress: string;
  onClose: () => void;
  onConfirmed?: () => void;
  dependencies?: WalletSponsoredSendDependencies;
  resumeDraft?: WalletSendDraft;
}>;

/** The ordinary Wallet send; tokens need not come from a reward. */
export function WalletSponsoredSendSheet(props: WalletSponsoredSendSheetProps) {
  const dependencies = props.dependencies;
  return dependencies === undefined ? (
    <SponsoredSendUnavailable onClose={props.onClose} />
  ) : (
    <SponsoredSendSheet {...props} dependencies={dependencies} />
  );
}

/** No deployment named: nothing is read, reserved or signed. */
function SponsoredSendUnavailable(props: Readonly<{ onClose: () => void }>) {
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <ModalContent
        class="flex w-full flex-col gap-4 px-5 pb-5 pt-4 md:max-w-[32rem] md:px-7 md:pb-7 md:pt-7"
        mobileSide="bottom"
      >
        <ModalHeader class="text-start">
          <ModalTitle>Send test USDm</ModalTitle>
        </ModalHeader>
        <Type role="alert">Send is not available here.</Type>
        <Button onClick={props.onClose}>Close</Button>
      </ModalContent>
    </Modal>
  );
}

function SponsoredSendSheet(
  props: WalletSponsoredSendSheetProps &
    Readonly<{ dependencies: WalletSponsoredSendDependencies }>,
) {
  const dependencies = props.dependencies;
  const network = dependencies.data.network;
  const USDC = network.token;
  const DECIMALS = network.decimals;
  const [quote, setQuote] = createSignal<WalletSendQuoteV1>();
  const [hostedOutcome, setHostedOutcome] = createSignal<RewardWalletOutcome>();
  const [step, setStep] = createSignal<Step>("loading");
  const [sender, setSender] = createSignal<Sender>();
  const [balance, setBalance] = createSignal<bigint>();
  const [record, setRecord] = createSignal<WalletSponsoredSendRecord | null>(
    null,
  );
  const candidate = props.resumeDraft;
  const resumed =
    candidate?.accountId === props.accountId &&
    candidate.personaId === props.personaId &&
    candidate.walletAddress.toLowerCase() === props.walletAddress.toLowerCase()
      ? candidate
      : undefined;
  const [recipient, setRecipient] = createSignal(resumed?.recipient ?? "");
  const [amount, setAmount] = createSignal(resumed?.amount ?? "");
  const [touched, setTouched] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal("");
  const [reloadRequired, setReloadRequired] = createSignal(false);
  const [returnConflict, setReturnConflict] = createSignal(false);
  let returnChecked = false;
  const [idempotencyKey, setIdempotencyKey] = createSignal(
    resumed?.idempotencyKey ?? crypto.randomUUID(),
  );
  const signInAbort = new AbortController();
  let alive = true;
  let wallet: SigningWallet | undefined;
  const notification = {
    personaId: props.personaId,
    address: props.walletAddress,
    confirmed: props.onConfirmed,
  };
  const owner = {
    accountId: props.accountId,
    personaId: props.personaId,
    address: props.walletAddress,
  };
  const reported = new Set<string>();
  createEffect(record, (current) => {
    if (
      !alive ||
      current?.status !== "confirmed" ||
      reported.has(current.send_id) ||
      current.persona_id !== notification.personaId ||
      props.personaId !== notification.personaId ||
      props.walletAddress !== notification.address ||
      current.sender_address.toLowerCase() !==
        notification.address.toLowerCase()
    )
      return;
    reported.add(current.send_id);
    notification.confirmed?.();
  });
  const shutdown = () => {
    alive = false;
    signInAbort.abort();
    wallet?.dispose();
    wallet = undefined;
  };
  createEffect(
    () => [props.accountId, props.personaId, props.walletAddress] as const,
    ([accountId, personaId, address]) => {
      if (
        accountId !== owner.accountId ||
        personaId !== owner.personaId ||
        address !== owner.address
      ) {
        shutdown();
        setStep("unavailable");
        setError(
          "The account or wallet changed. Reopen Send from your wallet.",
        );
      }
    },
  );
  onCleanup(shutdown);
  const close = () => {
    try {
      dependencies.continuation?.forget(idempotencyKey());
    } catch {
      /* A form hint grants no authority. */
    }
    shutdown();
    props.onClose();
  };
  const requestClose = () => {
    if (!busy() && !submitting()) close();
  };
  const run = async (operation: () => Promise<void>) => {
    if (busy() || !alive) return;
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (cause) {
      if (alive) {
        if (cause instanceof ApiClientResponseValidationError)
          versionMismatch();
        else if (cause instanceof WalletPortInputError) {
          setError(cause.message);
          setStep("details");
        } else {
          setError(
            "The send could not be completed. Check its recorded status before trying again.",
          );
          setStep("status");
        }
      }
    } finally {
      if (alive) setBusy(false);
    }
  };
  const versionMismatch = () => {
    setReloadRequired(true);
    setStep("unavailable");
    setError(
      "Wallet information could not be checked. Reload the page and check the recorded send before continuing.",
    );
  };
  const requireVerification = () => {
    setStep("verification");
    setError("");
  };
  const verify = () =>
    run(async () => {
      const to = recipientCheck();
      const value = amountCheck();
      const current = record();
      if (current !== null && current.status !== "reserved") {
        await refresh();
        return;
      }
      if (current === null && (!to.ok || !value.ok)) {
        setStep("details");
        return;
      }
      const draft: WalletSendDraft = {
        accountId: owner.accountId,
        personaId: owner.personaId,
        walletAddress: owner.address,
        recipient: current?.recipient_address ?? (to.ok ? to.address : ""),
        amount:
          current === null
            ? amount().trim()
            : formatUnits(BigInt(current.amount_atomic), DECIMALS),
        idempotencyKey: idempotencyKey(),
        sendId: current?.send_id ?? null,
      };
      if (!dependencies.continuation) {
        versionMismatch();
        return;
      }
      const path = dependencies.continuation.remember(draft);
      if (dependencies.navigate) dependencies.navigate(path);
      else window.location.assign(path);
    });
  const format = (atomic: bigint) =>
    `${formatUnits(atomic, DECIMALS)} ${network.symbol}`;
  const recipientCheck = () =>
    checkRecipient(recipient(), sender()?.address ?? props.walletAddress, USDC);
  const amountCheck = () => {
    if (
      !new RegExp(`^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,${DECIMALS}})?$`, "u").test(
        amount().trim(),
      )
    ) {
      return {
        ok: false as const,
        message: `Enter an amount with up to ${DECIMALS} decimal places.`,
      };
    }
    const atomic = parseUnits(amount().trim(), DECIMALS);
    if (atomic <= 0n)
      return { ok: false as const, message: "Enter an amount above zero." };
    if (balance() === undefined || atomic > balance()!) {
      return {
        ok: false as const,
        message: `This wallet does not hold that much ${network.symbol}.`,
      };
    }
    return { ok: true as const, atomic };
  };
  const refresh = async () => {
    const current = await dependencies.data.read(props.personaId);
    if (!alive) return;
    setRecord(current);
    if (
      !returnChecked &&
      resumed !== undefined &&
      (resumed.sendId === null
        ? current !== null
        : current?.send_id !== resumed.sendId)
    ) {
      returnChecked = true;
      setReturnConflict(true);
      setError(
        "The recorded send changed. Nothing was signed. Check its status.",
      );
      setStep(current === null ? "unavailable" : "status");
      return;
    }
    returnChecked = true;
    setStep(
      current?.status === "reserved" && current.verification_required
        ? "verification"
        : current === null
          ? "details"
          : "status",
    );
  };
  const refreshBalance = async () => {
    const assigned = await dependencies.data.sender(props.personaId);
    if (getAddress(assigned.address) !== getAddress(props.walletAddress))
      throw new Error("wallet_assignment_mismatch");
    const held = await dependencies.data.tokenBalance(USDC, assigned.address);
    if (!alive) return;
    setSender(assigned);
    setBalance(held);
    if (resumed === undefined && held !== undefined)
      setAmount(formatUnits(held, DECIMALS));
  };
  onSettled(() => {
    void Promise.resolve().then(async () => {
      try {
        await Promise.all([refresh(), refreshBalance()]);
      } catch (cause) {
        if (alive) {
          if (cause instanceof ApiClientResponseValidationError)
            versionMismatch();
          else setStep("unavailable");
        }
      }
    });
  });
  const openWallet = async () => {
    if (wallet !== undefined) return wallet;
    const opened = await dependencies.openWallet();
    if (!alive) {
      opened.dispose();
      throw new Error("wallet_session_closed");
    }
    wallet = opened;
    return opened;
  };
  const transfer = (
    current: WalletSponsoredSendRecord,
  ): RewardTokenTransfer => {
    const assigned = sender();
    if (assigned === undefined) throw new Error("wallet_sender_unavailable");
    return {
      sender: assigned.address,
      token: USDC,
      recipient: current.recipient_address,
      amountAtomic: current.amount_atomic,
      chainId: network.chainId,
    };
  };
  const matches = (
    current: WalletSponsoredSendRecord,
    intended: RewardTokenTransfer,
  ) =>
    current.persona_id === props.personaId &&
    current.chain_id === network.chainId &&
    getAddress(current.sender_address) === getAddress(intended.sender) &&
    getAddress(current.token_address) === getAddress(intended.token) &&
    getAddress(current.recipient_address) === getAddress(intended.recipient) &&
    current.amount_atomic === intended.amountAtomic;
  const authorize = async (
    current: WalletSponsoredSendRecord,
    action: "pay" | "cancel" = "pay",
  ) => {
    if (returnConflict()) return;
    if (current.status === "reserved" && current.verification_required) {
      requireVerification();
      return;
    }
    if (
      ["confirmed", "cancelled", "reverted", "abandoned"].includes(
        current.status,
      ) ||
      current.authorization === null
    ) {
      await refresh();
      return;
    }
    const fresh = await dependencies.data.read(props.personaId);
    if (!alive) return;
    if (
      fresh?.send_id === current.send_id &&
      fresh.status === "reserved" &&
      fresh.verification_required
    ) {
      setRecord(fresh);
      requireVerification();
      return;
    }
    if (
      fresh === null ||
      fresh.send_id !== current.send_id ||
      ["confirmed", "cancelled", "reverted", "abandoned"].includes(
        fresh.status,
      ) ||
      fresh.authorization === null ||
      fresh.intent.payment.guardNonce !== current.intent.payment.guardNonce ||
      !sameSendQuote(fresh.intent.quote, current.intent.quote) ||
      fresh.chain_id !== current.chain_id ||
      fresh.token_address !== current.token_address ||
      fresh.sender_address !== current.sender_address ||
      fresh.recipient_address !== current.recipient_address ||
      fresh.amount_atomic !== current.amount_atomic
    ) {
      setRecord(fresh);
      setStep("status");
      setError("The recorded send changed. Nothing was signed.");
      return;
    }
    const intended = transfer(fresh);
    if (!matches(fresh, intended)) {
      setRecord(fresh);
      setStep("status");
      setError("The assigned wallet changed. Nothing was signed.");
      return;
    }
    const currentWallet = await openWallet();
    if (!(await currentWallet.restoreAuthorization())) {
      if (alive) setStep("authorization");
      return;
    }
    if (!alive) return;
    const approval = await currentWallet.approveRecorded(fresh, action);
    if (!alive) return;
    setSubmitting(true);
    setStep("status");
    try {
      setRecord(await dependencies.data.submit(fresh.send_id, approval));
    } catch (cause) {
      try {
        await refresh();
      } catch {
        /* A failed read cannot authorize another submission. */
      }
      if (!alive) return;
      if (cause instanceof ApiClientResponseValidationError) versionMismatch();
      else if (
        dependencies.verificationRequired?.(cause) === true &&
        record()?.status === "reserved"
      )
        requireVerification();
      else
        setError(
          "The send may have reached the network. Check its status; do not send again.",
        );
    } finally {
      if (alive) setSubmitting(false);
    }
  };
  const begin = () =>
    run(async () => {
      setTouched(true);
      if (!dependencies.hosted) {
        const to = recipientCheck(),
          value = amountCheck();
        if (!to.ok || !value.ok) return;
        const preview = await dependencies.data.preview(
          to.address,
          value.atomic.toString(),
        );
        if (!alive) return;
        setQuote(preview);
      }
      const current = await openWallet();
      const restored = await current.restoreAuthorization();
      if (alive) setStep(restored ? "review" : "authorization");
    });
  const signIn = () =>
    run(async () => {
      const authenticated = await dependencies.reauthorize(signInAbort.signal);
      if (!alive || !authenticated) return;
      wallet?.dispose();
      wallet = undefined;
      const current = await openWallet();
      const restored = await current.restoreAuthorization();
      if (!alive) return;
      if (!restored) {
        setError(
          "Wallet authorization could not be restored. Sign in again from the Wallet page.",
        );
        return;
      }
      setStep("review");
    });
  const confirm = () =>
    run(async () => {
      if (dependencies.hosted) {
        setSubmitting(true);
        setStep("status");
        try {
          const result = await dependencies.hosted.open(signInAbort.signal);
          if (alive) setHostedOutcome(result);
        } finally {
          if (alive) setSubmitting(false);
        }
        return;
      }
      const to = recipientCheck();
      const value = amountCheck();
      const assigned = sender();
      if (!to.ok || !value.ok || assigned === undefined) {
        setStep("details");
        return;
      }
      let reserved: WalletSponsoredSendRecord;
      try {
        reserved = await dependencies.data.reserve(
          props.personaId,
          to.address,
          value.atomic.toString(),
          idempotencyKey(),
          quote()!,
        );
      } catch (cause) {
        if (!alive) return;
        if (cause instanceof ApiClientResponseValidationError) {
          versionMismatch();
          return;
        }
        if (dependencies.verificationRequired?.(cause) === true) {
          requireVerification();
          return;
        }
        try {
          await refresh();
        } catch {
          setStep("unavailable");
        }
        setError(
          "The send could not be recorded. Nothing was signed. Check its status.",
        );
        return;
      }
      if (!alive) return;
      setRecord(reserved);
      setStep("status");
      if (reserved.status === "reserved" && reserved.verification_required) {
        requireVerification();
        return;
      }
      const intended: RewardTokenTransfer = {
        sender: assigned.address,
        token: USDC,
        recipient: to.address,
        amountAtomic: value.atomic.toString(),
        chainId: network.chainId,
      };
      if (
        !matches(reserved, intended) ||
        reserved.status !== "reserved" ||
        reserved.authorization === null
      ) {
        setError(
          "The recorded send differs from this form. Nothing was signed.",
        );
        return;
      }
      await authorize(reserved);
    });
  const startNew = () =>
    run(async () => {
      await refreshBalance();
      if (!alive) return;
      setReturnConflict(false);
      setIdempotencyKey(crypto.randomUUID());
      setRecord(null);
      setRecipient("");
      setTouched(false);
      setStep("details");
    });
  const max = () =>
    run(async () => {
      const to = recipientCheck();
      setTouched(true);
      if (!to.ok) return;
      const preview = await dependencies.data.preview(to.address, "max");
      if (!alive) return;
      setAmount(formatUnits(BigInt(preview.amountAtomic), DECIMALS));
      setQuote(preview);
    });
  const refreshStatus = () =>
    run(async () => {
      const current = record();
      if (current) {
        const next = await dependencies.data.reconcile(current.send_id);
        if (alive) setRecord(next);
      } else await refresh();
    });
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) requestClose();
      }}
      modal={dependencies.externalWalletOwnsFocus ? false : undefined}
    >
      <ModalContent
        class="flex max-h-[88dvh] w-full flex-col gap-4 overflow-y-auto px-5 pb-5 pt-4 md:max-w-[32rem] md:px-7 md:pb-7 md:pt-7"
        mobileSide="bottom"
      >
        <ModalHeader class="text-start">
          <ModalTitle>Send {network.symbol}</ModalTitle>
          <ModalDescription>{network.feeDescription}</ModalDescription>
        </ModalHeader>
        <Show when={error()}>
          {(message) => (
            <Type role="alert" class="text-destructive-text break-words">
              {message()}
            </Type>
          )}
        </Show>
        <Switch>
          <Match when={step() === "loading"}>
            <Type role="status">Loading your wallet…</Type>
          </Match>
          <Match when={step() === "unavailable"}>
            <Type role="alert">
              Your wallet or send record could not be loaded.
            </Type>
            <Show when={reloadRequired()}>
              <Button
                onClick={() =>
                  dependencies.reload
                    ? dependencies.reload()
                    : window.location.reload()
                }
              >
                Reload wallet
              </Button>
            </Show>
            <Button onClick={requestClose}>Close</Button>
          </Match>
          <Match when={step() === "verification"}>
            <Type>
              Verify your palm with Very before sending. Your send details will
              be kept for your return.
            </Type>
            <Button disabled={busy()} onClick={() => void verify()}>
              Verify palm
            </Button>
            <Button
              variant="ghost"
              disabled={busy()}
              onClick={() => void run(refresh)}
            >
              Check status
            </Button>
          </Match>
          <Match when={step() === "details"}>
            <div class="flex flex-col gap-4">
              <Type class="text-sm">
                Wallet balance:{" "}
                {balance() === undefined ? "unavailable" : format(balance()!)}
              </Type>
              <Show when={!dependencies.hosted}>
                <TextField
                  value={recipient()}
                  onChange={setRecipient}
                  validationState={
                    touched() && !recipientCheck().ok ? "invalid" : "valid"
                  }
                >
                  <TextFieldLabel>Send to</TextFieldLabel>
                  <TextFieldInput
                    placeholder="0x…"
                    autocomplete="off"
                    spellcheck={false}
                  />
                </TextField>
                <Show when={touched() && !recipientCheck().ok}>
                  <Type role="alert" class="text-sm text-destructive-text">
                    {(() => {
                      const check = recipientCheck();
                      return check.ok ? "" : check.message;
                    })()}
                  </Type>
                </Show>
                <TextField
                  value={amount()}
                  onChange={setAmount}
                  validationState={
                    touched() && !amountCheck().ok ? "invalid" : "valid"
                  }
                >
                  <TextFieldLabel>Amount ({network.symbol})</TextFieldLabel>
                  <TextFieldInput inputmode="decimal" autocomplete="off" />
                </TextField>
                <Show when={touched() && !amountCheck().ok}>
                  <Type role="alert" class="text-sm text-destructive-text">
                    {amountCheck().ok ? "" : amountCheck().message}
                  </Type>
                </Show>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy()}
                  onClick={() => void max()}
                >
                  Max
                </Button>
              </Show>
              <Button disabled={busy()} onClick={() => void begin()}>
                Continue
              </Button>
              <Show when={dependencies.hosted}>
                <Button
                  variant="outline"
                  disabled={busy()}
                  onClick={() => void run(() => dependencies.hosted!.history())}
                >
                  Open MOSS history
                </Button>
              </Show>
            </div>
          </Match>
          <Match when={step() === "authorization"}>
            <Type>
              Your wallet authorization has ended. Use the usual sign-in to
              reconnect it before sending.
            </Type>
            <Button disabled={busy()} onClick={() => void signIn()}>
              Sign in
            </Button>
          </Match>
          <Match when={step() === "review"}>
            <div class="flex flex-col gap-4">
              <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                <dt>Amount</dt>
                <dd>
                  {dependencies.hosted
                    ? "Choose in MOSS"
                    : (() => {
                        const check = amountCheck();
                        return check.ok ? format(check.atomic) : "Invalid";
                      })()}
                </dd>
                <dt>To</dt>
                <dd class="break-all">
                  {dependencies.hosted ? "Choose in MOSS" : recipient()}
                </dd>
                <dt>From</dt>
                <dd class="break-all">{sender()?.address}</dd>
                <dt>Network</dt>
                <dd>{network.label}</dd>
                <dt>Network fee</dt>
                <dd>
                  {quote()
                    ? `${formatUnits(BigInt(quote()!.fee.reserveAtomic), quote()!.fee.decimals)} ${quote()!.fee.symbol} reserved`
                    : "Review in MOSS"}
                </dd>
                <dt>Token</dt>
                <dd class="break-all">{network.token}</dd>
                <Show when={quote()?.fee.estimatedAtomic != null}>
                  <dt>Estimated fee</dt>
                  <dd>
                    {formatUnits(
                      BigInt(quote()!.fee.estimatedAtomic!),
                      quote()!.fee.decimals,
                    )}{" "}
                    {quote()!.fee.symbol}
                  </dd>
                </Show>
              </dl>
              <Button disabled={busy()} onClick={() => void confirm()}>
                {dependencies.hosted ? "Continue in MOSS" : "Authorize send"}
              </Button>
              <Button
                variant="ghost"
                disabled={busy()}
                onClick={() => setStep("details")}
              >
                Change details
              </Button>
            </div>
          </Match>
          <Match when={step() === "status"}>
            <div class="flex flex-col gap-4" aria-live="polite">
              <Show when={record()}>
                {(current) => (
                  <>
                    <Type class="text-sm">
                      Recorded amount: {format(BigInt(current().amount_atomic))}
                    </Type>
                    <Type class="text-sm break-all">
                      To: {current().recipient_address}
                    </Type>
                    <Show when={current().transaction_hash}>
                      {(hash) => (
                        <Show
                          when={network.explorerTransactionUrl}
                          fallback={
                            <Type class="break-all text-sm">
                              Transaction: {hash()}
                            </Type>
                          }
                        >
                          {(url) => (
                            <a
                              class="break-all text-sm underline"
                              href={url()(hash())}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              View transfer
                            </a>
                          )}
                        </Show>
                      )}
                    </Show>
                    <Switch>
                      <Match when={current().status === "confirmed"}>
                        <Type role="status">
                          This send is confirmed. The {network.symbol} arrived
                          at the recipient.
                        </Type>
                      </Match>
                      <Match when={current().status === "cancelled"}>
                        <Type role="status">This Send is cancelled.</Type>
                      </Match>
                      <Match when={current().status === "reverted"}>
                        <Type role="status">
                          This transaction failed. Its token transfer did not
                          happen.
                        </Type>
                      </Match>
                      <Match when={current().status === "abandoned"}>
                        <Type role="status">
                          This unsigned request expired. No transaction was
                          submitted.
                        </Type>
                      </Match>
                      <Match when={current().status === "reserved"}>
                        <Type role="status">
                          {current().intent.payment.everDispatched
                            ? "Check this same guarded Send before any other action."
                            : "This send is recorded but has not been submitted."}
                        </Type>
                        <Show
                          when={current().verification_required}
                          fallback={
                            <Button
                              disabled={
                                busy() ||
                                returnConflict() ||
                                current().authorization === null ||
                                sender() === undefined
                              }
                              onClick={() =>
                                void run(() => authorize(current()))
                              }
                            >
                              Authorize recorded send
                            </Button>
                          }
                        >
                          <Button
                            disabled={busy() || returnConflict()}
                            onClick={requireVerification}
                          >
                            Verify palm
                          </Button>
                        </Show>
                      </Match>
                      <Match when={true}>
                        <Type role="status">
                          The network is checking this send. Check its status
                          before any other action.
                        </Type>
                      </Match>
                    </Switch>
                    <Show
                      when={[
                        "confirmed",
                        "cancelled",
                        "reverted",
                        "abandoned",
                      ].includes(current().status)}
                    >
                      <Button disabled={busy()} onClick={() => void startNew()}>
                        New send
                      </Button>
                    </Show>
                  </>
                )}
              </Show>
              <Show
                when={
                  record()?.authorization !== null &&
                  record() !== null &&
                  record()?.status !== "reserved"
                }
              >
                <Button
                  disabled={busy()}
                  onClick={() => void run(() => authorize(record()!))}
                >
                  Review same guarded Send
                </Button>
              </Show>
              <Show
                when={
                  record() &&
                  !["confirmed", "cancelled"].includes(record()!.status)
                }
              >
                <Button
                  variant="outline"
                  disabled={busy()}
                  onClick={() =>
                    void run(async () => {
                      const current = record()!;
                      if (!current.intent.payment.everDispatched) {
                        const next = await dependencies.data.cancel(
                          current.send_id,
                        );
                        if (alive) setRecord(next);
                      } else await authorize(current, "cancel");
                    })
                  }
                >
                  {record()?.intent.payment.everDispatched
                    ? "Cancel Send through wallet"
                    : "Cancel prepared Send"}
                </Button>
              </Show>
              <Show when={dependencies.hosted}>
                <Type role="status">
                  Check MOSS history for any Send you approved. This page does
                  not confirm a transfer or retry it.
                </Type>
                <Show when={hostedOutcome()?.hash}>
                  <Type class="break-all text-sm">
                    Transaction to check: {hostedOutcome()?.hash}
                  </Type>
                </Show>
                <Button
                  variant="outline"
                  disabled={busy()}
                  onClick={() => void run(() => dependencies.hosted!.history())}
                >
                  Open MOSS history
                </Button>
              </Show>
              <Show when={!dependencies.hosted}>
                <Button
                  variant="outline"
                  disabled={busy()}
                  onClick={() => void refreshStatus()}
                >
                  Refresh status
                </Button>
              </Show>
              <Button
                variant="ghost"
                disabled={busy() || submitting()}
                onClick={requestClose}
              >
                Close
              </Button>
            </div>
          </Match>
        </Switch>
      </ModalContent>
    </Modal>
  );
}
