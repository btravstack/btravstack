import { defineConfig, mergeConfig } from "vitest/config";

import shared, { covered } from "../../vitest.shared.js";

export default mergeConfig(shared, defineConfig({ test: { coverage: covered() } }));
