/** UNRUN coordinator harness port. Actual native IndexedDB transactions and
 * Web Locks; only HTTP/media/current authority are explicit simulations.
 * Requires a new isolated fixture account/origin, never a real member store. */
import { createDanceClient, DanceClientError } from "../src/dance/client.ts";
import {
  createIndexedDanceJournal,
  hasDanceExpiredOutcome,
  sameOriginalCommand,
  type DanceJournal,
} from "../src/dance/journal.ts";
import {
  createBrowserDanceJourneyStore,
  type DanceJourneyStore,
} from "../src/dance/source/journey-store.ts";
import { createDanceReviewController } from "../src/dance/source/dance-review-controller.ts";
import { createDancePreparationController } from "../src/dance/source/dance-preparation-controller.ts";
import { danceTargetKey } from "../src/dance/source/ports.ts";
import {
  simulatedSource,
  captureFixture,
  mediaFixture,
  scope,
  consent,
} from "./dance-source-fixtures.ts";
import { terminalUpload } from "./dance-terminal-recovery-fixtures.ts";
const insist = (condition: unknown, message: string) => {
  if (!condition) throw Error(message);
};
export async function runDanceTerminalOutcomeBrowserCases() {
  if (!globalThis.indexedDB || !navigator.locks)
    throw Error("native_storage_unavailable");
  const evidence = [];
  for (const boundary of [
    "before_outcome",
    "after_outcome",
    "before_journey",
    "after_journey",
  ] as const) {
    const f = simulatedSource(),
      account = {
        ...scope,
        accountId:
          "fixture_terminal_" + crypto.randomUUID().replaceAll("-", ""),
      },
      c = captureFixture(Date.now());
    c.learner = {
      ...c.learner,
      accountId: account.accountId,
      knownAliases: [account.accountId],
    };
    c.consent = { ...c.consent!, accountId: account.accountId };
    const nativeJourney = createBrowserDanceJourneyStore(indexedDB),
      nativeCommands = createIndexedDanceJournal(indexedDB),
      requests: string[] = [];
    let mode: "capture" | "unknown" | "expired" = "capture",
      armed = true;
    const commandPort: DanceJournal = {
      ...nativeCommands,
      rejectExpired: async (e) => {
        if (armed && boundary === "before_outcome") {
          armed = false;
          throw Error("SIMULATED interruption before real outcome transaction");
        }
        await nativeCommands.rejectExpired(e);
        if (armed && boundary === "after_outcome") {
          armed = false;
          throw Error(
            "SIMULATED acknowledgement loss after real outcome commit",
          );
        }
      },
    };
    const journeyPort: DanceJourneyStore = {
      read: nativeJourney.read,
      exclusive: (s, guard, use) =>
        nativeJourney.exclusive(s, guard, (h) =>
          use({
            ...h,
            save: async (patch) => {
              if (
                patch.terminal === "expired" &&
                armed &&
                boundary === "before_journey"
              ) {
                armed = false;
                throw Error(
                  "SIMULATED interruption before real journey transaction",
                );
              }
              const result = await h.save(patch);
              if (
                patch.terminal === "expired" &&
                armed &&
                boundary === "after_journey"
              ) {
                armed = false;
                throw Error(
                  "SIMULATED acknowledgement loss after real journey commit",
                );
              }
              return result;
            },
          }),
        ),
    };
    const make = (journal: DanceJournal) =>
      createDanceClient({
        communityId: account.communityId,
        accountId: account.accountId,
        csrf: "SIMULATED",
        isCurrent: () => true,
        journal,
        fetcher: (async (_url, init) => {
          if (!init?.method)
            return Response.json({ error: "not_accepted" }, { status: 404 });
          requests.push(String(init.body));
          const b = JSON.parse(String(init.body));
          if (mode === "capture") {
            c.consent = { ...c.consent!, receiptId: b.commandId };
            return Response.json(c);
          }
          if (mode === "unknown")
            throw TypeError("SIMULATED transport before acceptance");
          return Response.json(
            { error: "dance_capture_expired" },
            { status: 410 },
          );
        }) as typeof fetch,
      });
    const client = make(commandPort),
      ports = {
        ...f.ports,
        client,
        scope: account,
        currentScope: () => account,
        journal: journeyPort,
        nowMs: Date.now,
        media: { ...f.ports.media, status: async () => mediaFixture(c) },
      };
    await createDancePreparationController(ports).start(
      consent.termsHash,
      new AbortController().signal,
    );
    await nativeJourney.exclusive(
      account,
      () => {},
      async (h) => {
        await h.save({ upload: terminalUpload });
      },
    );
    mode = "unknown";
    const controller = createDanceReviewController(ports),
      view = await controller.observe(new AbortController().signal);
    try {
      await controller.act(
        view.result,
        { operation: "submit" },
        new AbortController().signal,
      );
    } catch {
      /* Original remains uncertain. */
    }
    const original = await client.retained!();
    insist(original?.path === "reviews", "original submission absent");
    mode = "expired";
    try {
      await createDanceReviewController(ports).load(
        new AbortController().signal,
      );
    } catch {
      /* Exact named interruption or actual typed refusal. */
    }
    client.dispose();
    armed = false;
    const reloadedCommands = createIndexedDanceJournal(indexedDB),
      reload = make(reloadedCommands);
    const reloaded = {
      ...ports,
      client: reload,
      journal: createBrowserDanceJourneyStore(indexedDB),
    };
    const before = requests.length,
      stored = await reload.command!(original!.commandId);
    insist(
      stored && sameOriginalCommand(stored, original!),
      "native outcome changed command UUID/body",
    );
    try {
      await createDancePreparationController(reloaded).prepare(
        consent.termsHash,
        new AbortController().signal,
      );
    } catch {
      /* Observation never dispatches. */
    }
    insist(requests.length === before, "native reload posted automatically");
    let refusal = false;
    try {
      await createDanceReviewController(reloaded).load(
        new AbortController().signal,
      );
    } catch (error) {
      refusal =
        error instanceof DanceClientError &&
        error.status === 410 &&
        error.code === "dance_capture_expired";
    }
    insist(refusal, "native recovery did not retain authoritative expiry");
    insist(
      requests.length === before + (hasDanceExpiredOutcome(stored!) ? 0 : 1),
      "persisted native outcome required another send",
    );
    const result = await reloaded.journal.read(account, () => {});
    insist(
      result.submission === "none" &&
        result.terminal === "expired" &&
        hasDanceExpiredOutcome(result.commands!.submit!),
      "native terminal outcome not reconciled",
    );
    insist(
      requests.slice(1).every((body) => body === original!.requestJson),
      "native retry replaced immutable body",
    );
    await createDancePreparationController(reloaded).closeTerminal(
      new AbortController().signal,
    );
    insist(
      (await reloaded.journal.read(account, () => {})).capture === null,
      "native expiry could not close",
    );
    insist(
      hasDanceExpiredOutcome((await reload.command!(original!.commandId))!),
      "native cleanup lost original outcome",
    );
    evidence.push({
      boundary,
      target: danceTargetKey(account),
      commandId: original!.commandId,
    });
    reload.dispose();
  }
  return {
    status: "passed",
    evidence: "actual fixture native storage only; HTTP/authority simulations",
    cases: evidence,
  };
}
