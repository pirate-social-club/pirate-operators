/** UNRUN. Coordinator-only isolated browser harness entry. Actual IndexedDB
 * commit/reload, immutable original storage and Web Lock cases, no server API.
 * Use an isolated fixture origin/profile, never a real account/browser store. */
import { createBrowserDanceJourneyStore } from "../src/dance/source/journey-store.ts";
import { createBrowserDanceRecordingStorage } from "../src/dance/source/dance-recording-storage.ts";
import { createDanceRecordingController } from "../src/dance/source/dance-recording.ts";
import { claimBrowserDanceCapture } from "../src/dance/source/capture-lease.ts";
import { createDanceClient } from "../src/dance/client.ts";
import { createIndexedDanceJournal } from "../src/dance/journal.ts";
import { createDancePreparationController } from "../src/dance/source/dance-preparation-controller.ts";
import { danceTargetKey } from "../src/dance/source/ports.ts";
import {
  simulatedSource,
  captureFixture,
  reviewFixture,
  scope,
} from "./dance-source-fixtures.ts";
const insist = (condition: unknown, text: string) => {
  if (!condition) throw Error(text);
};
export async function runDanceStorageBrowserCases() {
  let boundary = "initialization";
  try {
    return await storageCases((value) => {
      boundary = value;
    });
  } catch (error) {
    throw new Error("dance_storage_boundary:" + boundary, { cause: error });
  }
}

/** Additional UNRUN native IndexedDB ordering case; intercepted HTTP is an
 * explicit idempotent server simulation. It grants no capture/chain authority. */
