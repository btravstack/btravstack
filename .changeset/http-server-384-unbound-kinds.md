---
"@btravstack/http-server": patch
---

`HttpModule` now refuses a root that leaves a request-scope kind unbound. When the router or the fragments come from `auth.units<…>()`, every declared kind the root serves must appear on `unit` — a missing kind is `Property '<kind>' is missing`, and a root with no `unit` at all is refused against `"UNBOUND UNIT KINDS — units<…>() declared them, so bind each on unit"`. Such a root used to compile and then fork `anonymous`'s module, or nothing, under a leaf reading `context.unit`, answering `500`. To migrate, bind each kind the compiler names, with the module you passed to `units<…>()` for it. A declared kind none of the root's answerers serves stays optional.
