import {
  Port,
  Provider,
  type AnyPort,
  type PortClassOf,
  type PortInstance,
  type ServiceOf,
} from "@btravstack/di";
import { Err, Ok, P, TaggedError, fromSafePromise, type AsyncResult, type Result } from "unthrown";

/** The process environment as it actually arrives: flat, and every value a string or absent. */
export type Environment = Readonly<Record<string, string | undefined>>;

/**
 * The environment, as a service. The kernel provides this port to every graph it
 * boots — `process.env` by default, `StartOptions.env` for a test — so nothing
 * else in an application touches `process.env`.
 */
export class Env extends Port("Env")<Environment> {}

/**
 * The one issue shape a configuration schema reports: Standard Schema's
 * `Issue`, restated structurally so this package depends on nothing.
 */
export type ConfigIssue = {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
};

/**
 * A configuration port could not be bound: the environment is wrong, not the
 * code. `runMain` maps it to sysexits(3)'s `EX_CONFIG` (78) rather than the
 * generic startup `1`, and its message names every offending variable.
 */
export class ConfigInvalid extends TaggedError("ConfigInvalid")<{
  readonly port: string;
  readonly issues: readonly ConfigIssue[];
}> {
  override message = `${this.port} could not be configured:\n${describe(this.issues)}`;
}

const nameOf = (segment: PropertyKey | { readonly key: PropertyKey }): string =>
  String(typeof segment === "object" ? segment.key : segment);

const describe = (issues: readonly ConfigIssue[]): string =>
  issues
    .map(
      (issue) =>
        `  ${(issue.path ?? []).map(nameOf).join(".") || "(environment)"}: ${issue.message}`,
    )
    .join("\n");

/**
 * The slice of Standard Schema (v1) this package speaks — structurally, so a
 * `zod`, `valibot` or `arktype` schema is accepted with no adapter, and so is
 * anything `Config.object` builds.
 */
export type ConfigSchema<Input, Output> = {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) =>
      | { readonly value: Output; readonly issues?: undefined }
      | { readonly issues: readonly ConfigIssue[] }
      | Promise<
          | { readonly value: Output; readonly issues?: undefined }
          | { readonly issues: readonly ConfigIssue[] }
        >;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
};

/** Why one variable's value is not the value a field wanted — the message `ConfigInvalid` reports against it. */
export class ConfigFieldInvalid extends TaggedError("ConfigFieldInvalid")<{
  readonly reason: string;
}> {
  override message = this.reason;
}

/**
 * One environment variable, read into a value: `parse` receives the raw
 * string (or `undefined` when unset) and answers the value or the reason it
 * is not one. Compose them with `Config.object`.
 */
export type ConfigField<T> = {
  readonly variable: string;
  readonly parse: (raw: string | undefined) => Result<T, ConfigFieldInvalid>;
};

const invalid = (reason: string): Result<never, ConfigFieldInvalid> =>
  Err(new ConfigFieldInvalid({ reason }));

type WithDefault<T> = { readonly default?: T };

// An empty or blank value is a configuration ERROR, never an absent variable:
// `PORT=` would otherwise bind what the empty string coerces to — `0`, the
// ephemeral port. `default` applies only to a variable nobody set.
const present = <T>(
  variable: string,
  options: WithDefault<T>,
  read: (value: string) => Result<T, ConfigFieldInvalid>,
): ConfigField<T> => ({
  variable,
  parse: (raw) => {
    if (raw === undefined) {
      return options.default === undefined ? invalid("is required") : Ok(options.default);
    }
    const value = raw.trim();
    return value === "" ? invalid("is set but empty") : read(value);
  },
});

const integerIn =
  (min: number, max: number) =>
  (value: string): Result<number, ConfigFieldInvalid> => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed))
      return invalid(`is not a whole number: ${JSON.stringify(value)}`);
    if (parsed < min || parsed > max)
      return invalid(`must be between ${min} and ${max}, got ${parsed}`);
    return Ok(parsed);
  };

const TRUTHY = new Set(["true", "1", "yes", "on"]);
const FALSY = new Set(["false", "0", "no", "off"]);

/**
 * Configuration, the twelve-factor way: typed values bound from the environment,
 * validated once as the graph is built, and injected like any other service.
 *
 * `Config.object({...})` describes a slice of the environment as a schema — any
 * Standard Schema does as well — and `Config.provider(Port)(schema)` turns it
 * into a provider that reads {@link Env} and answers `ConfigInvalid`.
 */
