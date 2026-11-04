// The design-system surface this client uses, imported by path.
//
// The vendored package exports only its barrel (src/index.tsx). Importing the
// barrel loads every component module, including asset imports such as the
// brand mark's PNG, which Vite then emits into the release even when tree
// shaking drops the code. Importing the three modules used here keeps the
// release to what it renders. The paths resolve through the package's own
// `@/` alias (vite.shared.ts) and are pinned by the vendored commit.
export { Button } from "@/components/actions/button/button";
export { Card, CardContent, CardHeader } from "@/components/data-display/card/card";
export { Type } from "@/components/data-display/type/type";
