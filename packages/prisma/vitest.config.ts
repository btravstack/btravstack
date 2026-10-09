import { defineConfig, mergeConfig } from "vitest/config";

import shared, { covered } from "../../vitest.shared.js";

// No container, and that is the point rather than an omission: the pool's
// lifecycle and the probe it runs while opening — which is all this package
// owns — are provable against a stub client. A database here would test
// Prisma, not this; the burst it guards against is pinned against the shared
// container in `examples/order-infrastructure`.
export default mergeConfig(shared, defineConfig({ test: { coverage: covered() } }));
