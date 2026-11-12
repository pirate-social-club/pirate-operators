import type { LearningActions } from "../karaoke/page.tsx";

/** One mounted activity owns the shell's private history action at a time. */
export function createLearningActionOwner(
  publish: (actions: LearningActions | null) => void,
) {
  let generation = 0;
  let currentAction: LearningActions | null = null;
  const update = (value: LearningActions | null) => {
    currentAction = value;
    publish(value);
  };
  const clear = () => {
    generation += 1;
    update(null);
  };
  return {
    clear,
    current: () => currentAction,
    claim() {
      clear();
      const owner = generation;
      const current = () => generation === owner;
      return {
        current,
        publish(value: LearningActions | null) {
          if (current()) update(value);
        },
        release() {
          if (current()) clear();
        },
      };
    },
  };
}

export type LearningActionOwner = ReturnType<typeof createLearningActionOwner>;
