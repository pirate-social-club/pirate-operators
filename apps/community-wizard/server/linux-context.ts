import {recoveryPortFrom} from "./linux-journal-capacity.ts";
import {
  LinuxInputError,
  requireLinux,
  natural,
} from "../../../packages/community-setup/shared-linux-profile.ts";
import { custodyHeld } from "./linux-operations.ts";
import { capabilitiesFrom } from "./linux-boundaries.ts";
import { linuxJournalStore, type LinuxJournal } from "./linux-journal.ts";
import type {
  OriginalLinuxDeploymentPort as LinuxDeploymentPort,
  NamespaceAuthorityPort,
} from "./linux-contracts.ts";
import { validateLinuxJournal } from "./linux-journal-validation.ts";

export async function createLinuxContext(
  directory: string,
  backend: LinuxDeploymentPort,
  naming: NamespaceAuthorityPort,
  options: {
    now?: () => number;
    timeoutMs?: number;
    uploadTimeoutMs?: number;
  } = {},
) {
  requireLinux(
    backend.version === 2 && naming.version === 3 &&
      backend.operator &&
      ["deploy", "restore", "reconcile"].every(
        (key) =>
          typeof (backend.operator as unknown as Record<string, unknown>)[
            key
          ] === "function",
      ) &&
      ["begin","complete","recover","assertWritable"].every(key=>typeof (naming as unknown as Record<string,unknown>)[key]==="function") &&
      typeof naming.inspect === "function" &&
      typeof naming.revalidate === "function",
    "backend_unavailable",
    "Install compatible real Linux lifecycle and scoped naming adapters before starting this runner.",
  );
  recoveryPortFrom(backend);
  const store = await linuxJournalStore(directory);
  let state = validateLinuxJournal(await store.read());
  const now = options.now ?? Date.now,
    timeoutMs = Math.min(30_000, Math.max(1, options.timeoutMs ?? 20_000));
  let queue = Promise.resolve();
  async function change(fn: (state: LinuxJournal) => void) {
    const next = queue.then(async () => {
      const copy = structuredClone(state);
      fn(copy);
      await store.save(copy);
      state = copy;
    });
    queue = next.catch(() => {});
    await next;
  }
  const uploadTimeoutMs = Math.min(
    3_600_000,
    Math.max(1, options.uploadTimeoutMs ?? 900_000),
  );
  async function call<T>(
    work: () => Promise<T>,
    boundMs = timeoutMs,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(work),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new LinuxInputError(
                  "backend_timeout",
                  "The backend did not answer. Reconcile any retained request before retrying.",
                ),
              ),
            boundMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  const caps = async () =>
    capabilitiesFrom(await call(() => backend.capabilities()));
  const draft = () => {
    requireLinux(
      state.draft,
      "settings_required",
      "Save community and target settings first.",
    );
    return structuredClone(state.draft);
  };
  const editable = (s: LinuxJournal) =>
    requireLinux(
      !custodyHeld(s) && !s.secretRequest && !s.uploadRequest && !s.namespaceRequest,
      "reconciliation_required",
      "Reconcile the original deployment, credential write or backup upload before changing settings.",
    );
  const current = (s: LinuxJournal, revision: number) =>
    requireLinux(
      s.revision === revision,
      "settings_changed",
      "Settings changed while this read was pending. Refresh and repeat the current step.",
    );

  return {
    backend,
    naming,
    now,
    call,
    caps,
    uploadTimeoutMs,
    draft,
    editable,
    current,
    change,
    read: () => state,
  };
}
export type LinuxContext = Awaited<ReturnType<typeof createLinuxContext>>;
