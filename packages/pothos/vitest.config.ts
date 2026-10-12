import { defineConfig, mergeConfig } from "vitest/config";

import shared, { covered } from "../../vitest.shared.js";

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      // Inlined so Pothos and the specs share one `graphql`, and the unthrown
      // plugin registers with the same Pothos: externalised, each is a second
      // copy, refused by graphql's realm check or Pothos' plugin registry.
      server: { deps: { inline: [/@pothos\//u, /@unthrown\/pothos/u, /graphql/u, /@envelop\//u] } },
      coverage: covered(),
    },
  }),
);
