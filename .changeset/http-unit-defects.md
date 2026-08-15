---
"@btravstack/http": patch
---

Two consequences of the kernel's new `StartOptions.unit`. A unit whose work
begins after its response has already closed — a client that hung up during a
slow per-request build — now settles at once instead of waiting for a `'close'`
event that already fired, which held the unit open for the process lifetime.
And a defect that never reaches the handler's promise — a synchronous throw, or
a unit provider that failed to build — now answers `500` when no headers are
out, rather than only resetting the connection.
