// Adapted from c7 dance-preparation-controller: original prepare/start/reconcile
// and closeTerminal ownership, with V5's combined reservation/consent boundary.
import type { DanceCapture } from "../../../../../packages/dance/contracts.ts";
import { DanceClientError } from "../client.ts";
import {
  assertCapture,
  assertCurrent,
  type DanceSourcePorts,
} from "./ports.ts";
import {
  danceSession,
  type DanceSession,
  type DanceCaptureContext,
  type DanceObjectivesContext,
} from "./dance-preparation-api.ts";
import { assertDanceReview } from "./dance-review-api.ts";

export type DancePreparationView =
  | {
      readonly kind: "objectives";
      readonly session: null;
      readonly context: DanceObjectivesContext;
      readonly consentRequested?: true;
    }
  | {
      readonly kind: "capture_ready";
      readonly session: DanceSession;
      readonly context: DanceCaptureContext;
      readonly assertCurrent: () => void;
    }
  | {
      readonly kind: "upload_recovery" | "terminal" | "expired";
      readonly session: DanceSession;
      readonly context: null;
    };

export function createDancePreparationController(options: DanceSourcePorts) {
  let generation = 0;
  const now = options.nowMs ?? Date.now;
  const begin = (signal: AbortSignal) => {
    assertCurrent(options, signal);
    const selected = ++generation;
    return () => {
      assertCurrent(options, signal);
      if (selected !== generation) throw Error("dance_preparation_superseded");
    };
  };
  function ready(
    capture: DanceCapture,
    guard: () => void,
  ): DancePreparationView {
    assertCapture(capture, options.scope);
    const session = danceSession(capture, options.media.maximumBytes);
    if (now() >= capture.expiresAtMs)
      return { kind: "expired", session, context: null };
    return {
      kind: "capture_ready",
      session,
      context: {
        session,
        reference: {
          canonical_song_start_ms: capture.startSample / 48,
          canonical_song_end_ms:
            (capture.startSample + capture.durationSamples) / 48,
        },
      },
      assertCurrent: () => {
        guard();
        if (now() >= capture.expiresAtMs)
          throw Error("dance_preparation_capture_expired");
      },
    };
  }
  async function retained(guard: () => void) {
    if (!options.client.retained || !options.client.observe)
      throw Error("dance_source_client_port_unavailable");
    const value = await options.client.retained();
    guard();
    if (
      value &&
      (value.scope.accountId !== options.scope.accountId ||
        value.scope.communityId !== options.scope.communityId)
    )
      throw Error("dance_account_changed");
    return value;
  }
  return {
    async prepare(
      expectedTerms: string,
      signal: AbortSignal,
    ): Promise<DancePreparationView> {
      const guard = begin(signal);
      if (expectedTerms !== options.consent.termsHash)
        throw Error("dance_preparation_objectives_changed");
      return options.journal.exclusive(options.scope, guard, async (handle) => {
        const entry = handle.read(),
          original = await retained(guard);
        if (
          entry.terminal &&
          entry.capture &&
          !entry.captureUnknown &&
          entry.submission !== "unknown"
        ) {
          assertCapture(entry.capture, options.scope);
          return {
            kind: entry.terminal === "expired" ? "expired" : "terminal",
            session: danceSession(entry.capture, options.media.maximumBytes),
            context: null,
          };
        }
        if (
          !entry.capture &&
          original?.path.startsWith("reviews") &&
          original.receiptJson
        ) {
          const receipt = JSON.parse(original.receiptJson) as {
            reviewId?: string;
          };
          if (!receipt.reviewId || !options.client.observe)
            throw Error("dance_original_command_missing");
          const review = await options.client.observe(receipt.reviewId);
          guard();
          assertDanceReview(review, options.scope);
          await handle.save({
            capture: review.capture,
            submission: "accepted",
          });
          guard();
          return {
            kind: "upload_recovery",
            session: danceSession(review.capture, options.media.maximumBytes),
            context: null,
          };
        }
        if (entry.submission !== "none" || entry.upload) {
          if (!entry.capture) throw Error("dance_original_command_missing");
          if (entry.submission === "accepted" && options.client.observe) {
            const review = await options.client.observe(
              entry.capture.captureId,
              signal,
            );
            guard();
            assertDanceReview(review, options.scope, entry.capture);
            if (
              review.canonical?.canonical &&
              review.canonical.finality === "safe"
            )
              return {
                kind: "terminal",
                session: danceSession(
                  entry.capture,
                  options.media.maximumBytes,
                ),
                context: null,
              };
          }
          return {
            kind: "upload_recovery",
            session: danceSession(entry.capture, options.media.maximumBytes),
            context: null,
          };
        }
        // Loading never replays an unknown reservation. Explicit Retry must
        // recover the old durable client command, before any different action.
        if (entry.captureUnknown || (original && !original.receiptJson))
          throw Error("dance_response_unknown");
        let capture = entry.capture;
        if (!capture && original?.path === "captures" && original.receiptJson) {
          capture = JSON.parse(original.receiptJson) as DanceCapture;
          assertCapture(capture, options.scope);
          await handle.save({ capture, captureUnknown: false });
          guard();
        }
        if (capture) {
          assertCapture(capture, options.scope);
          const session = danceSession(capture, options.media.maximumBytes);
          if (entry.terminal || now() >= capture.expiresAtMs)
            return {
              kind: entry.terminal === "canceled" ? "terminal" : "expired",
              session,
              context: null,
            };
        }
        // Reservation is made only by the deliberate source Accept gesture.
        return {
          kind: "objectives",
          session: null,
          context: { consent: options.consent },
          ...(capture ? { consentRequested: true as const } : {}),
        };
      });
    },
    async start(
      acceptedTermsHash: string,
      signal: AbortSignal,
    ): Promise<DancePreparationView> {
      const guard = begin(signal),
        p = options.consent;
      if (p.admission !== "admitted" || acceptedTermsHash !== p.termsHash)
        throw Error("dance_terms_admission_held");
      return options.journal.exclusive(options.scope, guard, async (handle) => {
        let entry = handle.read();
        const original = await retained(guard);
        if (
          entry.captureUnknown ||
          entry.upload ||
          entry.submission !== "none" ||
          entry.terminal ||
          (original && !original.receiptJson)
        )
          throw Error("dance_response_unknown");
        let capture = entry.capture;
        if (!capture) {
          // This commit finishes before dispatch. The client additionally
          // reserves its exact consent/selection command ID/body durably.
          await handle.save({ captureUnknown: true });
          guard();
          try {
            capture = await options.client.capture(
              options.scope.songKey,
              options.scope.offerId,
              options.scope.reference?.id ?? null,
              {
                accepted: true,
                version: p.version,
                termsHash: p.termsHash,
                publicityPolicyHash: p.publicityPolicyHash,
              },
              signal,
            );
            guard();
            assertCapture(capture, options.scope);
            entry = await handle.save({ capture, captureUnknown: false });
            guard();
          } catch (e) {
            // A definite server expiry is distinguishable; auth/transport
            // refusal does not discard a potentially accepted reservation.
            if (
              e instanceof DanceClientError &&
              e.status === 410 &&
              e.code === "dance_capture_expired"
            ) {
              await handle.save({ captureUnknown: false });
              guard();
            }
            throw e;
          }
        }
        assertCapture(capture, options.scope);
        if (
          capture.consent?.version !== p.version ||
          capture.consent.termsHash !== p.termsHash ||
          capture.consent.publicityPolicyHash !== p.publicityPolicyHash
        )
          throw Error("dance_preparation_objectives_changed");
        return ready(capture, guard);
      });
    },
    async recover(
      expectedTerms: string,
      signal: AbortSignal,
    ): Promise<DancePreparationView> {
      const guard = begin(signal);
      await options.client.recover(signal);
      guard();
      return options.journal.exclusive(options.scope, guard, async (handle) => {
        const original = await retained(guard),
          entry = handle.read();
        let capture = entry.capture;
        if (original?.path === "captures" && original.receiptJson)
          capture = JSON.parse(original.receiptJson) as DanceCapture;
        if (!capture) throw Error("dance_original_command_missing");
        assertCapture(capture, options.scope);
        await handle.save({ capture, captureUnknown: false });
        guard();
        if (entry.upload || entry.submission !== "none")
          return {
            kind: "upload_recovery",
            session: danceSession(capture, options.media.maximumBytes),
            context: null,
          };
        if (capture.termsHash !== expectedTerms)
          throw Error("dance_preparation_objectives_changed");
        return {
          kind: "objectives",
          session: null,
          context: { consent: options.consent },
          consentRequested: true,
        };
      });
    },
    async closeTerminal(signal: AbortSignal): Promise<void> {
      const guard = begin(signal);
      await options.journal.exclusive(options.scope, guard, async (handle) => {
        const entry = handle.read(),
          original = await retained(guard);
        if (
          entry.captureUnknown ||
          entry.submission === "unknown" ||
          (original && !original.receiptJson)
        )
          throw Error("dance_preparation_resolution_unproven");
        if (entry.submission === "accepted") {
          if (!entry.capture || !options.client.observe)
            throw Error("dance_preparation_resolution_unproven");
          const review = await options.client.observe(
            entry.capture.captureId,
            signal,
          );
          guard();
          assertDanceReview(review, options.scope, entry.capture);
          if (
            !review.canonical?.canonical ||
            review.canonical.finality !== "safe"
          )
            throw Error("dance_preparation_resolution_unproven");
        } else if (entry.upload && entry.terminal !== "expired") {
          if (!entry.capture || !entry.upload.mediaId)
            throw Error("dance_preparation_resolution_unproven");
          const status = await options.media.status(
            entry.capture,
            entry.upload.mediaId,
            signal,
          );
          guard();
          if (
            status.id !== entry.upload.mediaId ||
            status.purpose !== "private-review" ||
            !["expired", "withdrawn", "revoked"].includes(status.state)
          )
            throw Error("dance_preparation_resolution_unproven");
        } else if (
          entry.capture &&
          !entry.terminal &&
          now() < entry.capture.expiresAtMs
        )
          throw Error("dance_preparation_resolution_unproven");
        if (entry.capture) {
          await handle.archive();
          guard();
        }
        await options.client.resetDefiniteCapture();
        guard();
        await handle.save({
          capture: null,
          upload: null,
          terminal: null,
          submission: "none",
        });
        guard();
      });
    },
    async cancelBeforeTake(signal: AbortSignal) {
      const guard = begin(signal);
      await options.journal.exclusive(options.scope, guard, async (handle) => {
        const entry = handle.read(),
          original = await retained(guard);
        if (
          entry.captureUnknown ||
          entry.upload ||
          entry.submission !== "none" ||
          (original && !original.receiptJson)
        )
          throw Error("dance_response_unknown");
        if (entry.capture) await handle.save({ terminal: "canceled" });
        guard();
      });
    },
  };
}
