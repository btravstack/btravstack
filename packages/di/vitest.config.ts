import { defineConfig, mergeConfig } from "vitest/config";

import shared, { covered } from "../../vitest.shared.js";

// The same floor as every other published package: being the package whose
// type-level behaviour is the product is not a reason for its RUNTIME to go
// unmeasured.
export default mergeConfig(shared, defineConfig({ test: { coverage: covered() } }));
