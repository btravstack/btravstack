---
"@btravstack/di": patch
"@btravstack/config": patch
---

`Context.get` now reads back a service registered as `undefined` instead of reporting the port as missing. An ordinary `Provider(...)` on a set port no longer compiles; it used to type-check against the whole array and land it as one nested member. Contribute through `Provider.member`, as the refusal's marker says. `Config.provider(SetPort)(schema)` is refused the same way, through the newly exported `SetPortGate`.
