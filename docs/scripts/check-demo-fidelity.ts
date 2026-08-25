import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The exact marker the landing page's demo quotes. It is pinned by
// `examples/order-application/src/needs-gate.test-d.ts`, whose `@ts-expect-error`
// fires only while di's `DependencyGate` still prints it.
const MARKER = "UNSATISFIED DEPENDENCIES — nothing provides";

const pinned = fileURLToPath(
  new URL("../../examples/order-application/src/needs-gate.test-d.ts", import.meta.url),
);
const demo = fileURLToPath(new URL("../.vitepress/theme/CompileErrorDemo.vue", import.meta.url));

// Both files may wrap the marker across lines (the pinned test's own comment
// does, at column width, with a `//` continuation prefix on the next line),
// so line-comment markers and whitespace are collapsed before matching — the
// check is for the words, not for line breaks neither file owes the other.
const normalize = (text: string) => text.replace(/^\s*\/\/ ?/gm, " ").replace(/\s+/g, " ");

for (const [what, path] of [
  ["the pinned type test", pinned],
  ["the landing page demo", demo],
] as const) {
  if (!normalize(readFileSync(path, "utf8")).includes(normalize(MARKER))) {
    process.stderr.write(
      `[docs] ${what} no longer contains ${JSON.stringify(MARKER)}.\n` +
        `The landing page quotes this diagnostic as proof. Update both, or drop the demo.\n`,
    );
    process.exit(1);
  }
}
