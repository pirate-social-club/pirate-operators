// Downloadable-file fields shown on the file tab, ported from the React
// post-composer-generic-asset-fields.tsx.

import { Show } from "solid-js";

import { Input, Type } from "../../../design-system.ts";
import { FieldLabel } from "./fields.tsx";
import type { DownloadFileComposerState } from "./types.ts";

const DOWNLOAD_ACCEPT =
  ".csv,.tsv,.txt,.json,text/csv,text/tab-separated-values,text/plain,application/json";
const DOWNLOAD_INPUT_ID = "post-composer-downloadable-file";

export function PostComposerGenericAssetFields(props: {
  file: DownloadFileComposerState;
  onFileChange: (next: DownloadFileComposerState) => void;
}) {
  return (
    <section class="space-y-3 rounded-[var(--radius-lg)] border border-border-soft bg-muted/30 p-4">
      <div>
        <FieldLabel htmlFor={DOWNLOAD_INPUT_ID} label="Downloadable file" />
        <Type as="p" variant="body" class="text-muted-foreground">
          CSV, TSV, TXT, and JSON files are scanned before publication. Locked
          delivery keeps plaintext available to the platform for rescanning.
        </Type>
      </div>
      <Input
        accept={DOWNLOAD_ACCEPT}
        id={DOWNLOAD_INPUT_ID}
        onChange={(event) => {
          const next = event.currentTarget.files?.[0] ?? null;
          props.onFileChange({ upload: next, label: next?.name });
        }}
        type="file"
      />
      <Show when={props.file.upload}>
        {(upload) => (
          <Type as="p" variant="caption" class="text-muted-foreground">
            {upload().name} · {upload().size.toLocaleString()} bytes
          </Type>
        )}
      </Show>
      <Type as="p" variant="caption" class="text-muted-foreground">
        Public/free delivery is not enabled yet. This creator flow publishes
        locked goods on the simulated Base Sepolia USDC rail.
      </Type>
    </section>
  );
}
