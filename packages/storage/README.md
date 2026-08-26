# @btravstack/storage

> The object-storage port for [`@btravstack/core`](../core): one `Storage` an
> application depends on, an in-memory adapter, an S3-compatible one with
> presigned reads, and a span, a count and a log line per operation.

📖 **[Documentation](https://btravstack.github.io/btravstack/reference/storage)** ·
[API Reference](https://btravstack.github.io/btravstack/api/storage/)

```sh
pnpm add @btravstack/storage @btravstack/core @btravstack/config @btravstack/di unthrown
```

Four peer dependencies, plus `@aws-sdk/client-s3` and
`@aws-sdk/s3-request-presigner` — optional, and needed only if you compose the
S3 adapter. Instrumentation needs no peer of its own: the `Logger`, `Tracer`
and `Meter` it depends on are
[the kernel's ports](https://btravstack.github.io/btravstack/reference/core/observability).
Node `>=22`.

## A worked example

<!-- doctest: group=order-temporal-worker -->
<!-- doctest: prelude
import { Module } from "@btravstack/di";
import { Logger } from "@btravstack/core";
import { observability } from "@btravstack/observability";
import { otel } from "@btravstack/observability/otel";
import { P } from "unthrown";
-->

Storing a document, and reading it back through a URL that carries no
credentials:

```ts
import {
  Port as InvoicePort,
  Provider as InvoiceProvider,
} from "@btravstack/di";
import { Storage } from "@btravstack/storage";
import type { AsyncResult } from "unthrown";

class Invoices extends InvoicePort("ReadmeInvoices")<{
  readonly store: (
    tenantId: string,
    id: string,
    pdf: Uint8Array,
  ) => AsyncResult<void, never>;
  readonly link: (
    tenantId: string,
    id: string,
  ) => AsyncResult<string | undefined, never>;
}> {}

// The tenant is in the key because the port has no slot for one — the same
// rule a cache key follows.
const keyFor = (tenantId: string, id: string) =>
  `invoices/${tenantId}/${id}.pdf`;

export const invoices = InvoiceProvider(Invoices)(
  { storage: Storage },
  {
    sync: ({ storage }) => ({
      store: (tenantId, id, pdf) =>
        storage
          .put(keyFor(tenantId, id), pdf, { contentType: "application/pdf" })
          // A document that failed to store is YOUR decision to make; here it
          // is swallowed because the instrumented store already logged and
          // counted it one layer down.
          .recoverErrCases((matcher) =>
            matcher.with(P.tag("StorageUnavailable"), () => undefined),
          ),
      // Serving bytes through your own process is the anti-pattern this arm
      // exists to avoid: the caller fetches the object directly, for a minute.
      link: (tenantId, id) =>
        storage
          .presignedUrl(keyFor(tenantId, id), { ttlMs: 60_000 })
          .recoverErrCases((matcher) =>
            matcher
              .with(P.tag("StorageUnavailable"), () => undefined)
              .with(P.tag("PresignNotSupported"), () => undefined),
          ),
    }),
  },
);
```

The composition — the adapter, and whether operations are instrumented,
decided here and nowhere else:

```ts
import { storage } from "@btravstack/storage";
import { s3Storage } from "@btravstack/storage/s3";

export const InvoicesApp = Module("InvoicesApp")({
  imports: [
    // Instrumented by default, which is why `observability()` and `otel()`
    // are below. Pass `instrumented: false` for the same graph without them.
    storage({ adapter: s3Storage() }),
    observability(),
    otel(),
  ],
  provides: [invoices],
  exports: [Invoices, Logger],
});
```

## Options

| Option                                                      | Where                              | What it is                                                             |
| ----------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------- |
| `adapter`                                                   | `storage({ adapter })`             | the adapter module providing `StorageBackend` — required               |
| `instrumented`                                              | `storage({ instrumented })`        | span, count and log every operation (default `true`; `false` opts out) |
| `STORAGE_S3_ENDPOINT`                                       | environment, read by `s3Storage()` | the store's endpoint — required                                        |
| `STORAGE_S3_BUCKET`                                         | environment                        | the bucket — required                                                  |
| `STORAGE_S3_ACCESS_KEY_ID` / `STORAGE_S3_SECRET_ACCESS_KEY` | environment                        | the credentials — required                                             |
| `STORAGE_S3_REGION`                                         | environment                        | default `us-east-1`                                                    |

The full table — defaults, semantics and the reasoning — lives on
[the reference page](https://btravstack.github.io/btravstack/reference/storage),
which is this list's one detailed home.

## What it decides, and what it does not

**It decides** that a missing object is an ordinary answer rather than a fault
(counted `not_found`, logged at `info`), that `delete` is idempotent, that
presigning asks the store nothing — and that an adapter which cannot presign
says so instead of minting a URL that would fail only in production.

**It does not decide** what your keys look like, whether a failed write should
fail your request, or how long a link should live. There is no streaming, no
presigned writes, no listing and no bucket management; the reasons are in
[`CLAUDE.md`](./CLAUDE.md).
