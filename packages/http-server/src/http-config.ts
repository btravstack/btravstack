import { Port } from "@btravstack/di";

/**
 * What the transport is bound and configured with, as a service: `http()`
 * binds it from `PORT` (default `3000`; `0` lets the OS pick), `HOST` (default
 * `0.0.0.0`), `BODY_LIMIT`, `CORS_ORIGIN` and `COMPRESSION`, each pinned by
 * the matching option, and anything else in the graph may read it.
 */
export class HttpConfig extends Port("HttpConfig")<{
  readonly port: number;
  readonly hostname: string;
  /** The largest request body a procedure reads, in bytes; `0` is unbounded. */
  readonly bodyLimit: number;
  /** Comma-separated allowed origins, or `*`. Empty is "the deployment said nothing". */
  readonly corsOrigin: string;
  readonly compression: boolean;
}> {}
