import type { Attributes, DiagnosticPolicy } from "@btravstack/core";

/** Finite vocabularies for strings/booleans, inclusive finite bounds for numbers. */
export type DiagnosticField =
  | readonly (string | boolean)[]
  | {
      readonly min: number;
      readonly max: number;
    };

/** Only deployment-owned static vocabulary belongs in these allowlists. */
export type DiagnosticOptions = {
  readonly messages?: readonly string[];
  readonly codes?: readonly string[];
  readonly fields?: Readonly<Record<string, DiagnosticField>>;
};

const CORRELATION_FIELDS = ["unitId", "traceId", "tenantId"];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const TRACE_ID = /^(?!0{32}$)[a-f0-9]{32}$/i;

const own = (value: unknown, key: string): unknown => {
  try {
    return value !== null && (typeof value === "object" || typeof value === "function")
      ? Object.getOwnPropertyDescriptor(value, key)?.value
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * A production policy that never traverses causes, stacks, payloads or error
 * messages. Unknown messages and failures retain a static diagnostic identity.
 * Correlation retains UUIDs and nonzero W3C trace IDs. Other field values must
 * match an explicit vocabulary or finite numeric bounds.
 */
export const diagnosticPolicy = (options: DiagnosticOptions = {}): DiagnosticPolicy => {
  const messages = new Set(options.messages);
  const codes = new Set(options.codes);
  const fields = Object.entries(options.fields ?? {});
  const attributes = (values: Readonly<Record<string, unknown>>): Attributes =>
    Object.fromEntries([
      ...CORRELATION_FIELDS.flatMap((key) => {
        const value = own(values, key);
        return typeof value === "string" && (UUID.test(value) || TRACE_ID.test(value))
          ? [[key, value]]
          : [];
      }),
      ...fields.flatMap(([key, rule]) => {
        const value = own(values, key);
        const accepted = Array.isArray(rule)
          ? rule.includes(value as string | boolean)
          : typeof value === "number" &&
            Number.isFinite(value) &&
            Number.isFinite((rule as { min: number }).min) &&
            Number.isFinite((rule as { max: number }).max) &&
            value >= (rule as { min: number }).min &&
            value <= (rule as { max: number }).max;
        return accepted ? [[key, value]] : [];
      }),
    ]) as Attributes;
  return {
    message: (message) => (messages.has(message) ? message : "diagnostic"),
    attributes,
    cause: (cause) => {
      const code = own(cause, "_tag") ?? own(cause, "code");
      return {
        ...attributes(cause as Readonly<Record<string, unknown>>),
        code: typeof code === "string" && codes.has(code) ? code : "unknown",
      };
    },
  };
};

/**
 * Explicit sensitive debugging: preserves raw causes and messages. Use only
 * with a separately authorized, access-controlled destination and short retention.
 */
export const sensitiveDiagnostics: DiagnosticPolicy = {
  message: (message) => message,
  attributes: (attributes) => attributes as Attributes,
  cause: (cause) => cause,
};
