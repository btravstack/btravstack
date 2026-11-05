import { Temporal as PortableTemporal } from "temporal-polyfill";
import { z } from "zod";

import { Entity } from "../index.js";

export const Temporal =
  (Reflect.get(globalThis, "Temporal") as typeof PortableTemporal | undefined) ?? PortableTemporal;

export const calendarDate = Entity.codec(z.iso.date(), z.instanceof(Temporal.PlainDate), {
  decode: (value) => Temporal.PlainDate.from(value),
  encode: (value) => value.toString(),
});

export const instant = Entity.codec(z.iso.datetime(), z.instanceof(Temporal.Instant), {
  decode: (value) => Temporal.Instant.from(value),
  encode: (value) => value.toString(),
});
