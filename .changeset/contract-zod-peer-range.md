---
"@btravstack/contract": patch
---

Declare the optional `zod` peer as `^4.3.0` rather than the workspace catalog's exact pin, so a consumer on another zod 4 release installs under strict peer dependencies.
