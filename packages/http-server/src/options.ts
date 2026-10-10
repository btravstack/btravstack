import type { AnyPort, ServiceOf } from "@btravstack/di";

/** The scopes options `O` declare, or none — per union member. */
export type ScopesOf<O> = O extends unknown
  ? "scopes" extends keyof O
    ? NonNullable<O["scopes"]> extends readonly string[]
      ? NonNullable<O["scopes"]>
      : readonly []
    : readonly []
  : never;

/**
 * The variable prefix options `O` name, or `Default` where they may name none —
 * per union member, so a prefix the type cannot know stays `string`.
 */
export type PrefixOf<O, Default extends string> = O extends unknown
  ? "variablePrefix" extends keyof O
    ?
        | (NonNullable<O["variablePrefix"]> & string)
        | (Record<never, never> extends Pick<O, "variablePrefix">
            ? Default
            : undefined extends O["variablePrefix"]
              ? Default
              : never)
    : Default
  : never;

/** The services an `inject` record resolves to, as a scheme's `principal` receives them. */
export type Injected<D> = {
  readonly [K in keyof D]: ServiceOf<InstanceType<D[K] & AnyPort>>;
};

// A prefix no option key carries, so the application's `inject` names can
// never collide with the scheme's own dependencies (`env`, `observers`, …).
const INJECTED = "principal:";

/** An application's `inject` record, keyed apart from the scheme's own dependencies. */
export const injectedDeps = (
  inject: Readonly<Record<string, AnyPort>> | undefined,
): Readonly<Record<string, AnyPort>> =>
  Object.fromEntries(Object.entries(inject ?? {}).map(([key, port]) => [INJECTED + key, port]));

/** Those services, read back under the application's own names. */
export const injectedServices = (services: Readonly<Record<string, unknown>>): object =>
  Object.fromEntries(
    Object.entries(services)
      .filter(([key]) => key.startsWith(INJECTED))
      .map(([key, service]) => [key.slice(INJECTED.length), service]),
  );
