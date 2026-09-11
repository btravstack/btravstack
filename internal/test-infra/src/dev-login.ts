import { parseArgs } from "node:util";

import { headlessLogin } from "./ory-login.js";
import { ORY_USERS, type OryUser } from "./ory-provision.js";

const USAGE =
  "usage: pnpm dev:login -- [--as alice@btravstack.test] [--origin http://localhost:3000]\n";

const parse = (): Partial<Record<"as" | "origin", string>> | undefined => {
  // `pnpm dev:login -- --as …` hops through two `pnpm run`s, and the second
  // leaves the separator in `argv` — only the FIRST goes, exactly as `dev-token`'s does.
  const argv = process.argv.slice(2);
  const separator = argv.indexOf("--");

  try {
    return parseArgs({
      args: separator === -1 ? argv : argv.toSpliced(separator, 1),
      options: { as: { type: "string" }, origin: { type: "string" } },
    }).values;
  } catch {
    return undefined;
  }
};

const fail = (message: string): void => {
  process.stderr.write(message);
  process.exitCode = 64;
};

const values = parse();
const email = values?.as ?? ORY_USERS.alice.email;
const user: OryUser | undefined = Object.values(ORY_USERS).find((known) => known.email === email);
const origin = values?.origin ?? "http://localhost:3000";

if (values === undefined || user === undefined) {
  fail(USAGE);
} else {
  const started = await fetch(`${origin}/auth/login`, { redirect: "manual" });
  const location = started.headers.get("location");
  if (location === null) {
    fail(`${origin}/auth/login answered ${started.status} and no Location: is pnpm dev running?\n`);
  } else {
    const transient = started.headers.getSetCookie().map((set) => set.split(";")[0] ?? "");
    const back = await headlessLogin({ authorizationUrl: new URL(location), user });
    const finished = await fetch(`${origin}/auth/callback${back.search}`, {
      redirect: "manual",
      headers: { cookie: transient.join("; ") },
    });
    const session = finished.headers
      .getSetCookie()
      .map((set) => set.split(";")[0] ?? "")
      .find((pair) => pair.startsWith("__Host-session="));
    if (session === undefined) {
      fail(`${origin}/auth/callback answered ${finished.status} and sealed no session\n`);
    } else {
      // The cookie and nothing else on stdout, for `curl -b`.
      process.stdout.write(`${session}\n`);
    }
  }
}
