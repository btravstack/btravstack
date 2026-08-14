import { collect } from "./collect.js";
import { parseAll } from "./parse.js";
import { Config as declareConfig } from "./slice.js";
import { source } from "./source.js";

export { ConfigInvalid, describeIssues, type ConfigIssue } from "./errors.js";
export type { Shape } from "./parse.js";
export { ConfigSource } from "./source.js";
export type { AnyConfigAdapter, ConfigType, DeclaredConfig, ValueOf } from "./slice.js";

/**
 * `Config(id)(shape, options?)` returns one value that is both the port token
 * and the di module that serves it from the environment; the namespaced
 * operations are the kernel's, following `Module.build` / `Module.scoped` and
 * `Port.many`.
 */
export const Config = Object.assign(declareConfig, {
  collect,
  parse: parseAll,
  source,
});
