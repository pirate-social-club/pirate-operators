import { createSignal, For, Show, onCleanup, onSettled } from "solid-js";
import type { Hex } from "viem";
import type { PublicationPurpose } from "../../../../packages/protocol/publication-consent.ts";
import { Button, Type } from "../ui.ts";
import { get, type CommunitySessionView } from "./api.ts";
import { publicationGrant, publicationWalletRequest, type PublicationGrantStatus } from "./publication-grant.ts";

const purposes = {
  "study-results": ["Study results", "Allow publication of eligible Study results."],
  "karaoke-results": ["Karaoke results", "Allow publication of eligible Karaoke results."],
  "dance-verdict": ["Dance verdict", "Allow the verdict for a Dance recording you explicitly submit to be published."],
  "dance-review-attribution": ["Dance review attribution", "Allow published Dance verdicts you issue as an authorized reviewer to be attributed to you."],
} as const satisfies Record<PublicationPurpose, readonly [string, string]>;
const labels = {
  prepare: "Continue preparing",
  resume: "Review original request",
  signed: "Retry the same signed request",
  pending: "Check the original request",
  empty: "Review publication request",
  expired: "Review a new grant",
  refused: "Review a new grant",
  recorded: "Review a new grant",
  unavailable: "Check the original request",
} satisfies Record<Exclude<PublicationGrantStatus["kind"], "review">, string>;
const documents = [["terms", "Terms"], ["disclosure", "Disclosure"], ["privacy", "Privacy"], ["retention", "Retention"]] as const;
type Sign = (wallet: string, data: ReturnType<typeof publicationWalletRequest>, current: () => void) => Promise<Hex | null>;

export function PublicationGrants(props: {
  communityId: string;
  session: () => CommunitySessionView | null;
  sign: Sign;
}) {
  const [available, setAvailable] = createSignal<PublicationPurpose[]>([]);
  const [purpose, setPurpose] = createSignal<PublicationPurpose | null>(null);
  let active = true;
  onCleanup(() => { active = false; });
  onSettled(() => {
    void get<{ profile: string; purposes: string[] }>("/api/publication-consent/v1/capabilities", { timeoutMs: 10_000 })
      .then((value) => {
        if (active && value.profile === "publication-consent-v1" && Array.isArray(value.purposes))
          setAvailable((Object.keys(purposes) as PublicationPurpose[]).filter((key) => value.purposes.includes(key)));
      }).catch(() => {});
  });
  return (
    <Show when={available().length > 0}>
      <section aria-label="Publication permissions" class="flex flex-col gap-3">
        <Type as="h2" variant="h3">Publication permissions</Type>
        <label class="flex flex-col gap-1">
          Publication purpose
          <select class="rounded border border-border-soft bg-transparent p-2"
            onChange={(event) => setPurpose((event.currentTarget.value || null) as PublicationPurpose | null)}>
            <option value="">Choose a purpose</option>
            <For each={available()}>{(key) => <option value={key}>{purposes[key][0]}</option>}</For>
          </select>
        </label>
        <Show when={purpose()} keyed>{(key) => <GrantPurpose {...props} purpose={key} />}</Show>
      </section>
    </Show>
  );
}

function GrantPurpose(props: {
  communityId: string;
  session: () => CommunitySessionView | null;
  purpose: PublicationPurpose;
  sign: Sign;
}) {
  const initialSession = props.session();
  const wallet = initialSession?.mossAddress.toLowerCase() ?? "";
  const origin = location.origin;
  const communityId = props.communityId;
  let active = true;
  onCleanup(() => { active = false; });
  function current() {
    const session = props.session();
    if (!active || !initialSession || !wallet || location.origin !== origin || props.communityId !== communityId ||
      session?.csrf !== initialSession.csrf || session?.authorId !== initialSession.authorId ||
      session?.mossAddress.toLowerCase() !== wallet)
      throw Error("Sign in to check your publication request.");
  }
  const controller = publicationGrant({ origin, communityId,
    authorId: initialSession?.authorId ?? "", wallet, purpose: props.purpose,
  }, {
    csrf: () => initialSession?.csrf ?? "",
    current,
    sign: (review) => props.sign(wallet, publicationWalletRequest(review.command), current),
  });
  const [status, setStatus] = createSignal<PublicationGrantStatus>({ kind: "unavailable" });
  const [busy, setBusy] = createSignal(false);
  const [notice, setNotice] = createSignal("");
  async function run(operation: () => Promise<PublicationGrantStatus>) {
    if (busy()) return;
    setBusy(true);
    setNotice("");
    try {
      const next = await operation();
      if (active) setStatus(next);
    } catch {
      if (active) setNotice("The request was interrupted. Check the original request or try the same step again.");
    } finally {
      if (active) setBusy(false);
    }
  }
  onSettled(() => { void run(controller.check); });
  function next(kind: Exclude<PublicationGrantStatus["kind"], "review">) {
    if (kind === "pending" || kind === "unavailable") return controller.check;
    if (kind === "signed") return () => controller.submit();
    return () => controller.prepare(["expired", "recorded", "refused"].includes(kind));
  }
  return (
    <div class="flex flex-col gap-3">
      <Type as="p">{purposes[props.purpose][1]}</Type>
      <Show when={status().kind === "recorded"}><Type as="p" role="status">Publication grant recorded.</Type></Show>
      <Show when={status().kind === "pending"}><Type as="p" role="status">Waiting for the original grant to be recorded.</Type></Show>
      <Show when={status().kind === "refused" || status().kind === "expired"}>
        <Type as="p" role="status">The original grant is no longer available.</Type>
      </Show>
      <Show when={notice()}><Type as="p" role="status">{notice()}</Type></Show>
      <Show when={status()} keyed>{(current) => current.kind === "review" ? (
        <>
          <For each={documents}>{([key, label]) => (
            <details class="rounded border border-border-soft p-2">
              <summary>{label}</summary>
              <p class="whitespace-pre-wrap">{current.review.documents[key]}</p>
            </details>
          )}</For>
          <Button variant="outline" disabled={busy()} onClick={() => void run(() => controller.submit(current.review))}>Sign publication grant in MOSS</Button>
        </>
      ) : (
        <Button variant="outline" disabled={busy()} onClick={() => void run(next(current.kind))}>{labels[current.kind]}</Button>
      )}</Show>
      <Show when={notice() && status().kind !== "pending" && status().kind !== "unavailable"}>
        <Button variant="ghost" disabled={busy()} onClick={() => void run(controller.check)}>Check the original request</Button>
      </Show>
    </div>
  );
}
