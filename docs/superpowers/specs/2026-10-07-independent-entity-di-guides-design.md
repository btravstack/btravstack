# Independent entity and DI guides in the btravstack docs deployment

## Intent

A visitor arriving at the [framework homepage](https://btravstack.github.io/btravstack/) or its getting-started tutorial should be able to find the standalone `@btravstack/entity` and `@btravstack/di` guides. Entity and DI are usable without the framework, so each needs a recognizable, package-specific starting point. The framework homepage should remain about building a backend process; library discovery should occupy only a compact secondary area.

This design keeps the existing VitePress deployment at `/btravstack/`. It does not add a second docs pipeline or revive the former DI repository's documentation.

## Routes and navigation

| Reader's destination     | Canonical route                                                                                       | Entry points                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Framework tutorial       | `/btravstack/tutorial/getting-started`                                                                | Framework hero and Guide nav                                                |
| Entity guide             | `/btravstack/entity/`                                                                                 | Framework homepage, framework tutorial, Packages nav, stack hub entity card |
| Entity tutorial          | `/btravstack/entity/tutorial/getting-started`                                                         | Entity hero and entity sidebar                                              |
| DI guide                 | `/btravstack/di/`                                                                                     | Framework homepage, framework tutorial, Packages nav, stack hub DI card     |
| DI tutorial              | `/btravstack/di/tutorial/getting-started`                                                             | DI hero and DI sidebar                                                      |
| DI reference and example | Existing `/btravstack/reference/di/*`, `/btravstack/api/di/`, and `/btravstack/examples/di-hexagonal` | DI landing and sidebar                                                      |

Add a short “Use the libraries independently” section near the framework homepage's existing “Where to start” links, with one sentence and one link each for entity and DI. Add the same two entry links in a short note near the start of the framework tutorial, before its install step, so a reader choosing a package alone does not have to install the whole HTTP stack. The framework's hero actions, feature cards, and main guide sidebar stay focused on the framework. The existing Packages dropdown gains a DI guide link beside the entity guide link.

Entity keeps its existing scoped landing page, tutorial, sidebar, branding, and social preview. DI gets a parallel scoped landing page and a DI-only getting-started tutorial. The `/di/` home layout links to the tutorial, reference, API and example through its hero actions and body; VitePress does not render a sidebar on home layouts. The tutorial and reference pages share a DI sidebar linking to those destinations rather than duplicating their content. Map `/reference/di/` to the DI sidebar as well, so following a reference link does not drop a DI-only reader into the framework guide sidebar. Shared `/reference/di/` and `/api/di/` URLs remain stable.

The stack hub at `https://btravstack.github.io/` updates the entity and DI cards to point their Docs buttons at the canonical scoped guides and their GitHub buttons and star lookups at `btravstack/btravstack`. The hub totals GitHub stars by unique repository, so showing two package cards from the same monorepo does not double-count its stars. Its Docs menu includes both guides. A lightweight `/di/` compatibility route on that already-deployed hub forwards readers of the former DI docs URL to `/btravstack/di/`; the existing entity redirect remains in its former deployment. The compatibility route is not a second DI documentation site.

## DI content and identity

The DI landing page explains the package on its own terms: ports define application capabilities, providers construct them, modules control visibility, and `Module.scoped` builds and closes a graph without `@btravstack/core`. Its install command is `pnpm add @btravstack/di unthrown`. Its primary action opens the DI-only tutorial. Secondary links lead to the DI reference, API reference, and the in-repository hexagonal example.

The DI tutorial starts in an empty TypeScript project and demonstrates one small port, one provider, one module, `Module.scoped`, and result handling. It imports only published packages a reader can install. It uses the current keyed `inject` API and current module entry points, not examples copied from the retired DI site. It then points to the existing reference for provider variants, scopes, and compile-time wiring diagnostics. The sample must be compiled by the docs sample gate; if its group cannot resolve a dependency, add only the necessary docs-sample workspace dependency.

Reuse the DI light and dark beetroot logos already present on the stack hub (identical to the former DI site assets), under `docs/public/di/`. Keep the page's visual treatment within the existing VitePress theme, using the logo and a DI-specific social card rather than a second theme or new UI subsystem. The old DI social card is available as a source asset; verify its wording and dimensions before reuse. Metadata for `/di/`, `/reference/di/`, and `/api/di/` pages selects that DI preview, as the entity routes already select the entity preview. Update the DI package README's Documentation and Getting started links to the new DI routes.

## Deployment and verification

The main docs build still deploys only from `btravstack/btravstack` to `/btravstack/`. The stack hub remains its existing deployment and receives only link and compatibility-route updates. Land the docs change before or together with the hub link change, so the hub never points to an unpublished DI route.

Check that all new pages have title, description, and tutorial framing consistent with the docs guide; root-relative links resolve under the VitePress base. Run the repository's format, lint, typecheck, knip, test, and build gates, including the docs sample and link checks. Build the stack hub and inspect both light and dark DI logos, both package cards, and the legacy `/di/` forward. Verify the built docs contain the entity and DI entry routes and their per-page Open Graph metadata. After deployment, directly open the canonical home, tutorial, DI, and entity URLs and follow each cross-link.

This change adds no package API, new docs deployment, or duplicated DI reference tree.
