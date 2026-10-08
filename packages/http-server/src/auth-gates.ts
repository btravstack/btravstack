import type { Requirements } from "@btravstack/contract";
import type { PortInstance } from "@btravstack/di";

import type { AuthenticatorService } from "./auth.js";
import type { SchemesOf } from "./principal.js";

export type SchemesIn<R> = R extends Requirements ? SchemesOf<R> : never;

export type SchemePortsOf<R> =
  SchemesIn<R> extends infer S extends string
    ? S extends string
      ? PortInstance<`HttpAuthenticator:${S}`, AuthenticatorService<unknown>>
      : never
    : never;

export type ScopesIn<R, K extends string> = R extends Requirements
  ? {
      [I in keyof R]: K extends keyof R[I]
        ? R[I][K] extends readonly (infer S extends string)[]
          ? S
          : never
        : never;
    }[number]
  : never;

export type UngrantableIn<R, Vocab> = {
  [K in SchemesIn<R>]: K extends keyof Vocab ? Exclude<ScopesIn<R, K>, Vocab[K]> : never;
}[SchemesIn<R>];

export type RequiresGate<R, Vocab> = [UngrantableIn<R, Vocab>] extends [never]
  ? unknown
  : {
      readonly "UNGRANTABLE SCOPE — its scheme's authenticator cannot grant it": UngrantableIn<
        R,
        Vocab
      >;
    };
