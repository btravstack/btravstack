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

// The template's exact oRPC pins move to the answerer's peer floor with it:
// a released orpc-server may require a beta the pinned one predates.
const orpcFloor = JSON.parse(
  readFileSync(new URL("../packages/orpc-server/package.json", import.meta.url), "utf8"),
).peerDependencies["@orpc/server"].replace(/^\^/, "");
for (const name of Object.keys(manifest.dependencies)) {
  if (name.startsWith("@orpc/")) manifest.dependencies[name] = orpcFloor;
}

writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
