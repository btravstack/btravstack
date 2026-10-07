import { defineConfig } from "vitepress";

const SITE_DESCRIPTION =
  "btravstack is the TypeScript backend framework whose dependency injection is checked by the compiler: modules and DI without decorators or reflect-metadata, errors as values, and a drain that survives Kubernetes.";

const BASE = "/btravstack/";
const SITE_URL = `https://btravstack.github.io${BASE}`;

// The guide is structured by the four Diátaxis modes (https://diataxis.fr/): a
// learning-oriented Tutorial, task-oriented How-to guides, information-oriented
// Reference, and understanding-oriented Explanation. One shared sidebar carries
// all four so any page can reach any other.
const GUIDE_SIDEBAR = [
  {
    text: "Tutorial",
    items: [
      { text: "1. Getting started", link: "/tutorial/getting-started" },
      { text: "2. Configure and test", link: "/tutorial/configure-and-test" },
      { text: "3. Protect the API", link: "/tutorial/protect-the-api" },
      { text: "4. Split into slices", link: "/tutorial/split-into-slices" },
      { text: "5. The same application, a second runtime", link: "/tutorial/second-runtime" },
    ],
  },
  {
    text: "How-to guides",
    items: [
      {
        text: "Foundations",
        collapsed: false,
        items: [
          {
            text: "Configure from the environment",
            link: "/how-to/configure-from-the-environment",
          },
          { text: "Log and correlate", link: "/how-to/log-and-correlate" },
          { text: "Open a per-request scope", link: "/how-to/open-a-per-request-scope" },
          { text: "Manage a resource's lifetime", link: "/how-to/manage-a-resource" },
          { text: "Talk to a database", link: "/how-to/talk-to-the-database" },
          { text: "Cache a read", link: "/how-to/cache-a-read" },
          { text: "Send an email", link: "/how-to/send-an-email" },
          { text: "Send a formatted email", link: "/how-to/send-a-formatted-email" },
          { text: "Keep a port private", link: "/how-to/keep-a-port-private" },
          { text: "Build a plugin registry", link: "/how-to/build-a-plugin-registry" },
          {
            text: "Read the ambient unit from an adapter",
            link: "/how-to/read-the-ambient-unit",
          },
          { text: "Read a wiring error", link: "/how-to/read-a-wiring-error" },
        ],
      },
      {
        text: "HTTP",
        collapsed: false,
        items: [
          { text: "Serve an oRPC contract over HTTP", link: "/how-to/serve-orpc-over-http" },
          {
            text: "Split a router into controllers",
            link: "/how-to/split-a-router-into-controllers",
          },
          { text: "Protect a procedure", link: "/how-to/protect-a-procedure" },
          { text: "Authorize a request", link: "/how-to/authorize-a-request" },
          { text: "Serve htmx fragments", link: "/how-to/serve-htmx-fragments" },
          { text: "Log a browser in", link: "/how-to/log-a-browser-in" },
          {
            text: "Stream with server-sent events",
            link: "/how-to/stream-with-server-sent-events",
          },
          {
            text: "Consume the contract from React",
            link: "/how-to/consume-the-contract-from-react",
          },
          { text: "List what a process serves", link: "/how-to/list-what-a-process-serves" },
        ],
      },
      {
        text: "Workers",
        collapsed: false,
        items: [
          { text: "Run a Temporal worker", link: "/how-to/run-a-temporal-worker" },
          {
            text: "Run something on a schedule",
            link: "/how-to/run-something-on-a-schedule",
          },
          { text: "Consume AMQP messages", link: "/how-to/consume-amqp-messages" },
          { text: "Publish a message", link: "/how-to/publish-a-message" },
          { text: "Split a worker into slices", link: "/how-to/split-a-worker-into-slices" },
          { text: "Add a slice by copying a sibling", link: "/how-to/add-a-slice" },
        ],
      },
      {
        text: "Testing",
        collapsed: false,
        items: [
          { text: "Upload a file", link: "/how-to/upload-a-file" },
          { text: "Test an application", link: "/how-to/test-an-application" },
          { text: "Swap an adapter for tests", link: "/how-to/swap-an-adapter" },
        ],
      },
      {
        text: "Operations",
        collapsed: false,
        items: [
          { text: "Tune the drain for Kubernetes", link: "/how-to/tune-the-drain-for-kubernetes" },
          { text: "Containerize and deploy", link: "/how-to/containerize-and-deploy" },
          {
            text: "Configure a Kubernetes deployment",
            link: "/how-to/configure-a-kubernetes-deployment",
          },
          { text: "Embed without runMain", link: "/how-to/embed-without-run-main" },
          {
            text: "Run several deployments locally",
            link: "/how-to/run-several-deployments-locally",
          },
          { text: "Write a runtime", link: "/how-to/write-a-runtime" },
        ],
      },
    ],
  },
  {
    text: "Reference",
    items: [
      { text: "Packages and install", link: "/reference/packages" },
      {
        text: "The kernel and its plumbing",
        collapsed: false,
        items: [
          { text: "@btravstack/contract", link: "/reference/contract" },
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
              { text: "Observability contracts", link: "/reference/core/observability" },
              { text: "runMain and exit codes", link: "/reference/core/exit-codes" },
              { text: "Probes", link: "/reference/core/probes" },
            ],
          },
        ],
      },
      {
        text: "Servers",
        collapsed: false,
        items: [
          { text: "@btravstack/http-server", link: "/reference/http-server" },
          { text: "@btravstack/temporal-worker", link: "/reference/temporal-worker" },
          { text: "@btravstack/amqp-worker", link: "/reference/amqp-worker" },
        ],
      },
      {
        text: "Capability ports",
        collapsed: false,
        items: [
          { text: "@btravstack/observability", link: "/reference/observability" },
          { text: "@btravstack/cache", link: "/reference/cache" },
          { text: "@btravstack/mailer", link: "/reference/mailer" },
          { text: "@btravstack/storage", link: "/reference/storage" },
          { text: "@btravstack/prisma", link: "/reference/prisma" },
          { text: "@btravstack/outbox", link: "/reference/outbox" },
        ],
      },
      {
        text: "The harness",
        collapsed: false,
        items: [{ text: "@btravstack/testing", link: "/reference/testing" }],
      },
      { text: "Glossary", link: "/reference/glossary" },
      { text: "API reference", link: "/api/" },
    ],
  },
  {
    text: "Explanation",
    items: [
      {
        text: "Theses",
        collapsed: false,
        items: [
          { text: "Why btravstack?", link: "/explanation/why-btravstack" },
          { text: "Coming from NestJS", link: "/explanation/coming-from-nestjs" },
          { text: "Coming from Spring Boot", link: "/explanation/coming-from-spring-boot" },
          { text: "Coming from AdonisJS", link: "/explanation/coming-from-adonisjs" },
          { text: "One process, one runtime", link: "/explanation/one-process-one-runtime" },
          { text: "Compile errors, not surprises", link: "/explanation/compile-time-wiring" },
          { text: "Nothing throws", link: "/explanation/nothing-throws" },
          { text: "The kernel maps nothing", link: "/explanation/the-kernel-maps-nothing" },
          { text: "Draining, in three beats", link: "/explanation/draining-in-three-beats" },
        ],
      },
      {
        text: "Mechanics",
        collapsed: false,
        items: [
          { text: "Modules and privacy", link: "/explanation/modules-and-privacy" },
          { text: "Scopes and resource safety", link: "/explanation/scopes-and-resources" },
          { text: "Ambient data, injected capabilities", link: "/explanation/ambient-vs-context" },
          { text: "Starters", link: "/explanation/starters" },
          { text: "Peer dependencies", link: "/explanation/peer-dependencies" },
          { text: "Design decisions", link: "/explanation/design-decisions" },
        ],
      },
    ],
  },
];

