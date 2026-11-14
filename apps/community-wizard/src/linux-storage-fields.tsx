import type {OriginalLinuxDraft} from "../../../packages/community-setup/linux-create-profile.ts";
// Independently owned pure Solid fields using the existing wizard interaction.
import { For, Show } from "solid-js";
import type { LinuxDraftV2 } from "../../../packages/community-setup/shared-linux-profile.ts";
import type { ObjectStorageProfileV1 } from "../../../packages/community-setup/storage.ts";
import type { LinuxCapabilities } from "../server/linux-contracts.ts";
function LinuxRecoveryStorageFields(props: {
  value: LinuxDraftV2;
  capabilities: LinuxCapabilities;
  disabled: boolean;
  onChange(value: LinuxDraftV2): void;
}) {
  const update = (value: Partial<LinuxDraftV2>) =>
    props.onChange({ ...props.value, ...value });
  const input = (
    label: string,
    value: string,
    change: (value: string) => void,
    type = "text",
  ) => (
    <label class="field">
      <span>{label}</span>
      <input
        aria-label={label}
        type={type}
        value={value}
        disabled={props.disabled}
        onInput={(event) => change(event.currentTarget.value)}
      />
    </label>
  );
  const backup = (value: Partial<ObjectStorageProfileV1>) =>
    update({
      storage: {
        ...props.value.storage,
        backup: {
          ...props.value.storage.backup,
          ...value,
        } as ObjectStorageProfileV1,
      },
    });
  return (
    <section class="card">
      <h2>Media, private data and recovery</h2>
      <p>
        Public media: Filebase IPFS pinning. Private community data: the host's
        persistent private volume. Backups: encrypted before transport, with a
        recovery key kept separately.
      </p>
      <label class="field">
        <span>Encrypted-backup destination</span>
        <select
          aria-label="Encrypted-backup destination"
          disabled={props.disabled}
          value={
            props.capabilities.backupProfiles.find(
              (p) =>
                JSON.stringify(p.profile) ===
                JSON.stringify(props.value.storage.backup),
            )?.id ?? ""
          }
          onChange={(e) => {
            const p = props.capabilities.backupProfiles.find(
              (p) => p.id === e.currentTarget.value,
            );
            if (p)
              update({
                storage: { ...props.value.storage, backup: p.profile },
              });
          }}
        >
          <option value="">
            Select a destination discovered by the runner
          </option>
          <For
            each={[...props.capabilities.backupProfiles].sort(
              (a, b) =>
                Number(b.profile.provider === "filebase-private") -
                Number(a.profile.provider === "filebase-private"),
            )}
          >
            {(p) => (
              <option value={p.id}>
                {p.label} · {p.profile.provider}
              </option>
            )}
          </For>
        </select>
      </label>
      <details>
        <summary>
          Advanced backup storage · optional Backblaze B2 or custom S3
        </summary>
        <label class="field">
          <span>Backup transport</span>
          <select
            aria-label="Backup transport"
            disabled={props.disabled}
            value={props.value.storage.backup.provider}
            onChange={(e) =>
              backup({
                provider: e.currentTarget
                  .value as ObjectStorageProfileV1["provider"],
                region:
                  e.currentTarget.value === "filebase-private" ? "auto" : "",
                endpoint:
                  e.currentTarget.value === "filebase-private"
                    ? "https://s3.filebase.io"
                    : "",
                forcePathStyle: e.currentTarget.value === "s3",
              })
            }
          >
            <option value="filebase-private">Filebase private objects</option>
            <option value="b2">Backblaze B2</option>
            <option value="s3">Custom S3</option>
          </select>
        </label>
        {input("Backup bucket", props.value.storage.backup.bucket, (bucket) =>
          backup({ bucket }),
        )}
        {input("Backup region", props.value.storage.backup.region, (region) =>
          backup({
            region,
            ...(props.value.storage.backup.provider === "b2"
              ? { endpoint: `https://s3.${region}.backblazeb2.com` }
              : {}),
          }),
        )}
        {input(
          "Backup endpoint",
          props.value.storage.backup.endpoint,
          (endpoint) => backup({ endpoint }),
          "url",
        )}
        <label class="check">
          <input
            type="checkbox"
            checked={props.value.storage.backup.forcePathStyle}
            disabled={props.disabled}
            onChange={(e) =>
              backup({ forcePathStyle: e.currentTarget.checked })
            }
          />
          Use path-style S3 addressing
        </label>
      </details>
      <p>
        A saved endpoint or credential does not prove private access,
        encryption, backup integrity or restore readiness. Only the owning
        backend can verify those capabilities.
      </p>
    </section>
  );
}

export function LinuxStorageFields(props:{value:OriginalLinuxDraft;capabilities:LinuxCapabilities;disabled:boolean;onChange(value:OriginalLinuxDraft):void}) {
  const retained=()=>{const d=props.value;if(d.version!==2)throw Error("V2 backup selection required");return d;};
  return <Show when={props.value.version === 2} fallback={<section class="card">
    <h2>Public media and private data</h2>
    <p>Public media uses Filebase IPFS pinning. Private community data stays in this host's persistent private volume.</p>
    <p>Encrypted backup, guided restore and session recovery are deferred for this create-only profile. Keep the host's persistent data; ordinary restart retains the original installation.</p>
  </section>}>
    <LinuxRecoveryStorageFields value={retained()} capabilities={props.capabilities} disabled={props.disabled} onChange={props.onChange}/>
  </Show>;
}
