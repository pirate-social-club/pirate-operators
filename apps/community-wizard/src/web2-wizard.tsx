import { createSignal, For, onSettled, Show } from "solid-js";
import {
  formatEther,
  getTypesForEIP712Domain,
  serializeTypedData,
  type TypedDataDefinition,
} from "viem";
import type { enrollmentTypedData } from "../../../packages/community/hosted-enrollment.ts";
import {
  createWeb2WizardClient,
  type Web2Action,
  type Web2Snapshot,
} from "./web2-api.ts";

interface Wallet {
  request(input: { method: string; params?: unknown[] }): Promise<unknown>;
}
export function Web2Wizard() {
  const api = createWeb2WizardClient();
  const [snapshot, setSnapshot] = createSignal<Web2Snapshot>(),
    [error, setError] = createSignal(""),
    [busy, setBusy] = createSignal(false);
  const [name, setName] = createSignal(""),
    [origin, setOrigin] = createSignal(""),
    [controller, setController] = createSignal(""),
    [publisher, setPublisher] = createSignal(""),
    [invite, setInvite] = createSignal("");
  const [accepted, setAccepted] = createSignal(false),
    [reviewed, setReviewed] = createSignal(false);
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
  const send = (action: Web2Action, input: Record<string, unknown> = {}) =>
    api.send(action, input, snapshot()!);
  async function sign(actor: string): Promise<string> {
    const wallet = (window as unknown as { ethereum?: Wallet }).ethereum;
    if (!wallet)
      throw Error(
        "Connect a wallet that supports the selected controller or publisher. Private keys never enter this wizard.",
      );
    const chain = await wallet.request({ method: "eth_chainId" });
    if (
      typeof chain !== "string" ||
      BigInt(chain) !== BigInt(view()!.policy.chainId)
    )
      throw Error(
        "Select the displayed test network in your wallet before signing.",
      );
    const accounts = await wallet.request({ method: "eth_requestAccounts" });
    if (
      !Array.isArray(accounts) ||
      !accounts.some((a) => typeof a === "string" && a.toLowerCase() === actor)
    )
      throw Error(
        "Select the account named in this exact request. Another account cannot authorize it.",
      );
    const typed = view()!.challenge as ReturnType<typeof enrollmentTypedData>;
    const payload = serializeTypedData({
      ...typed,
      types: {
        EIP712Domain: getTypesForEIP712Domain({ domain: typed.domain }),
        ...typed.types,
      },
    } as unknown as TypedDataDefinition);
    const proof = await wallet.request({
      method: "eth_signTypedData_v4",
      params: [actor, payload],
    });
    if (typeof proof !== "string" || !/^0x(?:[a-fA-F0-9]{2})+$/.test(proof))
      throw Error("The wallet did not return a complete authorization.");
    return proof;
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
                  publisher: publisher(),
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
            <label>
              Controller address
              <input
                required
                pattern="0x[a-fA-F0-9]{40}"
                value={controller()}
                onInput={(e) => setController(e.currentTarget.value)}
                disabled={locked()}
              />
            </label>
            <label>
              Publisher address
              <input
                required
                pattern="0x[a-fA-F0-9]{40}"
                value={publisher()}
                onInput={(e) => setPublisher(e.currentTarget.value)}
                disabled={locked()}
              />
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
            <button type="submit" disabled={locked() || !accepted()}>
              Prepare enrollment
            </button>
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
                    : { signature: await sign(view()!.selection!.controller) },
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
            onClick={() =>
              void perform(async () => {
                const proofs = [];
                if (!view()!.fundingAuthorized)
                  for (const r of view()!.recipients)
                    proofs.push({
                      recipient: r.address,
                      signature: await sign(r.address),
                    });
                return send(
                  "topup",
                  view()!.fundingAuthorized ? {} : { proofs },
                );
              })
            }
          >
            {view()!.fundingAuthorized
              ? "Retry original gas allocation"
              : "Authorize initial gas allocation"}
          </button>
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
              disabled={locked()}
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
