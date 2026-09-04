import { TaggedError } from "unthrown";

/**
 * The cursor could not be read.
 *
 * The one modeled failure of a listing, and it is modeled because the cursor is
 * the only part of the query that came from **outside** — a client sending
 * garbage is input you answer with a 400, not a bug. Every other pagination
 * failure is a defect like any other query.
 *
 * It lives in the application layer rather than the domain: a cursor is an
 * artifact of how a listing is served, and the domain has no listings. It is
 * not in `@btravstack/contract` beside `Page` either — the framework norms the
 * SHAPE a client and a server share, and leaves each application its own error
 * vocabulary, which is thesis #3 at the contract tier.
 */
export class MalformedCursor extends TaggedError("MalformedCursor")<{
  readonly cursor: string;
}> {}
