export type DrainReport = {
  /** Units in flight when the drain began. */
  readonly inFlightAtStart: number;
  /**
   * Units that closed during the drain. Counted from a monotonic total, not
   * `inFlightAtStart - abandoned` — it may exceed `inFlightAtStart` if
   * in-flight work spawned more units during the drain. That is honest
   * reporting, not a bug: the alternative formula can go negative.
   */
  readonly completed: number;
  /** Units still open at the deadline. The exit-code decision reads this. */
  readonly abandoned: number;
};
