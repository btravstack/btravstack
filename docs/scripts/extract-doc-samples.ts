// Extract every ```ts fence from the documentation into generated
// `*.test-d.ts` units, so `pnpm typecheck` fails when a sample stops
// compiling — the doctest model (#94): coverage is the default, and a fence
// that genuinely cannot compile opts out visibly, with a reason.
//
// Invoked from a TARGET workspace's `generate` script with `--group <name>`;
// turbo's existing `generate` edges on `typecheck` / `test:types` / `test` do
// the ordering, exactly as they do for the Prisma client. Groups are resolved
// from each page's own imports (a temporal import → the temporal worker, …),
// so the mapping maintains itself; a page the resolver cannot place carries an
// explicit `<!-- doctest: group=… -->`.
//
// Fence markers, as an HTML comment on the line above the fence — invisible in
// the rendered page, grep-able in the source:
//
//   <!-- doctest: skip — <reason> -->     not compiled; the reason is required
//   <!-- doctest: defer -->               same module, emitted after the
//                                          unmarked fences — for a page that
//                                          shows its composition root before
//                                          the parts it composes
//   <!-- doctest: isolate -->             own module (the page redeclares);
//                                          a private prelude makes it fully
//                                          self-contained (no page prelude)
//
// An isolate marker may span lines; everything after `isolate` is that
// fence's PRIVATE prelude. Because the generated module lives inside the
// target workspace's `src/`, a prelude can import the REAL artifact a page
// shows elsewhere — `import { relayConfig } from "../../outbox-relay.js";` —
// which is perfectly-typed context with no hand-written stub.
//
// And the Rust-doctest hidden-line analog, because the fences are NARRATIVE
// EXCERPTS — a page shows the body and narrates the imports — so nearly every
// page needs context the reader never sees. A prelude block is TypeScript
// compiled ahead of the page's fences and rendered nowhere:
//
//   <!-- doctest: prelude
//   import { AmqpHandler } from "@btravstack/amqp-worker";
//   declare const orderContract: …;
//   -->
//
// Composition: a page's unmarked fences concatenate into ONE module — pages
// build their sample progressively, and the later fences use the earlier
// ones' declarations — with import statements hoisted to the top and
// de-duplicated textually. Bodies are byte-for-byte: fidelity is the point,
// and `@ts-expect-error` inside a fence survives as a measured assertion.
import { existsSync, globSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";

const DOCS_ROOT = resolve(import.meta.dirname, "..");
const REPO_ROOT = resolve(DOCS_ROOT, "..");

type Group = "core" | "order-api" | "order-temporal-worker" | "order-amqp-worker";

const GROUPS: readonly Group[] = [
  "core",
  "order-api",
  "order-temporal-worker",
  "order-amqp-worker",
];

/** Module prefixes that pin a page to a group, most specific transport first. */
const classify = (imports: readonly string[]): Group => {
  const has = (...prefixes: readonly string[]) =>
    imports.some((source) => prefixes.some((prefix) => source.startsWith(prefix)));
  const temporal = has("@btravstack/temporal-worker", "@temporal-contract/", "@temporalio/");
  const amqp = has("@btravstack/amqp-worker", "@amqp-contract/");
  // oxlint-disable-next-line unthrown/no-throw -- a generator's misconfiguration must fail the generate task loudly
  if (temporal && amqp) throw new Error("a page mixing temporal and amqp needs a group marker");
  if (temporal) return "order-temporal-worker";
  if (amqp) return "order-amqp-worker";
  if (
    has(
      "@btravstack/http-server",
      "@btravstack/contract",
      "@btravstack/observability",
      "zod",
      "@orpc/",
      "@btravstack/example-",
    )
  ) {
    return "order-api";
  }
  return "core";
};

type Fence = {
  readonly file: string;
  readonly line: number;
  readonly body: string;
  readonly marker:
    | "include"
    | "defer"
    | { readonly isolate: string }
    | { readonly skip: string }
    | { readonly signature: string };
};

type Page = {
  readonly file: string;
  readonly group: Group;
  readonly prelude: string;
  readonly fences: readonly Fence[];
  readonly skips: readonly { readonly line: number; readonly reason: string }[];
};

const MARKER =
  /^<!--\s*doctest:\s*(skip\s*[—–-]\s*(?<reason>.+?)|(?<defer>defer)(\s*[—–-].*)?|isolate(\s*[—–-].*)?|signature=(?<signature>\S+)|group=(?<group>[a-z-]+))\s*-->$/;

const parsePage = (file: string): Page | undefined => {
  const lines = readFileSync(file, "utf8").split("\n");
  const fences: Fence[] = [];
  const skips: { line: number; reason: string }[] = [];
  const preludes: string[] = [];
  let pageGroup: Group | undefined;
  let pending: Fence["marker"] = "include";
  let pendingLine = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.trim() === "<!-- doctest: prelude") {
      const block: string[] = [];
      for (i += 1; i < lines.length && lines[i]!.trim() !== "-->"; i += 1) block.push(lines[i]!);
      preludes.push(block.join("\n"));
      continue;
    }
    if (/^<!--\s*doctest:\s*isolate\s*$/.test(lines[i]!.trim())) {
      const block: string[] = [];
      for (i += 1; i < lines.length && lines[i]!.trim() !== "-->"; i += 1) block.push(lines[i]!);
      pending = { isolate: block.join("\n") };
      pendingLine = i + 1;
      continue;
    }
    const marker = MARKER.exec(lines[i]!.trim());
    if (marker) {
      if (marker.groups?.["group"] !== undefined) {
        const named = marker.groups["group"];
        if (!GROUPS.includes(named as Group))
          // oxlint-disable-next-line unthrown/no-throw -- a generator's misconfiguration must fail the generate task loudly
          throw new Error(`${file}:${i + 1}: unknown group ${named}`);
        pageGroup = named as Group;
      } else if (marker.groups?.["reason"] !== undefined) {
        pending = { skip: marker.groups["reason"] };
        pendingLine = i + 1;
      } else if (marker.groups?.["signature"] !== undefined) {
        pending = { signature: marker.groups["signature"] };
        pendingLine = i + 1;
      } else if (marker.groups?.["defer"] !== undefined) {
        pending = "defer";
        pendingLine = i + 1;
      } else {
        pending = { isolate: "" };
        pendingLine = i + 1;
      }
      continue;
    }
    // `tsx` is admitted only to be REFUSED below unless it carries a skip: JSX
    // has no workspace that compiles it, and letting the fence language decide
    // that silently is the ungated channel a skip reason exists to close.
    if (lines[i] !== "```ts" && lines[i] !== "```tsx") {
      // A fence marker binds to the NEXT line only; anything else resets it,
      // so a stale marker cannot silently skip a fence added later below it.
      if (lines[i]!.trim() !== "" && pending !== "include") {
        // oxlint-disable-next-line unthrown/no-throw -- a stale marker must fail the generate task loudly, not skip a fence
        throw new Error(
          `${file}:${pendingLine}: doctest marker is not directly above a \`\`\`ts fence`,
        );
      }
      continue;
    }
    const jsx = lines[i] === "```tsx";
    const start = i + 1;
    const body: string[] = [];
    for (i += 1; i < lines.length && lines[i] !== "```"; i += 1) body.push(lines[i]!);
    if (typeof pending === "object" && "skip" in pending) {
      skips.push({ line: start, reason: pending.skip });
    } else if (jsx) {
      // oxlint-disable-next-line unthrown/no-throw -- an ungated fence must fail the generate task loudly
      throw new Error(
        `${file}:${start}: a \`\`\`tsx fence compiles nowhere — mark it \`<!-- doctest: skip — <reason> -->\``,
      );
    } else {
      fences.push({ file, line: start, body: body.join("\n"), marker: pending });
    }
    pending = "include";
  }
  if (fences.length === 0 && skips.length === 0) return undefined;
  const prelude = preludes.join("\n");
  // Classification reads the isolates' private preludes too: a page whose only
  // transport-identifying imports live in an isolate (a tutorial restating its
  // stack per spec fence) would otherwise fall to the default group.
  const isolatePreludes = fences.map((fence) =>
    typeof fence.marker === "object" && "isolate" in fence.marker ? fence.marker.isolate : "",
  );
  const imports = [prelude, ...isolatePreludes, ...fences.map((fence) => fence.body)].flatMap(
    (body) => [...body.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!),
  );
  return { file, group: pageGroup ?? classify(imports), prelude, fences, skips };
};

