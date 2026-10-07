// The consumer gate: pack, install, compile, lint the tarballs.
//
// It answers from OUTSIDE the workspace a question two existing gates answer
// from inside, where the answer can differ — see this workspace's README. It
// recomputes everything: the package list comes from `packages/*`, the compile
// runs against whatever `pnpm build` just produced, and nothing is hand-kept.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = resolve(fileURLToPath(import.meta.url), "..", "..");
const ROOT = resolve(HERE, "..", "..");

/**
 * The version the DEFAULT catalog pins `name` at — the block `catalog:` opens
 * and the next top-level key closes, at its own two-space indent — so a name
 * that also appears under `catalogs:` or `overrides:` is never read from there.
 */
const catalogVersion = (name: string): string | undefined => {
  const workspace = readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8");
  const block = /^catalog:\n((?:(?: .*)?\n)*)/m.exec(workspace)?.[1] ?? "";
  const escaped = name.replaceAll(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return new RegExp(`^  "?${escaped}"?: "?([^"\\s]+)"?$`, "m").exec(block)?.[1];
};

/** The peers a consumer installs beside the tarballs, and the compiler it realistically has (catalogued under an alias). */
const consumerPeers = (): readonly string[] | undefined => {
  const peers = [
    "@types/node",
    "@unthrown/standard-schema",
    "unthrown",
    "zod",
    "@orpc/contract",
    "@orpc/server",
    "@unthrown/orpc",
  ];
  const versions = [...peers, "typescript-consumer"].map(catalogVersion);
  if (versions.includes(undefined)) return undefined;
  return [
    ...peers.map((name, index) => `${name}@${String(versions[index])}`),
    String(versions.at(-1)).replace(/^npm:/, ""),
  ];
};

/** The published packages, read off the workspace rather than listed here. */
const published = (): readonly string[] =>
  readdirSync(join(ROOT, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(ROOT, "packages", entry.name))
    .filter((dir) => {
      const manifest: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      return (manifest as { private?: boolean }).private !== true;
    });

const run = (command: string, args: readonly string[], cwd: string): string =>
  execFileSync(command, [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

/**
 * How much a package's packed contents may grow against its last published
 * release. A release's worth of features moves a package here by a few
 * percent; what moves one by half is a mistake in what ships — a dependency
 * the bundler inlined instead of leaving external, a source map, a directory
 * nobody meant to publish — and each of those at least doubles a package this
 * size. Measured against `npm view <name> dist.unpackedSize`, which the sum of
 * the packed files matches to within the rewritten `package.json`.
 */
const BUDGET = 1.5;

/**
 * Growth past the budget that is meant, with why. An entry holds only until
 * the package is next published — it is then the baseline — so drop it with
 * the release that carries it: an entry for a package back under budget, or
 * one this run never packed, fails as stale, so an exemption cannot outlive
 * the growth it was for.
 */
const accepted: Readonly<Record<string, string>> = {};

const staleAcceptance = (name: string): string =>
  `size: ${name} is in \`accepted\` but no longer over budget, or no longer packed — drop the entry`;

/**
 * What the last published release of `name` unpacks to — or `"unpublished"`,
 * for a package npm has never seen, or the registry's own complaint.
 */
const publishedSize = (name: string): number | "unpublished" | { readonly failed: string } => {
  try {
    return Number(
      execFileSync("npm", ["view", name, "dist.unpackedSize"], {
        cwd: HERE,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch (cause) {
    const stderr = String((cause as { stderr?: unknown }).stderr);
    return stderr.includes("E404") ? "unpublished" : { failed: stderr.trim() };
  }
};

/** The package `pnpm pack --json` packed, and the budget's verdict on it — `undefined` when it holds. */
const overBudget = (
  dir: string,
  packed: string,
): { readonly name: string; readonly verdict: string | undefined } => {
  const { name, files } = JSON.parse(packed) as {
    readonly name: string;
    readonly files: readonly { readonly path: string }[];
  };
  const size = files.reduce((sum, { path }) => sum + statSync(join(dir, path)).size, 0);
  const baseline = publishedSize(name);
  const isAccepted = accepted[name] !== undefined;
  if (baseline === "unpublished") {
    process.stdout.write(`[consumer-check] ${name}: never published, no size baseline\n`);
    return { name, verdict: isAccepted ? staleAcceptance(name) : undefined };
  }
  if (typeof baseline !== "number") {
    return { name, verdict: `size: ${name}'s baseline: ${baseline.failed}` };
  }
  const ratio = size / baseline;
  if (ratio <= BUDGET) return { name, verdict: isAccepted ? staleAcceptance(name) : undefined };
  return {
    name,
    verdict: isAccepted
      ? undefined
      : `size: ${name} unpacks to ${String(size)} bytes, ${ratio.toFixed(2)}× its last release's ${String(baseline)} (budget ${String(BUDGET)}×) — find what started shipping, or add it to \`accepted\` with the reason`,
  };
};

const main = (): void => {
  const peers = consumerPeers();
  if (peers === undefined) {
    process.stderr.write(
      "[consumer-check] a consumer peer has no entry in pnpm-workspace.yaml's catalog\n",
    );
    process.exitCode = 1;
    return;
  }

  const dirs = published();
  const work = mkdtempSync(join(tmpdir(), "btravstack-consumer-"));
  const failures: string[] = [];

  try {
    // Turbo's graph orders the builds before this, and its entry names each
    // package by hand — so a package added without an entry there would pack
    // an empty tarball and pass. This is what makes that a failure instead:
    // the list THIS script derives is the one that must have been built.
    const unbuilt = dirs.filter((dir) => !existsSync(join(dir, "dist")));
    if (unbuilt.length > 0) {
      process.stderr.write(
        `[consumer-check] ${String(unbuilt.length)} package(s) have no dist — add them to this task's dependsOn in turbo.json:\n`,
      );
      for (const dir of unbuilt) process.stderr.write(`  ${dir}\n`);
      process.exitCode = 1;
      return;
    }

    process.stdout.write(`[consumer-check] packing ${String(dirs.length)} packages\n`);
    const packed = new Set<string>();
    for (const dir of dirs) {
      const { name, verdict } = overBudget(
        dir,
        run("pnpm", ["pack", "--json", "--pack-destination", work], dir),
      );
      packed.add(name);
      if (verdict !== undefined) failures.push(verdict);

      // Both run from HERE, with the package as an argument — never with the
      // package as the cwd. `publint` and `attw` are this workspace's
      // devDependencies and pnpm links a binary into the declaring package's
      // own `node_modules/.bin` alone, so `pnpm exec` from `dir` resolves
      // neither (verified: `Command "publint" not found`). It appeared to work
      // only because the outer `pnpm ... typecheck` had already put this
      // workspace's `.bin` on `PATH`, which is an accident of how the script
      // happens to be invoked.
      try {
        run("pnpm", ["exec", "publint", "run", dir, "--strict"], HERE);
      } catch {
        failures.push(`publint: ${dir}`);
      }

      // `--profile node16` is the node10 decision, expressed as a flag rather
      // than as a filter over a report: the legacy `moduleResolution: "node"`
      // ignores `exports` entirely, this package family publishes no
      // `typesVersions` shim, and a consumer on that resolution cannot use the
      // stack anyway — every relative import here carries a `.js` suffix
      // because `nodenext` requires it. See this workspace's README.
      try {
        run("pnpm", ["exec", "attw", "--pack", dir, "--profile", "node16", "--quiet"], HERE);
      } catch {
        failures.push(`attw: ${dir}`);
      }
    }
    for (const name of Object.keys(accepted)) {
      if (!packed.has(name)) failures.push(staleAcceptance(name));
    }

    // A throwaway project holding nothing but the tarballs and the peers a
    // consumer installs beside them.
    const tarballs = readdirSync(work).filter((name) => name.endsWith(".tgz"));
    writeFileSync(
      join(work, "package.json"),
      `${JSON.stringify({ name: "consumer", private: true, type: "module", version: "0.0.0" }, undefined, 2)}\n`,
    );
    writeFileSync(
      join(work, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            // What the check IS: a consumer emitting its own declarations over
            // this framework's types. `false` here and the gate proves nothing.
            declaration: true,
            emitDeclarationOnly: true,
            outDir: "out",
            // A consumer's resolution, not the repository's — and deliberately
            // `node16` rather than `nodenext`, since that is what a consumer on
            // a released TypeScript reaches for.
            module: "node16",
            moduleResolution: "node16",
            target: "es2023",
            strict: true,
            // What a consumer actually sets, and what every starter template
            // ships. Without it this gate reports a `type-fest` declaration
            // and a missing `Float16Array` — third-party `.d.ts` quality,
            // which is `attw` and `publint`'s question, not this one's.
            skipLibCheck: true,
          },
          include: ["consumer.ts"],
        },
        undefined,
        2,
      )}\n`,
    );
    // The consumer file, copied rather than compiled in place: it must resolve
    // `@btravstack/*` through `node_modules`, the way a consumer does, not
    // through the workspace links.
    writeFileSync(
      join(work, "consumer.ts"),
      readFileSync(join(HERE, "src", "consumer.ts"), "utf8"),
    );

    process.stdout.write("[consumer-check] installing the tarballs\n");
    run(
      "pnpm",
      [
        "add",
        ...tarballs.map((name) => `./${name}`),
        // At the catalog's own versions: floating them would make this gate a
        // test of whoever published last, and a hand-kept list drifted from
        // what the repository builds against.
        ...peers,
        // Nothing here resolves `latest` for a package this repository
        // publishes, so the release-age policy has nothing to wait on.
        "--config.minimum-release-age=0",
        // A consumer's install, not this workspace's: the repository sets
        // `strictPeerDependencies` for its own tree, and a throwaway project
        // outside it should fail on the COMPILE rather than on a warning
        // about a peer the compile would have caught anyway.
        "--config.strict-peer-dependencies=false",
        // Nothing here is built or run — the tarballs are compiled against,
        // not executed — so an unapproved postinstall script is not a decision
        // this gate should be asking anyone to make.
        "--config.strict-dep-builds=false",
        "--ignore-scripts",
      ],
      work,
    );

    process.stdout.write("[consumer-check] compiling a consumer under declaration: true\n");
    try {
      run("pnpm", ["exec", "tsc", "--project", "tsconfig.json"], work);
    } catch (cause) {
      // `tsc` writes its diagnostics to STDOUT, which is piped, so they have to
      // be relayed or the failure says only that there was one.
      const diagnostics: unknown = (cause as { stdout?: unknown }).stdout;
      if (typeof diagnostics === "string") process.stderr.write(diagnostics);
      failures.push("the consumer file did not emit declarations");
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    process.stderr.write(`[consumer-check] ${String(failures.length)} failure(s):\n`);
    for (const failure of failures) process.stderr.write(`  ${failure}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `[consumer-check] ${String(dirs.length)} packages pack, lint and compile as a consumer would\n`,
  );
};

main();
