---
"@btravstack/orpc-server": patch
---

Namespace generated controller ports by contract object identity so unrelated
APIs can reuse resource names in one process without duplicate-port warnings.
The same contract and path reuse one port, preserving duplicate-provider checks.
RPC resource keys and public HTTP paths are unchanged.
