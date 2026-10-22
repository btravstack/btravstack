import type { StorageService } from "./index.js";

declare const store: StorageService;
declare const key: string;

store.presignedUrl(key, {
  ttlMs: 60_000,
  contentDisposition: "attachment; filename=report.pdf; filename*=UTF-8''relev%C3%A9.pdf",
  contentType: "application/pdf",
  cacheControl: "private, no-store",
});