/** Hoist a fence body's import statements (possibly multi-line) off its code. */
const splitImports = (body: string): { imports: string[]; rest: string } => {
  const imports: string[] = [];
  const rest: string[] = [];
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (/^import[\s{]/.test(lines[i]!)) {
      let statement = lines[i]!;
      while (!/["'];?\s*$/.test(statement) && i + 1 < lines.length) {
        i += 1;
        statement += `\n${lines[i]!}`;
      }
      imports.push(statement);
    } else {
      rest.push(lines[i]!);
    }
  }
  return { imports, rest: rest.join("\n").trim() };
};

/**
 * Merge the hoisted imports into one statement per module. Fences re-import
 * overlapping names (`{ Logger }` here, `{ Logger, Module }` there), which
 * concatenation would turn into duplicate identifiers; and a page presenting a
 * multi-FILE layout imports its own earlier fences (`./handlers.js`), whose
 * bindings the concatenated module already holds — so RELATIVE imports are
 * dropped outright, and a name they carried that no fence declares surfaces as
 * an error the prelude answers.
 */
const mergeImports = (statements: ReadonlySet<string>): string[] => {
  const named = new Map<string, Map<string, boolean>>(); // source → name → typeOnly
  const passthrough = new Set<string>();
  for (const statement of statements) {
    const flat = statement.replace(/\s+/g, " ").trim();
    const match = /^import (type )?\{(?<names>[^}]*)\} from "(?<source>[^"]+)";?$/.exec(flat);
    const source = match?.groups?.["source"];
    if (!match || source === undefined) {
      if (!/["']\.\.?\//.test(flat)) passthrough.add(flat);
      continue;
    }
    if (source.startsWith("..")) {
      passthrough.add(flat);
      continue;
    }
    if (source.startsWith(".")) continue;
    const wholeType = match[1] !== undefined;
    const perSource = named.get(source) ?? new Map<string, boolean>();
    for (const raw of match.groups!["names"]!.split(",")) {
      const name = raw.trim();
      if (name === "") continue;
      const typeOnly = wholeType || name.startsWith("type ");
      const cleaned = name.replace(/^type /, "");
      // A value import outranks a type-only one for the same name.
      perSource.set(cleaned, (perSource.get(cleaned) ?? true) && typeOnly);
    }
    named.set(source, perSource);
  }
  const merged = [...named.entries()].map(([source, names]) => {
    const specifiers = [...names.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, typeOnly]) => (typeOnly ? `type ${name}` : name));
    return `import { ${specifiers.join(", ")} } from "${source}";`;
  });
  return [...merged, ...passthrough].sort();
};

