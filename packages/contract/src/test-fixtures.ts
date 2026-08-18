import { test } from "vitest";

import { auth } from "./auth.js";

type Principal = { readonly userId: string };

export const it = test.extend<{
  readonly authenticated: ReturnType<typeof auth<Principal>>["authenticated"];
  readonly fragment: { readonly place: { readonly kind: "procedure" } };
}>({
  authenticated: async ({}, use) => {
    await use(auth<Principal>().authenticated);
  },
  fragment: async ({}, use) => {
    await use({ place: { kind: "procedure" } });
  },
});
