import { parseArgs } from "node:util";

import { signDevToken } from "./dev-issuer.js";

/**
 * `principal` in `examples/order-api/src/auth.ts` parses the `tenant` claim
 * with `z.uuidv7()`, so a v4 — what `uuidgen` and `crypto.randomUUID()` mint —
 * is refused as a 401 rather than reported here.
 */
const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const { values } = parseArgs({
  // `pnpm dev:token -- --tenant …` hops through two `pnpm run`s, and the
  // second leaves the separator in `argv` — where `parseArgs` reads everything
  // after it as a positional this command does not take.
  args: process.argv.slice(2).filter((argument) => argument !== "--"),
  options: {
    tenant: { type: "string" },
    sub: { type: "string" },
    scope: { type: "string" },
  },
});

const tenant = values.tenant;

if (tenant === undefined || !UUIDV7.test(tenant)) {
  process.stderr.write(
    'usage: pnpm dev:token -- --tenant <uuidv7> [--sub u-1] [--scope "orders:export"]\n',
  );
  process.exitCode = 64;
} else {
  // The token and nothing else on stdout, so the whole call composes into a
  // header: `curl -H "authorization: Bearer $(pnpm dev:token -- --tenant …)"`.
  process.stdout.write(
    `${await signDevToken({
      tenant,
      sub: values.sub ?? "u-1",
      scope: values.scope ?? "orders:export",
    })}\n`,
  );
}
