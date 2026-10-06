import { parseArgs } from "node:util";

/**
 * The string flags a `pnpm dev:*` script was given, or `undefined` when one is
 * unknown: `parseArgs` reports that by throwing, and a mistyped flag is the
 * likeliest way to get here, so the caller answers its usage line rather than a
 * stack trace.
 */
export const flags = <const K extends string>(
  names: readonly K[],
): Partial<Record<K, string>> | undefined => {
  // `pnpm dev:x -- --flag …` hops through two `pnpm run`s, and the second leaves
  // the separator in `argv`, where `parseArgs` reads everything after it as a
  // positional. Only the FIRST goes: a later one is some option's own value.
  const argv = process.argv.slice(2);
  const separator = argv.indexOf("--");

  try {
    return parseArgs({
      args: separator === -1 ? argv : argv.toSpliced(separator, 1),
      options: Object.fromEntries(names.map((name) => [name, { type: "string" as const }])),
    }).values as Partial<Record<K, string>>;
  } catch {
    return undefined;
  }
};