export async function runDanceCommandOrderingBrowserCases() {
  const f = simulatedSource(),
    account = {
      ...scope,
      accountId: "fixture_command_" + crypto.randomUUID().replaceAll("-", ""),
    };
  const c = captureFixture(Date.now());
  c.learner = {
    ...c.learner,
    accountId: account.accountId,
    knownAliases: [account.accountId],
  };
  c.consent = { ...c.consent!, accountId: account.accountId };
  const bodies: string[] = [],
    commits = new Set<string>();
  let lose = true;
  const make = () =>
    createDanceClient({
      communityId: account.communityId,
      accountId: account.accountId,
      csrf: "SIMULATED",
      isCurrent: () => true,
      journal: createIndexedDanceJournal(indexedDB),
      fetcher: (async (_url, init) => {
        if (!init?.method) return Response.json(reviewFixture(c));
        bodies.push(String(init.body));
        const command = JSON.parse(String(init.body));
        commits.add(command.commandId);
        c.consent = { ...c.consent!, receiptId: command.commandId };
        if (lose) {
          lose = false;
          throw new TypeError("SIMULATED accepted acknowledgement lost");
        }
        return Response.json(c);
      }) as typeof fetch,
    });
  const first = make(),
    original = await first.prepareCapture!(
      danceTargetKey(account),
      account.songKey,
      account.offerId,
      account.reference!.id,
      {
        accepted: true,
        version: f.ports.consent.version,
        termsHash: f.ports.consent.termsHash,
        publicityPolicyHash: f.ports.consent.publicityPolicyHash,
      },
    );
  insist(bodies.length === 0, "preparation dispatched HTTP");
  first.dispose();
  const reload = make(),
    journal = createBrowserDanceJourneyStore();
  insist(
    (await reload.retained!())?.requestJson === original.requestJson,
    "native command-before-journey recovery changed bytes",
  );
  insist(
    !(await journal.read(account, () => {})).captureUnknown,
    "journey flag committed before original command",
  );
  await journal.exclusive(
    account,
    () => {},
    async (h) => {
      await h.save({ captureUnknown: true, commands: { capture: original } });
    },
  );
  let unknown = false;
  try {
    await reload.dispatchPrepared!(original);
  } catch {
    unknown = true;
  }
  insist(
    unknown && commits.size === 1,
    "simulated accepted response was not uncertain",
  );
  reload.dispose();
  const final = make(),
    ports = {
      ...f.ports,
      client: final,
      scope: account,
      currentScope: () => account,
      journal: createBrowserDanceJourneyStore(),
      nowMs: Date.now,
    };
  const before = bodies.length;
  try {
    await createDancePreparationController(ports).prepare(
      f.ports.consent.termsHash,
      new AbortController().signal,
    );
  } catch {
    /* Read-only uncertainty hold. */
  }
  insist(
    bodies.length === before,
    "native reload automatically replayed an original",
  );
  await createDancePreparationController(ports).recover(
    f.ports.consent.termsHash,
    new AbortController().signal,
  );
  insist(
    bodies.length === 2 &&
      bodies.every((body) => body === original.requestJson) &&
      commits.size === 1,
    "recovery replaced or duplicated the original server command",
  );
  const restored = await ports.journal.read(account, () => {});
  insist(
    restored.capture?.captureId === c.captureId &&
      !restored.captureUnknown &&
      restored.commands?.capture?.commandId === original.commandId,
    "native journey lost original identity",
  );
  final.dispose();
  return {
    status: "passed",
    evidence: "native fixture IndexedDB and simulated HTTP only",
    commandId: original.commandId,
    fixtureAccount: account.accountId,
  };
}
async function storageCases(at: (boundary: string) => void) {
  const f = simulatedSource(),
    unique = "fixture_dance_" + crypto.randomUUID().replaceAll("-", "");
  const account = { ...scope, accountId: unique },
    c = captureFixture(Date.now());
  c.learner = { ...c.learner, accountId: unique, knownAliases: [unique] };
  c.consent = { ...c.consent!, accountId: unique };
  const journal = createBrowserDanceJourneyStore(),
    guard = () => {};
  at("journey_commit");
  await journal.exclusive(account, guard, async (h) => {
    await h.save({ capture: c, captureUnknown: true });
  });
  const reload = createBrowserDanceJourneyStore();
  insist(
    (await reload.read(account, guard)).captureUnknown,
    "durable uncertainty missing after actual connection reload",
  );
  await reload.exclusive(account, guard, async (h) => {
    await h.save({ captureUnknown: false });
  });
  let current = true;
  const ports = {
    ...f.ports,
    scope: account,
    currentScope: () => (current ? account : null),
    journal: reload,
    nowMs: Date.now,
  };
  const session = {
    ...f.session,
    capture: c,
    session_id: c.captureId,
    expires_at_ms: c.expiresAtMs,
  };
  const ready = {
    ...f.ready,
    session,
    context: { ...f.ready.context, session },
  };
  const storage = createBrowserDanceRecordingStorage(unique),
    recordings = createDanceRecordingController({ ...ports, storage });
  const take = {
    sessionId: c.captureId,
    termsHash: c.termsHash,
    durationMs: session.body_end_ms,
    file: new File(["actual private fixture storage bytes"], "fixture.mp4", {
      type: "video/mp4",
    }),
  };
  at("original_retain");
  const saved = await recordings.retain(
    ready,
    take,
    new AbortController().signal,
  );
  at("original_restore");
  const restored = await createDanceRecordingController({
    ...ports,
    storage: createBrowserDanceRecordingStorage(unique),
  }).restore(c.captureId, new AbortController().signal);
  if (!restored) throw Error("actual original missing after reload");
  insist(
    restored.metadata.sha256 === saved.metadata.sha256 &&
      (await restored.blob.text()) === (await take.file.text()),
    "actual original reload changed bytes",
  );
  at("replacement_refusal");
  let replacementRefused = false;
  try {
    await recordings.retain(
      ready,
      {
        ...take,
        file: new File(["replacement"], "replacement.mp4", {
          type: "video/mp4",
        }),
      },
      new AbortController().signal,
    );
  } catch {
    replacementRefused = true;
  }
  insist(replacementRefused, "original storage was replaced");
  at("stale_account_refusal");
  current = false;
  let staleRefused = false;
  try {
    await recordings.restore(c.captureId, new AbortController().signal);
  } catch {
    staleRefused = true;
  }
  insist(staleRefused, "session invalidation returned private bytes");
  current = true;
  at("first_native_lease");
  const lease = await claimBrowserDanceCapture(account, () => current);
  let duplicateRefused = false;
  at("duplicate_native_lease_refusal");
  try {
    await claimBrowserDanceCapture(account, () => current);
  } catch {
    duplicateRefused = true;
  }
  insist(duplicateRefused, "second capture owner admitted");
  at("release_native_acknowledgement");
  const released = lease.release();
  let releasedHandleRefused = false;
  try {
    lease.assertCurrent();
  } catch {
    releasedHandleRefused = true;
  }
  insist(
    releasedHandleRefused,
    "released handle retained authority before native acknowledgement",
  );
  await released;
  at("reclaim_after_native_acknowledgement");
  const next = await claimBrowserDanceCapture(account, () => current);
  next.assertCurrent();
  at("native_lease_lifetime_loss");
  current = false;
  let staleLeaseRefused = false;
  try {
    next.assertCurrent();
  } catch {
    staleLeaseRefused = true;
  }
  insist(staleLeaseRefused, "stale native lease retained account authority");
  await next.release();
  let staleClaimRefused = false;
  try {
    await claimBrowserDanceCapture(account, () => current);
  } catch {
    staleClaimRefused = true;
  }
  insist(staleClaimRefused, "stale account reclaimed a released capture");
  current = true;
  at("journey_archive");
  await reload.exclusive(account, guard, async (h) => {
    await h.archive();
  });
  insist(
    (await reload.read(account, guard)).capture?.captureHash === c.captureHash,
    "archiving rewrote the current original",
  );
  return {
    status: "passed",
    evidence: "actual browser fixture storage/Web Locks only",
    captureHash: c.captureHash,
    fixtureAccount: unique,
  };
}
