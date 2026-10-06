import type { Module, Provider } from "@btravstack/di";
import { expectTypeOf } from "vitest";

import { overridden } from "./overridden.js";

type Greeter = { readonly greeter: true };
type Refused = { readonly _tag: "Refused" };

declare const Root: Module<Greeter, never, never>;
declare const fallible: Provider<Greeter, Refused, never>;
declare const infallible: Provider<Greeter, never, Refused>;

// An empty override list adds no error channel.
expectTypeOf(overridden(Root, [])).toEqualTypeOf<Module<Greeter, never, never>>();

// A unit override may need anything — its deps resolve from the fork.
void overridden(Root, [], { unit: { user: [infallible] } });

// @ts-expect-error — a fork's error channel is `never`, so a unit override carrying one is refused
void overridden(Root, [], { unit: { user: [fallible] } });
