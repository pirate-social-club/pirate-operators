import { For, Show } from "solid-js";
import { backupSizeLabel, type LinuxSnapshot } from "./linux-api.ts";
import type { LinuxDraftV2 } from "../../../packages/community-setup/shared-linux-profile.ts";
export interface LinuxPanelActions {
  action(
    path: string,
    input?: unknown,
    file?: File,
    inherit?: boolean,
  ): Promise<void>;
  working(): boolean;
  pending(): boolean;
}
export function LinuxRecoveryPanel(
  props: LinuxPanelActions & {
    snapshot: Extract<LinuxSnapshot, { available: true }>;
    draft(): LinuxDraftV2;
    setDraft(value: LinuxDraftV2): void;
    backup(): File | undefined;
    setBackup(value: File | undefined): void;
    recoveryKey(): string;
    setRecoveryKey(value: string): void;
    uploading(): boolean;
    save(): Promise<void>;
  },
) {
  const s = () => props.snapshot;
  const {
    draft,
    setDraft,
    working,
    pending,
    backup,
    setBackup,
    recoveryKey,
    setRecoveryKey,
    uploading,
    action,
    save,
  } = props;
  return (
    <section class="card">
      <h2>Restore encrypted backup</h2>
      <p>
        Upload supported encrypted backup bytes. Enter its recovery key
        separately; the key is cleared after submission and never enters the
        wizard journal.
      </p>
      <label class="field">
        <span>Encrypted backup</span>
        <input
          aria-label="Encrypted backup"
          type="file"
          disabled={working() || pending()}
          onChange={(e) => setBackup(e.currentTarget.files?.[0])}
        />
      </label>
      <p class="fine">
        Supported formats:{" "}
        {s().capabilities.backup.formats.join(", ") || "none"}. Maximum size:{" "}
        {backupSizeLabel(s().capabilities.backup.maxBytes)}.
      </p>
      <Show when={backup()}>
        {(file) => (
          <p>
            {file().name} · {backupSizeLabel(file().size)}
          </p>
        )}
      </Show>
      <Show when={uploading()}>
        <p role="status">
          Uploading the encrypted backup. Interrupted uploads resume by
          resending the same complete file under its retained request.
        </p>
        <progress aria-label="Encrypted backup upload" />
      </Show>
      <button
        class="secondary"
        disabled={working() || !backup() || pending()}
        onClick={() => void action("backup", {}, backup())}
      >
        {s().state.uploadRequest
          ? "Resume original encrypted upload"
          : "Upload encrypted backup"}
      </button>
      <label class="field">
        <span>Separate recovery key</span>
        <input
          aria-label="Separate recovery key"
          type="password"
          autocomplete="off"
          value={recoveryKey()}
          disabled={working() || !s().state.backupId || pending()}
          onInput={(e) => setRecoveryKey(e.currentTarget.value)}
        />
      </label>
      <button
        class="secondary"
        disabled={
          working() || !recoveryKey() || !s().state.backupId || pending()
        }
        onClick={() => {
          const key = recoveryKey();
          setRecoveryKey("");
          void action("restore/inspect", { recoveryKey: key }, undefined, true);
        }}
      >
        Authenticate and inspect backup
      </button>
      <Show when={s().state.restore}>
        {(r) => (
          <>
            <p role="status">
              Authenticated compatible backup for {r().profile.settings.name}.
              Community identity: {r().profile.identity.communityId}.
            </p>
            <label class="field">
              <span>Session recovery policy</span>
              <select
                aria-label="Session recovery policy"
                value={draft().recovery.sessionPolicy}
                disabled={working() || pending()}
                onChange={(e) =>
                  setDraft({
                    ...draft(),
                    recovery: {
                      sessionPolicy: e.currentTarget
                        .value as LinuxDraftV2["recovery"]["sessionPolicy"],
                    },
                  })
                }
              >
                <For each={r().sessionPolicies}>
                  {(p) => (
                    <option value={p}>
                      {p === "revoke-existing"
                        ? "Revoke existing sessions"
                        : "Preserve existing sessions under verified policy"}
                    </option>
                  )}
                </For>
              </select>
            </label>
            <button
              class="secondary"
              disabled={working() || pending()}
              onClick={() => void save()}
            >
              Save recovery policy
            </button>
            <p class="fine">
              Preservation requires actual session and revocation-state recovery
              by the backend. Missing capability blocks restore.
            </p>
          </>
        )}
      </Show>
    </section>
  );
}
