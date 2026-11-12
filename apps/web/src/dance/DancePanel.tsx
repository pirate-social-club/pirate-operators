/** Established c7 learner page and original recorder journey. The host supplies
 * authenticated owner account and admitted decentralized service ports. */
import {
  DanceSongPage,
  type DanceSongPageProps,
} from "./source/dance-song-page.tsx";
export type { DanceSongPageProps } from "./source/dance-song-page.tsx";
export { DanceRecorderPanel } from "./source/dance-recorder-panel.tsx";
export { DanceReviewPage } from "./source/dance-review-page.tsx";
export { DanceResultPage } from "./source/dance-result-page.tsx";
export { createDanceSourceServices } from "./source/services.ts";
export function DancePanel(props: DanceSongPageProps) {
  return <DanceSongPage {...props} />;
}
