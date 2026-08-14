import { Config } from "@btravstack/config";
import { port } from "@btravstack/config/zod";
import { z } from "zod";

/**
 * The address of the Temporal frontend service, named because `main.ts` needs
 * it a second time — see the comment there on why the connection cannot be
 * opened from the graph.
 */
export const TEMPORAL_ADDRESS_DEFAULT = "127.0.0.1:7233";

/**
 * Where this worker polls, and in which namespace.
 *
 * `Config("Temporal")` derives its prefix from its own identity, so the two
 * keys read `TEMPORAL_ADDRESS` and `TEMPORAL_NAMESPACE` — the same variables
 * this deployment has always taken. Both are strings with an emptiness rule:
 * `.min(1)` in front of `.default(...)` makes a blank value a configuration
 * error rather than an absent one, which a worker silently polling the wrong
 * namespace would otherwise never announce.
 */
export const temporalConfig = Config("Temporal")({
  address: z.string().min(1).default(TEMPORAL_ADDRESS_DEFAULT),
  namespace: z.string().min(1).default("default"),
});

/**
 * The probe port's default, named for the same reason as the address above.
 */
export const PROBE_PORT_DEFAULT = 9000;

/**
 * `/livez` and `/readyz`. Nothing resolves this port: it is declared so that
 * `PROBE_PORT` is validated by the same pre-boot pass as every other variable,
 * and reported in the same message when it is wrong.
 */
export const probeConfig = Config("Probe")({ port: port(PROBE_PORT_DEFAULT) });
