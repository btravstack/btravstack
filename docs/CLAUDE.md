# docs/

`@btravstack/docs` — the VitePress documentation site. The rule that a
public-surface change must update this site in the same commit lives in the
root `CLAUDE.md`; what follows is how the site itself is built.

`@btravstack/di`'s former standalone site was folded in here when the
container was merged; nothing under `docs/reference/di/` should be edited in
the old repository.

- **TypeDoc runs from `docs/`, not from the packages**, one
  `typedoc.<name>.json` per package; its own TypeScript pin, and why, is the
  `typedoc` catalog entry's comment.
  The package list is repeated in four places that must stay in sync: the
  configs, `build-api.ts`, `@btravstack/docs#build`'s `dependsOn` in
  `turbo.json` (explicit `<pkg>#build` edges — the site does not _depend_ on
  the packages, but a cross-package import inside a documented source must
  resolve), and the `/api/` sidebar in `.vitepress/config.ts`. Each config's
  `intentionallyNotExported` lists the internal helper types TypeDoc would
  otherwise warn about; a new unexported-but-referenced type goes there.
- **Deployed by `.github/workflows/deploy-docs.yml`**, unversioned: `main`
  deploys alone to the root. `unthrown`'s stable/beta split (`DOCS_BASE`,
  `DOCS_VERSIONS`) is the shape to adopt once a stable tag exists.
