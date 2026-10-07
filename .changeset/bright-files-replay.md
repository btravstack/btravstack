---
"@btravstack/storage": patch
---

Correct the presigned upload contract: a URL can be replayed until expiry to replace an object, and signed type and length do not verify its bytes. Document a staging and confirmation boundary for applications that need stable accepted content.
