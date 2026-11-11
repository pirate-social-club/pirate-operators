/** @jsxImportSource @solidjs/web */
import { For, Show, createEffect, createMemo, createSignal } from "solid-js";

import {
  Avatar,
  Button,
  FormNote,
  IconTrash,
  Input,
  Modal,
  ModalContent,
  ModalHeader,
  ModalTitle,
  Type,
} from "../../../design-system.ts";
import {
  basisPointsToPercentText,
  percentTextToBasisPoints,
} from "../media-submission/contracts.ts";
import { defaultComposerCopy, type ComposerCopy } from "./copy.ts";
import { FieldLabel } from "./fields.tsx";
import type {
  AssetRoyaltyAllocation,
  AssetRoyaltySplitState,
  ComposerRecipientProfile,
} from "./types.ts";

const TOTAL_BPS = 10_000;

function allocationBps(allocation: AssetRoyaltyAllocation): number {
  return allocation.shareBps ?? Math.round(allocation.sharePct * 100);
}

function authorLabel(
  profile: ComposerRecipientProfile | undefined,
  fallback: string,
): string {
  return profile?.displayName.trim() || profile?.handle?.trim() || fallback;
}

/**
 * The exact rules the publish path enforces, in the surface's own words. The
 * contract error strings never reach the author; every failure here is also
 * checked by `normalizeRoyaltyAllocations` before a submission is built.
 */
export function royaltySplitIssue(
  split: AssetRoyaltySplitState,
  authorPersonaId: string | undefined,
  copy: ComposerCopy = defaultComposerCopy,
): string {
  const author = authorPersonaId?.trim() ?? "";
  const allocations = split.allocations;
  if (author === "" || allocations.length === 0)
    return copy.rights.includeCreator;
  const recipients = new Set<string>();
  let total = 0;
  for (const allocation of allocations) {
    const recipientId = allocation.recipientId?.trim() ?? "";
    if (recipientId === "") return copy.rights.missingRecipient;
    if (recipients.has(recipientId)) return copy.rights.uniqueRecipients;
    recipients.add(recipientId);
    const bps = allocationBps(allocation);
    if (!Number.isInteger(bps) || bps <= 0 || bps > TOTAL_BPS)
      return copy.rights.positiveShares;
    total += bps;
  }
  if (!recipients.has(author)) return copy.rights.includeCreator;
  if (total !== TOTAL_BPS) return copy.rights.totalExact;
  return "";
}

function PercentField(props: {
  ariaLabel: string;
  copy: ComposerCopy;
  disabled?: boolean;
  maxBps: number;
  onCommit: (bps: number) => void;
  onReject?: (message: string) => void;
  rejectMessage: string;
  valueBps?: number;
}) {
  const committedText = () =>
    props.valueBps === undefined
      ? ""
      : basisPointsToPercentText(props.valueBps);
  const reject = (input: HTMLInputElement, message: string) => {
    // Restore the input to what will actually submit. A displayed share that
    // the commit path ignored is how a silent mismatch reaches Review.
    input.value = committedText();
    props.onReject?.(message);
  };
  return (
    <div class="grid h-11 grid-cols-[minmax(0,1fr)_1.25rem] items-center rounded-[var(--radius-lg)] border border-input bg-background px-3">
      <Input
        aria-label={props.ariaLabel}
        class="border-0 px-0 text-end tabular-nums shadow-none focus-visible:ring-0"
        disabled={props.disabled}
        inputmode="decimal"
        onChange={(event) => {
          const input = event.currentTarget;
          let bps: number;
          try {
            bps = percentTextToBasisPoints(input.value);
          } catch {
            reject(input, props.copy.rights.invalidShare);
            return;
          }
          if (bps <= 0 || bps > props.maxBps) {
            reject(input, props.rejectMessage);
            return;
          }
          props.onReject?.("");
          props.onCommit(bps);
        }}
        placeholder="0"
        value={committedText()}
      />
      <span class="text-end font-semibold text-muted-foreground">%</span>
    </div>
  );
}

