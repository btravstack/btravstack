import { Module, Provider, type AnyPort, type ServiceOf } from "@btravstack/di";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { P } from "unthrown";

import { ConfigInvalid } from "./errors.js";
import { parseShape, type Shape } from "./parse.js";
import { ConfigSource } from "./source.js";
import { assertValidPrefix } from "./variable.js";

/** The parsed value of a shape: each key's validator output. */
export type ValueOf<S extends Shape> = {
  readonly [K in keyof S]: StandardSchemaV1.InferOutput<S[K]>;
};

/**
 * Marks a `Config(port, prefix)(shape)` result so `collect` (Task 4) can find
 * it in a module tree by identity rather than by duck-typing on `provides` or
 * `exports`, which every module — adapter or not — carries. Exported:
 * `collect` lives in a different file and needs this exact symbol to test
 * `CONFIG_ADAPTER in module`, not a copy of it — an unexported unique symbol
 * has no identity another module can reach.
 *
 * `Symbol.for` (the global registry), not a fresh `Symbol(...)`: a fresh
 * symbol has per-*module-instantiation* identity, so two resolved copies of
 * this package — realistic once several starters depend on it across
 * diverging semver ranges, or across an ESM/CJS split — would each brand
 * their adapters with a different symbol. `collect`'s `CONFIG_ADAPTER in
 * module` check would then silently miss every adapter built by the other
 * copy, so `Config.parse` reports no issues for them and boot proceeds
 * against a bad environment — the exact failure this package exists to
 * prevent, and it would fail quietly. The registry symbol is shared
 * process-wide by string key, so every copy of this module resolves to the
 * same one regardless of which copy actually ran `Config(port, prefix)(shape)`.
 */
export const CONFIG_ADAPTER = Symbol.for("btravstack/config/adapter");

/**
 * Restated rather than imported: di's own `AnyModule` isn't part of its
 * public export list. `imports` is the only field `collect`'s walk reads, so
 * that is all this needs to say — but it is what `AnyConfigAdapter.imports`
 * below must also match, recursively, for a real adapter to satisfy both
 * this type (so `collect` can walk into one) and `AnyConfigAdapter` (so
 * `parseAll` can read one back out). Exported so `collect.ts` uses this one
 * instead of a second, merely structurally-identical copy.
 */
export type AnyModule = { readonly imports: readonly AnyModule[] };

/**
 * The structural type of what `Config(port, prefix)(shape)` returns, as
 * later tasks consume it: an ordinary di module — branded, and carrying back
 * the `prefix` and `shape` it was built from so `collect`/`parseAll` can read
 * them off the value instead of threading them separately. Unlike the welded
 * design this replaces, it is *only* a module: the port it implements is a
 * separate value, declared by whoever needs the port to exist.
 */
export type AnyConfigAdapter = AnyModule & {
  readonly [CONFIG_ADAPTER]: true;
  readonly prefix: string;
  readonly shape: Shape;
};

/**
 * `Config(port, prefix)(shape)` implements `port` — an ordinary port,
 * declared by the caller with `Port(id)<Service>` — by parsing
 * `prefix`-scoped variables out of `ConfigSource`, and returns the **module**
 * that provides it. It does not declare a port and does not return one: the
 * port stays adaptable precisely because this is just one provider for it,
 * the same as a test's literal or a future file/secret-manager adapter
 * would be.
 *
 * `ValueOf<S> extends ServiceOf<P>` — checked via the trailing rest
 * parameter, the same arity-gate idiom `Module.build`'s `_missing` uses — is
 * "this adapter implements this port" made a compile-time fact: a shape
 * missing a key the port declares, or with the wrong type for one, is a
 * call-arity error at `Config(port, prefix)(shape)`, not a mismatch
 * discovered only once `ctx.get(port)` is read.
 */
