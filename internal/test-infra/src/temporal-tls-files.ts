import { copyFile, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const file = (name: string): string =>
  fileURLToPath(new URL(`./temporal-tls/${name}`, import.meta.url));

/**
 * The certificates the shared Temporal TLS proxy and its clients use: one CA,
 * the proxy's certificate for `temporal.test`, a client pair the CA signed, a
 * second pair it signed for rotation, and a pair signed by a CA the proxy does
 * not trust. Committed rather than minted per run, because the reused proxy
 * must keep trusting the CA a later run's clients present.
 */
export const TEMPORAL_TLS_FILES = {
  ca: file("ca.pem"),
  serverName: "temporal.test",
  client: { cert: file("client-cert.pem"), key: file("client-key.pem") },
  rotated: { cert: file("rotated-cert.pem"), key: file("rotated-key.pem") },
  untrusted: { cert: file("untrusted-cert.pem"), key: file("untrusted-key.pem") },
} as const;

type SecretContent = {
  readonly pair: { readonly cert: string; readonly key: string };
  readonly apiKey: string;
};

/**
 * A client certificate, its key and an API key in a temporary directory laid
 * out as Kubernetes mounts a secret: each file a link through `..data` to a
 * generation directory, so `publish` swaps every file at once, the way a
 * rotated certificate and its key arrive together. It starts with the
 * {@link TEMPORAL_TLS_FILES} client pair and the key `temporal-test-first`.
 */
export const mountTemporalSecret = async () => {
  const dir = await mkdtemp(join(tmpdir(), "temporal-secret-"));
  let content: SecretContent = { pair: TEMPORAL_TLS_FILES.client, apiKey: "temporal-test-first" };
  let generation = 0;
  const publish = async (change: Partial<SecretContent>): Promise<void> => {
    content = { ...content, ...change };
    generation += 1;
    const target = join(dir, `..generation-${generation}`);
    await mkdir(target);
    await copyFile(content.pair.cert, join(target, "client-cert.pem"));
    await copyFile(content.pair.key, join(target, "client-key.pem"));
    await writeFile(join(target, "api-key"), `${content.apiKey}\n`);
    await symlink(target, join(dir, "..data-next"));
    await rename(join(dir, "..data-next"), join(dir, "..data"));
  };
  await publish({});
  for (const name of ["client-cert.pem", "client-key.pem", "api-key"])
    await symlink(join("..data", name), join(dir, name));
  return {
    cert: join(dir, "client-cert.pem"),
    key: join(dir, "client-key.pem"),
    apiKey: join(dir, "api-key"),
    publish,
    remove: () => rm(dir, { recursive: true, force: true }),
  };
};
