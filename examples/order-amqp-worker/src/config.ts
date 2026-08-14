import { Config } from "@btravstack/config";
import { port } from "@btravstack/config/zod";
import { z } from "zod";

/**
 * The broker this worker consumes from — and the relay publishes to.
 *
 * One value that is both the port token and the module serving it: `imports:
 * [amqpConfig]` provides it from the environment, `ctx.get(amqpConfig)` reads
 * it back. `Config("Amqp")` derives its prefix from its own identity, so `url`
 * reads `AMQP_URL` — the same variable this deployment has always taken.
 */
export const amqpConfig = Config("Amqp")({
  url: z.string().min(1).default("amqp://127.0.0.1:5672"),
});

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
