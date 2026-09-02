// Every `#fragment` link on the built site, resolved against the ids that
// actually exist in the page it points at.
//
// VitePress fails a build on a link to a page that does not exist and says
// nothing about the half after the `#`, so a dead anchor ships. One did:
// `explanation/compile-time-wiring.md` linked `#the-kernels-own-gate` twice
// where the renderer emits `the-kernel-s-own-gate` (an apostrophe becomes a
// hyphen rather than being dropped), on a page whose subject is compile-time
// gates.
//
// It checks the RENDERED output rather than the markdown, which is the whole
// point: a source-level checker has to reimplement VitePress's slugify, and a
// copy of a slugify can disagree with the renderer that ships. markdownlint's
// MD051 is that copy — measured against this site, it misses the real dead
// anchor (correct under GitHub's rules) and flags three working ones.
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = fileURLToPath(new URL("../.vitepress/dist", import.meta.url));

/** Every `id="…"` the page carries — what a fragment may name. */
const idsOf = (html: string): ReadonlySet<string> =>
  new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]!));

/** Every `href` carrying a fragment, with the page it sits on. */
const fragmentsOf = (html: string): readonly { readonly href: string }[] =>
  [...html.matchAll(/\shref="([^"]*#[^"]*)"/g)].map((match) => ({ href: match[1]! }));

const pages = globSync(join(DIST, "**/*.html"));
const idsByFile = new Map<string, ReadonlySet<string>>();
const read = (file: string): ReadonlySet<string> => {
  const cached = idsByFile.get(file);
  if (cached !== undefined) return cached;
  const ids = idsOf(readFileSync(file, "utf8"));
  idsByFile.set(file, ids);
  return ids;
};

const dead: string[] = [];
let checked = 0;
let skipped = 0;

for (const page of pages) {
  const html = readFileSync(page, "utf8");
  idsByFile.set(page, idsOf(html));
  for (const { href } of fragmentsOf(html)) {
    // An external link's fragment belongs to somebody else's page.
    if (/^[a-z]+:/i.test(href)) continue;
    const [path, fragment] = href.split("#");
    if (fragment === undefined || fragment === "") continue;
    // TypeDoc's cross-references are its own output, exempted from the site's
    // dead-link policy on the same reasoning `ignoreDeadLinks` carves them out
    // with — reported rather than silent, so the exemption stays visible.
    const target =
      path === undefined || path === ""
        ? page
        : resolve(dirname(page), path.endsWith("/") ? `${path}index.html` : path);
    const targetFile = target.endsWith(".html") ? target : `${target}.html`;
    if (relative(DIST, targetFile).startsWith("api/")) {
      skipped += 1;
      continue;
    }
    checked += 1;
    // A page VitePress already refused to build cannot be read here; a missing
    // file is its own failure, and reporting it as a dead anchor would be a
    // second, worse opinion about the same defect.
    let ids: ReadonlySet<string>;
    try {
      ids = read(targetFile);
    } catch {
      continue;
    }
    if (!ids.has(decodeURIComponent(fragment))) {
      dead.push(`${relative(DIST, page)} → ${href}`);
    }
  }
}

if (dead.length > 0) {
  process.stderr.write(
    `[docs] ${dead.length} dead fragment link(s) — the page exists, the anchor does not:\n` +
      dead.map((line) => `  ${line}\n`).join("") +
      `Anchors are the RENDERED ids: an apostrophe becomes a hyphen, so ` +
      `"The kernel's own gate" is #the-kernel-s-own-gate.\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `[docs] ${checked} fragment links resolved, ${skipped} skipped under /api/ (TypeDoc's own output)\n`,
);
