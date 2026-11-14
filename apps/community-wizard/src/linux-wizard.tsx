import type {OriginalLinuxDraft} from "../../../packages/community-setup/linux-create-profile.ts";
import { createSignal, onMount, onCleanup, Show, For } from "solid-js";
import {
  linuxRequest,
  sameLinuxSettings,
  type LinuxSnapshot,
} from "./linux-api.ts";
import { LinuxProfileForm, emptyLinuxDraft, emptyLinuxCreateDraft } from "./linux-profile-form.tsx";
import { LinuxReview } from "./linux-review.tsx";
import { LinuxRecoveryPanel } from "./linux-recovery-panel.tsx";
import { LinuxCredentialsPanel } from "./linux-credentials-panel.tsx";
import type { LinuxDraftV2 } from "../../../packages/community-setup/shared-linux-profile.ts";
export function LinuxWizard(props:{namespaceProofCollector?:(challenge:import("../server/linux-contracts.ts").NamespaceChallenge)=>Promise<unknown>} = {}) {
  const [snapshot, setSnapshot] = createSignal<LinuxSnapshot>();
  const [draft, setDraft] = createSignal<OriginalLinuxDraft>(emptyLinuxDraft());
  const [working, setWorking] = createSignal(false),
    [error, setError] = createSignal("");
  const [approved, setApproved] = createSignal(false),
    [credentials, setCredentials] = createSignal<Record<string, string>>({});
  const [backup, setBackup] = createSignal<File>(),
    [recoveryKey, setRecoveryKey] = createSignal("");
  const [step, setStep] = createSignal(0);
  const [collecting,setCollecting]=createSignal(false);
  const busy=()=>working()||collecting();
  const [uploading, setUploading] = createSignal(false);
  const current = () => {
    const s = snapshot();
    return s?.available ? s : undefined;
  };
  const retained = () => current()?.state;
  const dirty = () => {
    const state = retained();
    if (!state) return false;
    return state.draft
      ? !sameLinuxSettings(draft(), state.draft)
      : !sameLinuxSettings(
          { mode: draft().mode, target: draft().target },
          state.destination,
        );
  };
  const pending = () => {
    const op = retained()?.operation;
    return Boolean(op && ["running", "pending", "unknown"].includes(op.state));
  };
  const held = () => pending() && retained()?.operation?.custody !== "cleared";
  async function refresh(initial = false) {
    const value = await linuxRequest();
    setSnapshot(value);
    if (initial && value.available) {
      const createOnly=value.capabilities.operations.length===1 && value.capabilities.operations[0]==="create" &&
        value.capabilities.backup.maxBytes===0;
      const empty=createOnly && (!value.state.destination || value.state.destination.mode==="create") ? emptyLinuxCreateDraft() : emptyLinuxDraft();
      const d:OriginalLinuxDraft = value.state.draft ?? (empty.version === 3 ? empty : {
        ...empty, ...(value.state.destination ?? {}),
      });
      if (!value.state.draft) {
        d.services.publicationProfile =
          value.capabilities.publicationSelection ?? "";
        if(d.version === 2)d.storage.backup =
          value.capabilities.backupProfiles.find(
            (p) => p.profile.provider === "filebase-private",
          )?.profile ??
          value.capabilities.backupProfiles[0]?.profile ??
          d.storage.backup;
      }
      setDraft(d);
      if (value.state.operation) setStep(2);
    }
  }
  async function action(
    path: string,
    input: unknown = {},
    file?: File,
    inherit = false,
  ) {
    if (working()) return;
    if (
      dirty() &&
      [
        "inspect",
        "namespace",
        "import",
        "restore/inspect",
        "credentials",
        "credentials/verify",
        "plan",
        "deploy",
      ].includes(path)
    ) {
      setError(
        "Save changed settings in Community & host before inspecting, verifying or deploying.",
      );
      return;
    }
    setWorking(true);
    setUploading(path === "backup");
    setError("");
    setApproved(false);
    try {
      const value = await linuxRequest(path, input, snapshot()?.csrf, file);
      setSnapshot(value);
      if (inherit && value.available && value.state.draft)
        setDraft(value.state.draft);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "This step did not complete. Resume from the original runner.",
      );
      await refresh().catch(() => {});
    } finally {
      setWorking(false);
      setUploading(false);
    }
  }
  onMount(() => {
    void refresh(true).catch((error) =>
      setError(
        error instanceof Error
          ? error.message
          : "Could not reach the setup server. Pair this operator through its bootstrap and reconnect to the printed loopback address.",
      ),
    );
    const timer = setInterval(() => {
      if (held() && !working()) void action("reconcile");
    }, 3000);
    onCleanup(() => clearInterval(timer));
  });
  const save = () =>
    draft().mode !== "create" && !retained()?.draft
      ? action("destination", {
          revision: retained()?.revision,
          mode: draft().mode,
          target: draft().target,
        })
      : action(
          "settings",
          { revision: retained()?.revision, draft: draft() },
          undefined,
          true,
        );
  async function discoverInstalledProfile(){
    const state=current();if(!state || working() || held() || state.state.operation || draft().mode!=="create")return;
    const target=structuredClone(draft().target);setWorking(true);setError("");setApproved(false);
    try{
      const saved=await linuxRequest("destination",{revision:state.state.revision,mode:"create",target},state.csrf);setSnapshot(saved);
      if(!saved.available)throw Error(saved.correction);
      const inspected=await linuxRequest("inspect",{},saved.csrf);setSnapshot(inspected);
      if(!inspected.available)throw Error(inspected.correction);
      const prepared=inspected.state.target?.prepared;
      if(!prepared)throw Error("This target has no authenticated prepared community profile. Keep its original state and correct the installed inputs.");
      const preparedDraft=structuredClone(prepared.settings);
      if(preparedDraft.version===3){
        if(target.kind!=="local-linux")throw Error("The create-only original requires its local host.");
        setDraft(preparedDraft);
      }else setDraft({...preparedDraft,mode:"create",target});
      setStep(0);
    }catch(error){setError(error instanceof Error?error.message:"Profile discovery did not complete. Reconnect to the same runner.");await refresh().catch(()=>{});}
    finally{setWorking(false);}
  }
  async function verifyNamespaceControl() {
    if(!props.namespaceProofCollector || working() || collecting())return;
    const oldId=current()?.state.namespaceChallenge?.id;
    setCollecting(true);
    try {
      await action("namespace/begin");
      const state=current()?.state, challenge=state?.namespaceChallenge;
      if(state?.namespaceRequest || !challenge || challenge.id===oldId)throw new Error("Reconcile the original namespace request before another proof.");
      const proof=await props.namespaceProofCollector(challenge);
      await action("namespace/complete",{challengeId:challenge.id,proof});
    } catch(error) {setError(error instanceof Error?error.message:"Namespace verification did not complete. Recover its original request.");}
    finally {setCollecting(false);}
  }
  return (
    <>
      <header class="top">
        <a class="brand" href="/" aria-label="Pirate setup home">
          <span class="mark">P</span>PIRATE
        </a>
        <span class="edition">
          COMMUNITY SETUP <i>Linux</i>
        </span>
        <span class="local">
          <span />
          Setup server
        </span>
      </header>
      <div class="layout">
        <aside class="navigation">
          <p class="eyebrow">MAKE A PLACE FOR YOUR MUSIC</p>
          <h1>
            Your community.
            <br />
            Your Linux host.
          </h1>
          <p class="intro">
            Set up your community on your own Linux server. The installed profile lists its supported actions. When setup runs
            on a VPS, open it from your computer through the bootstrap's
            authenticated SSH tunnel. The public app uses its own HTTPS address
            after deployment.
          </p>
          <nav aria-label="Linux setup steps">
            <For
              each={["Community & host", "Verify & recover", "Review & deploy"]}
            >
              {(label, index) => (
                <button
                  classList={{ selected: step() === index() }}
                  aria-current={step() === index() ? "step" : undefined}
                  disabled={index() > 0 && dirty()}
                  onClick={() => setStep(index())}
                >
                  <span class="number">{index() + 1}</span>
                  {label}
                  <span class="arrow">→</span>
                </button>
              )}
            </For>
          </nav>
          <div class="resume">
            <p>
              The setup server saves settings and original operation identity.
              Reconnect to that same server after interruption. Uncertain
              effects must be reconciled before retry.
            </p>
          </div>

        </aside>
        <main>
          <Show when={error()}>
            <div class="alert" role="alert">
              {error()}
            </div>
          </Show>
          <Show
            when={snapshot()}
            fallback={<p role="status">Connecting to the setup runner…</p>}
          >
            <Show
              when={current()}
              fallback={
                <section class="card">
                  <h2>Linux backend unavailable</h2>
                  <p role="status">
                    {snapshot()?.available === false
                      ? (
                          snapshot() as Extract<
                            LinuxSnapshot,
                            { available: false }
                          >
                        ).correction
                      : "Connect the real Linux lifecycle and naming adapters to this runner."}
                  </p>
                  <p>
                    The browser cannot infer a deployment from saved
                    configuration or use a setup-page recipe as the full
                    application.
                  </p>
                </section>
              }
            >
              {(s) => (
                <>
                  <Show when={s().capabilities.limitations.length}>
                    <div class="note">
                      <h3>Backend support</h3>
                      <ul>
                        <For each={s().capabilities.limitations}>
                          {(v) => <li>{v}</li>}
                        </For>
                      </ul>
                    </div>
                  </Show>
                  <Show when={dirty()}>
                    <div class="note" role="status">
                      Unsaved changes. Save settings in Community &amp; host
                      before inspecting or deploying.
                    </div>
                  </Show>
                  <Show when={s().state.draft ?? s().state.destination}>
                    {(saved) => (
                      <p class="fine">
                        Saved host:{" "}
                        {saved().target.kind === "local-linux"
                          ? (s().state.target?.description ??
                            "the server running this setup")
                          : (
                              saved().target as Extract<
                                LinuxDraftV2["target"],
                                { kind: "ssh-linux" }
                              >
                            ).host}{" "}
                        · {saved().mode}
                      </p>
                    )}
                  </Show>
                  <Show when={step() === 0}>
                    <Show when={draft().mode==="create" && !s().state.draft && !s().state.operation}>
                      <div class="card">
                        <h3>Installed community profile</h3>
                        <p>Discover the actual signed name, shared namespace, selected services and storage on this host. Review them before saving; discovery does not deploy or verify readiness.</p>
                        <button class="secondary" disabled={busy() || held()} onClick={()=>void discoverInstalledProfile()}>Discover installed community profile</button>
                      </div>
                    </Show>
                    <LinuxProfileForm
                      value={draft()}
                      capabilities={s().capabilities}
                      resolved={Boolean(s().state.draft)}
                      disabled={busy() || held()}
                      onChange={(v) => {
                        setDraft(v);
                        setApproved(false);
                      }}
                    />
                    <button
                      class="primary"
                      disabled={
                        busy() ||
                        held() ||
                        Boolean(s().state.secretRequest) ||
                        Boolean(s().state.uploadRequest)
                      }
                      onClick={() => void save()}
                    >
                      {draft().mode !== "create" && !s().state.draft
                        ? "Use this destination host"
                        : "Save setup settings"}
                    </button>
                    <p class="fine">
                      Save changes before inspecting this host. Correction
                      remains available after a reconciled failure; retained
                      resource identities are not replaced.
                    </p>
                    <button
                      class="secondary"
                      disabled={
                        busy() ||
                        (!s().state.draft && !s().state.destination) ||
                        dirty() ||
                        held()
                      }
                      onClick={() => {
                        setStep(1);
                        void action("inspect");
                      }}
                    >
                      Inspect host and continue
                    </button>
                  </Show>
                  <Show when={step() === 1}>
                    <section class="card">
                      <h2>Inspect and verify</h2>
                      <button
                        class="secondary"
                        disabled={
                          busy() ||
                          (!s().state.draft && !s().state.destination) ||
                          dirty() ||
                          held()
                        }
                        onClick={() => void action("inspect")}
                      >
                        Inspect selected Linux host
                      </button>
                      <Show when={s().state.target}>
                        {(target) => (
                          <>
                            <p>
                              {target().description} ·{" "}
                              {target().supported
                                ? "supported by this adapter"
                                : "unsupported"}
                            </p>
                            <p class="address">
                              Host fingerprint: {target().fingerprint}
                            </p>
                            <For each={target().corrections}>
                              {(v) => <p>{v}</p>}
                            </For>
                            <Show
                              when={
                                (s().state.draft?.mode ??
                                  s().state.destination?.mode) === "import"
                              }
                            >
                              <h3>Discovered installations</h3>
                              <For
                                each={target().existing}
                                fallback={
                                  <p>
                                    No supported installation was discovered.
                                    Import cannot allocate a replacement
                                    community.
                                  </p>
                                }
                              >
                                {(profile) => (
                                  <button
                                    class="secondary"
                                    disabled={busy()}
                                    onClick={() =>
                                      void action(
                                        "import",
                                        {
                                          revision: s().state.revision,
                                          profile,
                                        },
                                        undefined,
                                        true,
                                      )
                                    }
                                  >
                                    Import {profile.settings.name} ·{" "}
                                    {profile.identity.deploymentId}
                                  </button>
                                )}
                              </For>
                            </Show>
                          </>
                        )}
                      </Show>
                      <button
                        class="secondary"
                        disabled={
                          busy() || dirty() || !s().state.draft || held()
                        }
                        onClick={() => void action("namespace")}
                      >
                        Discover current namespace binding
                      </button>
                      <button class="secondary" disabled={busy() || dirty() || held() || !s().state.draft || !props.namespaceProofCollector || Boolean(s().state.namespaceRequest)}
                        onClick={()=>void verifyNamespaceControl()}>Verify namespace control</button>
                      <Show when={!props.namespaceProofCollector}><p class="fine">The supported external namespace-proof collector is not connected. Existing discovery remains read-only; no new authority can be inferred.</p></Show>
                      <Show when={s().state.namespaceRequest}>
                        <p role="status">The original namespace proof request needs reconciliation. It will not be resubmitted automatically.</p>
                        <button class="secondary" disabled={busy()} onClick={()=>void action("namespace/recover")}>Reconcile original namespace proof</button>
                      </Show>
                      <Show when={s().state.namespace}>
                        {(ns) => (
                          <p role="status">
                            Namespace: {ns().status}. {ns().correction}{" "}
                            {(() => {const proof=ns();return proof.status==="verified"
                              ? "External role: "+proof.authorityKind+". Operator binding grants no member claim or funding authority."
                              : "";})()}
                          </p>
                        )}
                      </Show>
                    </section>
                    <Show
                      when={
                        (s().state.draft?.mode ??
                          s().state.destination?.mode) === "restore"
                      }
                    >
                      <LinuxRecoveryPanel
                        snapshot={s()}
                        draft={()=>{const d=draft();if(d.version!==2)throw Error("V2 restore profile required");return d;}}
                        setDraft={(value)=>setDraft(value)}
                        working={busy}
                        pending={pending}
                        backup={backup}
                        setBackup={setBackup}
                        recoveryKey={recoveryKey}
                        setRecoveryKey={setRecoveryKey}
                        uploading={uploading}
                        action={action}
                        save={save}
                      />
                    </Show>
                    <LinuxCredentialsPanel
                      snapshot={s()}
                      working={busy}
                      pending={pending}
                      credentials={credentials}
                      setCredentials={setCredentials}
                      action={action}
                    />
                    <button
                      class="primary"
                      disabled={busy() || dirty() || held()}
                      onClick={() => {
                        setStep(2);
                        void action("plan");
                      }}
                    >
                      Review whole application plan
                    </button>
                  </Show>
                  <Show when={step() === 2}>
                    <LinuxReview
                      state={s().state}
                      dirty={dirty()}
                      approved={approved()}
                      onApprove={setApproved}
                      working={busy()}
                      onReview={() => void action("plan")}
                      onDeploy={() =>
                        void action("deploy", {
                          revision: s().state.revision,
                          planDigest: s().state.plan?.digest,
                          targetFingerprint: s().state.plan?.targetFingerprint,
                          approved: approved(),
                        })
                      }
                      onReconcile={() => void action("reconcile")}
                    />
                  </Show>
                </>
              )}
            </Show>
          </Show>
        </main>
      </div>
      <footer>
        BUILD A COMMUNITY THAT BELONGS TO YOU.
        <span>Pirate / Linux setup v1</span>
      </footer>
    </>
  );
}
