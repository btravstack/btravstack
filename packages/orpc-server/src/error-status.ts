import type { AnyProcedureContract } from "@orpc/contract";

export const errorStatusesOf = (procedure: AnyProcedureContract): Record<string, number> => {
  const statuses: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const [code, entry] of Object.entries(procedure["~orpc"].errorMap)) {
    const status = (entry as { readonly status?: unknown } | undefined)?.status;
    if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599)
      statuses[code] = status;
  }
  return statuses;
};
