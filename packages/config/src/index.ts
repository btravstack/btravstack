import { collect } from "./collect.js";
import { parseAll } from "./parse.js";
import { Config as declareConfig } from "./slice.js";
import { source } from "./source.js";

export { ConfigInvalid, describeIssues, type ConfigIssue } from "./errors.js";
export type { Shape } from "./parse.js";
export { ConfigSource } from "./source.js";
export type { AnyConfigAdapter, ValueOf } from "./slice.js";

/**
 * `Config(port, "PREFIX")({ … })` implements `port` as a module; the
 * namespaced operations are the kernel's, following `Module.build` /
 * `Module.scoped` and `Port.many`.
 */
export const Config = Object.assign(declareConfig, {
  collect,
  parse: parseAll,
  source,
});
