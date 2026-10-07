import { Module, Port, type AnyModule, type AnyProvider } from "@btravstack/di";

import type { AnyUnitModule } from "./unit-record.js";

/**
 * Providers substituted inside a runtime's unit modules, keyed by the kind
 * the runtime declares on `Runtime.units` — test-facing: `@btravstack/testing`'s
 * `overridden(root, providers, { unit })` is the one contributor, and a
 * production root never names it.
 *
 * Each provider must already carry di's override brand. The kernel applies
 * them at boot, before the runtime starts: every kind named must be one the
 * runtime binds, and every port must be one that kind's module provides, or
 * the boot is a defect — the same drift gate a root-level override has.
 */
export class UnitOverrides extends Port.many("UnitOverrides")<
  Readonly<Record<string, readonly AnyProvider[]>>
> {}

/** Whether `module`'s tree carries a provider for `portId`. */
export const provides = (module: AnyModule, portId: string): boolean =>
  module.provides.some((provider) => provider.port.portId === portId) ||
  module.imports.some((imported) => provides(imported, portId));

/**
 * Each overridden kind's module, mapped to the module the kernel forks in its
 * place. Keyed by module IDENTITY, because `UnitHost.fork` is handed the
 * module and never the kind — which is why a module bound under two kinds is
 * refused rather than overridden under both.
 */
export const unitSubstitutes = (
  runtime: string,
  units: Readonly<Record<string, AnyUnitModule | undefined>>,
  overrides: readonly Readonly<Record<string, readonly AnyProvider[]>>[],
): ReadonlyMap<AnyUnitModule, AnyUnitModule> => {
  const byKind = new Map<string, AnyProvider[]>();
  for (const member of overrides)
    for (const [kind, providers] of Object.entries(member))
      byKind.set(kind, [...(byKind.get(kind) ?? []), ...providers]);

  const substitutes = new Map<AnyUnitModule, AnyUnitModule>();
  for (const [kind, providers] of byKind) {
    const module = units[kind];
    if (module === undefined) {
      // oxlint-disable-next-line unthrown/no-throw -- a drifted fixture is a wiring bug; `start` calls this inside di's `flatMap`, which turns the throw into the boot's defect
      throw new Error(
        `[core] unit override for kind "${kind}", which runtime "${runtime}" binds no module for`,
      );
    }
    const shared = Object.keys(units).find((other) => other !== kind && units[other] === module);
    if (shared !== undefined) {
      // oxlint-disable-next-line unthrown/no-throw -- see above
      throw new Error(
        `[core] unit override for kind "${kind}", whose module kind "${shared}" binds too — an override cannot reach one without the other`,
      );
    }
    const seen = new Set<string>();
    for (const provider of providers) {
      if (seen.has(provider.port.portId)) {
        // oxlint-disable-next-line unthrown/no-throw -- see above
        throw new Error(
          `[core] two unit overrides registered for port ${JSON.stringify(provider.port.portId)} in kind "${kind}"`,
        );
      }
      seen.add(provider.port.portId);
      if (!provides(module, provider.port.portId)) {
        // oxlint-disable-next-line unthrown/no-throw -- see above
        throw new Error(
          `[core] unit override for port ${JSON.stringify(provider.port.portId)} in kind "${kind}" with nothing to override — its module no longer provides it`,
        );
      }
    }
    substitutes.set(
      module,
      Module("UnitOverridden")({
        imports: [module],
        provides: providers,
        exports: [module],
      } as never) as unknown as AnyUnitModule,
    );
  }
  return substitutes;
};
