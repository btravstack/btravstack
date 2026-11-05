import type { Attributes } from "./observability.js";

/**
 * An application's diagnostic disclosure boundary, shared by log and trace
 * adapters. Implementations must be synchronous and must not throw. Rendering
 * never changes the original Result or exception.
 */
export type DiagnosticPolicy = {
  readonly message: (message: string) => string;
  readonly attributes: (attributes: Readonly<Record<string, unknown>>) => Attributes;
  readonly cause: (cause: unknown) => unknown;
};
