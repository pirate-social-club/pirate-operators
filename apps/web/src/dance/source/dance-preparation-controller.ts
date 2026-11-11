// Adapted from c7 dance-preparation-controller: original prepare/start/reconcile
// and closeTerminal ownership, with V5's combined reservation/consent boundary.
import type { DanceCapture } from "../../../../../packages/dance/contracts.ts";
import { DanceClientError, privateAccessLost } from "../client.ts";
import {
  assertCapture,
  assertCurrent,
  type DanceSourcePorts,
  danceTargetKey,
} from "./ports.ts";
import {
  danceSession,
  type DanceSession,
  type DanceCaptureContext,
  type DanceObjectivesContext,
} from "./dance-preparation-api.ts";
import { assertDanceReview } from "./dance-review-api.ts";
import {
  acceptedCaptureMatches,
  assertCaptureCommand,
  requireCommandPorts,
  DanceOriginalHeldError,
} from "./command-ordering.ts";
import { sameOriginalCommand, type DanceJournalEntry } from "../journal.ts";

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
        if (
          original &&
          !original.receiptJson &&
          original.targetKey !== danceTargetKey(options.scope)
        )
          throw new DanceOriginalHeldError(original);
        if (entry.captureUnknown || (original && !original.receiptJson))
          throw Error("dance_response_unknown");
        let capture = entry.capture;
        if (!capture) {
          const accepted = await requireCommandPorts(options).acceptedCapture();
          guard();
          capture = accepted ? acceptedCaptureMatches(accepted, options) : null;
          if (capture) {
            await handle.save({ capture, captureUnknown: false });
            guard();
          }
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
          original &&
          !original.receiptJson &&
          original.targetKey !== danceTargetKey(options.scope)
        )
          throw new DanceOriginalHeldError(original);
        if (
          entry.captureUnknown ||
          entry.upload ||
          entry.submission !== "none" ||
          entry.terminal ||
          (original && !original.receiptJson)
        )
          throw Error("dance_response_unknown");
        let capture = entry.capture;
        const client = requireCommandPorts(options);
        if (!capture) {
          const accepted = await client.acceptedCapture();
          guard();
          capture = accepted ? acceptedCaptureMatches(accepted, options) : null;
          if (capture) {
            entry = await handle.save({ capture });
            guard();
          }
        }
        if (!capture) {
          const previous = await client.acceptedCapture();
          guard();
          if (previous && !acceptedCaptureMatches(previous, options)) {
            if (!previous.receiptJson)
              throw Error("dance_other_original_pending");
            const old = JSON.parse(previous.receiptJson) as DanceCapture;
            try {
              await client.releaseCompletedCapture(
                previous.commandId,
                old.captureId,
                signal,
              );
            } catch (error) {
              guard();
              if (privateAccessLost(error)) throw error;
              throw new DanceOriginalHeldError(previous, error);
            }
            guard();
          }
          const command = await client.prepareCapture(
            danceTargetKey(options.scope),
            options.scope.songKey,
            options.scope.offerId,
            options.scope.reference?.id ?? null,
            {
              accepted: true,
              version: p.version,
              termsHash: p.termsHash,
              publicityPolicyHash: p.publicityPolicyHash,
            },
          );
          guard();
          assertCaptureCommand(command, options);
          await handle.save({
            captureUnknown: true,
            commands: { ...entry.commands, capture: command },
          });
          guard();
          try {
            capture = (await client.dispatchPrepared(
              command,
              signal,
            )) as DanceCapture;
            guard();
            assertCapture(capture, options.scope);
            entry = await handle.save({ capture, captureUnknown: false });
            guard();
            await options.client.acknowledgeRecovery(command.commandId);
            guard();
          } catch (e) {
            // A definite server expiry is distinguishable; auth/transport
            // refusal does not discard a potentially accepted reservation.
            if (
              e instanceof DanceClientError &&
              e.status === 410 &&
              e.code === "dance_capture_expired"
            ) {
              // The server explicitly rejected this original reservation;
              // its command remains in command history, not as the next take.
              await handle.save({ captureUnknown: false, commands: undefined });
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
      return options.journal.exclusive(options.scope, guard, async (handle) => {
        const entry = handle.read(),
          client = requireCommandPorts(options);
        let capture = entry.capture;
        if (capture && (entry.upload || entry.submission !== "none"))
          return {
            kind: "upload_recovery",
            session: danceSession(capture, options.media.maximumBytes),
            context: null,
          };
        let command: DanceJournalEntry | null = entry.commands?.capture
          ? await client.command(entry.commands.capture.commandId)
          : await retained(guard);
        guard();
        if (
          entry.commands?.capture &&
          (!command || !sameOriginalCommand(command, entry.commands.capture))
        )
          throw Error("dance_original_command_changed");
        if (!command) command = await client.acceptedCapture();
        guard();
        if (!capture && command?.path === "captures") {
          if (command.receiptJson && !command.targetKey) {
            capture = acceptedCaptureMatches(command, options);
            if (!capture) throw Error("dance_other_original_pending");
          } else {
            assertCaptureCommand(command, options);
            await handle.save({
              captureUnknown: true,
              commands: { ...entry.commands, capture: command },
            });
            guard();
            capture = (await client.dispatchPrepared(
              command,
              signal,
            )) as DanceCapture;
            guard();
          }
        }
        if (!capture) throw Error("dance_legacy_original_missing");
        assertCapture(capture, options.scope);
        await handle.save({ capture, captureUnknown: false });
        guard();
        if (
          command?.path === "captures" &&
          (command.receiptJson || command.targetKey)
        ) {
          await options.client.acknowledgeRecovery(command!.commandId);
          guard();
        }
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
        if (!entry.capture)
          throw Error("dance_preparation_resolution_unproven");
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
        await options.client.resetDefiniteCapture(entry.capture?.captureId);
        guard();
        await handle.save({
          capture: null,
          upload: null,
          terminal: null,
          submission: "none",
          commands: undefined,
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
