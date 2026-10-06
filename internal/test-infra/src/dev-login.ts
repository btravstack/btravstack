import { flags } from "./cli.js";
import { browserLogin } from "./ory-login.js";
import { ORY_USERS, type OryUser } from "./ory-provision.js";

const USAGE =
  "usage: pnpm dev:login -- [--as alice@btravstack.test] [--origin http://localhost:3000]\n";

const values = flags(["as", "origin"]);
const email = values?.as ?? ORY_USERS.alice.email;
const user: OryUser | undefined = Object.values(ORY_USERS).find((known) => known.email === email);

if (values === undefined || user === undefined) {
  process.stderr.write(USAGE);
  process.exitCode = 64;
} else {
  // The cookie and nothing else on stdout, for `curl -b`.
  process.stdout.write(`${await browserLogin(values.origin ?? "http://localhost:3000", user)}\n`);
}
