import { test } from "vitest";

export const it = test.extend<{
  readonly fragment: { readonly place: { readonly kind: "procedure" } };
}>({
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  fragment: async ({}, use) => {
    await use({ place: { kind: "procedure" } });
  },
});
