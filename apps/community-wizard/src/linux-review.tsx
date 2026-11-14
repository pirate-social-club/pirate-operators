import { For, Show } from "solid-js";
import type { LinuxJournal } from "../server/linux-journal.ts";
export function LinuxReview(props: {
  state: LinuxJournal;
  dirty: boolean;
  approved: boolean;
  onApprove(value: boolean): void;
  working: boolean;
  onReview(): void;
  onDeploy(): void;
  onReconcile(): void;
}) {
  const plan = () => props.state.plan;
  const unresolved = () =>
    props.state.operation &&
    ["running", "pending", "unknown"].includes(props.state.operation.state);
  const held = () =>
    unresolved() && props.state.operation?.custody !== "cleared";
  return (
    <section class="card plan">
      <h2>Review and deploy the application</h2>
      <p>
        Review the full app, selected Learning configuration, retained
        identities, storage roles and recovery policy together.
      </p>
      <button
        class="secondary"
        disabled={
          props.working ||
          props.dirty ||
          Boolean(held()) ||
          Boolean(props.state.secretRequest) ||
          Boolean(props.state.uploadRequest)
        }
        onClick={props.onReview}
      >
        Prepare current plan
      </button>
      <Show when={plan()}>
        {(p) => (
          <>
            <p class="origin">{p().profile.settings.origin}</p>
            <p>
              Action: {p().action}. Session recovery:{" "}
              {p().sessionPolicy === "revoke-existing"
                ? "revoke existing sessions"
                : "preserve existing sessions under the verified backend policy"}
              .
            </p>
            <dl>
              <dt>Host fingerprint</dt>
              <dd>{p().targetFingerprint}</dd>
              <dt>Namespace</dt>
              <dd>
                {p().profile.namespace.binding.issuanceTld} · {p().profile.namespace.authorityKind}.
                Member issuance requires separate authorization.
              </dd>
              <dt>Infrastructure</dt>
              <dd>Shared Directory v2 / configuration v2. Portable key and explicit installation mapping are retained.</dd>
              <dt>Budget enforcement</dt>
              <dd>{p().operatorPolicy?.providerBudget.enforcement ?? "unverified"}.
                Covered: {p().operatorPolicy?.providerBudget.coveredServices.join(", ") || "not supplied"}.
                Excluded: {p().operatorPolicy?.providerBudget.excludedServices.join(", ") || "not supplied"}.
                Evidence: {p().operatorPolicy?.providerBudget.evidenceRef ?? "none"}.
                A budget proposal does not establish provider enforcement or cover gas, hosting and storage.</dd>
              <dt>Learning</dt>
              <dd>
                {p().profile.learning
                  ? "Included in this deployment"
                  : "Not selected"}
              </dd>
              <dt>Monthly provider budget proposal</dt>
              <dd>
                $
                {(p().profile.settings.limits.monthlyUsdCents / 100).toFixed(2)}{" "}
                USD
              </dd>
            </dl>
            <ul>
              <For each={p().changes}>{(change) => <li>{change}</li>}</For>
            </ul>
            <Show when={p().warnings.length}>
              <div class="note">
                <h3>Before deploying</h3>
                <ul>
                  <For each={p().warnings}>
                    {(warning) => <li>{warning}</li>}
                  </For>
                </ul>
              </div>
            </Show>
            <details>
              <summary>
                Advanced · complete versioned profile and identities
              </summary>
              <pre class="command">{JSON.stringify(p().profile, null, 2)}</pre>
              <p class="fine">Plan digest: {p().digest}</p>
              <p class="fine">
                Technical IDs are discovered by the backend. This document
                contains configuration and references, not secret values or
                current naming authority.
              </p>
            </details>
            <label class="check approval">
              <input
                type="checkbox"
                checked={props.approved}
                disabled={props.working || props.dirty || Boolean(unresolved())}
                onChange={(e) => props.onApprove(e.currentTarget.checked)}
              />
              I reviewed this exact host fingerprint, community identity,
              namespace scope, spending limits and recovery policy.
            </label>
            <button
              class="primary"
              disabled={
                props.working ||
                props.dirty ||
                !props.approved ||
                Boolean(unresolved()) ||
                !p().requirements.every((r) => r.state === "verified")
              }
              onClick={props.onDeploy}
            >
              {p().action === "restore"
                ? "Restore this community"
                : p().action === "adopt"
                  ? "Adopt this installation"
                  : p().action === "upgrade"
                    ? "Apply reviewed upgrade"
                    : "Deploy app and selected services"}
            </button>
            <Show when={!p().requirements.every((r) => r.state === "verified")}>
              <p class="fine">
                Verify the selected service requirements first, then refresh the
                plan. Saved credentials are not readiness.
              </p>
            </Show>
          </>
        )}
      </Show>
      <Show when={props.state.operation}>
        {(op) => (
          <div class="note" role="status" aria-live="polite">
            <h3>Deployment · {op().state}</h3>
            <p>{op().message}</p>
            <Show when={op().results.at(-1)?.lastCompletedPhase}>
              {(phase) => <p>Last reported completed phase: {phase()}</p>}
            </Show>
            <p class="fine">Original operation: {op().id}</p>
            <Show when={op().receiptRef}>
              <p class="fine">Backend receipt: {op().receiptRef}</p>
            </Show>
            <Show when={unresolved()}>
              <button
                class="secondary"
                disabled={props.working}
                onClick={props.onReconcile}
              >
                Reconcile original operation
              </button>
            </Show>
            <Show when={op().state === "succeeded"}>
              <a
                class="primary link"
                href={op().plan.profile.settings.origin}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open the verified application
              </a>
              <p class="fine">
                Keep this runner’s retained receipt and encrypted recovery
                backup before changing or moving the installation.
              </p>
            </Show>
          </div>
        )}
      </Show>
    </section>
  );
}
