import type { CopyOptions, StorageService, WriteOptions } from "./index.js";

declare const storage: StorageService;
const write: WriteOptions = {
  contentType: "application/pdf",
  sha256: "a".repeat(64),
  metadata: { producer: "compiler" },
};
const copy: CopyOptions = {
  contentType: "application/pdf",
  checksum: "sha256",
  metadata: { producer: "publisher" },
};
storage.put("document", new Uint8Array(), write);
storage.putIfAbsent("document", new Uint8Array(), write);
storage.copy("staging", "published", copy);
// @ts-expect-error a copy computes its own checksum; it cannot accept a write digest
storage.copy("staging", "published", write);
// @ts-expect-error writes verify a supplied digest; they do not accept copy algorithms
storage.put("document", new Uint8Array(), copy);
// @ts-expect-error conditional writes use the same write digest contract
storage.putIfAbsent("document", new Uint8Array(), copy);

storage.presignedUrl("document", {
  ttlMs: 60_000,
  contentDisposition: "attachment; filename=report.pdf; filename*=UTF-8''relev%C3%A9.pdf",
  contentType: "application/pdf",
  cacheControl: "private, no-store",
});