const ENTITY_SIDEBAR = [
  {
    text: "Tutorial",
    items: [{ text: "Getting started", link: "/entity/tutorial/getting-started" }],
  },
  {
    text: "How-to guides",
    items: [
      { text: "Expose an HTTP contract", link: "/entity/how-to/http-contract" },
      { text: "Persist and rehydrate", link: "/entity/how-to/persist-and-rehydrate" },
      { text: "Evolve an entity", link: "/entity/how-to/evolve-an-entity" },
      { text: "Add a stricter rule", link: "/entity/how-to/add-a-stricter-rule" },
      { text: "Model an aggregate", link: "/entity/how-to/model-an-aggregate" },
      { text: "Persist an aggregate relationally", link: "/entity/how-to/persist-relationally" },
      { text: "Number without gaps", link: "/entity/how-to/number-without-gaps" },
      { text: "Enforce a uniqueness rule", link: "/entity/how-to/enforce-uniqueness" },
      { text: "Write commands and events", link: "/entity/how-to/write-commands" },
      {
        text: "Model an event-driven aggregate",
        link: "/entity/how-to/model-an-event-driven-aggregate",
      },
      { text: "Test domain logic", link: "/entity/how-to/test-domain-logic" },
    ],
  },
  {
    text: "Reference",
    items: [
      { text: "Declaring an entity", link: "/entity/reference/declaration" },
      { text: "Schema members", link: "/entity/reference/schemas" },
      { text: "Entry points", link: "/entity/reference/entry-points" },
      { text: "Errors", link: "/entity/reference/errors" },
      { text: "Helper types", link: "/entity/reference/types" },
      { text: "Guarantees and compatibility", link: "/entity/reference/guarantees" },
      { text: "API reference", link: "/api/entity/" },
    ],
  },
  {
    text: "Explanation",
    items: [
      { text: "Why entity?", link: "/entity/explanation/why-entity" },
      { text: "Compared with zod and Effect", link: "/entity/explanation/compared" },
      { text: "Branded fields", link: "/entity/explanation/branded-fields" },
      { text: "No I/O, by design", link: "/entity/explanation/no-io" },
      { text: "Sealed construction", link: "/entity/explanation/sealed-construction" },
      { text: "Immutability", link: "/entity/explanation/immutability" },
      { text: "Why computed re-derives", link: "/entity/explanation/computed-fields" },
      { text: "Tags and identity", link: "/entity/explanation/tags-and-identity" },
      { text: "Unions and roots", link: "/entity/explanation/unions-and-roots" },
      {
        text: "Invariants and transitions",
        link: "/entity/explanation/invariants-and-transitions",
      },
      { text: "Errors are values", link: "/entity/explanation/errors-are-values" },
      { text: "Peer dependencies", link: "/entity/explanation/peer-dependencies" },
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
      { text: "Hexagonal (di alone)", link: "/examples/di-hexagonal" },
    ],
  },
];

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: "btravstack",
  description: SITE_DESCRIPTION,
  base: BASE,
  cleanUrls: true,

  // `docs/superpowers/` holds gitignored working files (plans, specs). VitePress
  // scans the whole of `docs/`, so without this it compiles them as pages.
  srcExclude: ["superpowers/**", "AGENTS.md", "CLAUDE.md"],

  // TypeDoc resolves its own cross-references, which is what these three
  // RELATIVE patterns exempt. Do NOT add a root-relative one (`/^\/api\//`):
  // that is the only check a dead link into the generated tree ever meets, and
  // `extract-doc-samples.ts` skips root-relative links because this one runs.
  ignoreDeadLinks: [/^\.\/index$/, /^\.\/[a-z-]+$/, /^\.\.\//],

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

    // The /api/ pages are TypeDoc output generated at build time — they have no
    // source file in the repo, so "Edit this page" would 404.
    if (pageData.relativePath.startsWith("api/")) {
      pageData.frontmatter.editLink = false;
    }

    pageData.frontmatter.head.push(["link", { rel: "canonical", href: canonicalUrl }]);

    const pageTitle = pageData.title || pageData.frontmatter.title || "btravstack";
    const pageDescription =
      pageData.description || pageData.frontmatter.description || SITE_DESCRIPTION;

    pageData.frontmatter.head.push(
      ["meta", { property: "og:url", content: canonicalUrl }],
      ["meta", { property: "og:title", content: pageTitle }],
      ["meta", { property: "og:description", content: pageDescription }],
      ["meta", { name: "twitter:title", content: pageTitle }],
      ["meta", { name: "twitter:description", content: pageDescription }],
    );
    const isEntity =
      pageData.relativePath.startsWith("entity/") ||
      pageData.relativePath.startsWith("api/entity/");
    const image = `${SITE_URL}${isEntity ? "entity/og-entity-btravstack.png" : "og-btravstack.png"}`;
    const imageAlt = isEntity
      ? "entity — Your domain, declared once. Validated at the boundary. Identity card with a smiling beetroot portrait."
      : "btravstack — Your application, composed. Your process, taken care of. Smiling beetroot mascot on three teal layers.";
    pageData.frontmatter.head.push(
      ["meta", { property: "og:image", content: image }],
      ["meta", { property: "og:image:type", content: "image/png" }],
      ["meta", { property: "og:image:width", content: "1200" }],
      ["meta", { property: "og:image:height", content: "630" }],
      ["meta", { property: "og:image:alt", content: imageAlt }],
      ["meta", { name: "twitter:card", content: "summary_large_image" }],
      ["meta", { name: "twitter:image", content: image }],
      ["meta", { name: "twitter:image:alt", content: imageAlt }],
    );
  },

  themeConfig: {
    logo: { light: "/logo-light.svg", dark: "/logo-dark.svg", alt: "" },
    nav: [
      // The guide is organised by the four Diátaxis modes; the dropdown links
      // the entry page of each. See the sidebar for the full contents.
      {
        text: "Guide",
        items: [
          { text: "Tutorial", link: "/tutorial/getting-started" },
          { text: "How-to guides", link: "/how-to/configure-from-the-environment" },
          { text: "Reference", link: "/reference/packages" },
          { text: "Explanation", link: "/explanation/why-btravstack" },
        ],
      },
      {
        text: "Packages",
        items: [
          { text: "All packages", link: "/reference/packages" },
          { text: "Entity guide", link: "/entity/" },
        ],
      },
      { text: "API", link: "/api/" },
      { text: "Examples", link: "/examples/" },
      {
        text: "Changelog",
        link: "https://github.com/btravstack/btravstack/releases",
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
      "/entity/": ENTITY_SIDEBAR,
      "/api/": [
        {
          text: "API Reference",
          items: [
            { text: "Overview", link: "/api/" },
            { text: "@btravstack/contract", link: "/api/contract/" },
            { text: "@btravstack/entity", link: "/api/entity/" },
            { text: "@btravstack/di", link: "/api/di/" },
            { text: "@btravstack/config", link: "/api/config/" },
            { text: "@btravstack/core", link: "/api/core/" },
            { text: "@btravstack/observability", link: "/api/observability/" },
            { text: "@btravstack/cache", link: "/api/cache/" },
            { text: "@btravstack/mailer", link: "/api/mailer/" },
            { text: "@btravstack/storage", link: "/api/storage/" },
            { text: "@btravstack/prisma", link: "/api/prisma/" },
            { text: "@btravstack/outbox", link: "/api/outbox/" },
            { text: "@btravstack/testing", link: "/api/testing/" },
            { text: "@btravstack/http-server", link: "/api/http-server/" },
            { text: "@btravstack/temporal-worker", link: "/api/temporal-worker/" },
            { text: "@btravstack/amqp-worker", link: "/api/amqp-worker/" },
          ],
        },
      ],
      "/examples/": EXAMPLES_SIDEBAR,
    },

    socialLinks: [
      { icon: "github", link: "https://github.com/btravstack/btravstack" },
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
      pattern: "https://github.com/btravstack/btravstack/edit/main/docs/:path",
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
    ["link", { rel: "icon", type: "image/svg+xml", href: `${BASE}favicon.svg` }],
    ["meta", { name: "author", content: "Benoit TRAVERS" }],
    ["meta", { name: "application-name", content: "btravstack" }],
    [
      "meta",
      {
        name: "keywords",
        content:
          "typescript, application kernel, dependency injection, graceful shutdown, drain, kubernetes, readiness, liveness, orpc, temporal, amqp, rabbitmq, unthrown, result, spring boot starters",
      },
    ],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "btravstack" }],
    ["meta", { property: "og:locale", content: "en_US" }],
  ],
});