/**
 * A quoted declaration, checked against the real export instead of skipped.
 *
 * A reference page quotes a package's signature as a `const NAME: T;` or a
 * `type NAME = T;` — neither of which is a runnable program, which is why 49 of
 * them carried a `skip` reason saying so. Nothing diffed them against `src/`,
 * and the repository's canonical drift incident (a `Logger` whose documented
 * parameter order was not the shipped one) went out through exactly this
 * channel.
 *
 * `<!-- doctest: signature=@btravstack/core -->` turns one into a gate: the
 * quoted type becomes an alias, and two assignments check it against the real
 * export in both directions, so a drift in either is a compile error naming the
 * page. The real symbol is reached by an inline `import(…)` type query rather
 * than an import statement, so nothing collides with the page's own bindings.
 *
 * Two shapes are checkable — a value declaration and a type alias with no
 * parameters. A GENERIC alias would need type arguments this script cannot
 * invent, and a bare `name(args): T` line is not a declaration at all; both are
 * carried through unchecked and **named in the generate report**, so a fence
 * that looks gated and is only half gated says so out loud. A fence with
 * nothing checkable at all fails the task: that one wants a `skip` reason.
 */
const signatureChecks = (
  fence: Fence,
  module: string,
): { readonly code: string; readonly unchecked: readonly string[] } => {
  // Split on a `;` at DEPTH ZERO only: an object type's every property line
  // ends in one, and splitting on those would cut a declaration into pieces
  // that each look like something this function cannot check.
  const declarations: string[] = [];
  {
    // Comments go first, trailing ones included — a `// name defaults to "x"`
    // after a declaration would otherwise read as a declaration of its own.
    // The preceding character class is `[ \t]`, never `\s`: eating the newline
    // would join two lines, and a `;` at the end of the first would land inside
    // whatever the second says. Requiring space-or-start before `//` is what
    // keeps a `https://` inside a string literal intact — there the `//`
    // follows a colon.
    const source = fence.body.replace(/(^|[ \t])\/\/[^\n]*/g, "$1");
    let depth = 0;
    let quote = "";
    let current = "";
    for (const character of source) {
      // A `;` inside a string or template literal is data — `type S = "a;b";`
      // would otherwise split into two fragments, neither a declaration.
      if (quote !== "") {
        current += character;
        if (character === quote) quote = "";
        continue;
      }
      if (character === '"' || character === "'" || character === "`") quote = character;
      if ("({[".includes(character)) depth += 1;
      if (")}]".includes(character)) depth -= 1;
      if (character === ";" && depth === 0) {
        declarations.push(current.trim());
        current = "";
        continue;
      }
      current += character;
    }
    if (current.trim() !== "") declarations.push(current.trim());
  }
  const checks: string[] = [];
  const unchecked: string[] = [];
  for (const declaration of declarations) {
    const value = /^(?:export\s+)?(?:declare\s+)?const\s+(?<name>\w+)\s*:\s*(?<type>[\s\S]+)$/.exec(
      declaration,
    );
    const alias = /^(?:export\s+)?type\s+(?<name>\w+)\s*=\s*(?<type>[\s\S]+)$/.exec(declaration);
    const match = value ?? alias;
    if (!match?.groups) {
      unchecked.push(declaration.split("\n")[0]!.slice(0, 60));
      continue;
    }
    const { name, type } = match.groups as { name: string; type: string };
    const real = value ? `typeof import("${module}").${name}` : `import("${module}").${name}`;
    const quoted = `__quoted_${name}_${fence.line}`;
    checks.push(
      `type ${quoted} = ${type};`,
      `const __sig_${name}_${fence.line}_a: ${real} = null as unknown as ${quoted};`,
      `const __sig_${name}_${fence.line}_b: ${quoted} = null as unknown as ${real};`,
      `void __sig_${name}_${fence.line}_a;`,
      `void __sig_${name}_${fence.line}_b;`,
    );
  }
  if (checks.length === 0) {
    // oxlint-disable-next-line unthrown/no-throw -- a generator's misconfiguration must fail the generate task loudly
    throw new Error(
      `${fence.file}:${fence.line}: a signature fence declares nothing checkable — mark it \`<!-- doctest: skip — <reason> -->\``,
    );
  }
  return { code: checks.join("\n"), unchecked };
};

