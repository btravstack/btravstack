---
"@btravstack/orpc-server": patch
---

Preserve root Zod void and undefined schemas without checks as no-content
OpenAPI inputs and outputs. Keep conversion defects from refined roots,
optional native values and generic Standard JSON Schema implementations.
Existing codec wire schemas and optional/defaulted JSON bodies retain their
conversion behavior.
