import { createEffect, createSignal, onCleanup } from "solid-js";
import { isServer } from "@solidjs/web";
import type {
  DanceQueue,
  DanceReview,
  DanceVerdict,
  DanceConsentPolicy,
} from "../../../../packages/dance/contracts.ts";
import { privateAccessLost, type DanceClient } from "./client.ts";
import { assertDanceSurfaces, type DanceMediaUiPort } from "./media-port.ts";
import { danceError, danceStatus } from "./presentation.ts";
import { DanceOwnerReviewSurface } from "./reference-owner-surface.tsx";
export function DanceReviewQueue(props: {
  client: DanceClient;
  accountId: string;
  media: DanceMediaUiPort;
  reviewDisclosure: DanceConsentPolicy;
}) {
  assertDanceSurfaces(props.media);
  const [page, setPage] = createSignal<DanceQueue | null>(null),
    [detail, setDetail] = createSignal<DanceReview | null>(null),
    [busy, setBusy] = createSignal(false),
    [error, setError] = createSignal(""),
    [preview, setPreview] = createSignal(false);
  let active = true;
  const account = props.accountId,
    current = () => active && props.accountId === account;
  function clear() {
    props.media.clearPrivate();
    setPreview(false);
    setPage(null);
    setDetail(null);
  }
  createEffect(
    () => props.accountId,
    (next) => {
      if (next === account) return;
      clear();
      setError("This review isn’t available to you.");
    },
  );
  onCleanup(() => {
    active = false;
    clear();
  });
  async function run(use: () => Promise<void>) {
    if (busy() || !current()) return;
    setBusy(true);
    setError("");
    try {
      await use();
    } catch (e) {
      if (current()) {
        if (privateAccessLost(e)) clear();
        setError(danceError(e));
      }
    } finally {
      if (current()) setBusy(false);
    }
  }
  async function recover() {
    const entry = await props.client.recover();
    if (!current()) return false;
    const id = entry?.path.match(/^reviews\/([^/]+)\/verdict$/)?.[1];
    if (id) {
      setDetail(await props.client.get(id));
      setPreview(false);
      await props.client.acknowledgeRecovery();
      return true;
    }
    await props.client.acknowledgeRecovery();
    return false;
  }
  async function load(more = false) {
    await run(async () => {
      if (await recover()) return;
      const next = await props.client.queue(more ? page()?.cursor : null);
      if (!current()) return;
      setPage(
        more && page()
          ? { ...next, items: [...page()!.items, ...next.items] }
          : next,
      );
      setDetail(null);
      props.media.clearPrivate();
      setPreview(false);
    });
  }
  async function select(r: DanceReview) {
    await run(async () => {
      if (await recover()) return;
      const fresh = await props.client.get(r.reviewId);
      if (current()) {
        props.media.clearPrivate();
        setDetail(fresh);
        setPreview(false);
      }
    });
  }
  async function decide(v: DanceVerdict) {
    await run(async () => {
      const r = detail();
      if (!r) return;
      props.media.clearPrivate();
      setPreview(false);
      setDetail({ ...r, state: "decision_pending" });
      await props.client.decide(
        r.reviewId,
        r.revision,
        v,
        props.reviewDisclosure.version,
      );
      const fresh = await props.client.get(r.reviewId);
      if (current()) setDetail(fresh);
    });
  }
  async function play() {
    await run(async () => {
      const r = detail();
      if (!r) return;
      await props.client.get(r.reviewId);
      if (current()) setPreview(true);
    });
  }
  if (!isServer) void load();
  return (
    <DanceOwnerReviewSurface
      loading={busy()}
      error={error()}
      page={page()}
      detail={detail()}
      privatePreview={
        detail() && preview() ? props.media.privatePreview(detail()!) : null
      }
      referencePreview={
        detail()?.capture.reference
          ? props.media.referencePreview(detail()!)
          : null
      }
      previewReady={preview()}
      reviewDisclosure={props.reviewDisclosure.text}
      canDecide={
        props.reviewDisclosure.admission === "admitted" &&
        !!detail() &&
        detail()!.state === "awaiting_review" &&
        !detail()!.localDenied &&
        !detail()!.decision
      }
      status={detail() ? danceStatus(detail()!).detail : ""}
      onPreview={() => void play()}
      onSelect={(r) => void select(r)}
      onMore={() => void load(true)}
      onLoad={() => void load()}
      onDecide={(v) => void decide(v)}
    />
  );
}
