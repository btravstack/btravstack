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
import {
  httpServer,
  type HttpConfig,
  type HttpHandler,
  type HttpOptions,
  type HttpRuntime,
} from "@btravstack/http-server";
import {
  applicationExports,
  type ApplicationExports,
  type AnyUnitModule,
  type CookieSchemes,
  type HttpServerEnv,
  type HttpUnit,
  type UnitsNeedsOf,
} from "@btravstack/http-server/internal";

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
  | Observers,
  ConfigInvalid,
  HttpServerEnv | UnitsNeedsOf<Units>
>;
type Imports<I extends readonly AnyModule[], A> = readonly [...I, HttpStarter<UnitsOf<A>>];
type Provides<P extends readonly AnyProvider[], A> = readonly (A | AuthOf<A> | P[number])[];
type EnvAnd<N extends readonly AnyPort[]> = readonly [...N, typeof Env];
type Exports<
  I extends readonly AnyModule[],
  P extends readonly AnyProvider[],
  X extends readonly unknown[],
> = readonly [...ApplicationExports<I, P>, ...X];

/** Declare a GraphQL HTTP application without repeating runtime or authenticator wiring. */
export const GraphqlModule =
  <const Name extends string>(name: Name) =>
  <
    A extends AnyAnswerer,
    const I extends readonly AnyModule[] = [],
    const P extends readonly AnyProvider[] = [],
    const X extends readonly Exportable<Imports<I, A>, Provides<P, A>>[] = [],
    const N extends readonly AnyPort[] = [],
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
      needs: [...(options.needs ?? []), Env] as EnvAnd<N>,
    } as {
      readonly imports: Imports<I, A>;
      readonly provides: Provides<P, A>;
      readonly exports: Exports<Imports<I, A>, Provides<P, A>, X>;
      readonly needs: EnvAnd<N>;
    } & NeedsGate<Imports<I, A>, Provides<P, A>, EnvAnd<N>>);
  };
