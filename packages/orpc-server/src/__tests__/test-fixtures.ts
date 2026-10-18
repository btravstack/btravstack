import { it as base, type HttpFixtures } from "@btravstack/internal-http-fixtures";
import { vi, type TestAPI } from "vitest";

export const it: TestAPI<HttpFixtures & { portWarnings: () => readonly unknown[] }> = base.extend<{
  portWarnings: () => readonly unknown[];
}>({
  // oxlint-disable-next-line no-empty-pattern -- this fixture observes diagnostics without changing console behavior
  portWarnings: async ({}, use) => {
    const warnings = vi.spyOn(console, "warn");
    await use(() => warnings.mock.calls);
    warnings.mockRestore();
  },
});
