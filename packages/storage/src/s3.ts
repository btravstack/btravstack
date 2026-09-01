import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Config, Env, type ConfigInvalid } from "@btravstack/config";
import type { Scope } from "@btravstack/di";
import { Module, Port, Provider } from "@btravstack/di";
import { fromPromise, fromSafePromise } from "unthrown";

import {
  ObjectNotFound,
  StorageBackend,
  StorageUnavailable,
  type StorageService,
  type StoredObject,
} from "./storage.js";

/** What the graph bound from the environment for the S3 adapter. */
export class StorageConfig extends Port("StorageConfig")<{
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}> {}

/**
 * The five variables an S3-compatible store needs, and no sixth.
 *
 * `STORAGE_S3_ENDPOINT` is required rather than defaulted to AWS: every store
 * this port exists for has one, and a default pointing at Amazon would be a
 * surprising bill. **Path-style addressing is not configurable**, it is simply
 * on — every self-hosted store requires it and AWS accepts it, so it is a value
 * that never changes.
 */
export const s3Schema = Config.object({
  endpoint: Config.string("STORAGE_S3_ENDPOINT"),
  region: Config.string("STORAGE_S3_REGION", { default: "us-east-1" }),
  bucket: Config.string("STORAGE_S3_BUCKET"),
  accessKeyId: Config.string("STORAGE_S3_ACCESS_KEY_ID"),
  secretAccessKey: Config.string("STORAGE_S3_SECRET_ACCESS_KEY"),
});

/**
 * The client, as a port of its own: a resourceful provider is handed back the
 * service it acquired, and a store's four methods are not something you can
 * close — so the client rides the graph and the scope closing destroys it.
 */
class S3Connection extends Port("S3Connection")<{
  readonly client: S3Client;
  readonly bucket: string;
}> {}

const unavailable = (
  operation: "put" | "get" | "delete" | "presignedUrl" | "presignedUpload",
  key: string,
  cause: unknown,
): StorageUnavailable =>
  new StorageUnavailable({
    operation,
    key,
    reason: cause instanceof Error ? cause.message : String(cause),
  });

/** A missing key is S3's `NoSuchKey`, which is a different fact from "the store is down". */
const isMissing = (cause: unknown): boolean =>
  cause instanceof Error && (cause.name === "NoSuchKey" || cause.name === "NotFound");

/**
 * The adapter's service over a client and a bucket. A delete of a key nobody
 * stored answers `Ok`, which is S3's own idempotent behaviour rather than a
 * fiction layered over it.
 */
export const s3StorageBackend = (client: S3Client, bucket: string): StorageService => ({
  put: (key, bytes, options) =>
    fromPromise(
      client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentType: options.contentType,
        }),
      ),
      (cause) => unavailable("put", key, cause),
    ).map(() => undefined),
  get: (key) =>
    fromPromise(
      client
        .send(new GetObjectCommand({ Bucket: bucket, Key: key }))
        .then(async (response): Promise<StoredObject> => ({
          bytes: await (
            response.Body as { transformToByteArray: () => Promise<Uint8Array> }
          ).transformToByteArray(),
          // A store that lost the type still has the bytes; the caller gets
          // the honest default rather than an error it cannot act on.
          contentType: response.ContentType ?? "application/octet-stream",
        })),
      (cause): ObjectNotFound | StorageUnavailable =>
        isMissing(cause) ? new ObjectNotFound({ key }) : unavailable("get", key, cause),
    ),
  delete: (key) =>
    fromPromise(client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })), (cause) =>
      unavailable("delete", key, cause),
    ).map(() => undefined),
  presignedUrl: (key, options) =>
    fromPromise(
      getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
        // The SDK counts in seconds and the port in milliseconds, as every
        // other duration in this stack does. The conversion lives here, once.
        expiresIn: Math.ceil(options.ttlMs / 1_000),
      }),
      (cause) => unavailable("presignedUrl", key, cause),
    ),
  presignedUpload: (key, options) =>
    fromPromise(
      getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          ContentType: options.contentType,
          ContentLength: options.contentLength,
        }),
        // `ContentType` and `ContentLength` are signed because they are set on
        // the command, so a client sending different ones is refused. Naming
        // them in `signableHeaders` changes nothing (measured against RustFS).
        { expiresIn: Math.ceil(options.ttlMs / 1_000) },
      ),
      (cause) => unavailable("presignedUpload", key, cause),
    ),
});

/**
 * The S3 adapter: one client, built with the scope and destroyed with it, and
 * `StorageBackend` over it. Its two AWS SDK peers are **optional** and reached
 * only through this subpath, so an application composing the memory adapter
 * installs neither.
 */
export const s3Storage = (): Module<StorageBackend, ConfigInvalid, Env | Scope> =>
  Module("S3Storage")({
    needs: [Env],
    provides: [
      Config.provider(StorageConfig)(s3Schema),
      Provider(S3Connection)({
        inject: { config: StorageConfig },
        acquire: ({ config }) =>
          fromSafePromise(
            Promise.resolve({
              client: new S3Client({
                endpoint: config.endpoint,
                region: config.region,
                forcePathStyle: true,
                credentials: {
                  accessKeyId: config.accessKeyId,
                  secretAccessKey: config.secretAccessKey,
                },
              }),
              bucket: config.bucket,
            }),
          ),
        release: ({ client }) => {
          client.destroy();
        },
      }),
      Provider(StorageBackend)({
        inject: { connection: S3Connection },
        sync: ({ connection }) => s3StorageBackend(connection.client, connection.bucket),
      }),
    ],
    exports: [StorageBackend],
  });
