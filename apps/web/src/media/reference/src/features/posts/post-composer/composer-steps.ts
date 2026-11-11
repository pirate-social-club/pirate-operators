import { createEffect, createSignal, type Accessor } from "solid-js";

import type { ComposerTab } from "./types.ts";
import { composerStepTrack, type ComposerStepName } from "./utils.ts";

export interface ComposerSteps {
  readonly list: Accessor<readonly ComposerStepName[]>;
  readonly current: Accessor<ComposerStepName>;
  readonly isFirst: Accessor<boolean>;
  readonly isLast: Accessor<boolean>;
  set: (step: ComposerStepName) => void;
}

/**
 * Step state for the designed multi-step composer. The seed accessor lets a
 * host restore a retained draft at the right step; seeding keeps applying
 * until the user navigates, then never overrides their choice again.
 */
export function createComposerSteps(
  activeTab: Accessor<ComposerTab>,
  seed: Accessor<1 | 2 | 3 | undefined>,
): ComposerSteps {
  const track = () => composerStepTrack(activeTab());
  const seedStep = (): ComposerStepName => {
    const songTrack = composerStepTrack("song");
    return songTrack[(seed() ?? 1) - 1] ?? "song";
  };
  let userNavigated = false;
  const [current, setCurrent] = createSignal<ComposerStepName>("song", {
    ownedWrite: true,
  });
  createEffect(
    () => [track(), seedStep()] as const,
    ([trackList, seededStep]) => {
      if (trackList.length === 0) {
        userNavigated = false;
        setCurrent(seededStep);
        return;
      }
      if (!userNavigated) setCurrent(seededStep);
    },
  );
  return {
    list: track,
    current,
    isFirst: () => current() === track()[0],
    isLast: () => current() === track()[track().length - 1],
    set: (step) => {
      if (!track().includes(step)) return;
      userNavigated = true;
      setCurrent(step);
    },
  };
}