export const Config = {
  /** A non-empty string. */
  string: (variable: string, options: WithDefault<string> = {}): ConfigField<string> =>
    present(variable, options, (value) => Ok(value)),

  /** A whole number, optionally bounded (both bounds inclusive). */
  integer: (
    variable: string,
    options: WithDefault<number> & { readonly min?: number; readonly max?: number } = {},
  ): ConfigField<number> =>
    present(
      variable,
      options,
      integerIn(options.min ?? Number.MIN_SAFE_INTEGER, options.max ?? Number.MAX_SAFE_INTEGER),
    ),

  /**
   * A flag: `true`/`false`, `1`/`0`, `yes`/`no` or `on`/`off`, case-insensitive.
   * Anything else is an error rather than a falsy reading — a deployment that
   * wrote `HTTP_COMPRESSION=enabled` meant to turn it on.
   */
  boolean: (variable: string, options: WithDefault<boolean> = {}): ConfigField<boolean> =>
    present(variable, options, (value) => {
      const flag = TRUTHY.has(value.toLowerCase())
        ? true
        : FALSY.has(value.toLowerCase())
          ? false
          : undefined;
      return flag === undefined ? invalid(`is not a flag: ${JSON.stringify(value)}`) : Ok(flag);
    }),

  /** A TCP port: a whole number the OS will accept, `0` (an ephemeral bind) included. */
  port: (variable: string, options: WithDefault<number> = {}): ConfigField<number> =>
    present(variable, options, integerIn(0, 65_535)),

  /**
   * `field`, unless `value` is given — then a field answering `value` that
   * reads nothing. Explicit beats environment beats default, per field:
   * `http({ port: 0 })` still reads `HOST`.
   */
  pinned: <T>(value: T | undefined, field: ConfigField<T>): ConfigField<T> =>
    value === undefined ? field : { variable: field.variable, parse: () => Ok(value) },

  /**
   * A record of fields, as a Standard Schema over the environment. Every field
   * is read, so one validation names every offending variable at once — an
   * operator fixes the deployment in one round trip.
   */
  object: <F extends Record<string, ConfigField<unknown>>>(
    fields: F,
  ): ConfigSchema<
    Environment,
    { readonly [K in keyof F]: F[K] extends ConfigField<infer T> ? T : never }
  > => ({
    "~standard": {
      version: 1,
      vendor: "btravstack",
      validate: (input) => {
        const env = (input ?? {}) as Environment;
        const issues: ConfigIssue[] = [];
        const value: Record<string, unknown> = {};
        for (const [key, field] of Object.entries(fields)) {
          field.parse(env[field.variable]).match({
            ok: (parsed) => {
              value[key] = parsed;
            },
            errCases: (matcher) =>
              matcher.with(P.tag("ConfigFieldInvalid"), (error) => {
                issues.push({ message: error.reason, path: [field.variable] });
              }),
            // A bug in the field, reported against its variable rather than
            // thrown through a validation that promised issues.
            defect: (cause) => {
              issues.push({ message: String(cause), path: [field.variable] });
            },
          });
        }
        return issues.length > 0
          ? { issues }
          : {
              value: value as {
                readonly [K in keyof F]: F[K] extends ConfigField<infer T> ? T : never;
              },
            };
      },
    },
  }),

  /**
   * A provider binding a port from the environment through `schema`. Reads
   * {@link Env}, so the port is built with the rest of the graph and a bad
   * environment is a modeled startup `Err` rather than a silently wrong value.
   *
   * Two forms of the first call. `Config.provider(Port)(schema)` binds a port
   * you declared — for a port that is public API another package names.
   * `Config.provider("RelayConfig")(schema)` mints the port and hands back the
   * provider carrying it, for a slice that is one application's own.
   */
  provider: configProvider,
};

function configProvider<P extends AnyPort>(
  port: P,
): (
  schema: ConfigSchema<Environment, ServiceOf<P>>,
) => Provider<InstanceType<P>, ConfigInvalid, Env> & { readonly port: P };
function configProvider<const Name extends string>(
  name: Name,
): <Output>(schema: ConfigSchema<Environment, Output>) => Provider<
  PortInstance<Name, Output>,
  ConfigInvalid,
  Env
> & {
  readonly port: PortClassOf<Name, Output>;
};
// The implementation's return type is `unknown` — the two overloads above are
// the whole contract, and no single type is assignable both ways to
// `Provider<InstanceType<P>, …> & { port: P }` and
// `Provider<PortInstance<Name, Output>, …> & { port: PortClassOf<Name, Output> }`
// (`Provider` is contravariant in its port).
function configProvider(portOrName: AnyPort | string): unknown {
  const port: AnyPort =
    typeof portOrName === "string" ? class extends Port(portOrName)<unknown> {} : portOrName;
  return (schema: ConfigSchema<Environment, unknown>) =>
    Provider(port)({
      inject: { env: Env },
      make: ({ env }): AsyncResult<unknown, ConfigInvalid> =>
        fromSafePromise((async () => await schema["~standard"].validate(env))()).flatMap(
          (result) =>
            result.issues === undefined
              ? Ok(result.value)
              : Err(new ConfigInvalid({ port: port.portId, issues: result.issues })),
        ),
    });
}
