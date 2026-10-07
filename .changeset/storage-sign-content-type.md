---
"@btravstack/storage": patch
---

`presignedUpload` on the S3 adapter now signs the content type. The AWS presigner leaves `content-type` unsigned by default even when the command sets it, so a URL minted for one type accepted a same-length write under any other; it is now named in `signableHeaders`, and the store refuses the mismatch with `403`.
