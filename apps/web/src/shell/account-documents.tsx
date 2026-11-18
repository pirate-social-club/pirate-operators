// AccountPage document placement @ c7cb87835a1858a1955c820b03d566365e6d42db.
import { Show } from "solid-js";
import type { CommunityCapabilities } from "../api-contract.ts";

export function AccountDocuments(props: {
  learningPolicy?: CommunityCapabilities["learningPolicy"];
}) {
  return (
    <nav
      class="flex flex-wrap gap-4 text-sm text-muted-foreground"
      aria-label="Community documents"
    >
      <a href="/terms">Terms</a>
      <a href="/privacy">Privacy</a>
      <Show when={props.learningPolicy}>
        {(policy) => (
          <>
            <a href={policy().termsUrl} target="_blank" rel="noopener">
              Learning terms
            </a>
            <a href={policy().privacyUrl} target="_blank" rel="noopener">
              Learning privacy
            </a>
          </>
        )}
      </Show>
    </nav>
  );
}
