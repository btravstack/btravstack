---
"@btravstack/orpc-server": patch
---

Add a literal `namespace` option to `defineHttp` so separate APIs can reuse
resource names without duplicate-port warnings or ambiguous DI types. The same
namespace and path reuse one port across contract objects and package copies.
Router construction rejects duplicate controller paths before composing them.
Existing unnamed controller IDs, RPC keys and public HTTP paths are unchanged.
