import { Module, Port, Provider } from "@btravstack/di";

/**
 * Where slices read from. A port rather than an ambient `process.env` read so
 * that the kernel's validation pass and the slices' own providers cannot
 * disagree about what the environment was.
 */
export class ConfigSource extends Port("config/Source")<Record<string, string | undefined>> {}

/** The module an application (or, in phase 2, `start`) imports exactly once. */
export const source = (record: Record<string, string | undefined>) =>
  Module("ConfigSource")({
    provides: [Provider(ConfigSource)({ value: record })],
    exports: [ConfigSource],
  });
