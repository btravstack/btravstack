import { readFileSync } from "node:fs";

import { it } from "@btravstack/internal-http-fixtures";
import { describe, expect } from "vitest";

describe("the root entry point", () => {
  it("reaches no optional peer, so a consumer that never imports a subpath installs none", () => {
    // GIVEN the optional peers, and the root entry's source
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const optional = Object.keys(manifest.peerDependenciesMeta);

    // WHEN every runtime import reachable from it is collected
    const reached = new Set<string>();
    const pending = ["index.ts"];
    for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      for (const [, from] of source.matchAll(
        /^(?:import|export)(?!\s+type\b)[^;]*?["']([^"']+)["'];/gms,
      )) {
        const local = from?.startsWith("./") ? from.replace(/\.js$/, ".ts") : undefined;
        if (local !== undefined && !reached.has(local)) pending.push(local);
        reached.add(local ?? from ?? "");
      }
    }

    // THEN none of them is an optional peer or one of its subpaths
    expect(
      [...reached].filter((name) =>
        optional.some((peer) => name === peer || name.startsWith(`${peer}/`)),
      ),
    ).toEqual([]);
  });
});
