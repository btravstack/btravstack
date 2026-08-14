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
  // A cursor rather than `shift()`: the walk must stay breadth-first so
  // adapters come back in declaration order — which is the order
  // `describeIssues` promises an operator — and an index keeps that order
  // without re-indexing the array on every step.
  const queue: AnyModule[] = [module];

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    if (isAdapter(current)) adapters.push(current);
    queue.push(...current.imports);
  }

  return adapters;
};