export const Config =
  <TPort extends AnyPort, const Prefix extends string>(port: TPort, prefix: Prefix) =>
  <S extends Shape>(
    shape: S,
    ..._implements: ValueOf<S> extends ServiceOf<TPort>
      ? []
      : [error: "shape does not implement the port's service type", expected: ServiceOf<TPort>]
  ): Module<InstanceType<TPort>, never, ConfigSource> & {
    readonly [CONFIG_ADAPTER]: true;
    readonly prefix: Prefix;
    readonly shape: S;
  } => {
    assertValidPrefix(prefix);

    const provider = Provider(port)([ConfigSource], {
      sync: (source: ServiceOf<ConfigSource>) =>
        // The provider is reached only after `Config.parse` has already
        // validated every adapter, so a failure here is a defect rather than
        // a domain outcome — the environment cannot have changed in between.
        // That ordering is not something this file enforces: `Config.parse`
        // (Task 5) does the validating, and `@btravstack/start-core` is what
        // will call it before building the graph, in phase 2 — this file
        // only trusts the kernel to have done so first. Reaching this line
        // with an invalid environment therefore means that guarantee was
        // skipped, which is a bug in the caller, not in the environment —
        // exactly what `getOrThrow` turning it into a thrown `ConfigInvalid`
        // expresses. Wrapped into `ConfigInvalid` first (rather than thrown
        // as the bare `ConfigIssue[]` `parseShape` returns) so a reporter
        // catching this sees a tagged error with a real `message`, not
        // `[object Object]`.
        // oxlint-disable-next-line unthrown/no-get-or-throw -- deliberate defect conversion; see the comment above on why reaching this invalid is a caller bug, not a domain outcome
        parseShape(prefix, shape, source)
          .mapErrCases((matcher) =>
            // oxlint-disable-next-line unthrown/no-catch-all-pattern -- E is readonly ConfigIssue[], a single non-union type
            matcher.with(P._, (issues) => new ConfigInvalid({ issues })),
          )
          .getOrThrow() as ServiceOf<TPort>,
    });

    // `port as never`: `Module`'s `exports` array checks each entry against
    // `AnyPort & (new () => Available<...>)` — a *non-abstract* constructor
    // — but `AnyPort` (and therefore `TPort`, bounded by it) declares an
    // *abstract* one on purpose (see `port.ts`'s note on why: it is what
    // lets a concrete port class still widen to `AnyPort`). A generic
    // `TPort` is checked against its bound, not against whatever concrete
    // class the caller actually passed, so TypeScript can never see this
    // particular `port` as concrete — no cast to a *named* type closes that
    // gap. `never` is the bottom type, assignable into anything, so it
    // sidesteps the check entirely rather than trying to satisfy it; the
    // final cast below restates the real, precise type this factory
    // promises, so nothing downstream ever observes the widening.
    const adapter = Module(`Config(${prefix})`)({
      provides: [provider],
      exports: [port as never],
    });

    // Non-enumerable — the default `Object.defineProperties` descriptor:
    // `collect`/`parseAll` reach these three through the type, not through
    // `Object.keys`/spreading the adapter, so leaving them out of an
    // enumerated view keeps `{ ...adapter }` and friends showing only the
    // ordinary module fields (`name`/`imports`/`provides`/`exports`).
    Object.defineProperties(adapter, {
      [CONFIG_ADAPTER]: { value: true },
      prefix: { value: prefix },
      shape: { value: shape },
    });

    // `as unknown as`: the widened `exports: [port as never]` above means
    // `Module(...)`'s own inferred return type is wider than the precise
    // `Module<InstanceType<TPort>, never, ConfigSource>` this factory
    // promises — a direct `as` between two differently-instantiated
    // `Module<...>`s is rejected for the same contravariant-phantom-field
    // reason di's own `Provider`/`Module` factories cast `as never`
    // internally. The object itself is exactly right at runtime; only the
    // type needs restating here, back to what the port and shape actually are.
    return adapter as unknown as Module<InstanceType<TPort>, never, ConfigSource> & {
      readonly [CONFIG_ADAPTER]: true;
      readonly prefix: Prefix;
      readonly shape: S;
    };
  };