function ProfileRowContent(props: {
  profile: ComposerRecipientProfile | undefined;
  fallback: string;
}) {
  const handle = () => props.profile?.handle?.trim();
  return (
    <>
      <Avatar
        class="size-9 shrink-0 border-0 bg-card"
        fallback={authorLabel(props.profile, props.fallback)}
        size="sm"
        src={props.profile?.avatarSrc ?? undefined}
      />
      <span class="min-w-0">
        <Type as="span" class="block truncate" variant="body-strong">
          {authorLabel(props.profile, props.fallback)}
        </Type>
        <Show when={handle()}>
          {(value) => (
            <Type
              as="span"
              class="block truncate text-muted-foreground"
              variant="caption"
            >
              {value()}
            </Type>
          )}
        </Show>
      </span>
    </>
  );
}

function CollaboratorPicker(props: {
  candidates: readonly ComposerRecipientProfile[];
  copy: ComposerCopy;
  maxShareBps: number;
  onAdd: (personaId: string, shareBps: number) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const [query, setQuery] = createSignal("", { ownedWrite: true });
  const [selectedId, setSelectedId] = createSignal<string | undefined>(
    undefined,
    { ownedWrite: true },
  );
  const [shareBps, setShareBps] = createSignal<number | undefined>(undefined, {
    ownedWrite: true,
  });
  const [shareError, setShareError] = createSignal("", { ownedWrite: true });
  const filtered = () => {
    const needle = query().trim().toLowerCase();
    if (needle === "") return props.candidates;
    return props.candidates.filter((profile) =>
      `${profile.displayName} ${profile.handle ?? ""}`
        .toLowerCase()
        .includes(needle),
    );
  };
  const selected = () =>
    props.candidates.find((profile) => profile.personaId === selectedId());
  const canAdd = () =>
    selected() !== undefined &&
    shareBps() !== undefined &&
    shareBps()! > 0 &&
    shareBps()! <= props.maxShareBps;
  // A fresh open starts a fresh choice. The host opens this sheet by setting
  // `open` directly, so the reset tracks that transition rather than the
  // Modal's own onOpenChange callback, which only fires for dismissals.
  createEffect(
    () => props.open,
    (open) => {
      if (!open) return;
      setQuery("");
      setSelectedId(undefined);
      setShareBps(undefined);
      setShareError("");
    },
  );

  return (
    <Modal forceMobile onOpenChange={props.onOpenChange} open={props.open}>
      <ModalContent
        class="flex max-h-[85dvh] flex-col rounded-t-[var(--radius-3xl)] px-0 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-4 sm:rounded-[var(--radius-xl)]"
        mobileSide="bottom"
      >
        <div
          aria-hidden="true"
          class="mx-auto mb-4 h-1 w-12 rounded-full bg-muted sm:hidden"
        />
        <ModalHeader class="px-5 pb-3 text-start sm:px-6">
          <ModalTitle leading="tight" variant="h3">
            {props.copy.rights.addCollaborator}
          </ModalTitle>
        </ModalHeader>
        <div class="px-5 pb-2 sm:px-6">
          <Input
            aria-label={props.copy.rights.searchProfiles}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={props.copy.rights.searchProfiles}
            value={query()}
          />
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto px-2 sm:px-3">
          <For each={filtered()}>
            {(profile) => (
              <button
                aria-pressed={
                  selectedId() === profile.personaId ? "true" : "false"
                }
                class="grid w-full grid-cols-[2.25rem_minmax(0,1fr)] items-center gap-3 rounded-[var(--radius-lg)] px-3 py-2 text-start transition-colors hover:bg-muted/60 aria-pressed:bg-primary-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => {
                  setSelectedId(profile.personaId);
                  setShareBps(undefined);
                  setShareError("");
                }}
                type="button"
              >
                <ProfileRowContent fallback="Profile" profile={profile} />
              </button>
            )}
          </For>
          <Show when={props.candidates.length === 0}>
            <div class="px-3 py-4">
              <FormNote>{props.copy.rights.everyProfileHasShare}</FormNote>
            </div>
          </Show>
          <Show when={props.candidates.length > 0 && filtered().length === 0}>
            <div class="px-3 py-4">
              <FormNote>{props.copy.rights.noMatchingProfiles}</FormNote>
            </div>
          </Show>
        </div>
        <Show when={selected()}>
          {(profile) => (
            <div class="grid gap-3 border-t border-border-soft px-5 pt-4 sm:px-6">
              <div class="grid grid-cols-[minmax(0,1fr)_7rem] items-center gap-3">
                <FieldLabel
                  label={`${props.copy.rights.share} for ${profile().displayName}`}
                />
                <PercentField
                  ariaLabel={`${props.copy.rights.share} for ${profile().displayName}`}
                  copy={props.copy}
                  maxBps={props.maxShareBps}
                  onCommit={(bps) => {
                    setShareError("");
                    setShareBps(bps);
                  }}
                  onReject={setShareError}
                  rejectMessage={props.copy.rights.overRemaining}
                  valueBps={shareBps()}
                />
              </div>
              <Show when={props.maxShareBps <= 0}>
                <FormNote tone="warning">
                  {props.copy.rights.overRemaining}
                </FormNote>
              </Show>
              <Show when={shareError()}>
                <FormNote tone="warning">{shareError()}</FormNote>
              </Show>
              <Button
                disabled={!canAdd()}
                onClick={() => {
                  const personaId = selected()?.personaId;
                  const bps = shareBps();
                  if (personaId === undefined || bps === undefined) return;
                  props.onAdd(personaId, bps);
                  props.onOpenChange(false);
                }}
              >
                {props.copy.rights.addProfile}
              </Button>
            </div>
          )}
        </Show>
      </ModalContent>
    </Modal>
  );
}

