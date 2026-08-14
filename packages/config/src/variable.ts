const PREFIX_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * `Config("amqp")` would derive `amqp_URL` — a variable no operator will ever
 * set, so every key silently falls back to its default: a wrong environment
 * that reports clean. Called from `Config(prefix)(shape)` at slice
 * declaration — synchronous, import-time setup code, not the `Result`
 * pipeline `Config.parse` promises never to throw out of — so a malformed
 * prefix is a programmer error caught immediately, the same way a malformed
 * schema throws at definition time.
 */
export const assertValidPrefix = (prefix: string): void => {
  if (!PREFIX_PATTERN.test(prefix)) {
    // oxlint-disable-next-line unthrown/no-throw -- programmer-error precondition at import-time slice declaration, not the Result pipeline; see the doc comment above
    throw new Error(
      `Config prefix must be upper-snake-case (e.g. "AMQP"), got ${JSON.stringify(prefix)}`,
    );
  }
};

/**
 * The environment variable a slice's key is read from: the prefix, then the
 * key shouted. Spring's relaxed binding, in the one direction an environment
 * needs it — the environment shouts, the injected value does not.
 */
export const variableName = (prefix: string, key: string): string =>
  `${prefix}_${key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}`;
