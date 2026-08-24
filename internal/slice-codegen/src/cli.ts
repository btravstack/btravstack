import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { P } from "unthrown";

// Executed directly by `node`, which resolves .ts extensions via type stripping.
import { renderSlicesGen } from "./render.ts";

const src = join(process.cwd(), "src");
renderSlicesGen(src).match({
  ok: (content) => {
    writeFileSync(join(src, "slices.gen.ts"), content);
  },
  errCases: (matcher) =>
    matcher.with(P.tag("SliceTreeInvalid"), (error) => {
      process.stderr.write(`slice-codegen: ${error.directory}: ${error.problem}\n`);
      process.exitCode = 1;
    }),
  defect: (cause) => {
    process.stderr.write(`slice-codegen: unexpected error: ${cause}\n`);
    process.exitCode = 1;
  },
});
