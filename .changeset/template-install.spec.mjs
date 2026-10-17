import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

describe("template registry selection", () => {
  for (const [scenario, registryError, expected] of [
    ["all packages published", "", ["1.0.0", "1.0.0"]],
    ["core published before the starter", "E404", ["file:core.tgz", "file:orpc-server.tgz"]],
    ["registry unavailable", "E503", undefined],
  ]) {
    it(`should handle ${scenario}`, (test) => {
      // GIVEN a registry boundary with core published and a controlled starter response
      const root = fileURLToPath(new URL("../", import.meta.url));
      const work = mkdtempSync(join(tmpdir(), "btravstack-template-registry-"));
      test.after(() => rmSync(work, { recursive: true, force: true }));
      const script = join(work, "internal", "consumer-check", "src", "check-template.ts");
      mkdirSync(join(work, "internal", "consumer-check", "src"), { recursive: true });
      cpSync(join(root, "internal", "consumer-check", "src", "check-template.ts"), script);
      for (const name of ["core", "orpc-server"]) {
        mkdirSync(join(work, "packages", name), { recursive: true });
        writeFileSync(join(work, "packages", name, "package.json"), '{"version":"1.0.0"}');
      }
      mkdirSync(join(work, "templates", "http-app"), { recursive: true });
      writeFileSync(
        join(work, "templates", "http-app", "package.json"),
        JSON.stringify({
          engines: { node: ">=22.12.0" },
          dependencies: {
            "@btravstack/core": "1.0.0",
            "@btravstack/orpc-server": "1.0.0",
            "@orpc/server": "2.0.0-beta.28",
          },
        }),
      );
      const installed = join(work, "installed.json");
      mkdirSync(join(work, "bin"));
      writeFileSync(
        join(work, "bin", "npm"),
        `#!/bin/sh
if [ "$1" = view ]; then
  if [ "$2" = '@btravstack/orpc-server@1.0.0' ] && [ -n '${registryError}' ]; then
    echo '${registryError}' >&2
    exit 1
  fi
  echo '"1.0.0"'
  exit 0
fi
cp package.json '${installed}'
exit 1
`,
        { mode: 0o755 },
      );
      writeFileSync(
        join(work, "bin", "pnpm"),
        '#!/bin/sh\nprintf \'{"filename":"%s.tgz"}\\n\' "${PWD##*/}"\n',
        { mode: 0o755 },
      );

      // WHEN the real gate reaches the install boundary
      const result = spawnSync(process.execPath, [script], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${join(work, "bin")}${delimiter}${process.env.PATH}` },
      });

      // THEN it selects one complete source or refuses the registry failure
      const manifest = existsSync(installed)
        ? JSON.parse(readFileSync(installed, "utf8"))
        : undefined;
      assert.deepEqual(
        {
          pins: manifest && [
            manifest.dependencies["@btravstack/core"],
            manifest.dependencies["@btravstack/orpc-server"],
          ],
          registryFailed: result.stderr.includes("E503"),
        },
        { pins: expected, registryFailed: registryError === "E503" },
      );
    });
  }
});
