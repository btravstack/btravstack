export type Phase = "building" | "starting" | "serving" | "draining" | "stopping" | "exited";

const ORDER: readonly Phase[] = [
  "building",
  "starting",
  "serving",
  "draining",
  "stopping",
  "exited",
];

const rank = (phase: Phase): number => ORDER.indexOf(phase);

export type PhaseTracker = {
  readonly current: () => Phase;
  readonly advanceTo: (phase: Phase) => boolean;
};

export const createPhaseTracker = (onChange: (phase: Phase) => void): PhaseTracker => {
  let phase: Phase = "building";

  return {
    current: () => phase,
    advanceTo: (next) => {
      if (rank(next) <= rank(phase)) return false;
      phase = next;
      onChange(next);
      return true;
    },
  };
};
