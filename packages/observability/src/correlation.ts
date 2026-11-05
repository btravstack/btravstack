import type { DiagnosticPolicy, UnitRecord } from "@btravstack/core";

type Correlation = {
  readonly unitId: string;
  readonly traceId: string;
  readonly tenantId?: string;
};

export const correlationOf = (
  unit: Correlation | UnitRecord | undefined,
  diagnostics?: DiagnosticPolicy,
): Correlation | undefined => {
  if (unit === undefined) return undefined;
  const fields = diagnostics === undefined ? unit : diagnostics.attributes(unit);
  return {
    unitId: typeof fields["unitId"] === "string" ? fields["unitId"] : "[redacted]",
    traceId: typeof fields["traceId"] === "string" ? fields["traceId"] : "[redacted]",
    ...(typeof fields["tenantId"] === "string" ? { tenantId: fields["tenantId"] } : {}),
  };
};
