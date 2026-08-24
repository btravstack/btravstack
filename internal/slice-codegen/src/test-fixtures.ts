import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test } from "vitest";

type Tree = {
  /** Materialise `src/slices/<dir>/<file>` entries under a temp root; returns the `src` path. */
  src: (files: readonly string[]) => string;
};

export const it = test.extend<{ tree: Tree }>({
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  tree: async ({}, use) => {
    const root = mkdtempSync(join(tmpdir(), "slice-codegen-"));
    await use({
      src: (files) => {
        const src = join(root, "src");
        for (const file of files) {
          const path = join(src, file);
          mkdirSync(join(path, ".."), { recursive: true });
          writeFileSync(path, "");
        }
        mkdirSync(join(src, "slices"), { recursive: true });
        return src;
      },
    });
    rmSync(root, { recursive: true, force: true });
  },
});
