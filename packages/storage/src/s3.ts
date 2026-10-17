import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Config, Env, type ConfigInvalid, type EnvReading } from "@btravstack/config";
import type { Scope } from "@btravstack/di";
import { Module, Port, Provider } from "@btravstack/di";
import { Ok, fromPromise } from "unthrown";

import {
  ObjectExists,
  ObjectNotFound,
  StorageBackend,
  StorageUnavailable,
  type ObjectHead,
  type StorageService,
  type StoredObject,
  type WriteOptions,
} from "./storage.js";

/** What the graph bound from the environment for the S3 adapter. */
class StorageConfig extends Port("StorageConfig")<{
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
const s3Schema = Config.object({
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
  operation: StorageUnavailable["operation"],
  key: string,
  cause: unknown,
): StorageUnavailable =>
  new StorageUnavailable({
    operation,
    key,
    reason: cause instanceof Error ? cause.message : String(cause),
  });

/** S3's answer to `If-None-Match: *` on a key that is held: HTTP 412. */
const isPreconditionFailed = (cause: unknown): boolean =>
  (cause as { $metadata?: { httpStatusCode?: number } } | null | undefined)?.$metadata
    ?.httpStatusCode === 412;

/** A missing key is S3's `NoSuchKey`, which is a different fact from "the store is down". */
const isMissing = (cause: unknown): boolean =>
  cause instanceof Error && (cause.name === "NoSuchKey" || cause.name === "NotFound");

/** SSE-KMS parameters when a key is named; none otherwise, so the bucket's default applies. */
const encryption = (options: WriteOptions) =>
  options.kmsKeyId === undefined
    ? {}
    : { ServerSideEncryption: "aws:kms" as const, SSEKMSKeyId: options.kmsKeyId };

/** S3 reports and takes checksums in base64; the port speaks hex. */
const hexToBase64 = (hex: string): string => Buffer.from(hex, "hex").toString("base64");
const base64ToHex = (base64: string): string => Buffer.from(base64, "base64").toString("hex");

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
          ...encryption(options),
        }),
      ),
      (cause) => unavailable("put", key, cause),
    ).map(() => undefined),
  putIfAbsent: (key, bytes, options) =>
    fromPromise(
      client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentType: options.contentType,
          IfNoneMatch: "*",
          ...encryption(options),
        }),
      ),
      (cause): ObjectExists | StorageUnavailable =>
        isPreconditionFailed(cause)
          ? new ObjectExists({ key })
          : unavailable("putIfAbsent", key, cause),
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
  copy: (from, to, options) =>
    fromPromise(
      // Async so that a key `encodeURIComponent` refuses (an unpaired
      // surrogate) is a rejection mapped below, not a synchronous throw.
      (async () =>
        client.send(
          new CopyObjectCommand({
            Bucket: bucket,
            Key: to,
            CopySource: `${bucket}/${from.split("/").map(encodeURIComponent).join("/")}`,
            MetadataDirective: "REPLACE",
            // The tagging directive defaults to COPY; the package has no tags, so none are inherited.
            TaggingDirective: "REPLACE",
            // Annotations are copied by default and need extra permissions; the package has none.
            AnnotationDirective: "EXCLUDE",
            ContentType: options.contentType,
            ...encryption(options),
          }),
        ))(),
      (cause): ObjectNotFound | StorageUnavailable =>
        isMissing(cause) ? new ObjectNotFound({ key: from }) : unavailable("copy", from, cause),
    ).map(() => undefined),
  head: (key) =>
    fromPromise(
      client
        .send(new HeadObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: "ENABLED" }))
        .then((response): ObjectHead => ({
          size: response.ContentLength ?? 0,
          contentType: response.ContentType ?? "application/octet-stream",
          // A multipart object's COMPOSITE checksum is a digest of part
          // digests, not of the bytes: it is not a sha256 of the object.
          ...(response.ChecksumSHA256 === undefined || response.ChecksumType === "COMPOSITE"
            ? {}
            : { sha256: base64ToHex(response.ChecksumSHA256) }),
        })),
      (cause): ObjectNotFound | StorageUnavailable =>
        isMissing(cause) ? new ObjectNotFound({ key }) : unavailable("head", key, cause),
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
          ...(options.sha256 === undefined ? {} : { ChecksumSHA256: hexToBase64(options.sha256) }),
        }),
        // The presigner leaves `content-type` unsigned by default even when it
        // is set on the command; without naming it here a client could PUT any
        // type at a URL minted for one.
        {
          expiresIn: Math.ceil(options.ttlMs / 1_000),
          signableHeaders: new Set(["content-type"]),
          // Hoisted into the query string the checksum would be unsigned and
          // swappable by the client; kept as a header it is signed, the client
          // must send it, and the store verifies the body against it.
          ...(options.sha256 === undefined
            ? {}
            : { unhoistableHeaders: new Set(["x-amz-checksum-sha256"]) }),
        },
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
export const s3Storage = (): Module<
  StorageBackend,
  ConfigInvalid,
  | EnvReading<
      | "STORAGE_S3_ENDPOINT"
      | "STORAGE_S3_BUCKET"
      | "STORAGE_S3_ACCESS_KEY_ID"
      | "STORAGE_S3_SECRET_ACCESS_KEY",
      "STORAGE_S3_REGION"
    >
  | Scope
> =>
  Module("S3Storage")({
    needs: [Env],
    provides: [
      Config.provider(StorageConfig)(s3Schema),
      Provider(S3Connection)({
        inject: { config: StorageConfig },
        acquire: ({ config }) =>
          Ok({
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
