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
    ([, name, major]) => [name, `^${major}.0.0-beta`],
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
      for (const [name, range] of traps) {
        // A bare mention: the name not followed by `@<something>`.
        const at = line.indexOf(name);
        if (at !== -1 && !/[\w@/.-]/.test(line[at + name.length] ?? " ")) {
          unpinned.push(`${file}:${index + 1}  ${name} \u2192 write ${name}@${range}`);
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
