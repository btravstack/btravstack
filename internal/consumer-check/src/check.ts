// The consumer gate: pack, install, compile, lint the tarballs — then install
// each one alone and load it, on this Node and on the published floor.
//
// It answers from OUTSIDE the workspace a question two existing gates answer
// from inside, where the answer can differ — see this workspace's README. It
// recomputes everything: the package list comes from `packages/*`, the compile
// runs against whatever `pnpm build` just produced, and nothing is hand-kept.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

type Manifest = {
  readonly name: string;
  readonly engines?: { readonly node?: string };
  readonly exports?: Readonly<Record<string, unknown>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>;
};

/** A tarball and the manifest `pnpm pack` wrote into it — `workspace:` and `catalog:` already rewritten to the ranges a consumer is told. */
type Packed = { readonly tarball: string; readonly manifest: Manifest };

const packed = (tarball: string): Packed => ({
  tarball,
  manifest: JSON.parse(
    run("tar", ["-xzOf", tarball, "package/package.json"], dirname(tarball)),
  ) as Manifest,
});

const peersOf = (manifest: Manifest, optional: boolean): readonly (readonly [string, string])[] =>
  Object.entries(manifest.peerDependencies ?? {}).filter(
    ([name]) => (manifest.peerDependenciesMeta?.[name]?.optional === true) === optional,
  );

/**
 * The Node every published `engines.node` promises — `>=22` is `22.0.0` — or
 * why there is none. One floor for the family, because they install together.
 */
const nodeFloor = (manifests: readonly Manifest[]): string | { readonly failed: string } => {
  const stated = [...new Set(manifests.map(({ engines }) => engines?.node))];
  const floor =
    stated.length === 1 ? /^>=(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(stated[0] ?? "") : null;
  if (floor === null) {
    return {
      failed: `node floor: every package must state one \`engines.node\` of the form ">=x[.y[.z]]", found ${stated.map(String).join(", ")}`,
    };
  }
  return `${String(floor[1])}.${floor[2] ?? "0"}.${floor[3] ?? "0"}`;
};

/**
 * Entry points that fail to load for a reason the package cannot fix on its
 * own, keyed `<package> <import|require> (<floor|current>)`, with why. Like
 * `accepted`, an entry fails as stale once that run loads clean.
 */
const temporalCjs =
  "`@temporal-contract/worker` exports `./activity` under an `import` condition alone, so the CJS build's `require` of it resolves on no Node";
const gaps: Readonly<Record<string, string>> = {
  "@btravstack/http-server require (floor)":
    "`@orpc/server` is ESM-only, so the CJS build needs `require(esm)`, unflagged from Node 22.12; a CJS consumer on 22.0-22.11 cannot load it",
  "@btravstack/temporal-worker require (floor)": temporalCjs,
  "@btravstack/temporal-worker require (current)": temporalCjs,
};

/**
 * Loads each entry point with `import()` and, where the package publishes a
 * `require` condition, `require()` — from INSIDE the install, so both resolve
 * through its own `node_modules` — and prints what failed and with which code.
 */
const SMOKE = `const entries = JSON.parse(process.argv[2]);
(async () => {
  const failed = [];
  for (const { specifier, cjs } of entries) {
    for (const mode of cjs ? ["import", "require"] : ["import"]) {
      try {
        if (mode === "import") await import(specifier);
        else require(specifier);
      } catch (error) {
        failed.push({ specifier, mode, code: error?.code, message: String(error?.message ?? error).split("\\n")[0] });
      }
    }
  }
  process.stdout.write(JSON.stringify(failed));
})();
`;

type SmokeFailure = {
  readonly specifier: string;
  readonly mode: "import" | "require";
  readonly code?: string;
  readonly message: string;
};

/**
 * The one failure an entry point is allowed: a SUBPATH that cannot find one
 * of its package's own optional peers. The root is never allowed it — that is
 * the optional adapter staying optional — and a missing package nobody
 * declared is a dependency the manifest forgot.
 */
const isOptionalAdapter = (manifest: Manifest, failure: SmokeFailure): boolean => {
  const missing = /Cannot find (?:package|module) '((?:@[^/']+\/)?[^/']+)/.exec(
    failure.message,
  )?.[1];
  return (
    failure.specifier !== manifest.name &&
    (failure.code === "ERR_MODULE_NOT_FOUND" || failure.code === "MODULE_NOT_FOUND") &&
    peersOf(manifest, true).some(([name]) => name === missing)
  );
};

/**
 * A pnpm install, relaying what pnpm printed when it fails — it reports an
 * unmet peer on STDOUT, which `run` pipes, so without this the failure says
 * only that there was one.
 */
const install = (args: readonly string[], cwd: string): boolean => {
  try {
    run("pnpm", [...args, "--config.minimum-release-age=0"], cwd);
    return true;
  } catch (cause) {
    const output: unknown = (cause as { stdout?: unknown }).stdout;
    if (typeof output === "string") process.stderr.write(output);
    return false;
  }
};

/**
 * One package installed alone — its tarball, the tarballs of the
 * `@btravstack/*` peers it requires (transitively), and its other REQUIRED
 * peers at the floor of the range it advertises — then loaded on each Node.
 * Returns the failures, and the gap keys that ran.
 */
