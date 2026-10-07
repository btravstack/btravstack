// Every symbol a published entry point exports, checked against the places a
// symbol earns its place: an example, a compiled doc sample, a spec, or a
// sibling package that imports it. An export none of them names is surface
// nobody exercises — dead, or alive only by accident — and the matrix that
// would say so lived nowhere until this script recomputed it.
//
// "Names" means IMPORTS it: a word match would count `start` in every
// sentence. What counts:
//
// - an import from the package's specifier in an example, a `ts` fence or a
//   `doctest: prelude` (the samples `extract-doc-samples.ts` compiles), or any
//   file of ANOTHER published package — a starter importing the kernel's
//   `noObserverMember` is a cross-package contract its own specs exercise;
// - a relative import in the package's own specs, which is how they reach it;
// - for anything with a type side, being what a type position anywhere in the
//   published source resolves to. That export is part of some signature, and exists so
//   a consumer can SPELL what it already receives — an options record built
//   apart from its call, an error class in an `Err` union. Without it a
//   consumer's declaration emit fails with TS4023 on the first binding it
//   exports, so it is surface by necessity, exercised through what carries it.
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");
const files = (patterns: string[]) =>
  globSync(patterns, {
    cwd: root,
    exclude: (name) => name === "node_modules" || name === "dist" || name === "generated",
  });

// What a reason has to say for an export to stay with no consumer here. A
// stale entry fails the run too, so the list cannot outlive its reasons.
const literal =
  "a documented default, exported so a consumer reads it rather than copying it; the specs pin the literal it holds, which an import would turn into an assertion that agrees with any change";
const allowed: Readonly<Record<string, string>> = {
  "@btravstack/http-server:DEFAULT_ALGORITHMS": literal,
  "@btravstack/http-server:DEFAULT_TTL_SEC": literal,
  "@btravstack/http-server:TRANSIENT_TTL_SEC": literal,
  "@btravstack/http-server:SESSION_COOKIE": literal,
  "@btravstack/http-server:cookieScheme":
    "the member a hand-rolled cookie-reading surface contributes so `csrf` defaults on; the shipped ones contribute it internally and no example writes a scheme of its own",
  "@btravstack/http-server:principalPort":
    "`defineHttp` mints one per declared scheme, which is how every example reaches it; exported for a unit module written without `defineHttp`",
  "@btravstack/prisma:qualify":
    "the SQLSTATE triage `tryQuery` is built on, exported for an adapter whose query runs outside `tryQuery`; `result.spec.ts` exercises it through `tryQuery`",
};

type Manifest = { readonly private?: boolean; readonly exports?: Record<string, unknown> };

const packages = files(["packages/*/package.json"])
  .map((path) => ({
    dir: path.slice(0, -"/package.json".length),
    manifest: JSON.parse(read(path)) as Manifest,
  }))
  .filter(({ manifest }) => manifest.private !== true)
  .map(({ dir, manifest }) => ({
    name: `@btravstack/${dir.slice("packages/".length)}`,
    dir,
    entries: Object.keys(manifest.exports ?? {})
      .filter((key) => key !== "./package.json")
      .map((key) => `${dir}/src/${key === "." ? "index" : key.slice(2)}.ts`),
  }));

const isTest = (path: string): boolean =>
  /\.(spec|test-d)\.ts$/.test(path) || path.includes("/__tests__/");

const parse = (name: string, text: string) =>
  ts.createSourceFile(name, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);

const isExported = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword);

/** The names a module exports, re-exports included. */
const exportsOf = (path: string): readonly string[] =>
  parse(path, read(path)).statements.flatMap((statement): string[] => {
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      return clause !== undefined && ts.isNamedExports(clause)
        ? clause.elements.map(({ name }) => name.text)
        : [];
    }
    if (!isExported(statement)) return [];
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.flatMap(({ name }) =>
        ts.isIdentifier(name) ? [name.text] : [],
      );
    }
    const named = statement as ts.Statement & { readonly name?: ts.Node };
    return named.name !== undefined && ts.isIdentifier(named.name) ? [named.name.text] : [];
  });

/** Every `{ name }` a module imports, and where from. */
const importsOf = (name: string, text: string): readonly (readonly [string, string])[] =>
  parse(name, text).statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      return [];
    }
    const bindings = statement.importClause?.namedBindings;
    const from = statement.moduleSpecifier.text;
    return bindings !== undefined && ts.isNamedImports(bindings)
      ? bindings.elements.map(
          ({ name, propertyName }) => [from, (propertyName ?? name).text] as const,
        )
      : [];
  });

/**
 * The entry exports some type position of the package's published source
 * resolves to. Resolved by the checker, never by name: a private `Options`
 * elsewhere in the package says nothing about an exported `Options`, and the
 * bundled declarations cannot stand in — they rename a collision (`Options$1`)
 * but also split types across chunks behind mangled aliases (`Cache as t`).
 */
