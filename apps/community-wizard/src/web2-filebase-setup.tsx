import { createSignal, Show } from "solid-js";
import type { Web2FilebaseView } from "../server/web2-filebase-credentials.ts";

export function Web2FilebaseSetup(props: {
  view: Web2FilebaseView;
  busy: boolean;
  check(): void;
  save(token: string): void;
}) {
  const [token, setToken] = createSignal("");
  const scope = () => props.view.scope;
  return (
    <section class="card" aria-label="Filebase credential">
      <h2>Connect Filebase</h2>
      <p>The wizard uses this key to pin your community configuration.</p>
      <Show when={props.view.mode === "cli"} fallback={
        <p>Use the runner's Infisical machine identity with read and create access to this folder.</p>
      }>
        <Show when={!props.view.connected}>
          <p>
            {props.view.cliAvailable === false ? "The runner did not find the Infisical CLI. " : ""}
            <a href="https://infisical.com/docs/cli/overview" target="_blank" rel="noreferrer">
              Install Infisical on the wizard runner
            </a>
            {" "}if needed, then sign in as the runner's user.
          </p>
          <pre class="command"><code>infisical login --domain {scope().siteUrl}</code></pre>
          <p>If the runner uses a CLI profile, select the same profile when signing in.</p>
        </Show>
      </Show>
      <dl>
        <dt>Infisical project</dt><dd>{scope().projectId}</dd>
        <dt>Environment</dt><dd>{scope().environment}</dd>
        <dt>Folder</dt><dd>{scope().secretPath}</dd>
      </dl>
      <button type="button" disabled={props.busy} onClick={() => { setToken(""); props.check(); }}>
        Check Infisical folder
      </button>
      <Show when={props.view.status === "ready"}>
        <p role="status">Filebase is saved and available through the key agent.</p>
      </Show>
      <Show when={props.view.status === "saved" || props.view.status === "unverified"}>
        <p role="status">Check the folder again to verify the saved credential.</p>
      </Show>
      <Show when={props.view.connected && props.view.status === "missing"}>
        <form autocomplete="off" onSubmit={(event) => {
          event.preventDefault();
          const value = token();
          setToken("");
          props.save(value);
        }}>
          <label>
            Filebase IPFS RPC token
            <input type="password" autocomplete="new-password" spellcheck={false}
              maxLength={4096} required disabled={props.busy} value={token()}
              onInput={(event) => setToken(event.currentTarget.value)} />
          </label>
          <button type="submit" disabled={props.busy || !token()}>Save to Infisical</button>
        </form>
      </Show>
    </section>
  );
}
