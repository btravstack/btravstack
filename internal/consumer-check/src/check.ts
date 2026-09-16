// The consumer gate: pack, install, compile, lint the tarballs.
//
// It answers from OUTSIDE the workspace a question two existing gates answer
// from inside, where the answer can differ — see this workspace's README. It
// recomputes everything: the package list comes from `packages/*`, the compile
// runs against whatever `pnpm build` just produced, and nothing is hand-kept.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = resolve(fileURLToPath(import.meta.url), "..", "..");
const ROOT = resolve(HERE, "..", "..");

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

const main = (): void => {
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
    for (const dir of dirs) {
      run("pnpm", ["pack", "--pack-destination", work], dir);

      // `publint` reads the package directory; `attw --pack` reads the tarball
      // it builds itself. Both are per package, so a failure names one.
      try {
        run("pnpm", ["exec", "publint", "--strict"], dir);
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
        run("pnpm", ["exec", "attw", "--pack", ".", "--profile", "node16", "--quiet"], dir);
      } catch {
        failures.push(`attw: ${dir}`);
      }
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
        // The peers a consumer installs beside them, at the versions the
        // install snippets on the documentation site name. Floating them would
        // make this gate a test of whoever published last.
        "@types/node@26.4.1",
        "unthrown@5.8.0",
        "zod@4.5.4",
        "@orpc/contract@2.0.0-beta.28",
        "@orpc/server@2.0.0-beta.28",
        "@unthrown/orpc@0.2.0",
        "typescript@5.9.3",
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
