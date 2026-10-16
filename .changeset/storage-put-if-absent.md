---
"@btravstack/storage": minor
---

Add `StorageService.putIfAbsent`, a first-writer-wins write: the S3 adapter sends `If-None-Match: *`, the memory adapter checks and sets atomically, and a held key answers the new `ObjectExists` error. `StorageUnavailable.operation` gains `"putIfAbsent"`, and the instrumented composition reports the call as `put_if_absent`, counting a held key as `result: "exists"`.
