import { createSignal, For, onSettled, Show } from "solid-js";
import { formatEther, type TypedDataDefinition } from "viem";
import { hashJson } from "../../../packages/community/common.ts";
import {createWeb2MossWindow} from "./web2-moss-window.ts";
import {
  createWeb2WizardClient,
  type Web2Action,
  type Web2Snapshot,
} from "./web2-api.ts";
import { Web2StorageSection } from "./web2-storage.tsx";
import type { Web2StorageOutcome } from "../server/web2-storage-setup.ts";

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
  const [rolesReviewed, setRolesReviewed] = createSignal(false),
    [ownerReviewed, setOwnerReviewed] = createSignal(false),
    [accepted, setAccepted] = createSignal(false),
    [reviewed, setReviewed] = createSignal(false),
    [waitingForInstallation, setWaitingForInstallation] = createSignal(false);
  const view = () => snapshot()?.view;
  const locked = () => busy() || Boolean(view()?.busy);
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
    void perform(() => api.state());
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
  // Storage actions funnel through the same busy serialization and error
  // display as every other step. A thrown reply is unknown, never presumed:
  // the retained request id and the reconcile step sort out what happened.
  async function storageAct(
    action: "storage-save" | "storage-check" | "storage-reconcile",
    input: Record<string, unknown>,
  ): Promise<Web2StorageOutcome | null> {
    let outcome: Web2StorageOutcome | undefined;
    await perform(async () => {
      const snap = await send(action, input);
      outcome = snap.view.outcome;
      return snap;
    });
    return outcome ?? null;
  }
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
        Create a community on your Linux host. HNS, names, learning and Dance
        are separate later steps.
      </p>
      <Show when={error()}>
        <p role="alert">{error()}</p>
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
                onInput={(e) => setName(e.currentTarget.value)}
                disabled={locked()}
              />
            </label>
            <label>
              HTTPS community origin
              <input
                required
                type="url"
                placeholder="https://community.example"
                value={origin()}
                onInput={(e) => setOrigin(e.currentTarget.value)}
                disabled={locked()}
              />
            </label>
            <button
              type="button"
              disabled={locked()}
              onClick={() =>
                void perform(async () => {
                  const account = await wallet().connect();
                  setController(account.address);
                  if (!owner()) setOwner(account.address);
                  setRolesReviewed(false);
                  return api.state();
                })
              }
            >
              Connect MOSS
            </button>
            <p>Controller: {controller() || "Connect your human controller"}</p>
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
                value={owner()}
                onInput={(e) => {
                  setOwner(e.currentTarget.value.toLowerCase());
                  setRolesReviewed(false);
                  setOwnerReviewed(false);
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
                disabled={locked()}
              />
              I accept this pilot notice and its storage limitations.
            </label>
            <button
              type="submit"
              disabled={
                locked() ||
                !accepted() ||
                !rolesReviewed() ||
                !controller() ||
                !view()!.serverPublisher
              }
            >
              Prepare enrollment
            </button>
          </form>
        </Show>
        <p role="status">Setup state: {view()!.phase}</p>
        <Show when={view()!.selection}>
          <Web2StorageSection
            view={() => view()}
            locked={locked}
            act={(action, input) => storageAct(action, input)}
          />
        </Show>
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
              locked() || (view()!.invitationCorrectionRequired && !accepted())
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
          <button
            disabled={locked()}
            onClick={() =>
              void perform(async () =>
                send(
                  "redeem",
                  view()!.controllerAuthorized
                    ? {}
                    : { signature: await sign(view()!.challenge) },
                ),
              )
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
            <button
              disabled={locked() || !view()!.publishing?.attached}
              onClick={() => void perform(() => send("installation-prepare"))}
            >
              Review Linux installation
            </button>
            <Show when={view()!.installPlan}>
              <p>
                Install {view()!.installPlan!.summary.name} at{" "}
                {view()!.installPlan!.summary.origin}, using the registered
                controller and publisher shown above. Names, learning and Dance
                remain disabled.
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
