---
"@btravstack/http-server": patch
---

A handler that rejects after flushing its headers now has its socket reset, as a synchronous throw already did, instead of leaving the client and the unit open until shutdown. A bound unit module is now discharged only of its own scheme's principal — `anonymous`'s of none — so a root whose module needs a principal its kind is never seeded with is refused at `start` instead of answering `500`.
