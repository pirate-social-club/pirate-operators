import { Show } from "solid-js";
import type { Snapshot } from "./types.ts";

export function InfisicalConnection(props: {
  state: Snapshot;
  busy: boolean;
  onConnect: () => void;
}) {
  const connection = () => props.state.infisical;
  return (
    <div class="card">
      <h3>Connect Infisical</h3>
      <p>
        Use your own Infisical account. Create a Secrets Management project and
        choose an environment there, then enter their identifiers in Community.
      </p>
      <p>
        Instance:{" "}
        <a href={connection()?.siteUrl} target="_blank" rel="noreferrer">
          {connection()?.siteUrl}
        </a>
      </p>
      <Show
        when={connection()?.mode === "cli"}
        fallback={
          <p>
            Advanced machine authentication is selected on the runner. Its
            identity needs secret read/create/update access to an existing
            dedicated folder. Prepare that folder before unattended operation.
          </p>
        }
      >
        <ol>
          <li>
            <a
              href="https://infisical.com/docs/cli/overview"
              target="_blank"
              rel="noreferrer"
            >
              Install the Infisical CLI
            </a>{" "}
            on this computer.
          </li>
          <li>
            In a terminal, sign in to this instance:
            <pre class="command">
              <code>infisical login --domain {connection()?.siteUrl}</code>
            </pre>
            If the runner selects a CLI profile, sign in to that same profile.
          </li>
          <li>
            Return here and connect. You do not paste a login token into this
            page.
          </li>
        </ol>
        <p class="fine">
          The trusted local runner uses your existing account permissions. Its
          requests stay within the selected project, environment and folder;
          your login itself is not restricted to that folder.
        </p>
      </Show>
      <p>
        Project: {props.state.settings?.projectId}
        <br />
        Environment: {props.state.settings?.environment}
        <br />
        Folder: {props.state.settings?.secretPath}
      </p>
      <p>
        {connection()?.mode === "cli"
          ? "Connecting checks access and creates any missing folders along this path."
          : "Connecting checks access to the existing selected folder."}{" "}
        It does not change project permissions or create a machine identity.
      </p>
      <button
        class="secondary"
        type="button"
        disabled={props.busy || !props.state.settings}
        onClick={props.onConnect}
      >
        {connection()?.connected
          ? "Check Infisical again"
          : connection()?.mode === "cli"
            ? "Connect & prepare folder"
            : "Connect existing folder"}
      </button>
      <p role="status">
        {connection()?.connected
          ? "Infisical scope connected. Saving keys checks secret write and readback access."
          : "Infisical connection not checked. Sign in, then connect here."}
      </p>
    </div>
  );
}
