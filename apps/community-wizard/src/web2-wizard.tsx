import { createSignal, For, onSettled, Show } from "solid-js";
import { formatEther, type TypedDataDefinition } from "viem";
import { hashJson } from "../../../packages/community/common.ts";
import { httpsOrigin } from "../../../packages/community/manifest-core.ts";
import type { Web2OperatorDraft } from "../web2-setup-draft.ts";
import {createWeb2MossWindow} from "./web2-moss-window.ts";
import { Web2FilebaseSetup } from "./web2-filebase-setup.tsx";
import {
  createWeb2WizardClient,
  type Web2Action,
  type Web2Snapshot,
} from "./web2-api.ts";

export function Web2Wizard() {
  const api = createWeb2WizardClient();
  const wallet=()=>{
    const signingOrigin=snapshot()?.view.signingOrigin;
    if(!signingOrigin)throw Error("A trusted HTTPS MOSS signing window is unavailable. Keep the paired Wizard on loopback.");
    return createWeb2MossWindow({signingOrigin});
  };
  const [snapshot, setSnapshot] = createSignal<Web2Snapshot>(),
    [error, setError] = createSignal(""),
    [busy, setBusy] = createSignal(false);
  const [name, setName] = createSignal(""),
    [origin, setOrigin] = createSignal(""),
    [controller, setController] = createSignal(""),
    [owner, setOwner] = createSignal(""),
    [invite, setInvite] = createSignal("");
  const [controllerConnected, setControllerConnected] = createSignal(false);
  const [draftState, setDraftState] = createSignal<"idle" | "saving" | "saved" | "failed">("idle");
  const [draftError, setDraftError] = createSignal("");
  let draftRevision = 0, savingDraft = false;
  let draftFields: Web2OperatorDraft = { name: "", origin: "", controller: "", owner: "", invite: "" };
  let queuedDraft: Web2OperatorDraft | undefined;
  const [rolesReviewed, setRolesReviewed] = createSignal(false),
    [ownerReviewed, setOwnerReviewed] = createSignal(false),
    [accepted, setAccepted] = createSignal(false),
    [reviewed, setReviewed] = createSignal(false),
    [study, setStudy] = createSignal(false),
    [waitingForInstallation, setWaitingForInstallation] = createSignal(false);
  const view = () => snapshot()?.view;
  const [now, setNow] = createSignal(Date.now());
  const sessionDeadline = () => snapshot()?.operatorSessionExpiresAt;
  const registrationDeadline = () => {
    const expiresAt = view()?.registrationExpiresAt;
    return expiresAt === undefined ? undefined : Math.min(expiresAt * 1000, sessionDeadline() ?? Infinity);
  };
  const sessionEnded = () => now() >= (sessionDeadline() ?? Infinity);
  const registrationEnded = () => now() >= (registrationDeadline() ?? Infinity);
  const locked = () => busy() || sessionEnded() || Boolean(view()?.busy || view()?.pairingOnly);
  const registrationExpiredNotice = "The saved registration challenge expired. Reconcile the original enrollment to check its status.";
  const deadlineText = (deadline: number) => new Date(deadline).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
  const filebaseReady = () => !view()?.filebase || view()?.filebase?.status === "ready";
  const eligibleOrigin = () => {
    try { return httpsOrigin(origin()) === origin(); }
    catch { return false; }
  };
  const prepareReady = () => !locked() && filebaseReady() && draftState() === "saved" &&
    controllerConnected() && rolesReviewed() && accepted() && Boolean(view()?.serverPublisher) &&
    controller() !== view()?.serverPublisher?.address && name().trim().length > 0 && !/[<>\u0000-\u001f]/.test(name()) &&
    eligibleOrigin() && /^0x[a-f0-9]{40}$/.test(owner()) && !/^0x0+$/.test(owner()) &&
    /^[a-f0-9]{64}$/.test(invite());

  async function saveDraft() {
    if (savingDraft || !queuedDraft) return;
    savingDraft = true;
    setDraftState("saving");
    setDraftError("");
    try {
      while (queuedDraft) {
        const fields = queuedDraft;
        queuedDraft = undefined;
        try {
          const saved = await api.draft(snapshot()!.csrf, { revision: draftRevision, fields });
          draftRevision = saved.revision;
        } catch (error) {
          queuedDraft ??= fields;
          setDraftState("failed");
          setDraftError(error instanceof Error ? error.message : "The paired runner could not save the draft.");
          return;
        }
      }
      setDraftState("saved");
    } finally {
      savingDraft = false;
    }
  }

  function rememberDraft(changes: Partial<Web2OperatorDraft>) {
    if (!snapshot() || view()?.pairingOnly || view()?.selection) return;
    draftFields = { ...draftFields, ...changes };
    queuedDraft = draftFields;
    void saveDraft();
  }

  async function loadDraft() {
    const fresh = await api.state();
    if (!fresh.view.pairingOnly) {
      const saved = await api.draft(fresh.csrf);
      draftRevision = saved.revision;
      if (saved.fields) {
        draftFields = saved.fields;
        setName(saved.fields.name);
        setOrigin(saved.fields.origin);
        setController(saved.fields.controller);
        setOwner(saved.fields.owner);
        setInvite(saved.fields.invite);
        setDraftState("saved");
      }
    }
    return fresh;
  }
  const offeredPractice = () => view()?.privatePracticeSelection ?? (view()?.privateStudyAvailable ? "study-v5" : undefined);
  const practiceSelection = () => {
    const retained = view()?.installationSelection;
    return retained ? retained === "off" ? undefined : retained : study() ? offeredPractice() : undefined;
  };
  const practiceLabel = () => {
    const value = practiceSelection() ?? offeredPractice();
    if (value === "study-karaoke-dance-v2") return "private Study, Karaoke and Dance";
    if (value === "study-karaoke-v5") return "private Study and Karaoke";
    if (value === "study-dance-v2") return "private Study and Dance";
    return "private Study";
  };
  async function perform(work: () => Promise<Web2Snapshot>, readOnly = false) {
    if (busy() || (!readOnly && view()?.busy)) return;
    setBusy(true);
    setError("");
    try {
      setSnapshot(await work());
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "This step did not complete. Reconcile the original request.",
      );
      try {
        setSnapshot(await api.state());
      } catch {
        /* Retain the original visible state when transport is unavailable. */
      }
    } finally {
      setBusy(false);
    }
  }
  onSettled(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!savingDraft && !queuedDraft) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    void perform(loadDraft);
    return () => {
      clearInterval(tick);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  });
  const send = async (
    action: Web2Action,
    input: Record<string, unknown> = {},
  ) => {
    const installation =
      action === "installation-prepare" ||
      action === "install" ||
      action === "installation-status";
    if (installation) setWaitingForInstallation(true);
    try {
      return await api.send(action, input, snapshot()!);
    } finally {
      if (installation) setWaitingForInstallation(false);
    }
  };
  async function sign(
    data: unknown,
    requestDigest = hashJson(data),
  ): Promise<string> {
    const result = await wallet().signTypedData({
      expectedController: view()!.selection!.controller,
      requestDigest: requestDigest as `0x${string}`,
      data: data as TypedDataDefinition,
    });
    if (result.status === "cancelled")
      throw Error("Signing cancelled. Your original request is retained.");
    if (result.status === "error")
      throw Error(
        result.code === "web2_wallet_unavailable"
          ? "MOSS is unavailable in the configured HTTPS signing window. Reopen it and retry the retained request."
          : result.code,
      );
    return result.signature;
  }
  return (
    <section class="linux-setup" aria-label="Web2 community setup">
      <h1>Set up your HTTPS community</h1>
      <p>
        Create a community on your Linux host. Names and HNS are separate steps.
      </p>
      <Show when={view()?.pairingOnly}>
        <p role="status">This pairing session is read-only.</p>
      </Show>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
      <Show when={!view()?.challenge && view()?.filebase}>
        {(filebase) => (
          <Web2FilebaseSetup
            view={filebase()}
            busy={locked()}
            check={() => void perform(() => send("filebase-check"))}
            save={(token) => void perform(() => send("filebase-save", { token }))}
          />
        )}
      </Show>
      <Show when={waitingForInstallation()}>
        <p role="status">
          Waiting for the Linux installation step to finish. If the connection
          is interrupted, reload this runner and reconcile the saved request.
        </p>
      </Show>
      <Show
        when={snapshot()}
        fallback={<p role="status">Connecting to the paired setup runner…</p>}
      >
        <p>
          Network: {view()!.policy.chainId}. Hosted enrollment:{" "}
          {view()!.policy.serviceOrigin}.
        </p>
        <Show when={sessionDeadline()}>{deadline => (
          <p>
            {sessionEnded()
              ? "This operator session expired. Open a newly authorized setup session for the saved original."
              : `Operator session ends at ${deadlineText(deadline())}.`}
          </p>
        )}</Show>
        <Show
          when={!view()!.selection}
          fallback={
            <>
              <h2>{view()!.selection!.name}</h2>
              <p>{view()!.selection!.origin}</p>
              <p>Controller: {view()!.selection!.controller}</p>
              <p>Publisher: {view()!.selection!.publisher}</p>
              <p>Community: {view()!.selection!.communityId}</p>
            </>
          }
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!prepareReady()) return;
              void perform(async () => {
                const state = await send("prepare", {
                  name: name(),
                  origin: origin(),
                  controller: controller(),
                  publisher: view()!.serverPublisher?.address ?? "",
                  inviteToken: invite(),
                  noticeAccepted: accepted(),
                });
                setInvite("");
                return state;
              });
            }}
          >
            <label>
              Community name
              <input
                required
                maxlength={63}
                value={name()}
                onInput={(e) => {
                  const name = e.currentTarget.value;
                  setName(name);
                  rememberDraft({ name });
                }}
                disabled={locked()}
              />
            </label>
            <label>
              HTTPS community origin
              <input
                required
                type="url"
                maxlength={300}
                placeholder="https://community.example"
                value={origin()}
                onInput={(e) => {
                  const origin = e.currentTarget.value;
                  setOrigin(origin);
                  rememberDraft({ origin });
                }}
                disabled={locked()}
              />
            </label>
            <button
              type="button"
              disabled={locked()}
              onClick={() =>
                void perform(async () => {
                  const account = await wallet().connect();
                  const selectedOwner = owner() || account.address;
                  setController(account.address);
                  setControllerConnected(true);
                  setOwner(selectedOwner);
                  setRolesReviewed(false);
                  rememberDraft({ controller: account.address, owner: selectedOwner });
                  return api.state();
                })
              }
            >
              Connect MOSS
            </button>
            <p>Controller: {controller() || "Connect your human controller"}</p>
            <Show when={controller() && !controllerConnected()}>
              <p>Reconnect MOSS to confirm this saved controller.</p>
            </Show>
            <p>
              Server publisher:{" "}
              {view()!.serverPublisher?.address ??
                "Managed publisher custody unavailable"}
            </p>
            <label>
              Owner wallet
              <input
                required
                pattern="0x[a-fA-F0-9]{40}"
                maxlength={42}
                value={owner()}
                onInput={(e) => {
                  const owner = e.currentTarget.value.toLowerCase();
                  setOwner(owner);
                  setRolesReviewed(false);
                  setOwnerReviewed(false);
                  rememberDraft({ owner });
                }}
                disabled={locked()}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={rolesReviewed()}
                onChange={(e) => setRolesReviewed(e.currentTarget.checked)}
                disabled={locked()}
              />
              I reviewed the controller, owner and server publisher
            </label>
            <label>
              Pilot invitation
              <input
                required
                pattern="[a-f0-9]{64}"
                maxlength={64}
                type="password"
                autocomplete="off"
                value={invite()}
                onInput={(e) => {
                  const invite = e.currentTarget.value;
                  setInvite(invite);
                  rememberDraft({ invite });
                }}
                disabled={locked()}
              />
            </label>
            <p>{view()!.notice}</p>
            <label>
              <input
                type="checkbox"
                checked={accepted()}
                onChange={(e) => setAccepted(e.currentTarget.checked)}
                disabled={locked()}
              />
              I accept this pilot notice and its storage limitations.
            </label>
            <Show when={draftState() === "saving"}>
              <p role="status">Saving draft…</p>
            </Show>
            <Show when={draftState() === "saved"}>
              <p role="status">Draft saved for this paired session.</p>
            </Show>
            <Show when={draftState() === "failed"}>
              <p role="alert">{draftError()}</p>
              <button type="button" disabled={locked()} onClick={() => void saveDraft()}>
                Save draft again
              </button>
            </Show>
            <button type="submit" disabled={!prepareReady()}>Prepare enrollment</button>
          </form>
        </Show>
        <p role="status">Setup state: {view()!.phase}</p>
        <Show when={view()!.selection && !view()!.challenge}>
          <Show when={view()!.invitationCorrectionRequired}>
            <label>
              Replacement pilot invitation
              <input
                type="password"
                autocomplete="off"
                value={invite()}
                onInput={(e) => setInvite(e.currentTarget.value)}
                disabled={locked()}
              />
            </label>
            <p>{view()!.notice}</p>
            <label>
              <input
                type="checkbox"
                checked={accepted()}
                onChange={(e) => setAccepted(e.currentTarget.checked)}
              />
              I accept this pilot notice for the corrected invitation.
            </label>
          </Show>
          <button
            disabled={
              locked() || !filebaseReady() || (view()!.invitationCorrectionRequired && !accepted())
            }
            onClick={() =>
              void perform(() =>
                send(
                  "resume-prepare",
                  view()!.invitationCorrectionRequired
                    ? { inviteToken: invite(), noticeAccepted: accepted() }
                    : {},
                ),
              )
            }
          >
            Resume original preparation
          </button>
        </Show>
        <Show when={view()!.challenge}>
          <p>{view()!.notice}</p>
          <p>
            Policy: {view()!.policy.admissionPolicy.version} (
            {view()!.policy.admissionPolicy.sha256}). Initial controller gas:{" "}
            {formatEther(BigInt(view()!.policy.controllerInitialWei))} ETH.
            Initial publisher gas:{" "}
            {formatEther(BigInt(view()!.policy.publisherInitialWei))} ETH.
          </p>
          <p>
            Your wallet authorizes this community, its controller and publisher,
            exact origin, configuration and selected pilot policy. It does not
            send a community transaction.
          </p>
          <Show when={registrationDeadline()}>{deadline => (
            <p>{registrationEnded() && !sessionEnded()
              ? registrationExpiredNotice
              : `Registration authorization ends at ${deadlineText(deadline())}.`}</p>
          )}</Show>
          <button
            disabled={locked() || registrationEnded()}
            onClick={() =>
              void perform(async () => {
                if (Date.now() >= (registrationDeadline() ?? Infinity))
                  throw Error(registrationExpiredNotice);
                return send(
                  "redeem",
                  view()!.controllerAuthorized
                    ? {}
                    : { signature: await sign(view()!.challenge) },
                );
              })
            }
          >
            {view()!.controllerAuthorized
              ? "Retry original registration"
              : "Authorize community registration"}
          </button>
          <Show when={view()!.controllerAuthorized}>
            <button
              disabled={locked()}
              onClick={() => void perform(() => send("reconcile"))}
            >
              Reconcile original enrollment
            </button>
          </Show>
        </Show>
        <Show
          when={view()!.enrollment?.operations.some(
            (op) => op.kind === "registration" && op.state === "consumed",
          )}
        >
          <h2>Initial publication gas</h2>
          <p>
            Pirate supplies the policy's capped initial gas allocation. Each
            distinct recipient authorizes this enrollment; no funding key is
            collected.
          </p>
          <For each={view()!.recipients}>
            {(r) => (
              <p>
                {r.address}: {formatEther(BigInt(r.value))} ETH
              </p>
            )}
          </For>
          <button
            disabled={locked()}
            onClick={() => void perform(() => send("topup"))}
          >
            {view()!.fundingAuthorized
              ? "Retry original gas allocation"
              : "Authorize initial gas allocation"}
          </button>
          <h2>Owner publishing authorization</h2>
          <p>
            Publishing is reviewed separately from enrollment, login and song
            terms. Policy: {view()!.policy.admissionPolicy.version} (
            {view()!.policy.admissionPolicy.sha256}).
          </p>
          <Show when={!view()!.publishing}>
            <label>
              Nominated owner wallet
              <input
                pattern="0x[a-fA-F0-9]{40}"
                value={owner() || view()!.selection!.controller}
                onInput={(e) => {
                  setOwner(e.currentTarget.value.toLowerCase());
                  setRolesReviewed(false);
                }}
                disabled={locked()}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={rolesReviewed()}
                onChange={(e) => setRolesReviewed(e.currentTarget.checked)}
                disabled={locked()}
              />
              I reviewed the controller, owner and server publisher for
              publishing
            </label>
            <button
              disabled={locked() || !rolesReviewed()}
              onClick={() =>
                void perform(() =>
                  send("publishing-prepare", {
                    ownerWallet: owner() || view()!.selection!.controller,
                    rolesReviewed: rolesReviewed(),
                  }),
                )
              }
            >
              Review owner publishing
            </button>
          </Show>
          <Show when={view()!.publishing}>
            <p>Owner: {view()!.publishing!.authorization.ownerWallet}</p>
            <p>
              Window: {view()!.publishing!.authorization.validFrom} through{" "}
              {view()!.publishing!.authorization.expiresAt} (Unix seconds).
            </p>
            <p>
              Destination: chain{" "}
              {view()!.publishing!.selection.grant.destination.chainId}, Posts{" "}
              {view()!.publishing!.selection.grant.destination.postsContract},
              publisher{" "}
              {view()!.publishing!.selection.grant.destination.publisher}.
            </p>
            <p>
              Limits: songs {view()!.publishing!.selection.grant.limits.songs};
              pin additions {view()!.publishing!.selection.grant.limits.pinAdds}
              ; pin bytes {view()!.publishing!.selection.grant.limits.pinBytes};
              recognition requests{" "}
              {view()!.publishing!.selection.grant.limits.recognitionRequests};
              post fee wei{" "}
              {view()!.publishing!.selection.grant.limits.postFeeWei}.
            </p>
            <Show when={!view()!.publishing!.authorized}>
              <label>
                <input
                  type="checkbox"
                  checked={ownerReviewed()}
                  onChange={(e) => setOwnerReviewed(e.currentTarget.checked)}
                  disabled={locked()}
                />
                I reviewed the owner policy, window, destination and every
                service limit
              </label>
              <button
                disabled={locked() || !ownerReviewed()}
                onClick={() =>
                  void perform(async () =>
                    send("publishing-authorize", {
                      signature: await sign(
                        view()!.publishing!.typedData,
                        view()!.publishing!.requestDigest,
                      ),
                      requestDigest: view()!.publishing!.requestDigest,
                      reviewed: ownerReviewed(),
                    }),
                  )
                }
              >
                Authorize owner publishing
              </button>
            </Show>
            <Show
              when={
                view()!.publishing!.authorized && !view()!.publishing!.attached
              }
            >
              <button
                disabled={locked() || (!view()!.publishing!.pending && !view()!.publishing!.live)}
                onClick={() =>
                  void perform(() =>
                    send(
                      view()!.publishing!.pending
                        ? "publishing-reconcile"
                        : "publishing-attach",
                    ),
                  )
                }
              >
                {view()!.publishing!.pending
                  ? "Reconcile original publishing attachment"
                  : "Attach reviewed publishing grant"}
              </button>
            </Show>
            <Show when={view()!.publishing!.attached}>
              <p>{view()!.publishing!.live ? "Publishing grant attached" : "Original grant attachment recorded; window expired"}</p>
            </Show>
          </Show>
          <h2>Install on this Linux host</h2>
          <Show
            when={view()!.installationAvailable}
            fallback={
              <p>
                The real Linux Web2 installer is unavailable. Enrollment is
                retained; this community is not reported installed.
              </p>
            }
          >
            <Show when={offeredPractice() || practiceSelection()}
              fallback={<p>Private Study is unavailable on this setup runner.</p>}>
              <label>
                <input type="checkbox" checked={Boolean(practiceSelection())}
                  disabled={locked() || Boolean(view()!.installationSelection)}
                  onChange={(event) => setStudy(event.currentTarget.checked)} />
                Include {practiceLabel()}
              </label>
            </Show>
            <button
              disabled={locked() || !view()!.publishing?.attached}
              onClick={() => void perform(() => send("installation-prepare",
                practiceSelection() ? { privatePractice: practiceSelection() } : {}))}
            >
              Review Linux installation
            </button>
            <Show when={view()!.installPlan}>
              <p>
                Install {view()!.installPlan!.summary.name} at{" "}
                {view()!.installPlan!.summary.origin}, using the registered
                controller and publisher shown above. Names remain disabled.
                {view()!.installPlan!.summary.learningEnabled
                  ? ` This installation includes ${practiceLabel()}.`
                  : " Private Study is off."}
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={reviewed()}
                  onChange={(e) => setReviewed(e.currentTarget.checked)}
                  disabled={locked()}
                />
                I reviewed this installation on the selected host.
              </label>
              <button
                disabled={locked() || !reviewed()}
                onClick={() =>
                  void perform(() =>
                    send("install", {
                      planId: view()!.installPlan!.planId,
                      planDigest: view()!.installPlan!.planDigest,
                      approved: true,
                    }),
                  )
                }
              >
                Install reviewed community
              </button>
              <button
                disabled={locked()}
                onClick={() => void perform(() => send("installation-status"))}
              >
                Read installation status
              </button>
            </Show>
          </Show>
        </Show>
        <Show when={view()!.observation}>
          <p role="status">
            Last installation observation: {view()!.observation!.state}
          </p>
        </Show>
        <button
          disabled={busy()}
          onClick={() => void perform(() => api.state(), true)}
        >
          Refresh retained setup
        </button>
      </Show>
    </section>
  );
}