const isolated = (
  alone: string,
  subject: Packed,
  family: ReadonlyMap<string, Packed>,
  nodes: Readonly<Record<"current" | "floor", string>>,
): { readonly failures: readonly string[]; readonly ran: readonly string[] } => {
  const { name } = subject.manifest;
  const dir = join(alone, name.replace("/", "+"));
  mkdirSync(dir, { recursive: true });
  const dependencies = new Map<string, string>();
  const visit = ({ tarball, manifest }: Packed): void => {
    dependencies.set(manifest.name, `file:${tarball}`);
    const required = peersOf(manifest, false);
    // Ranges before recursion, so the subject's own range for a peer wins: a
    // sibling's stricter one then fails the strict peer check, which is the
    // point, and a looser one never stands in for the subject's.
    for (const [peer, range] of required) {
      if (!family.has(peer) && !dependencies.has(peer)) dependencies.set(peer, range);
    }
    for (const [peer] of required) {
      const local = family.get(peer);
      if (local !== undefined && !dependencies.has(peer)) visit(local);
    }
  };
  visit(subject);

  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "isolated", private: true, dependencies: Object.fromEntries(dependencies) }, undefined, 2)}\n`,
  );
  // Settings, not `--config.*` flags: pnpm ignores `resolutionMode` as a flag
  // and resolves the highest version instead.
  writeFileSync(
    join(dir, "pnpm-workspace.yaml"),
    [
      // The advertised floor, not the catalog: each peer above resolves to
      // the lowest version its range admits.
      "resolutionMode: lowest-direct",
      "strictPeerDependencies: true",
      // What npm and pnpm both do for a consumer, and it never installs an
      // OPTIONAL peer — so the subject still gets only the peers listed above,
      // and a third party's own required peer (`@prisma/orm-toolchain`'s
      // `@prisma/cli-engine`) is not this package's to declare.
      "autoInstallPeers: true",
      "strictDepBuilds: false",
      // A tarball's version reads as its `file:` path, which no `^0.x` range
      // admits, so strict peers would refuse every sibling tarball. They are
      // the same commit by construction; every other peer stays strict.
      "peerDependencyRules:",
      "  allowAny:",
      '    - "@btravstack/*"',
      "",
    ].join("\n"),
  );
  writeFileSync(join(dir, "smoke.cjs"), SMOKE);
  if (!install(["install", "--ignore-scripts"], dir)) {
    return { failures: [`isolated install: ${name} with only its required peers`], ran: [] };
  }

  const entries = Object.entries(subject.manifest.exports ?? {})
    .filter(([path]) => path !== "./package.json")
    .map(([path, conditions]) => ({
      specifier: path === "." ? name : `${name}/${path.slice(2)}`,
      cjs: typeof conditions === "object" && conditions !== null && "require" in conditions,
    }));
  const failures: string[] = [];
  const ran: string[] = [];
  for (const [label, node] of Object.entries(nodes)) {
    // Without `NODE_PATH`: pnpm's script shims point it at this workspace's
    // store, and `require` falls back to it — so an optional peer the install
    // lacks would be found in the repository instead.
    const { NODE_PATH: _, ...env } = process.env;
    const output = execFileSync(node, ["smoke.cjs", JSON.stringify(entries)], {
      cwd: dir,
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "inherit"],
    });
    const failed = (JSON.parse(output) as readonly SmokeFailure[]).filter(
      (failure) => !isOptionalAdapter(subject.manifest, failure),
    );
    for (const mode of ["import", "require"]) {
      const key = `${name} ${mode} (${label})`;
      const ofMode = failed.filter((failure) => failure.mode === mode);
      if (gaps[key] !== undefined) {
        ran.push(key);
        if (ofMode.length === 0) failures.push(`smoke: ${key} loads clean — drop it from \`gaps\``);
        continue;
      }
      for (const failure of ofMode) {
        failures.push(
          `smoke: ${failure.mode}("${failure.specifier}") on the ${label} Node — ${failure.code ?? "no code"}: ${failure.message}`,
        );
      }
    }
  }
  return { failures, ran };
};

/** Every packed package installed alone and loaded on this Node and on the published floor. */
const smoke = (work: string, alone: string, tarballs: readonly string[]): readonly string[] => {
  const family = new Map(
    tarballs.map((name) => packed(join(work, name))).map((pkg) => [pkg.manifest.name, pkg]),
  );
  const floor = nodeFloor([...family.values()].map(({ manifest }) => manifest));
  if (typeof floor !== "string") return [floor.failed];

  process.stdout.write(`[consumer-check] fetching Node ${floor}, the published floor\n`);
  const floorDir = join(alone, "node-floor");
  mkdirSync(floorDir);
  writeFileSync(
    join(floorDir, "package.json"),
    `${JSON.stringify({ name: "node-floor", private: true })}\n`,
  );
  if (!install(["add", `node@runtime:${floor}`], floorDir)) {
    return [`node floor: could not fetch Node ${floor}`];
  }
  const nodes = {
    current: process.execPath,
    floor: join(floorDir, "node_modules", ".bin", "node"),
  };

  process.stdout.write(
    `[consumer-check] installing each package alone, loading it on Node ${process.versions.node} and ${floor}\n`,
  );
  const failures: string[] = [];
  const ran = new Set<string>();
  for (const subject of family.values()) {
    const result = isolated(alone, subject, family, nodes);
    failures.push(...result.failures);
    for (const key of result.ran) ran.add(key);
  }
  for (const key of Object.keys(gaps)) {
    if (!ran.has(key)) failures.push(`smoke: ${key} is in \`gaps\` but never ran — drop it`);
  }
  return failures;
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
  // Beside `work`, never inside it: Node resolves a bare specifier by
  // climbing directories, so an install nested under the full one would find
  // every package the full one has, and nothing would be missing from it.
  const alone = mkdtempSync(join(tmpdir(), "btravstack-alone-"));
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

    failures.push(...smoke(work, alone, tarballs));
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(alone, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    process.stderr.write(`[consumer-check] ${String(failures.length)} failure(s):\n`);
    for (const failure of failures) process.stderr.write(`  ${failure}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `[consumer-check] ${String(dirs.length)} packages pack, lint, compile and load as a consumer would\n`,
  );
};

main();