/** What a signature fence carried through unchecked, for the generate report. */
const uncheckedSignatures: string[] = [];

const emit = (page: Page, outDir: string): number => {
  const slug = relative(REPO_ROOT, page.file).replaceAll("/", "__").replace(/\.md$/, "");
  const banner = (fence: Fence) => `// — ${relative(REPO_ROOT, fence.file)}:${fence.line}`;
  const render = (fences: readonly Fence[], suffix: string, ownPrelude = ""): void => {
    const imports = new Set<string>();
    const bodies: string[] = [];
    // An isolate with a private prelude is fully self-contained: the page
    // prelude is NOT included, so a page-level name the isolated fence
    // redeclares cannot collide. A bare isolate inherits the page prelude.
    for (const prelude of ownPrelude === "" ? [page.prelude] : [ownPrelude]) {
      if (prelude === "") continue;
      const split = splitImports(prelude);
      for (const statement of split.imports) imports.add(statement.trim());
      if (split.rest !== "") bodies.push(`// — prelude\n${split.rest}`);
    }
    for (const fence of fences) {
      if (typeof fence.marker === "object" && "signature" in fence.marker) {
        const checked = signatureChecks(fence, fence.marker.signature);
        for (const declaration of checked.unchecked) {
          uncheckedSignatures.push(
            `${relative(REPO_ROOT, fence.file)}:${fence.line} — ${declaration}`,
          );
        }
        bodies.push(`${banner(fence)}\n${checked.code}`);
        continue;
      }
      const split = splitImports(fence.body);
      // A FENCE's relative imports — `./x.js` and `../x.js` alike — are
      // dropped: they narrate the page's own file layout, and the
      // concatenated module supplies those names directly. Only a PRELUDE may
      // import by relative path, which is the real-artifact trick (the
      // generated module lives inside the workspace's `src/`, so
      // `../../auth.js` reaches the application's own file).
      for (const statement of split.imports) {
        // Matched on the specifier, not on `from`, so a side-effect import
        // (`import "./setup.js";`) is dropped with the rest.
        if (/["']\.\.?\//.test(statement)) continue;
        imports.add(statement.trim());
      }
      if (split.rest !== "") bodies.push(`${banner(fence)}\n${split.rest}`);
    }
    const header =
      `// GENERATED by docs/scripts/extract-doc-samples.ts from ${relative(REPO_ROOT, page.file)} — do not edit.\n` +
      `// A failure here means the page's sample no longer compiles: fix the PAGE.\n`;
    // `export {}` keeps an import-free page a module, so top-level await parses.
    const importStatements = mergeImports(imports);
    const module = [
      header,
      ...importStatements,
      importStatements.length === 0 ? "export {}" : "",
      ...bodies,
    ]
      .filter((part) => part !== "")
      .join("\n\n");
    writeFileSync(join(outDir, `${slug}${suffix}.test-d.ts`), `${module}\n`);
  };
  const together = [
    ...page.fences.filter((fence) => fence.marker === "include"),
    ...page.fences.filter((fence) => fence.marker === "defer"),
    // Last: a signature check declares only aliases and two `const`s of its
    // own, so it can never be what another fence reads.
    ...page.fences.filter(
      (fence) => typeof fence.marker === "object" && "signature" in fence.marker,
    ),
  ];
  const isolated = page.fences.filter(
    (fence): fence is Fence & { marker: { isolate: string } } =>
      typeof fence.marker === "object" && "isolate" in fence.marker,
  );
  if (together.length > 0) render(together, "");
  isolated.forEach((fence, index) =>
    render([fence], `.isolated-${index + 1}`, fence.marker.isolate),
  );
  return together.length + isolated.length;
};

/**
 * Every relative link in a page, with the line it sits on.
 *
 * Fenced blocks are stripped first: a `](../x)` inside a sample is code, not
 * a link, and resolving it would fail for a path that was never meant to
 * exist. Root-relative links (`/reference/…`) are deliberately NOT collected
 * — VitePress fails its own build on those, and checking them here would be a
 * second opinion that can disagree with the one that ships. That deferral only
 * holds while VitePress genuinely checks them — see its `ignoreDeadLinks`.
 */
const relativeLinks = (
  body: string,
): readonly { readonly target: string; readonly line: number }[] => {
  const withoutFences = body.replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, " "));
  const links: { target: string; line: number }[] = [];
  const pattern = /]\(\s*<?([^)>\s]+)>?(?:\s+"[^"]*")?\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(withoutFences)) !== null) {
    const target = match[1] ?? "";
    if (!target.startsWith(".")) continue;
    links.push({ target, line: withoutFences.slice(0, match.index).split("\n").length });
  }
  return links;
};