/**
 * Earnings split: one row per recipient, the author's remainder derived from
 * what collaborators are given. There is no server field and no wallet input;
 * the author sees who is paid and how much, in the same row on every width.
 */
export function EarningsSplit(props: {
  authorPersonaId?: string;
  copy: ComposerCopy;
  disabled?: boolean;
  onChange: (next: AssetRoyaltySplitState) => void;
  recipients: readonly ComposerRecipientProfile[];
  split: AssetRoyaltySplitState;
}) {
  const [pickerOpen, setPickerOpen] = createSignal(false);
  const [shareError, setShareError] = createSignal("");
  const collaborators = createMemo(() =>
    props.split.allocations.filter(
      (allocation) => allocation.recipientKind !== "creator",
    ),
  );
  const collaboratorBps = createMemo(() =>
    collaborators().reduce(
      (sum, allocation) => sum + allocationBps(allocation),
      0,
    ),
  );
  const creatorBps = createMemo(() => {
    const creator = props.split.allocations.find(
      (allocation) => allocation.recipientKind === "creator",
    );
    return creator === undefined
      ? Math.max(0, TOTAL_BPS - collaboratorBps())
      : allocationBps(creator);
  });
  const profileFor = (personaId: string | undefined) =>
    props.recipients.find((profile) => profile.personaId === personaId);
  const pickerCandidates = () =>
    props.recipients.filter(
      (profile) =>
        profile.personaId !== props.authorPersonaId &&
        !collaborators().some(
          (allocation) => allocation.recipientId === profile.personaId,
        ),
    );

  const withDerivedCreator = (
    allocations: readonly AssetRoyaltyAllocation[],
  ): AssetRoyaltySplitState => {
    const collaboratorTotal = allocations
      .filter((allocation) => allocation.recipientKind !== "creator")
      .reduce((sum, allocation) => sum + allocationBps(allocation), 0);
    const derivedBps = Math.max(0, TOTAL_BPS - collaboratorTotal);
    const retained = allocations.find(
      (allocation) => allocation.recipientKind === "creator",
    );
    const creator: AssetRoyaltyAllocation = {
      id: retained?.id ?? "creator",
      recipientKind: "creator",
      recipientId: retained?.recipientId ?? props.authorPersonaId,
      shareBps: derivedBps,
      sharePct: derivedBps / 100,
    };
    return {
      allocations: [
        creator,
        ...allocations.filter(
          (allocation) => allocation.recipientKind !== "creator",
        ),
      ],
    };
  };

  const addCollaborator = (personaId: string, shareBps: number) => {
    props.onChange(
      withDerivedCreator([
        ...props.split.allocations,
        {
          id: `recipient-${personaId}`,
          recipientKind: "collaborator",
          recipientId: personaId,
          shareBps,
          sharePct: shareBps / 100,
        },
      ]),
    );
  };
  const updateCollaborator = (id: string, shareBps: number) => {
    props.onChange(
      withDerivedCreator(
        props.split.allocations.map((allocation) =>
          allocation.id === id
            ? { ...allocation, shareBps, sharePct: shareBps / 100 }
            : allocation,
        ),
      ),
    );
  };
  const removeCollaborator = (id: string) => {
    props.onChange(
      withDerivedCreator(
        props.split.allocations.filter((allocation) => allocation.id !== id),
      ),
    );
  };

  const addButton = () => (
    <Button
      disabled={props.disabled}
      onClick={() => setPickerOpen(true)}
      class="h-11 w-full"
      variant="outline"
    >
      {props.copy.rights.addCollaborator}
    </Button>
  );

  return (
    <section class="space-y-3">
      <Type as="h3" variant="body-strong">
        {props.copy.rights.earningsTitle}
      </Type>
      <div class="divide-y divide-border-soft overflow-hidden rounded-[var(--radius-lg)] border border-border-soft bg-background">
        <div class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-3">
          <div class="flex min-w-0 items-center gap-3">
            <Avatar
              class="size-8 shrink-0 border-0 bg-secondary text-xs font-semibold"
              fallback={authorLabel(
                profileFor(props.authorPersonaId),
                props.copy.review.you,
              )}
              size="sm"
              src={profileFor(props.authorPersonaId)?.avatarSrc ?? undefined}
            />
            <Type as="span" variant="body">
              {props.copy.review.you}
            </Type>
          </div>
          <Type
            as="span"
            class="text-end text-base tabular-nums"
            variant="body-strong"
          >
            {basisPointsToPercentText(creatorBps())}%
          </Type>
        </div>
        <For each={collaborators()}>
          {(allocation) => {
            const profile = () => profileFor(allocation.recipientId);
            const name = () => authorLabel(profile(), "Collaborator");
            return (
              <div class="grid grid-cols-[minmax(0,1fr)_4.5rem_2.5rem] items-center gap-2 px-3 py-2">
                <div class="flex min-w-0 items-center gap-2.5">
                  <ProfileRowContent fallback={name()} profile={profile()} />
                </div>
                <PercentField
                  ariaLabel={`${props.copy.rights.share} for ${name()}`}
                  copy={props.copy}
                  disabled={props.disabled}
                  maxBps={Math.max(
                    1,
                    creatorBps() + allocationBps(allocation) - 1,
                  )}
                  onCommit={(bps) => {
                    setShareError("");
                    updateCollaborator(allocation.id, bps);
                  }}
                  onReject={setShareError}
                  rejectMessage={props.copy.rights.overRemaining}
                  valueBps={allocationBps(allocation)}
                />
                <Button
                  aria-label={`Remove ${name()}`}
                  class="h-10 w-10"
                  disabled={props.disabled}
                  onClick={() => removeCollaborator(allocation.id)}
                  size="icon"
                  variant="ghost"
                >
                  <IconTrash class="size-5" />
                </Button>
              </div>
            );
          }}
        </For>
      </div>
      <Show when={shareError()}>
        <FormNote tone="warning">{shareError()}</FormNote>
      </Show>
      {addButton()}
      <CollaboratorPicker
        candidates={pickerCandidates()}
        copy={props.copy}
        maxShareBps={Math.max(0, creatorBps() - 1)}
        onAdd={addCollaborator}
        onOpenChange={setPickerOpen}
        open={pickerOpen()}
      />
    </section>
  );
}
