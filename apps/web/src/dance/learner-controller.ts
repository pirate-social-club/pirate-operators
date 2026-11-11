import type {
  DanceCapture,
  DanceConsentPolicy,
  DanceReview,
} from "../../../../packages/dance/contracts.ts";
import type { DanceClient } from "./client.ts";
import { privateAccessLost } from "./client.ts";
import type { DanceTake } from "./media-port.ts";
export interface DanceLearnerState {
  phase: "capture" | "preview" | "submission_unknown" | "submitted" | "denied";
  capture: DanceCapture | null;
  take: DanceTake | null;
  review: DanceReview | null;
  busy: boolean;
  error: string;
}
export function createDanceLearnerController(options: {
  client: DanceClient;
  selection: {
    songKey: string;
    offerId: string | null;
    referenceId: string | null;
  };
  consent: DanceConsentPolicy;
  record: (
    capture: DanceCapture,
  ) => Promise<{ status: "ready"; take: DanceTake } | { status: "canceled" }>;
  clearPrivate: () => void;
  changed: (state: DanceLearnerState) => void;
  current: () => boolean;
}) {
  let state: DanceLearnerState = {
    phase: "capture",
    capture: null,
    take: null,
    review: null,
    busy: false,
    error: "",
  };
  const emit = (patch: Partial<DanceLearnerState>) => {
    state = { ...state, ...patch };
    if (options.current()) options.changed(state);
  };
  function failure(e: unknown) {
    if (privateAccessLost(e)) {
      options.clearPrivate();
      emit({
        phase: "denied",
        capture: null,
        take: null,
        review: null,
        error: "Review access is unavailable.",
        busy: false,
      });
    } else
      emit({ error: e instanceof Error ? e.message : "dance_unavailable" });
  }
  async function run(use: () => Promise<void>) {
    if (state.busy || !options.current()) return;
    emit({ busy: true, error: "" });
    try {
      await use();
    } catch (e) {
      failure(e);
    } finally {
      emit({ busy: false });
    }
  }
  async function load(id?: string) {
    await run(async () => {
      const recovered = await options.client.recover();
      const body = recovered
        ? (JSON.parse(recovered.bodyJson) as { captureId?: string })
        : null;
      const resolved =
        id ??
        (recovered?.path === "reviews"
          ? body?.captureId
          : recovered?.path.match(
              /^reviews\/([^/]+)\/(?:verdict|withdraw)$/,
            )?.[1]);
      if (resolved) {
        const review = await options.client.get(resolved);
        emit({ phase: "submitted", review, capture: null, take: null });
      } else if (recovered?.path === "captures" && recovered.receiptJson)
        emit({ capture: JSON.parse(recovered.receiptJson) as DanceCapture });
      await options.client.acknowledgeRecovery();
    });
  }
  async function record() {
    await run(async () => {
      if (state.phase === "submission_unknown")
        throw Error("dance_response_unknown");
      if (options.consent.admission !== "admitted")
        throw Error("dance_terms_admission_held");
      const p = options.consent;
      const capture =
        state.capture ??
        (await options.client.capture(
          options.selection.songKey,
          options.selection.offerId,
          options.selection.referenceId,
          {
            accepted: true,
            version: p.version,
            termsHash: p.termsHash,
            publicityPolicyHash: p.publicityPolicyHash,
          },
        ));
      emit({ capture });
      await options.client.acknowledgeRecovery();
      const result = await options.record(capture);
      if (!options.current()) {
        options.clearPrivate();
        return;
      }
      if (result.status === "canceled") {
        await options.client.resetDefiniteCapture();
        options.clearPrivate();
        emit({ phase: "capture", capture: null, take: null });
      } else emit({ phase: "preview", take: result.take });
    });
  }
  async function observe(id: string) {
    // Background status observation must not dispatch command recovery.
    if (state.error && /unknown|journal/.test(state.error)) return;
    await run(async () => {
      const review = await options.client.get(id);
      emit({ phase: "submitted", review, capture: null, take: null });
    });
  }
  async function submit() {
    await run(async () => {
      const c = state.capture,
        t = state.take;
      if (!c || !t) throw Error("dance_take_missing");
      emit({ phase: "submission_unknown" });
      try {
        await options.client.submit(c.captureId, t.mediaId, t.recordingSha256);
      } catch (e) {
        if (e instanceof Error && e.message === "dance_capture_expired") {
          await options.client.resetDefiniteCapture();
          options.clearPrivate();
          emit({ phase: "capture", capture: null, take: null });
        }
        throw e;
      }
      const r = await options.client.get(c.captureId);
      await options.client.acknowledgeRecovery();
      options.clearPrivate();
      emit({ phase: "submitted", review: r, capture: null, take: null });
    });
  }
  async function reset() {
    await run(async () => {
      if (state.phase === "submission_unknown")
        throw Error("dance_response_unknown");
      await options.client.resetDefiniteCapture();
      options.clearPrivate();
      emit({ phase: "capture", capture: null, take: null, review: null });
    });
  }
  async function withdraw() {
    await run(async () => {
      const review = state.review;
      if (!review || state.phase !== "submitted")
        throw Error("dance_review_unavailable");
      // The existing journal reserves this exact command before dispatch.
      // Uncertain replies recover it before any different action.
      await options.client.withdraw(review.reviewId, review.revision);
      options.clearPrivate();
      emit({ phase: "denied", capture: null, take: null, review: null });
      await options.client.acknowledgeRecovery();
    });
  }
  return {
    load,
    observe,
    record,
    submit,
    reset,
    withdraw,
    get state() {
      return state;
    },
    clear: () => {
      options.clearPrivate();
      state = {
        phase: "denied",
        capture: null,
        take: null,
        review: null,
        busy: false,
        error: "",
      };
      if (options.current()) options.changed(state);
    },
  };
}
