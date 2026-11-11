/** UNRUN. Coordinator-only isolated browser harness entry. Actual IndexedDB
 * commit/reload, immutable original storage and Web Lock cases, no server API.
 * Use an isolated fixture origin/profile, never a real account/browser store. */
import { createBrowserDanceJourneyStore } from "../src/dance/source/journey-store.ts";
import { createBrowserDanceRecordingStorage } from "../src/dance/source/dance-recording-storage.ts";
import { createDanceRecordingController } from "../src/dance/source/dance-recording.ts";
import { claimBrowserDanceCapture } from "../src/dance/source/capture-lease.ts";
import {
  simulatedSource,
  captureFixture,
  scope,
} from "./dance-source-fixtures.ts";
const insist = (condition: unknown, text: string) => {
  if (!condition) throw Error(text);
};
export async function runDanceStorageBrowserCases() {
  const f = simulatedSource(),
    unique = "fixture_dance_" + crypto.randomUUID().replaceAll("-", "");
  const account = { ...scope, accountId: unique },
    c = captureFixture(Date.now());
  c.learner = { ...c.learner, accountId: unique, knownAliases: [unique] };
  c.consent = { ...c.consent!, accountId: unique };
  const journal = createBrowserDanceJourneyStore(),
    guard = () => {};
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
  const saved = await recordings.retain(
    ready,
    take,
    new AbortController().signal,
  );
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
  current = false;
  let staleRefused = false;
  try {
    await recordings.restore(c.captureId, new AbortController().signal);
  } catch {
    staleRefused = true;
  }
  insist(staleRefused, "session invalidation returned private bytes");
  current = true;
  const lease = await claimBrowserDanceCapture(account, () => current);
  let duplicateRefused = false;
  try {
    await claimBrowserDanceCapture(account, () => current);
  } catch {
    duplicateRefused = true;
  }
  insist(duplicateRefused, "second capture owner admitted");
  lease.release();
  const next = await claimBrowserDanceCapture(account, () => current);
  next.assertCurrent();
  next.release();
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
