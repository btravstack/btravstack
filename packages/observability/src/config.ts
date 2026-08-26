import { Config, ConfigFieldInvalid, type ConfigField } from "@btravstack/config";
import { LEVELS, type Level } from "@btravstack/core";

const isLevel = (value: string): value is Level => (LEVELS as readonly string[]).includes(value);

/**
 * `LOG_LEVEL`, as a `ConfigField` of the six levels and nothing else.
 *
 * A value outside the set is a `ConfigInvalid` naming the variable — exit
 * `78` under `runMain`, before a line is written — rather than a silent
 * fallback to `info`: a deployment that meant `debug` and typed `verbose`
 * should be told, not quietly under-logged for a week. Built on
 * `Config.string`, so it inherits the semantics every other variable has: an
 * unset variable takes the default, a set-but-blank one is an error.
 */
export const logLevel = (options: { readonly default?: Level } = {}): ConfigField<Level> => {
  const text = Config.string("LOG_LEVEL", { default: options.default ?? "info" });
  return {
    variable: text.variable,
    parse: (raw) =>
      text.parse(raw).ensure(
        isLevel,
        (value) =>
          new ConfigFieldInvalid({
            reason: `must be one of ${LEVELS.join(", ")}, got ${JSON.stringify(value)}`,
          }),
      ),
  };
};

/** What `observability()` binds from the environment. */
export type LoggerSettings = { readonly level: Level };

/** The schema `observability()` binds `LoggerConfig` through — one field today, and the place a second one lands. */
export const loggerSchema = (level: Level | undefined) =>
  Config.object({ level: Config.pinned(level, logLevel()) });
