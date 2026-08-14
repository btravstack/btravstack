import { CONFIG_ADAPTER, type AnyConfigAdapter, type AnyModule } from "./slice.js";

const isAdapter = (module: AnyModule): module is AnyConfigAdapter => CONFIG_ADAPTER in module;

/**
 * Every config adapter reachable from a root module, each once.
 *
 * Iterative rather than recursive, and `seen`-guarded: a module graph may
 * reach the same module by two paths, and an adapter imported twice must be
 * parsed — and reported — once.
 */
export const collect = (module: AnyModule): readonly AnyConfigAdapter[] => {
  const seen = new Set<AnyModule>();
  const adapters: AnyConfigAdapter[] = [];
  const queue: AnyModule[] = [module];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    if (isAdapter(current)) adapters.push(current);
    queue.push(...current.imports);
  }

  return adapters;
};
