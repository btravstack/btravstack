import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, root)), "utf8");

// A catalog entry pinned to a PRERELEASE is a package whose `latest` dist-tag
// points at an older major, so an unversioned install line resolves the wrong
// one — the trap the root CLAUDE.md documents for contributors and issue #206
// found in the consumer-facing snippets. Derived from the catalog rather than
// listed here, so a family that goes stable stops being checked by itself.
const traps = new Map(
  [...read("pnpm-workspace.yaml").matchAll(/^ +"?(@[\w./-]+)"?: (\d+)\.\d+\.\d+-/gm)].map(
    ([, name, major]) => [name, major!] as const,
  ),
);

// An install command, or one of its backslash continuations — which is the only
// other line shape a package name may be pinned on.
const isInstallLine = (line: string) =>
  /^(?:pnpm add|npm install|npm i|yarn add|bun add)\b/.test(line) || /^\s+@[\w-]+\//.test(line);

const files = globSync(
  ["README.md", "docs/**/*.md", "packages/*/README.md", "examples/**/README.md"],
  {
    cwd: fileURLToPath(root),
    exclude: (name) => name === "node_modules",
  },
);

const unpinned: string[] = [];
for (const file of files) {
  read(file)
    .split("\n")
    .forEach((line, index) => {
      if (!isInstallLine(line)) return;
      for (const [name, major] of traps) {
        const at = line.indexOf(name);
        if (at === -1) continue;
        const after = line.slice(at + name.length);
        // Not merely "is there an `@`": `@orpc/server@^1.0.0` carries one and
        // is the exact bug this guard exists to catch, so the MAJOR is what is
        // checked. A range's first digit run is its major — `^2.0.0-beta`,
        // `2.0.0-beta.28` and `>=2.0.0-beta` all answer 2.
        if (/^[\w/.-]/.test(after)) continue;
        const wanted = `${name}@^${major}.0.0-beta`;
        if (!after.startsWith("@")) {
          unpinned.push(`${file}:${index + 1}  ${name} (no version) \u2192 write ${wanted}`);
          continue;
        }
        const spec = after.slice(1).split(/\s/)[0] ?? "";
        if ((/\d+/.exec(spec)?.[0] ?? "") !== major) {
          unpinned.push(`${file}:${index + 1}  ${name}@${spec} \u2192 write ${wanted}`);
        }
      }
    });
}

if (unpinned.length > 0) {
  process.stderr.write(
    `[docs] install snippets name a package whose \`latest\` dist-tag is an older major:\n` +
      unpinned.map((line) => `  ${line}\n`).join("") +
      `An unversioned install resolves the wrong major and the first run dies in type errors.\n`,
  );
  process.exit(1);
}
