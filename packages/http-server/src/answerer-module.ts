import { Env, type ConfigInvalid } from "@btravstack/config";
import type { Observers } from "@btravstack/core";
import {
  Module,
  type AnyModule,
  type AnyPort,
  type AnyProvider,
  type Exportable,
  type NeedsGate,
  type Provider,
} from "@btravstack/di";

import { applicationExports, type ApplicationExports } from "./application-exports.js";
import type { CookieSchemes } from "./cookie.js";
import type { HttpHandler } from "./handler.js";
import type { HttpConfig } from "./http-config.js";
import {
  httpServer,
  type AnyUnitModule,
  type HttpOptions,
  type HttpRuntime,
  type HttpServerEnv,
  type HttpUnit,
  type UnitsNeedsOf,
} from "./http-runtime.js";
import type { HttpChallenges } from "./protected-resource.js";

type AnyAnswerer = Provider<InstanceType<typeof HttpHandler>, unknown, unknown> & {
  readonly authenticators: readonly AnyProvider[];
  readonly units: Readonly<Record<string, AnyUnitModule>> | undefined;
};
type UnitsOf<A> = A extends { readonly units: infer U } ? U : never;
type AuthOf<A> = A extends { readonly authenticators: readonly (infer P)[] } ? P : never;
type HttpStarter<Units> = Module<
  | HttpRuntime
  | HttpConfig
  | InstanceType<typeof HttpHandler>
  | HttpUnit
  | CookieSchemes
  | HttpChallenges
  | Observers,
  ConfigInvalid,
  HttpServerEnv | UnitsNeedsOf<Units>
>;
type Imports<I extends readonly AnyModule[], A> = readonly [...I, HttpStarter<UnitsOf<A>>];
type Provides<P extends readonly AnyProvider[], A> = readonly (A | AuthOf<A> | P[number])[];
type EnvAnd<N extends readonly AnyPort[] | undefined> = N extends readonly AnyPort[]
  ? readonly [...N, typeof Env]
  : undefined;
type Exports<
  I extends readonly AnyModule[],
  P extends readonly AnyProvider[],
  X extends readonly unknown[],
> = readonly [...ApplicationExports<I, P>, ...X];

/**
 * Declare an HTTP application served by one answerer — `graphql()`, `mcp()` —
 * without repeating runtime or authenticator wiring: the answerer's
 * authenticators are provided and its declared request modules bound to the
 * runtime. `HttpModule` is the oRPC and fragments one.
 */
export const AnswererModule =
  <const Name extends string>(name: Name) =>
  <
    A extends AnyAnswerer,
    const I extends readonly AnyModule[] = [],
    const P extends readonly AnyProvider[] = [],
    const X extends readonly Exportable<Imports<I, A>, Provides<P, A>>[] = [],
    const N extends readonly AnyPort[] | undefined = undefined,
  >(
    options: Omit<HttpOptions, "unit" | "cors" | "compression"> & {
      readonly answerer: A;
      readonly imports?: I;
      readonly provides?: P;
      readonly exports?: X;
      readonly needs?: N;
    } & NeedsGate<Imports<I, A>, Provides<P, A>, EnvAnd<N>>,
  ) => {
    const starter = httpServer({ ...options, unit: options.answerer.units });
    const imports = [...(options.imports ?? []), starter] as Imports<I, A>;
    const provides = [
      options.answerer,
      ...options.answerer.authenticators,
      ...(options.provides ?? []),
    ] as Provides<P, A>;
    // The options gate checks concrete tuples at the caller; it defers inside this generic wrapper.
    return Module(name)({
      imports,
      provides,
      exports: [...applicationExports(imports, provides), ...(options.exports ?? [])] as Exports<
        Imports<I, A>,
        Provides<P, A>,
        X
      >,
      needs: (options.needs === undefined
        ? undefined
        : [...options.needs, Env]) as unknown as EnvAnd<N>,
    } as {
      readonly imports: Imports<I, A>;
      readonly provides: Provides<P, A>;
      readonly exports: Exports<Imports<I, A>, Provides<P, A>, X>;
      readonly needs: EnvAnd<N>;
    } & NeedsGate<Imports<I, A>, Provides<P, A>, EnvAnd<N>>);
  };
