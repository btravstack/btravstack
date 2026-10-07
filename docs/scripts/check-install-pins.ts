import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, root)), "utf8");

// A catalog entry pinned to a PRERELEASE is a package whose `latest` dist-tag
// points at an older major, so an unversioned install line resolves the wrong
// one — the trap the root AGENTS.md documents for contributors and issue #206
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

// The default catalog: what the published packages are built and tested
// against. A snippet that writes a version where a range would not hold — an
// exact beta, or a 0.x caret, whose minor is its major — states a number, and
// a number in prose drifts unless something recomputes it.
const catalog = new Map(
  [
    ...(/^catalog:\n((?:(?: .*)?\n)*)/m.exec(read("pnpm-workspace.yaml"))?.[1] ?? "").matchAll(
      /^ {2}"?([@\w./-]+)"?: "?(\d[^"\s]*)"?$/gm,
    ),
  ].map(([, name, version]) => [name!, version!] as const),
);

const unpinned: string[] = [];
const drifted: string[] = [];
for (const file of files) {
  read(file)
    .split("\n")
    .forEach((line, index) => {
      if (!isInstallLine(line)) return;
      for (const [, name, spec] of line.matchAll(/(?:^|\s)(@?[\w.-]+(?:\/[\w.-]+)?)@(\S+)/g)) {
        const version = catalog.get(name!);
        if (version === undefined) continue;
        const exact = /^\d+\.\d+\.\d+(?:-\S+)?$/.test(spec!);
        const zeroMinor = /^\^0\.(\d+)/.exec(spec!)?.[1];
        if (
          (exact && spec !== version) ||
          (zeroMinor !== undefined && !version.startsWith(`0.${zeroMinor}.`))
        ) {
          drifted.push(`${file}:${index + 1}  ${name}@${spec} \u2192 the catalog has ${version}`);
        }
      }
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

if (drifted.length > 0) {
  process.stderr.write(
    `[docs] install snippets pin a version the catalog no longer has:\n` +
      drifted.map((line) => `  ${line}\n`).join("") +
      `A reader installs exactly what the snippet says, so it must be what the packages are built against.\n`,
  );
  process.exit(1);
}

if (unpinned.length > 0) {
  process.stderr.write(
    `[docs] install snippets name a package whose \`latest\` dist-tag is an older major:\n` +
      unpinned.map((line) => `  ${line}\n`).join("") +
      `An unversioned install resolves the wrong major and the first run dies in type errors.\n`,
  );
  process.exit(1);
}
