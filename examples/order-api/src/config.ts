import { Config } from "@btravstack/config";
import { port } from "@btravstack/config/zod";

/**
 * The port the API listens on.
 *
 * One value that is both the port token and the module serving it: `imports:
 * [httpConfig]` provides it from the environment, `ctx.get(httpConfig)` reads
 * it back. `Config("Http")` derives its prefix from its own identity, so
 * `port` reads `HTTP_PORT`.
 *
 * **This is the one variable this refactor renamed.** It was `PORT`, and a
 * bare `PORT` is not expressible: every variable a config declares is
 * `PREFIX_KEY`, and there is no prefix and key whose join is `PORT` alone. The
 * options were a variable the package cannot name, or a name it can — see the
 * PR description; an operator setting `PORT` today has to set `HTTP_PORT`.
 */
export const httpConfig = Config("Http")({ port: port(3000) });

/**
 * The probe port's default, named because `main.ts` needs it a second time —
 * see the comment there on why the kernel's own port cannot come out of the
 * graph in phase 1.
 */
export const PROBE_PORT_DEFAULT = 9000;

/**
 * `/livez` and `/readyz`. Nothing resolves this port: it is declared so that
 * `PROBE_PORT` is validated by the same pre-boot pass as every other variable,
 * and reported in the same message when it is wrong.
 */
export const probeConfig = Config("Probe")({ port: port(PROBE_PORT_DEFAULT) });
