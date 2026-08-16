import { defineConfig } from "vitepress";

const SITE_DESCRIPTION =
  "The application kernel for TypeScript: boot a dependency-injection module into a running process — HTTP, Temporal or AMQP — with a drain that survives Kubernetes, and stop it again without losing work.";

const BASE = "/start/";
const SITE_URL = `https://btravstack.github.io${BASE}`;

// The guide is structured by the four Diátaxis modes (https://diataxis.fr/): a
// learning-oriented Tutorial, task-oriented How-to guides, information-oriented
// Reference, and understanding-oriented Explanation. One shared sidebar carries
// all four so any page can reach any other.
const GUIDE_SIDEBAR = [
  {
    text: "Tutorial",
    items: [
      { text: "Getting started", link: "/tutorial/getting-started" },
      { text: "The same application, a second runtime", link: "/tutorial/second-runtime" },
    ],
  },
  {
    text: "How-to guides",
    items: [
      { text: "Configure from the environment", link: "/how-to/configure-from-the-environment" },
      { text: "Serve an oRPC contract over HTTP", link: "/how-to/serve-orpc-over-http" },
      { text: "Run a Temporal worker", link: "/how-to/run-a-temporal-worker" },
      { text: "Consume AMQP messages", link: "/how-to/consume-amqp-messages" },
      { text: "Open a per-request scope", link: "/how-to/open-a-per-request-scope" },
      { text: "Manage a resource's lifetime", link: "/how-to/manage-a-resource" },
      { text: "Swap an adapter for tests", link: "/how-to/swap-an-adapter" },
      { text: "Test an application", link: "/how-to/test-an-application" },
      { text: "Tune the drain for Kubernetes", link: "/how-to/tune-the-drain-for-kubernetes" },
      { text: "Embed without runMain", link: "/how-to/embed-without-run-main" },
      { text: "Write a runtime", link: "/how-to/write-a-runtime" },
      { text: "Read the ambient unit from an adapter", link: "/how-to/read-the-ambient-unit" },
      { text: "Keep a port private", link: "/how-to/keep-a-port-private" },
      { text: "Build a plugin registry", link: "/how-to/build-a-plugin-registry" },
    ],
  },
  {
    text: "Reference",
    items: [
      { text: "Packages and install", link: "/reference/packages" },
      {
        text: "@btravstack/di",
        collapsed: false,
        items: [
          { text: "Ports", link: "/reference/di/ports" },
          { text: "Providers", link: "/reference/di/providers" },
          { text: "Modules", link: "/reference/di/modules" },
          { text: "Entry points", link: "/reference/di/entry-points" },
          { text: "Wiring defects", link: "/reference/di/wiring-defects" },
        ],
      },
      { text: "@btravstack/config", link: "/reference/config" },
      {
        text: "@btravstack/core",
        collapsed: false,
        items: [
          { text: "start and StartOptions", link: "/reference/core/start" },
          { text: "RunningApp", link: "/reference/core/running-app" },
          { text: "The Runtime contract", link: "/reference/core/runtime" },
          { text: "ExitReport and DrainReport", link: "/reference/core/exit-report" },
          { text: "Kernel events", link: "/reference/core/events" },
          { text: "runMain and exit codes", link: "/reference/core/exit-codes" },
          { text: "Probes", link: "/reference/core/probes" },
          { text: "Testing entry point", link: "/reference/core/testing" },
        ],
      },
      { text: "@btravstack/http", link: "/reference/http" },
      { text: "@btravstack/temporal", link: "/reference/temporal" },
      { text: "@btravstack/amqp", link: "/reference/amqp" },
      { text: "Glossary", link: "/reference/glossary" },
      { text: "API reference", link: "/api/" },
    ],
  },
  {
    text: "Explanation",
    items: [
      { text: "Why start?", link: "/explanation/why-start" },
      { text: "One process, one runtime", link: "/explanation/one-process-one-runtime" },
      { text: "Compile errors, not surprises", link: "/explanation/compile-time-wiring" },
      { text: "Modules and privacy", link: "/explanation/modules-and-privacy" },
      { text: "Scopes and resource safety", link: "/explanation/scopes-and-resources" },
      { text: "Ambient data, injected capabilities", link: "/explanation/ambient-vs-context" },
      { text: "Draining, in three beats", link: "/explanation/draining-in-three-beats" },
      { text: "The kernel maps nothing", link: "/explanation/the-kernel-maps-nothing" },
      { text: "Nothing throws", link: "/explanation/nothing-throws" },
      { text: "Starters", link: "/explanation/starters" },
      { text: "Peer dependencies", link: "/explanation/peer-dependencies" },
      { text: "Design decisions", link: "/explanation/design-decisions" },
    ],
  },
];

