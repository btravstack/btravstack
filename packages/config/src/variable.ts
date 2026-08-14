const PREFIX_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * camelCase → SCREAMING_SNAKE_CASE. Shared by `variableName`'s key half and
 * by `defaultPrefix`'s identity half — both are the same case conversion,
 * applied to different strings.
 */
const screamingSnake = (s: string): string =>
  s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();

/**
 * `Config("amqp")` would derive `amqp_URL` — a variable no operator will ever
 * set, so every key silently falls back to its default: a wrong environment
 * that reports clean. Called from `Config(id)(shape, options?)` at slice
 * declaration — synchronous, import-time setup code, not the `Result`
 * pipeline `Config.parse` promises never to throw out of — so a malformed
 * prefix is a programmer error caught immediately, the same way a malformed
 * schema throws at definition time. Applied to the *resolved* prefix — the
 * explicit `options.prefix` when given, `defaultPrefix(id)` otherwise — so
 * neither path can slip a lowercase or malformed prefix past declaration.
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
 * The prefix a slice gets when it declares no `options.prefix`: the
 * screaming-snake form of its own identity. `"AmqpConfig"` → `"AMQP_CONFIG"`,
 * so its `url` key reads `AMQP_CONFIG_URL`.
 */
export const defaultPrefix = (id: string): string => screamingSnake(id);

/**
 * The environment variable a slice's key is read from: the prefix, then the
 * key shouted. Spring's relaxed binding, in the one direction an environment
 * needs it — the environment shouts, the injected value does not.
 */
export const variableName = (prefix: string, key: string): string =>
  `${prefix}_${screamingSnake(key)}`;
