export type DrainReport = {
  readonly inFlightAtStart: number;
  readonly completed: number;
  readonly abandoned: number;
};
