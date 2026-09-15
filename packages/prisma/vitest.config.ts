import { defineConfig, mergeConfig } from "vitest/config";

import shared, { covered } from "../../vitest.shared.js";

// No container, and that is the point rather than an omission: a Prisma
// client dials on the first statement, so the pool's lifecycle — which is
// all this package owns — is provable against a stub client. A database
// here would test Prisma, not this.
export default mergeConfig(shared, defineConfig({ test: { coverage: covered() } }));
