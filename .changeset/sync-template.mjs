import { readFileSync, writeFileSync } from "node:fs";

const path = new URL("../templates/http-app/package.json", import.meta.url);
const manifest = JSON.parse(readFileSync(path, "utf8"));

for (const name of Object.keys(manifest.dependencies)) {
  if (!name.startsWith("@btravstack/")) continue;
  const pkg = new URL(
    `../packages/${name.slice("@btravstack/".length)}/package.json`,
    import.meta.url,
  );
  manifest.dependencies[name] = JSON.parse(readFileSync(pkg, "utf8")).version;
}

writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