const EXAMPLES_SIDEBAR = [
  {
    text: "Examples",
    items: [
      { text: "Overview", link: "/examples/" },
      { text: "The order application", link: "/examples/order-application" },
      { text: "Order API (HTTP)", link: "/examples/order-api" },
      { text: "Order Temporal worker", link: "/examples/order-temporal-worker" },
      { text: "Order AMQP worker", link: "/examples/order-amqp-worker" },
      { text: "Hexagonal order API (di alone)", link: "/examples/hexagonal-order-api" },
    ],
  },
];

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: "start",
  description: SITE_DESCRIPTION,
  base: BASE,
  lang: "en-US",
  cleanUrls: true,

  // The API reference under /api/ is generated by TypeDoc and copied in at build
  // time; its cross-references use relative links TypeDoc resolves itself.
  ignoreDeadLinks: [/^\/api\//, /^\.\/index$/, /^\.\/[a-z-]+$/, /^\.\.\//],

  sitemap: {
    hostname: SITE_URL,
  },

  // Per-page canonical URL + Open Graph / Twitter title & description, so every
  // page shares a correct preview and avoids duplicate-content ambiguity.
  transformPageData(pageData) {
    if (!pageData.relativePath.endsWith(".md")) {
      return;
    }

    const normalizedPath = pageData.relativePath.replace(/^\/+/, "");
    // cleanUrls is true, so the public URL has no `.html` extension: strip
    // `index.md` to the directory and any other `.md` to the bare route.
    const canonicalUrl = `${SITE_URL}${normalizedPath}`
      .replace(/index\.md$/, "")
      .replace(/\.md$/, "");

    pageData.frontmatter ??= {};
    pageData.frontmatter.head ??= [];

    // The /api/ pages (except the hand-written overview) are TypeDoc output copied
    // in at build time — they have no source file in the repo, so "Edit this page"
    // would 404. docs/api/index.md is the one committed file there.
    if (pageData.relativePath.startsWith("api/") && pageData.relativePath !== "api/index.md") {
      pageData.frontmatter.editLink = false;
    }

    pageData.frontmatter.head.push(["link", { rel: "canonical", href: canonicalUrl }]);

    const pageTitle = pageData.title || pageData.frontmatter.title || "start";
    const pageDescription =
      pageData.description || pageData.frontmatter.description || SITE_DESCRIPTION;

    pageData.frontmatter.head.push(
      ["meta", { property: "og:url", content: canonicalUrl }],
      ["meta", { property: "og:title", content: pageTitle }],
      ["meta", { property: "og:description", content: pageDescription }],
      ["meta", { name: "twitter:title", content: pageTitle }],
      ["meta", { name: "twitter:description", content: pageDescription }],
    );
  },

  themeConfig: {
    nav: [
      // The guide is organised by the four Diátaxis modes; the dropdown links
      // the entry page of each. See the sidebar for the full contents.
      {
        text: "Guide",
        items: [
          { text: "Tutorial", link: "/tutorial/getting-started" },
          { text: "How-to guides", link: "/how-to/configure-from-the-environment" },
          { text: "Reference", link: "/reference/packages" },
          { text: "Explanation", link: "/explanation/why-start" },
        ],
      },
      { text: "API", link: "/api/" },
      { text: "Examples", link: "/examples/" },
      {
        text: "Changelog",
        link: "https://github.com/btravstack/start/releases",
      },
      // Back to the btravstack hub (links the docs up to the landing page).
      { text: "btravstack", link: "https://btravstack.github.io/" },
    ],

    sidebar: {
      // One shared sidebar across all four Diátaxis sections, so a reader can
      // move between Tutorial / How-to / Reference / Explanation from any page.
      ...Object.fromEntries(
        ["/tutorial/", "/how-to/", "/reference/", "/explanation/"].map((prefix) => [
          prefix,
          GUIDE_SIDEBAR,
        ]),
      ),
      "/api/": [
        {
          text: "API Reference",
          items: [
            { text: "Overview", link: "/api/" },
            { text: "@btravstack/di", link: "/api/di/" },
            { text: "@btravstack/config", link: "/api/config/" },
            { text: "@btravstack/core", link: "/api/core/" },
            { text: "@btravstack/http", link: "/api/http/" },
            { text: "@btravstack/temporal", link: "/api/temporal/" },
            { text: "@btravstack/amqp", link: "/api/amqp/" },
          ],
        },
      ],
      "/examples/": EXAMPLES_SIDEBAR,
    },

    socialLinks: [
      { icon: "github", link: "https://github.com/btravstack/start" },
      { icon: "npm", link: "https://www.npmjs.com/package/@btravstack/core" },
    ],

    footer: {
      message: "Released under the MIT License.",
      copyright: `Copyright © ${new Date().getFullYear()} Benoit TRAVERS`,
    },

    search: {
      provider: "local",
    },

    // The generated API pages are long scrolls; surfacing h3s in the right-rail
    // outline is what makes them navigable.
    outline: { level: [2, 3] },

    editLink: {
      pattern: "https://github.com/btravstack/start/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },
  },

  vite: {
    // @btravstack/theme's entry imports `vitepress/theme` (which pulls in `.css`)
    // and its own `style.css`. VitePress externalizes node_modules deps in the SSR
    // build, so Node's ESM loader would hit those `.css` files and throw
    // ERR_UNKNOWN_FILE_EXTENSION. Bundling the theme through Vite handles the CSS.
    ssr: { noExternal: ["@btravstack/theme"] },
  },

  head: [
    ["meta", { name: "author", content: "Benoit TRAVERS" }],
    ["meta", { name: "robots", content: "index, follow" }],
    ["meta", { name: "application-name", content: "start" }],
    [
      "meta",
      {
        name: "keywords",
        content:
          "typescript, application kernel, dependency injection, graceful shutdown, drain, kubernetes, readiness, liveness, orpc, temporal, amqp, rabbitmq, unthrown, result, spring boot starters",
      },
    ],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "start" }],
    ["meta", { property: "og:locale", content: "en_US" }],
    ["meta", { name: "twitter:card", content: "summary" }],
  ],
});
