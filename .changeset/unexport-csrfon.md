---
"@btravstack/http-server": minor
---

**Breaking: `csrfOn` is no longer exported from `@btravstack/http-server/session`.** It is the runtime's own decision of whether `csrf` defaults on, re-exported by the session subpath with no user in code, tests, examples or docs. Set `csrf` on `http()` / `HttpModule`, or contribute `cookieScheme()`, as before.