const carriedBy = (dir: string, entries: readonly string[]): ReadonlySet<string> => {
  const config = ts.getParsedCommandLineOfConfigFile(
    join(root, dir, "tsconfig.json"),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () => {},
    },
  );
  const sources = (config?.fileNames ?? []).filter((file) => !isTest(file));
  const program = ts.createProgram(sources, config?.options ?? {});
  const checker = program.getTypeChecker();
  const resolve = (symbol: ts.Symbol): ts.Symbol =>
    symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;

  const named = new Set<ts.Symbol>();
  const visit = (node: ts.Node): void => {
    const at = ts.isTypeReferenceNode(node)
      ? node.typeName
      : ts.isTypeQueryNode(node)
        ? node.exprName
        : ts.isExpressionWithTypeArguments(node)
          ? node.expression
          : undefined;
    const symbol = at === undefined ? undefined : checker.getSymbolAtLocation(at);
    if (symbol !== undefined) named.add(resolve(symbol));
    ts.forEachChild(node, visit);
  };
  for (const file of program.getSourceFiles()) {
    if (sources.includes(file.fileName)) visit(file);
  }

  return new Set(
    entries.flatMap((entry) => {
      const file = program.getSourceFile(join(root, entry));
      const module = file === undefined ? undefined : checker.getSymbolAtLocation(file);
      return module === undefined
        ? []
        : checker
            .getExportsOfModule(module)
            .filter((symbol) => named.has(resolve(symbol)))
            .map(({ name }) => name);
    }),
  );
};

const referenced = new Set<string>();
const record = (file: string, text: string): void => {
  const home = packages.find(({ dir }) => file.startsWith(`${dir}/`));
  for (const [from, name] of importsOf(file, text)) {
    const owner = from.startsWith(".")
      ? home !== undefined && isTest(file)
        ? home
        : undefined
      : packages.find((pkg) => from === pkg.name || from.startsWith(`${pkg.name}/`));
    if (owner !== undefined && (owner !== home || isTest(file))) {
      referenced.add(`${owner.name}:${name}`);
    }
  }
};

for (const file of files(["examples/**/*.ts", "packages/*/src/**/*.ts"])) record(file, read(file));

// The pages and the markers are `extract-doc-samples.ts`'s, mirrored: a sample
// is credited only if that script compiles it, so a `skip`-marked fence, a
// `tsx` fence (refused there unless skipped) and a page it never reads credit
// nothing.
const SKIP = /^<!--\s*doctest:\s*skip\s*[—–-]\s*.+?\s*-->$/;
const OTHER_MARKER =
  /^<!--\s*doctest:\s*((defer)(\s*[—–-].*)?|isolate(\s*[—–-].*)?|signature=\S+|group=[a-z-]+)\s*-->$/;

/** The TypeScript `extract-doc-samples.ts` compiles out of one page. */
const samplesOf = (text: string): readonly string[] => {
  const lines = text.split("\n");
  const samples: string[] = [];
  let skipped = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (line === "<!-- doctest: prelude" || /^<!--\s*doctest:\s*isolate\s*$/.test(line)) {
      const block: string[] = [];
      for (i += 1; i < lines.length && lines[i]!.trim() !== "-->"; i += 1) block.push(lines[i]!);
      samples.push(block.join("\n"));
      skipped = false;
      continue;
    }
    if (SKIP.test(line)) {
      skipped = true;
      continue;
    }
    if (OTHER_MARKER.test(line)) {
      skipped = false;
      continue;
    }
    if (lines[i] !== "```ts" && lines[i] !== "```tsx") {
      if (line !== "") skipped = false;
      continue;
    }
    const compiled = lines[i] === "```ts" && !skipped;
    const body: string[] = [];
    for (i += 1; i < lines.length && lines[i] !== "```"; i += 1) body.push(lines[i]!);
    if (compiled) samples.push(body.join("\n"));
    skipped = false;
  }
  return samples;
};

let samples = 0;
for (const page of files([
  "docs/{tutorial,how-to,reference,explanation,examples}/**/*.md",
  "docs/index.md",
  "README.md",
  "packages/*/README.md",
])) {
  for (const body of samplesOf(read(page))) {
    samples += 1;
    record(page, body);
  }
}

const exported = packages.flatMap(({ name, dir, entries }) => {
  const carried = carriedBy(dir, entries);
  return [...new Set(entries.flatMap(exportsOf))].map((symbol) => {
    const key = `${name}:${symbol}`;
    if (carried.has(symbol)) referenced.add(key);
    return key;
  });
});
const unreferenced = exported.filter((key) => !referenced.has(key) && allowed[key] === undefined);
const stale = Object.keys(allowed).filter((key) => !exported.includes(key) || referenced.has(key));

console.log(
  `[docs] export coverage: ${exported.length} exports across ${packages.length} packages, ` +
    `checked against examples, specs, sibling packages and ${samples} doc samples; ` +
    `${Object.keys(allowed).length} allowed by reason`,
);
if (unreferenced.length > 0 || stale.length > 0) {
  process.stderr.write(
    (unreferenced.length > 0
      ? `[docs] exported, and imported by no example, no doc sample, no spec and no sibling package:\n` +
        unreferenced.map((key) => `  ${key}\n`).join("") +
        `Exercise it, unexport it, or give it a reason in check-export-coverage.ts's \`allowed\`.\n`
      : "") +
      (stale.length > 0
        ? `[docs] allowed with a reason that no longer holds — referenced now, or no longer exported:\n` +
          stale.map((key) => `  ${key}\n`).join("")
        : ""),
  );
  process.exit(1);
}
