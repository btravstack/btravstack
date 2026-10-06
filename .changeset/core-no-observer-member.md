---
"@btravstack/core": minor
---

**New: `noObserverMember`**, the ready-made no-op `Observers` member a module reading that set port provides so a graph composing no observability still starts. Every starter reading the port spelled `Provider.member(Observers)({ inject: {}, value: noObserver })` by hand; they now share this one provider, which di de-duplicates by reference, so a graph composing several of them pays one inert call per operation instead of one per starter.
