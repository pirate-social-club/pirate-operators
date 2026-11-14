import { Show, createEffect, createSignal, createUniqueId } from "solid-js";
import {
  Modal, ModalContent, ModalDescription, ModalHeader, ModalTitle,
} from "@/patterns/overlays/modal/modal";
import { Button, Input } from "./design-system.ts";
import {
  acceptedJoin, canonicalMemberLabel, memberNameRecoveryCopy, type MembershipState,
} from "./community-membership.ts";

export interface ChooseHandleProps {
  readonly communityName: string;
  readonly state: MembershipState;
  readonly returnFocus: () => HTMLElement | undefined;
  readonly onClose: () => void;
  readonly onPrepare: (label: string) => void;
  readonly onConsent: () => void;
  readonly onCheck: () => void;
  readonly onReconcile: () => void;
}
/** Independently owned adaptation of CommunityJoinName's responsive Paper
 * modal, field/suffix, announcements and focus return. Admission is already
 * accepted; the server's original ClaimAcceptance supplies all name authority. */
export function ChooseHandle(props: ChooseHandleProps) {
  const id = createUniqueId();
  const [label, setLabel] = createSignal("");
  let field: HTMLInputElement | undefined;
  let draftOwner: string | null = null;
  createEffect(
    () => [props.state.ownerKey, props.state.nameOpen] as const,
    ([owner, open]) => {
      if (!open || owner !== draftOwner) setLabel("");
      draftOwner = owner;
    },
  );
  const current = () => props.state.name;
  const editing = () => current()?.state === "idle" && !props.state.nameUncertain;
  const prepared = () => {
    const value = current();
    return value?.state === "awaiting_consent" ? value : undefined;
  };
  const blocked = () => {
    const value = current();
    return value?.state === "blocked" ? value : undefined;
  };
  const consumed = () => {
    const value = current();
    return value?.state === "consumed" ? value : undefined;
  };
  const valid = () => canonicalMemberLabel(label());
  const pending = () => {
    const value = current();
    return value && ["queued", "pending", "unknown"].includes(value.state);
  };
  function close() {
    setLabel("");
    props.onClose();
  }
  return (
    <Modal open={props.state.nameOpen} onOpenChange={(open) => { if (!open) close(); }}>
      <ModalContent
        aria-label="Choose your name"
        mobileSide="bottom"
        onOpenAutoFocus={(event) => {
          if (editing() && field) { event.preventDefault(); field.focus(); }
        }}
        onCloseAutoFocus={(event) => {
          const target = props.returnFocus();
          if (target?.isConnected && target.getClientRects().length > 0) {
            event.preventDefault(); target.focus({ preventScroll: true });
          }
        }}
        class="max-h-[90dvh] overflow-y-auto rounded-t-[var(--radius-sheet)] bg-background px-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-6 sm:max-w-md sm:rounded-[var(--radius-xl)] sm:p-8"
      >
        <div class="flex flex-col gap-6" data-community-name-state={current()?.state ?? "checking"}>
          <ModalHeader class="text-start">
            <ModalTitle>Choose your name</ModalTitle>
            <ModalDescription>
              You have joined {props.communityName}. A name is optional.
            </ModalDescription>
          </ModalHeader>
          <Show when={acceptedJoin(props.state)}>
            <Show when={editing()}>
              <form class="flex flex-col gap-5" onSubmit={(event) => {
                event.preventDefault();
                if (valid() && !props.state.naming) props.onPrepare(label());
              }}>
                <div class="flex flex-col gap-2">
                  <label class="text-sm font-semibold" for={id + "-name"}>Name</label>
                  <div class="flex items-center rounded-[var(--radius-lg)] border border-input bg-background px-4 focus-within:ring-2 focus-within:ring-ring" dir="ltr">
                    <Input ref={(element: HTMLInputElement) => { field = element; }}
                      id={id + "-name"}
                      class="min-w-0 border-0 px-0 shadow-none focus-visible:ring-0"
                      value={label()} autocomplete="nickname" autocapitalize="none"
                      inputmode="text" enterkeyhint="go" spellcheck={false}
                      maxlength={63} disabled={props.state.naming}
                      aria-describedby={id + "-hint"}
                      aria-invalid={label() !== "" && !valid() ? "true" : undefined}
                      onInput={(event) => setLabel(event.currentTarget.value)}
                    />
                    <span class="shrink-0 text-muted-foreground">.{current()?.tld}</span>
                  </div>
                  <p class="min-h-10 text-sm leading-5 text-muted-foreground sm:min-h-5" id={id + "-hint"}>
                    8–63 characters. Lowercase a–z, 0–9 and hyphens; begin and end with a letter or digit. Hyphens cannot occupy both positions 3 and 4.
                  </p>
                </div>
                <Button class="w-full" type="submit" loading={props.state.naming}
                  disabled={!valid() || props.state.naming}>Get name</Button>
              </form>
            </Show>
            <Show when={prepared()}>{(value) => (
              <div class="flex flex-col gap-5">
                <p class="break-all text-xl font-semibold" dir="ltr">
                  {value().claim.label}.{value().tld}
                </p>
                <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                  <dt>Initial price</dt><dd>Free ({value().terms.initialPriceAtomic} atomic units)</dd>
                  <dt>Gas</dt><dd class="break-all">Up to {value().terms.gas.maxTotalWei} wei, paid by {value().terms.gas.payerAddress}</dd>
                  <dt>Initial term</dt><dd>{value().terms.initialTermDays} days</dd>
                  <dt>Annual renewal</dt><dd class="break-all">{value().terms.annualRenewal.amountAtomic} atomic units of token {value().terms.annualRenewal.token}</dd>
                  <dt>Consent expires</dt><dd>{new Date(value().consent.expiresAtMs).toLocaleString()}</dd>
                </dl>
                <p class="text-sm text-muted-foreground">
                  Your wallet signs the original claim acceptance. A name claim is public. Issuance and current name usability are checked separately.
                </p>
                <Button class="w-full" loading={props.state.naming}
                  disabled={props.state.naming || props.state.nameUncertain}
                  onClick={props.onConsent}>Agree and sign</Button>
              </div>
            )}</Show>
            <Show when={memberNameRecoveryCopy(current(), props.state.nameUncertain)}>
              {(copy) => <p class="text-sm text-muted-foreground" role="status">{copy()}</p>}
            </Show>
            <Show when={blocked()}>{(value) => (
              <p role="status" class="text-sm text-muted-foreground">{value().correction}</p>
            )}</Show>
            <Show when={consumed()}>{(value) => (
              <div class="flex flex-col gap-3">
                <p role="status">The original name claim was consumed.</p>
                <p class="break-all text-xl font-semibold" dir="ltr">{value().claim.name}</p>
                <p class="text-sm text-muted-foreground">
                  {value().usability === "usable" ? "Your name is currently usable." :
                    value().usability === "unknown" ? "Current name usability is unknown." :
                    value().usability === "not_checked" ? "Current name usability has not been checked." :
                      "Your name is currently unavailable."}
                </p>
              </div>
            )}</Show>
            <div role="status" aria-live="polite" aria-atomic="true">
              <Show when={props.state.naming}><p class="text-sm">Checking your original request…</p></Show>
            </div>
            <Show when={props.state.error}>
              <p role="alert" class="text-sm text-destructive-text">{props.state.error}</p>
            </Show>
            <Show when={!editing()}>
              <Button class="w-full" variant="outline" disabled={props.state.naming}
                onClick={props.onCheck}>Check my name</Button>
              <Show when={(pending() || current()?.state === "expired_unconsumed") && current()?.claim}>
                <Button class="w-full" variant="ghost" disabled={props.state.naming}
                  onClick={props.onReconcile}>Reconcile original request</Button>
              </Show>
            </Show>
          </Show>
          <Button class="w-full" variant="ghost" onClick={close}>Back to community</Button>
        </div>
      </ModalContent>
    </Modal>
  );
}
