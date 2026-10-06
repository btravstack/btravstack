---
"@btravstack/http-server": patch
---

**The root entry point no longer requires `jose`.** `jose` is an optional peer, needed only by the `/jwt` and `/session` subpaths, but the root `@btravstack/http-server` imported `CookieSchemes`, `cookieScheme` and `csrfOn` from the session module, which imports `jose` at its top level. So an application that never verified a token or logged a browser in, and therefore never installed `jose`, failed to load the package at all with `ERR_MODULE_NOT_FOUND`.

Those three now live in a module that does not touch `jose`, and `/session` still exports them, so no import changes. A spec walks every runtime import reachable from the root entry and fails if any of them is an optional peer.
