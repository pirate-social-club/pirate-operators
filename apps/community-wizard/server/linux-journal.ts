import {originalLinuxDraftFrom,originalLinuxProfileFrom,type OriginalLinuxDraft} from "../../../packages/community-setup/linux-create-profile.ts";
import {JOURNAL_CAPACITY_POLICY,JOURNAL_MAX_BYTES,requireJournalCapacity} from "./linux-journal-capacity.ts";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  LinuxInputError,
  requireLinux,
  linuxProfileFrom,
  identityFrom,
  type DeploymentIdentity,
  type LinuxDraftV2,
  type LinuxTarget,
} from "../../../packages/community-setup/shared-linux-profile.ts";
import type {
  BoundLinuxIntent,
  LinuxOperationResult,
  CredentialRequirement,
  OriginalLinuxOperation as LinuxOperation,
  OriginalLinuxPlan as LinuxPlan,
  NamespaceAuthorityResult,
  RestoreInspection,
  TargetInspection,
} from "./linux-contracts.ts";
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  requireLinux(
    value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value)),
    "unsupported_value",
    "Use a supported JSON profile.",
  );
  return JSON.stringify(value);
}
export const digestJson = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export const sameIdentity = (a: DeploymentIdentity, b: DeploymentIdentity) =>
  canonical(a) === canonical(b);
export interface JournalOperation extends LinuxOperation {
  state: "running" | "pending" | "unknown" | "failed" | "succeeded";
  intent: BoundLinuxIntent | null;
  results: LinuxOperationResult[];
  capacityPhase:"binding"|"reading"|"ready"|"terminal";
  recoveryResultDigest:string|null;
  custody: "held" | "cleared";
  receiptRef: string | null;
  observationRevision: number;
  message: string;
}
export interface LinuxJournal {
  version: 2;
  capacityPolicy:typeof JOURNAL_CAPACITY_POLICY;
  revision: number;
  draft: OriginalLinuxDraft | null;
  destination: { mode: LinuxDraftV2["mode"]; target: LinuxTarget } | null;
  target: TargetInspection | null;
  namespace: NamespaceAuthorityResult | null;
  imported: ReturnType<typeof linuxProfileFrom> | null;
  backupId: string | null;
  backupDigest: string | null;
  restore: RestoreInspection | null;
  plan: LinuxPlan | null;
  identity: DeploymentIdentity | null;
  requirements: CredentialRequirement[];
  secretRequest: { id: string; fieldIds: string[] } | null;
  uploadRequest: { id: string; byteLength: number } | null;
  namespaceRequest: null | {id:string;kind:"begin"|"complete";bindingRevision:number;challengeId:string|null};
  namespaceChallenge: import("./linux-contracts.ts").NamespaceChallenge | null;
  namespaceHistory: Array<{requestId:string;kind:"begin"|"complete";challengeId:string|null;bindingRevision:number;outcome:"completed"|"not-started";evidenceRef:string}>;
  operation: JournalOperation | null;
  history: JournalOperation[];
  message: string;
}
export const emptyJournal = (): LinuxJournal => ({
  version: 2,
  capacityPolicy:JOURNAL_CAPACITY_POLICY,
  revision: 0,
  draft: null,
  destination: null,
  target: null,
  namespace: null,
  imported: null,
  backupId: null,
  backupDigest: null,
  restore: null,
  plan: null,
  identity: null,
  requirements: [],
  secretRequest: null,
  uploadRequest: null,
  namespaceRequest: null,
  namespaceChallenge: null,
  namespaceHistory: [],
  operation: null,
  history: [],
  message: "Choose create, import or restore to begin.",
});
export async function linuxJournalStore(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  requireLinux(
    info.isDirectory() &&
      !info.isSymbolicLink() &&
      info.uid === process.getuid!() &&
      !(info.mode & 0o077),
    "private_state_required",
    "Use an owned private state directory; preserve existing state rather than changing its permissions.",
  );
  const legacy = join(directory, "linux-setup-v1.json");
  requireLinux(!(await lstat(legacy).then(()=>true, (error:NodeJS.ErrnoException)=>{if(error.code==="ENOENT")return false;throw error;})),
    "legacy_cutover_required","Retain the V1 journal and use its original recovery codec; explicit migration/cutover is required before V2 adoption.");
  const path = join(directory, "linux-setup-v2.json");
  async function read(): Promise<LinuxJournal> {
    try {
      const meta = await lstat(path);
      requireLinux(
        meta.isFile() &&
          !meta.isSymbolicLink() &&
          meta.nlink === 1 &&
          meta.uid === process.getuid!() &&
          !(meta.mode & 0o077) &&
          meta.size <= JOURNAL_MAX_BYTES,
        "invalid_journal",
        "Preserve this state file; it needs an explicit compatible recovery.",
      );
      const state = JSON.parse(await readFile(path, "utf8")) as LinuxJournal;
      requireLinux(
        state.version === 2 &&
          Number.isSafeInteger(state.revision) &&
          state.revision >= 0 &&
          Array.isArray(state.history) &&
          state.history.length <= 1000 &&
          Array.isArray(state.requirements),
        "invalid_journal",
        "Preserve the unsupported setup journal for recovery.",
      );
      requireJournalCapacity(state);
      if (state.draft) state.draft = originalLinuxDraftFrom(state.draft);
      if (state.imported) state.imported = linuxProfileFrom(state.imported);
      if (state.identity) state.identity = identityFrom(state.identity);
      for (const plan of [
        state.plan,
        state.operation?.plan,
        ...state.history.map((op) => op.plan),
      ])
        if (plan) {
          originalLinuxProfileFrom(plan.profile);
          const { digest, ...bytes } = plan;
          requireLinux(
            digest === digestJson(bytes) &&
              plan.profileDigest === digestJson(plan.profile),
            "invalid_journal",
            "The retained reviewed plan changed; preserve it for recovery.",
          );
        }
      if (state.operation?.state === "running") {
        state.operation.state = "unknown";
        state.operation.message =
          "The runner stopped. Reconcile this original operation before retrying.";
      }
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return emptyJournal();
      if (error instanceof LinuxInputError) throw error;
      throw new LinuxInputError(
        "invalid_journal",
        "The setup journal could not be read safely. Preserve it and restore a compatible backup.",
      );
    }
  }
  async function save(state: LinuxJournal) {
    requireLinux(
      state.history.length <= 1000 && state.namespaceHistory.length <= 1000,
      "journal_full",
      "Preserve the journal and export retained backend evidence before new operations.",
    );
    requireJournalCapacity(state);
    // This explicit policy uses compact JSON; original objects/digests stay intact.
    const bytes = JSON.stringify(state) + "\n";
    requireLinux(
      Buffer.byteLength(bytes) <= JOURNAL_MAX_BYTES,
      "journal_full",
      "Preserve the journal and ask the backend to export its retained operation evidence.",
    );
    const temporary = join(directory, `.linux-setup-${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, path);
      const parent = await open(directory, "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    } finally {
      await unlink(temporary).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "ENOENT") throw e;
      });
    }
  }
  return { read, save };
}
