---
"@btravstack/orpc-server": patch
---

Accept the released `@unthrown/orpc` 0.4.2 bridge while retaining compatibility
with 0.2 consumers. Validate the workspace against unthrown 5.12.1, the fixed
oRPC and Pothos bridges, and oRPC 2.0.0-beta.34.
Use the OpenAPI generator's own base-document parameter type so the newer
beta's versioned document return type does not break options forwarded to it.
