import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The exact marker the landing page's demo quotes.
const MARKER = "UNSATISFIED DEPENDENCIES — nothing provides";

// `DependencyGate`'s own marker type — the string the compiler actually prints,
// and the only one of the three that is not prose about it. A rename here is
// what the other two would otherwise drift away from silently: the type test's
// `@ts-expect-error` fires on ANY error on that line, so it would keep passing
// with a stale comment beside it while the landing page quoted a diagnostic
// TypeScript no longer emits.
const source = fileURLToPath(new URL("../../packages/di/src/module.ts", import.meta.url));
const pinned = fileURLToPath(
  new URL("../../examples/order-application/src/needs-gate.test-d.ts", import.meta.url),
);
const demo = fileURLToPath(new URL("../.vitepress/theme/CompileErrorDemo.vue", import.meta.url));

// Both files may wrap the marker across lines (the pinned test's own comment
// does, at column width, with a `//` continuation prefix on the next line),
// so line-comment markers and whitespace are collapsed before matching — the
// check is for the words, not for line breaks neither file owes the other.
const normalize = (text: string) => text.replace(/^\s*\/\/ ?/gm, " ").replace(/\s+/g, " ");

// TypeScript escapes the em dash in type-printing positions and leaves it
// literal in the `Property … is missing` clause, so the demo quotes BOTH
// spellings verbatim. Checking only one would let drift confined to the other
// pass green — the demo carries the escaped form twice and the literal once.
const ESCAPED = MARKER.replace("—", "\\u2014");

for (const [what, path, expected] of [
  ["di's `DependencyGate` marker", source, [MARKER]],
  ["the pinned type test", pinned, [MARKER]],
  ["the landing page demo", demo, [MARKER, ESCAPED]],
] as const) {
  const text = normalize(readFileSync(path, "utf8"));
  for (const marker of expected) {
    if (!text.includes(normalize(marker))) {
      process.stderr.write(
        `[docs] ${what} no longer contains ${JSON.stringify(marker)}.\n` +
          `The landing page quotes this diagnostic as proof. Update both, or drop the demo.\n`,
      );
      process.exit(1);
    }
  }
}