- **Every `ts` fence on the site, in the root README and in the package
  READMEs is compiled by `pnpm typecheck`, continuously.**
  The markers, the groups and how a page becomes one module are
  `docs/scripts/extract-doc-samples.ts`'s header.
  A page whose fences import a package its group's workspace does not have
  needs that package as a **devDependency there**, ignored for it in
  `knip.json` — `examples/order-api` carries `@btravstack/prisma` and
  `@prisma/adapter-pg` for `how-to/talk-to-the-database.md` on exactly those
  terms, the way `examples/order-temporal-worker` already carried `zod`. The
  one sample that cannot compile anywhere is `pinoSink`'s — no example
  workspace installs `pino` — held by `packages/observability/src/pino.spec.ts`
  and skipped with that reason.

  **A prelude may import the real artifact a page describes; it may NOT import
  a private workspace** (issue #193). The generated module lives inside an
  example workspace, so `@btravstack/example-order-*` resolves there and the
  gate stays green — while a reader on npm cannot install any of it, which
  makes a "minimal example" unfollowable on the one surface read outside this
  repository. So a package README's prelude declares the application's own
  half inline (a `TaggedError`, a `Port`, a `declare const` module) and imports
  only published packages. That is why `examples/order-amqp-worker` carries
  `@amqp-contract/contract` and `zod` as devDependencies it never imports
  itself, both ignored for it in `knip.json`: the amqp README's own contract is
  built there, from the packages a reader would install, exactly as the
  temporal README's already was.

  **A ` ```tsx ` fence must carry a skip reason.** JSX compiles in no workspace
  here — none installs React — so the extractor admits the fence only to refuse
  it unless a `skip` says why. Letting the fence LANGUAGE decide what is gated
  is the silent channel a stated reason exists to close, and `tsx` was the one
  spelling that would have opened it by accident. Regression-proved: removing
  the marker above the React component on
  `docs/how-to/consume-the-contract-from-react.md` fails `generate` with
  `a \`\`\`tsx fence compiles nowhere`.

  The kernel-only README samples are
  additionally held by `packages/core/src/docs-examples.test-d.ts`, and
  `examples/order-api/src/docs-examples.test-d.ts` still pins the
  application-reality coupling the extraction cannot (its samples call the
  real use cases through the real `auth.ts` by hand).

- **A signature display is a gate, not a skip** (issue #195).
  `<!-- doctest: signature=<module> -->` above a fence turns each quoted
  declaration into a check: the quoted type becomes an alias, and two
  assignments compare it against the real export in **both** directions, so a
  drift in either is a compile error naming the page. The real symbol is reached
  by an inline `import("<module>")` type query, so nothing collides with the
  page's own bindings, and the module is on the marker because a page quotes
  several (`Level` is the kernel's, `Line` is observability's).

  **Two shapes are checkable**: `const NAME: T;` and a type alias with **no
  parameters**. A generic alias would need type arguments the script cannot
  invent, and a bare `name(args): T` line is not a declaration at all; both are
  carried through unchecked and **named in the generate report**, so a fence
  that looks gated and is only half gated says so out loud. A fence with
  nothing checkable fails the task — that one wants a `skip`.

  **What stays skipped is what has no exported symbol to check against**, and
  each says which: `api.OrpcController` (minted by `defineHttp`, and its type
  names internal `FragmentAt` / `Schemes`), `http()` (its needs channel names
  the unexported `OrpcRouterPort`), `amqp()` (`AnyAmqpContract`), `tapped`
  (`TapGate`) and `overridden` (di's `AnyProviderFor`). A skip reason that
  says "a signature display" and nothing more is now the wrong reason: it means
  either the marker or an export is missing.

  One limit worth knowing: TypeScript's assignability ignores parameter
  **optionality**, so turning `(start?: number)` into `(start: number)` in a
  display does not fail. A parameter's TYPE, a return type, a field, a union
  member — all do (verified by breaking each shape and watching the gate fire).

- **Two link gates, and each one's soundness is the other's behaviour.**
  `extract-doc-samples.ts` checks RELATIVE links and deliberately skips
  root-relative ones, on the grounds that VitePress fails its own build on
  those.

  The rule that generalises: **an exemption justified by another gate's
  behaviour is only as true as that behaviour**, and nothing re-checks it. The
  `doctest: skip` paragraph below is the same shape. If a third gate is ever
  given a reason of this kind, verify the claim rather than the reason.

  **The API hub is generated for the same reason** — `docs/scripts/build-api.ts`
  emits `api/index.md` from the `typedoc.*.json` files on disk, each entry
  carrying the package's own `description` and the subpaths its `exports` map
  declares. The ordered list in the script stays written down — dependency
  order is information a glob cannot recover — but it is now checked against
  those files rather than asked to stay in sync.

- **The same script resolves every RELATIVE link in those files, and a link
  that resolves to nothing fails the generate task.** It reports the count it
  checked, so a silent no-op is visible.

  Regression-proved: restoring the `](../http)` link a package rename broke in
  `packages/core/README.md` fails `generate` with
  `packages/core/README.md:27 → ../http`.

- **`scripts/check-install-pins.ts` refuses an install snippet that names a
  package whose `latest` dist-tag is an older major.** An unversioned `pnpm add`
  of such a package resolves the wrong one, and a new user's first run dies in
  type errors.

  **It checks the MAJOR, not merely that a version is present.**
  `@orpc/server@^1.0.0` carries an `@` and is the exact bug the guard exists to
  catch, so the range's first digit run is compared against the catalog's — a
  guard that only asked "is it pinned" would have passed the wrong pin.

  The doc-samples gate cannot catch this class — it compiles against the
  pinned catalog, where the resolution already went right. Regression-proved:
  dropping the range from the root README's line fails the docs build with
  `README.md:116  @orpc/server`.

- Pages carry frontmatter `title` and `description`, open with the quadrant
  blockquote (`> **How-to.** …`), and link root-relative (`/reference/core/start`).
  The house style is `unthrown`'s; read a page there before writing one here.
- The site's build is on the gate — `@btravstack/docs#build` is one of the
  tasks `pnpm build` runs; `dev` is not. A dead `#fragment` is
  `check-anchors.ts`'s, which reads the **rendered** `dist` — its header says
  why, and why markdownlint's `MD051` is off in `.markdownlint-cli2.jsonc`.
  `/api/` is skipped, since TypeDoc's cross-references are its own output —
  the same carve-out `ignoreDeadLinks` makes, and the skipped count is printed
  so the exemption stays visible rather than reading as coverage.