/**
 * A relative link that resolves to nothing fails the generate task.
 *
 * This exists because a package rename broke `packages/core/README.md`'s
 * `](../http)` and **nothing noticed**: VitePress checks the site's own
 * routes, but a package README is not part of the site, and this script read
 * every README already without ever looking at a link. The four shapes a
 * rename has to sweep — the specifier, the workspace path, and the two
 * documentation routes — do not include a relative sibling link, so the one
 * form no gate covered was also the one form a regex was most likely to miss.
 */
const checkLinks = (file: string, body: string): readonly string[] =>
  relativeLinks(body)
    .filter(({ target }) => {
      const [path] = target.split(/[#?]/);
      // A bare anchor names this page and resolves to it.
      if (path === undefined || path === "") return false;
      return !existsSync(resolve(dirname(file), path));
    })
    .map(({ target, line }) => `${relative(REPO_ROOT, file)}:${line} → ${target}`);

const main = (): void => {
  const group = process.argv[process.argv.indexOf("--group") + 1] as Group | undefined;
  const out = process.argv[process.argv.indexOf("--out") + 1];
  if (!group || !GROUPS.includes(group) || !out) {
    // oxlint-disable-next-line unthrown/no-throw -- a CLI usage error must fail the generate task loudly
    throw new Error("usage: extract-doc-samples.ts --group <name> --out <dir>");
  }
  const sources = [
    ...globSync(join(DOCS_ROOT, "{tutorial,how-to,reference,explanation,examples}/**/*.md")),
    join(DOCS_ROOT, "index.md"),
    join(REPO_ROOT, "README.md"),
    ...globSync(join(REPO_ROOT, "packages/*/README.md")),
  ];
  const outDir = resolve(out);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  let fences = 0;
  let pages = 0;
  let links = 0;
  const skips: string[] = [];
  const broken: string[] = [];
  for (const file of sources.sort()) {
    // Links are checked on EVERY page, not only this group's: a page belongs
    // to one group's TypeScript, and to nobody's links.
    const body = readFileSync(file, "utf8");
    links += relativeLinks(body).length;
    broken.push(...checkLinks(file, body));
    const page = parsePage(file);
    if (!page || page.group !== group) continue;
    pages += 1;
    fences += emit(page, outDir);
    for (const skip of page.skips) {
      skips.push(`${relative(REPO_ROOT, page.file)}:${skip.line} — ${skip.reason}`);
    }
  }
  if (broken.length > 0) {
    // oxlint-disable-next-line unthrown/no-throw -- a generate task reports failure by throwing; there is no Result channel in a CLI script
    throw new Error(
      `doc-samples: ${broken.length} relative link(s) resolve to nothing:\n  ${broken.join("\n  ")}`,
    );
  }
  const report = [
    `doc-samples[${group}]: ${fences} fences from ${pages} pages → ${relative(process.cwd(), outDir)}, ${links} relative links resolved`,
  ];
  // Opt-outs are part of the output on purpose: silent truncation reads as
  // "covered everything" when it was not.
  for (const skip of skips) report.push(`  skipped: ${skip}`);
  for (const unchecked of uncheckedSignatures) {
    report.push(`  unchecked declaration in a signature fence: ${unchecked}`);
  }
  process.stdout.write(`${report.join("\n")}\n`);
};

main();
