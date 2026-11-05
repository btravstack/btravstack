---
"@btravstack/orpc-server": patch
---

Preserve explicit root Zod void and undefined schemas as no-content OpenAPI
inputs and outputs without suppressing optional native or generic Standard JSON
Schema conversion defects. Existing codec wire schemas and optional/defaulted
JSON bodies retain their conversion behavior.
