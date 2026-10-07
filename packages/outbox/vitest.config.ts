import { defineConfig, mergeConfig } from "vitest/config";

import shared, { covered } from "../../vitest.shared.js";

// No container: the relay is proven against the in-process store, and the
// Prisma store's statements against a stub client. That two relays over the
// real table take turns on a tenant needs the application's own contract
// and the shared PostgreSQL, so it lives in `examples/order-infrastructure`.
export default mergeConfig(shared, defineConfig({ test: { coverage: covered() } }));
