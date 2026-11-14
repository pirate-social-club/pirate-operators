// Layout/field interactions independently reuse the existing wizard main.tsx
// and style.css at a88. This component has no centralized API/auth dependency.
import { For, Show } from "solid-js";
import type {
  LinuxDraftV2,
  LinuxTarget,
} from "../../../packages/community-setup/shared-linux-profile.ts";
import type { LinuxCapabilities } from "../server/linux-contracts.ts";
import { LinuxStorageFields } from "./linux-storage-fields.tsx";
export const emptyLinuxDraft = (): LinuxDraftV2 => ({
  version: 2,
  infrastructure: "pirate.shared-directory/2",
  mode: "create",
  name: "",
  slug: "",
  origin: "",
  target: { kind: "local-linux" },
  namespace: { tld: "" },
  features: {
    learning: false,
    karaoke: false,
    media: false,
    dance: false,
    telegram: false,
  },
  services: { publicationProfile: "", learningProfile: null },
  storage: {
    publicMedia: { version: 1, role: "public-ipfs", provider: "filebase-ipfs" },
    privateData: { provider: "local-volume" },
    backup: {
      version: 1,
      role: "backup",
      provider: "filebase-private",
      bucket: "",
      endpoint: "https://s3.filebase.io",
      region: "auto",
      forcePathStyle: false,
    },
  },
  limits: {
    speechDaily: 0,
    websiteReserved: 0,
    perAccountDaily: 0,
    monthlyUsdCents: 0,
  },
  recovery: { sessionPolicy: "revoke-existing" },
});
export function linuxIdentifierFromName(name: string) {
  const value = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/g, "");
  return /^[a-z][a-z0-9-]{1,28}[a-z0-9]$/.test(value)
    ? value
    : value
      ? ("community-" + value).slice(0, 30).replace(/-+$/g, "")
      : "";
}
export function LinuxProfileForm(props: {
  value: LinuxDraftV2;
  capabilities: LinuxCapabilities;
  onChange(value: LinuxDraftV2): void;
  disabled: boolean;
  resolved: boolean;
}) {
  const update = (value: Partial<LinuxDraftV2>) =>
    props.onChange({ ...props.value, ...value });
  const input = (
    label: string,
    value: string,
    change: (v: string) => void,
    type = "text",
  ) => (
    <label class="field">
      <span>{label}</span>
      <input
        aria-label={label}
        type={type}
        value={value}
        disabled={props.disabled}
        onInput={(e) => change(e.currentTarget.value)}
      />
    </label>
  );
  const feature = (key: keyof LinuxDraftV2["features"], value: boolean) => {
    const features = { ...props.value.features, [key]: value };
    if (!features.learning) {
      features.karaoke = false;
      features.telegram = false;
    }
    if (!features.media) features.dance = false;
    update({
      features,
      services: {
        ...props.value.services,
        learningProfile: features.learning
          ? (props.value.services.learningProfile ??
            props.capabilities.learningProfiles.find((p) => p.verified)?.id ??
            null)
          : null,
      },
    });
  };
  const ssh = (value: Partial<Extract<LinuxTarget, { kind: "ssh-linux" }>>) => {
    const current =
      props.value.target.kind === "ssh-linux"
        ? props.value.target
        : {
            kind: "ssh-linux" as const,
            host: "",
            port: 22,
            user: "",
            connectionRef: "",
          };
    update({ target: { ...current, ...value } });
  };
  return (
    <>
      <section class="card">
        <h2>Create, import or restore</h2>
        <label class="field">
          <span>Setup action</span>
          <select
            aria-label="Setup action"
            disabled={props.disabled}
            value={props.value.mode}
            onChange={(e) =>
              update({ mode: e.currentTarget.value as LinuxDraftV2["mode"] })
            }
          >
            <option
              value="create"
              disabled={!props.capabilities.operations.includes("create")}
            >
              Create a community
              {props.capabilities.operations.includes("create")
                ? ""
                : " · backend unavailable"}
            </option>
            <option
              value="import"
              disabled={!props.capabilities.operations.includes("import")}
            >
              Import an existing installation
              {props.capabilities.operations.includes("import")
                ? ""
                : " · backend unavailable"}
            </option>
            <option
              value="restore"
              disabled={!props.capabilities.operations.includes("restore")}
            >
              Restore an encrypted backup
              {props.capabilities.operations.includes("restore")
                ? ""
                : " · backend unavailable"}
            </option>
          </select>
        </label>
        <p>
          Import adopts a discovered installation. Restore needs backup bytes
          and a separate recovery key; it does not create a different community
          identity.
        </p>
        <label class="field">
          <span>Linux host</span>
          <select
            aria-label="Linux host"
            disabled={props.disabled}
            value={props.value.target.kind}
            onChange={(e) =>
              update({
                target:
                  e.currentTarget.value === "local-linux"
                    ? { kind: "local-linux" }
                    : {
                        kind: "ssh-linux",
                        host: "",
                        user: "",
                        port: 22,
                        connectionRef:
                          props.capabilities.sshConnections[0]?.id ?? "",
                      },
              })
            }
          >
            <option
              value="local-linux"
              disabled={!props.capabilities.targets.includes("local-linux")}
            >
              The server running this setup
            </option>
            <option
              value="ssh-linux"
              disabled={!props.capabilities.targets.includes("ssh-linux")}
            >
              A different Linux server over SSH
            </option>
          </select>
        </label>
        <Show when={props.value.target.kind === "ssh-linux"}>
          {(_visible) => (
            <>
              {input(
                "SSH host",
                (
                  props.value.target as Extract<
                    LinuxTarget,
                    { kind: "ssh-linux" }
                  >
                ).host,
                (host) => ssh({ host }),
              )}
              {input(
                "SSH user",
                (
                  props.value.target as Extract<
                    LinuxTarget,
                    { kind: "ssh-linux" }
                  >
                ).user,
                (user) => ssh({ user }),
              )}
              <label class="field">
                <span>Managed SSH connection</span>
                <select
                  aria-label="Managed SSH connection"
                  disabled={props.disabled}
                  value={
                    (
                      props.value.target as Extract<
                        LinuxTarget,
                        { kind: "ssh-linux" }
                      >
                    ).connectionRef
                  }
                  onChange={(e) =>
                    ssh({ connectionRef: e.currentTarget.value })
                  }
                >
                  <option value="">
                    Select a connection discovered by the runner
                  </option>
                  <For each={props.capabilities.sshConnections}>
                    {(p) => <option value={p.id}>{p.label}</option>}
                  </For>
                </select>
              </label>
              <details>
                <summary>Advanced SSH connection</summary>
                {input(
                  "SSH port",
                  String(
                    (
                      props.value.target as Extract<
                        LinuxTarget,
                        { kind: "ssh-linux" }
                      >
                    ).port,
                  ),
                  (v) => ssh({ port: Number(v) }),
                  "number",
                )}
              </details>
              <p>
                Use your existing server and managed SSH connection. The backend
                must inspect this host and return its exact fingerprint before
                any deployment.
              </p>
            </>
          )}
        </Show>
      </section>
      <Show when={props.value.mode === "create" || props.resolved}>
        <section class="card">
          <h2>Community and public address</h2>
          {input("Community name", props.value.name, (name) =>
            update({
              name,
              ...(!props.resolved &&
              (!props.value.slug ||
                props.value.slug === linuxIdentifierFromName(props.value.name))
                ? { slug: linuxIdentifierFromName(name) }
                : {}),
            }),
          )}
          <details>
            <summary>Advanced · community identifier</summary>
            {input("Community identifier", props.value.slug, (slug) =>
              update({ slug }),
            )}
            <p>
              The name supplies an initial identifier. After the first
              deployment attempt, its original resource identity is retained.
            </p>
          </details>
          {input(
            "Application HTTPS address",
            props.value.origin,
            (origin) => update({ origin }),
            "url",
          )}
          <p>
            This is the app's hosting origin, such as https://app.example.net.
            It does not prove control of the separate issuance namespace.
          </p>
          {input("Controlled TLD to import", props.value.namespace.tld, (tld) =>
            update({ namespace: { tld } }),
          )}
          <p>
            Bind the selected issuance namespace using its actual external control proof. The
            member claim scope is separately authorized by the shared service; parent or sibling rights
            are never inferred from this application's address.
          </p>
        </section>
        <section class="card">
          <h2>Features and services</h2>
          <For
            each={
              [
                ["learning", "Study / Learning"],
                ["karaoke", "Karaoke"],
                ["media", "Video and private media"],
                ["dance", "Private Dance review"],
                ["telegram", "Connected Telegram"],
              ] as const
            }
          >
            {([key, label]) => (
              <label class="check">
                <input
                  type="checkbox"
                  aria-label={label}
                  checked={props.value.features[key]}
                  disabled={
                    props.disabled ||
                    !props.capabilities.features.includes(key) ||
                    ((key === "karaoke" || key === "telegram") &&
                      !props.value.features.learning) ||
                    (key === "dance" && !props.value.features.media)
                  }
                  onChange={(e) => feature(key, e.currentTarget.checked)}
                />
                {label}
                <Show
                  when={
                    (key === "karaoke" || key === "telegram") &&
                    !props.value.features.learning
                  }
                >
                  {" "}
                  · enable Learning first
                </Show>
                <Show when={key === "dance" && !props.value.features.media}>
                  {" "}
                  · enable video and private media first
                </Show>
                <Show when={!props.capabilities.features.includes(key)}>
                  {" "}
                  — backend unavailable
                </Show>
              </label>
            )}
          </For>
          <Show when={props.capabilities.publicationProfiles.length===0}><p role="status">No publication service is connected. Use the authenticated bootstrap's supported create/connect service journey, then refresh discovery. This backend has not supplied an in-wizard provisioning capability.</p></Show>
          <p class="fine">Publication and recognition use the Root-selected shared profile; community provider keys and catalogue selection are not setup inputs.</p>
          <label class="field"><span>Shared publication profile</span>
            <input aria-label="Shared publication profile" readonly value={props.capabilities.publicationProfiles.find(p=>p.id===props.value.services.publicationProfile)?.label ?? "Unavailable: connect the genuine Root-selected profile"} />
          </label>
          <Show when={props.value.features.learning}>
            <Show when={props.capabilities.learningProfiles.length===0}><p role="status">No Learning configuration is connected. The real backend must create or connect it; entering a raw ID cannot establish readiness.</p></Show>
            <p>{props.capabilities.policy?.speech?.definition ?? "The selected service has not supplied its admission-unit contract. Provider billing units are separate."}</p>
            <label class="field">
              <span>Learning configuration</span>
              <select
                aria-label="Learning configuration"
                disabled={props.disabled}
                value={props.value.services.learningProfile ?? ""}
                onChange={(e) =>
                  update({
                    services: {
                      ...props.value.services,
                      learningProfile: e.currentTarget.value || null,
                    },
                  })
                }
              >
                <option value="">Choose a discovered configuration</option>
                <For each={props.capabilities.learningProfiles}>
                  {(p) => (
                    <option value={p.id}>
                      {p.label}
                      {p.verified ? "" : " — not verified"}
                    </option>
                  )}
                </For>
              </select>
            </label>
            <p>
              The full app and this Learning operator are included in one
              reviewed deployment. Contract, issuer and resource IDs are
              discovered and shown under Advanced.
            </p>
            <div class="grid">
              {input(
                "Daily speech admission units (defined by selected service)",
                String(props.value.limits.speechDaily),
                (v) =>
                  update({
                    limits: { ...props.value.limits, speechDaily: Number(v) },
                  }),
                "number",
              )}
              {input(
                "Units reserved for website learners",
                String(props.value.limits.websiteReserved),
                (v) =>
                  update({
                    limits: {
                      ...props.value.limits,
                      websiteReserved: Number(v),
                    },
                  }),
                "number",
              )}
              {input(
                "Daily units per account",
                String(props.value.limits.perAccountDaily),
                (v) =>
                  update({
                    limits: {
                      ...props.value.limits,
                      perAccountDaily: Number(v),
                    },
                  }),
                "number",
              )}
              {input(
                "Monthly provider budget (USD)",
                String(props.value.limits.monthlyUsdCents / 100),
                (v) =>
                  update({
                    limits: {
                      ...props.value.limits,
                      monthlyUsdCents: Number(v) * 100,
                    },
                  }),
                "number",
              )}
            </div>
          </Show>
        </section>
        <LinuxStorageFields
          value={props.value}
          capabilities={props.capabilities}
          disabled={props.disabled}
          onChange={props.onChange}
        />
      </Show>
    </>
  );
}
