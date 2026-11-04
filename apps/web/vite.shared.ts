import { fileURLToPath } from "node:url";
import type { AliasOptions } from "vite";

// solid-ui source imports its own `@/` alias. The vendored package is source,
// not a build, so the consumer maps that alias to the package's src directory.
// This client's own code never uses `@/`.
const uiSource = fileURLToPath(new URL("./node_modules/@pirate/web-solid-ui/src/", import.meta.url));
export const alias: AliasOptions = [{ find: /^@\//, replacement: uiSource }];
export const dedupe = ["solid-js", "@solidjs/web"];
