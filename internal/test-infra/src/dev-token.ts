import { flags } from "./cli.js";
import { signDevToken } from "./dev-issuer.js";

/**
 * `principal` in `examples/order-api/src/auth.ts` parses the `tenant` claim
 * with `z.uuidv7()`, so a v4 — what `uuidgen` and `crypto.randomUUID()` mint —
 * is refused as a 401 rather than reported here.
 */
const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const USAGE = 'usage: pnpm dev:token -- --tenant <uuidv7> [--sub u-1] [--scope "orders:export"]\n';

const values = flags(["tenant", "sub", "scope"]);
const tenant = values?.tenant;

if (values === undefined || tenant === undefined || !UUIDV7.test(tenant)) {
  process.stderr.write(USAGE);
  process.exitCode = 64;
} else {
  // The token and nothing else on stdout. `pnpm` puts its own `[ELIFECYCLE]`
  // line there when this exits `64`, which is why the README mints into a
  // variable and checks the status instead of composing a `$(…)` into a header.
  process.stdout.write(
    `${await signDevToken({
      tenant,
      sub: values.sub ?? "u-1",
      scope: values.scope ?? "orders:export",
    })}\n`,
  );
}
