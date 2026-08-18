import { test } from "vitest";

import { auth } from "./auth.js";

type Principal = { readonly userId: string };

export const it = test.extend<{
  readonly authenticated: ReturnType<typeof auth<Principal>>["authenticated"];
  readonly fragment: { readonly place: { readonly kind: "procedure" } };
}>({
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  authenticated: async ({}, use) => {
    await use(auth<Principal>().authenticated);
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  fragment: async ({}, use) => {
    await use({ place: { kind: "procedure" } });
  },
});
