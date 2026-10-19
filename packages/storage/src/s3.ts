import { createHash } from "node:crypto";

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type CompletedPart,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Config, Env, type ConfigInvalid, type EnvReading } from "@btravstack/config";
import type { Scope } from "@btravstack/di";
import { Module, Port, Provider } from "@btravstack/di";
import { Err, Ok, OkAsync, P, fromPromise, fromSafePromise, type AsyncResult } from "unthrown";

import { validateOptions } from "./options.js";
import {
  ChecksumMismatch,
  ObjectExists,
  ObjectNotFound,
  StorageBackend,
  StorageUnavailable,
  StreamInterrupted,
  type ObjectHead,
  type StorageService,
  type StoredObject,
  type StreamedObject,
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

const isChecksumMismatch = (cause: unknown): boolean =>
  cause instanceof Error && (cause.name === "BadDigest" || cause.name === "InvalidDigest");

/** A missing key is S3's `NoSuchKey`, which is a different fact from "the store is down". */
const isMissing = (cause: unknown): boolean =>
  cause instanceof Error && (cause.name === "NoSuchKey" || cause.name === "NotFound");

/** SSE-KMS parameters when a key is named; none otherwise, so the bucket's default applies. */
const encryption = (options: { readonly kmsKeyId?: string }) =>
  options.kmsKeyId === undefined
    ? {}
    : { ServerSideEncryption: "aws:kms" as const, SSEKMSKeyId: options.kmsKeyId };

/** S3 reports and takes checksums in base64; the port speaks hex. */
const hexToBase64 = (hex: string): string => Buffer.from(hex, "hex").toString("base64");
const base64ToHex = (base64: string): string => Buffer.from(base64, "base64").toString("hex");

/** Every part but the last must reach S3's 5 MiB floor; 8 MiB × 10,000 parts allows 78 GiB. */
const PART_SIZE = 8 * 1024 * 1024;

type Part = { readonly bytes: Buffer; readonly ended: boolean };

/** The next part of the stream, hashed as it passes; `ended` once the stream is done. */
const readPart = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  key: string,
  digest: ReturnType<typeof createHash>,
): AsyncResult<Part, StreamInterrupted> =>
  fromPromise(
    (async (): Promise<Part> => {
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (length < PART_SIZE) {
        const { done, value } = await reader.read();
        if (done) return { bytes: Buffer.concat(chunks, length), ended: true };
        digest.update(value);
        chunks.push(value);
        length += value.byteLength;
      }
      return { bytes: Buffer.concat(chunks, length), ended: false };
    })(),
    (cause) => new StreamInterrupted({ key, cause }),
  );

/** The SDK's own answer, settled; an abort or a cancel that fails changes nothing the caller can act on. */
const settled = (promise: Promise<unknown>): AsyncResult<void, never> =>
  fromSafePromise(
    promise.then(
      () => undefined,
      () => undefined,
    ),
  );

/**
 * `putStream`, and with `ifAbsent` its conditional twin: `If-None-Match: *` on
 * the write that publishes the object, so only that variant can meet a held
 * key.
 *
 * ponytail: one part in flight at a time, so memory stays at the first part
 * and the one being sent, and throughput at one round trip per 8 MiB; overlap
 * reading and uploading if a deployment needs more.
 */
function streamUpload(
  client: S3Client,
  bucket: string,
  ifAbsent: false,
): StorageService["putStream"];
function streamUpload(
  client: S3Client,
  bucket: string,
  ifAbsent: true,
): StorageService["putStreamIfAbsent"];
function streamUpload(
  client: S3Client,
  bucket: string,
  ifAbsent: boolean,
): StorageService["putStreamIfAbsent"] {
  const operation = ifAbsent ? "putStreamIfAbsent" : "putStream";
  const condition = ifAbsent ? { IfNoneMatch: "*" } : {};
  return (key, stream, options) => {
    const reader = stream.getReader();
    const digest = createHash("sha256");
    const refused = (cause: unknown): ObjectExists | ChecksumMismatch | StorageUnavailable =>
      isPreconditionFailed(cause)
        ? new ObjectExists({ key })
        : isChecksumMismatch(cause)
          ? new ChecksumMismatch({ key })
          : unavailable(operation, key, cause);
    const verified = () =>
      (options.sha256 === undefined || digest.digest("hex") === options.sha256
        ? Ok()
        : Err(new ChecksumMismatch({ key }))
      ).toAsync();
    const description = {
      Bucket: bucket,
      Key: key,
      ContentType: options.contentType,
      Metadata: { ...options.metadata },
      ...encryption(options),
    };

    const multipart = (UploadId: string | undefined, first: Part) => {
      const parts: CompletedPart[] = [];
      const send = ({ bytes, ended }: Part) =>
        bytes.byteLength === 0
          ? OkAsync(ended)
          : fromPromise(
              client.send(
                new UploadPartCommand({
                  Bucket: bucket,
                  Key: key,
                  UploadId,
                  PartNumber: parts.length + 1,
                  Body: bytes,
                }),
              ),
              refused,
            ).map(({ ETag, ChecksumCRC32 }) => {
              parts.push({ PartNumber: parts.length + 1, ETag, ChecksumCRC32 });
              return ended;
            });
      // Reading and sending are steps of their own, never the callback that
      // recurses: a `flatMap` holds its input until what it returns settles,
      // so a part handed to the recursion stayed in memory to the last one.
      const rest = (): AsyncResult<
        boolean,
        ObjectExists | ChecksumMismatch | StreamInterrupted | StorageUnavailable
      > =>
        readPart(reader, key, digest)
          .flatMap(send)
          .flatMap((ended) => (ended ? OkAsync(ended) : rest()));
      return send(first)
        .flatMap((ended) => (ended ? OkAsync(ended) : rest()))
        .flatMap(verified)
        .flatMap(() =>
          fromPromise(
            client.send(
              new CompleteMultipartUploadCommand({
                Bucket: bucket,
                Key: key,
                UploadId,
                MultipartUpload: { Parts: parts },
                ...condition,
              }),
            ),
            refused,
          ),
        )
        .flatTapErrCases((matcher) =>
          matcher.with(
            P.tag("ObjectExists"),
            P.tag("ChecksumMismatch"),
            P.tag("StreamInterrupted"),
            P.tag("StorageUnavailable"),
            // Parts left behind by an abort the store also refuses are never
            // an object, and the bucket's incomplete-upload rule reaps them.
            () =>
              settled(
                client.send(
                  new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId }),
                ),
              ),
          ),
        );
    };

    return validateOptions(key, options)
      .toAsync()
      .flatMap(() => readPart(reader, key, digest))
      .flatMap((first) =>
        first.ended
          ? verified().flatMap(() =>
              fromPromise(
                client.send(
                  new PutObjectCommand({ ...description, Body: first.bytes, ...condition }),
                ),
                refused,
              ),
            )
          : fromPromise(
              client.send(new CreateMultipartUploadCommand(description)),
              refused,
            ).flatMap(({ UploadId }) => multipart(UploadId, first)),
      )
      .map(() => undefined)
      .flatTapErrCases((matcher) =>
        matcher.with(
          P.tag("InvalidStorageOptions"),
          P.tag("ObjectExists"),
          P.tag("ChecksumMismatch"),
          P.tag("StreamInterrupted"),
          P.tag("StorageUnavailable"),
          (error) => settled(reader.cancel(error)),
        ),
      );
  };
}

/**
 * The adapter's service over a client and a bucket. A delete of a key nobody
 * stored answers `Ok`, which is S3's own idempotent behaviour rather than a
 * fiction layered over it.
 */
export const s3StorageBackend = (client: S3Client, bucket: string): StorageService => ({
  put: (key, bytes, options) => {
    const validated = validateOptions(key, options);
    if (!validated.isOk()) return validated.toAsync();
    return fromPromise(
      client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentType: options.contentType,
          Metadata: { ...options.metadata },
          ...(options.sha256 === undefined ? {} : { ChecksumSHA256: hexToBase64(options.sha256) }),
          ...encryption(options),
        }),
      ),
      (cause) =>
        isChecksumMismatch(cause) ? new ChecksumMismatch({ key }) : unavailable("put", key, cause),
    ).map(() => undefined);
  },
  putIfAbsent: (key, bytes, options) => {
    const validated = validateOptions(key, options);
    if (!validated.isOk()) return validated.toAsync();
    return fromPromise(
      client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentType: options.contentType,
          IfNoneMatch: "*",
          Metadata: { ...options.metadata },
          ...(options.sha256 === undefined ? {} : { ChecksumSHA256: hexToBase64(options.sha256) }),
          ...encryption(options),
        }),
      ),
      (cause): ObjectExists | ChecksumMismatch | StorageUnavailable =>
        isChecksumMismatch(cause)
          ? new ChecksumMismatch({ key })
          : isPreconditionFailed(cause)
            ? new ObjectExists({ key })
            : unavailable("putIfAbsent", key, cause),
    ).map(() => undefined);
  },
  putStream: streamUpload(client, bucket, false),
  putStreamIfAbsent: streamUpload(client, bucket, true),
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
  getStream: (key) =>
    fromPromise(
      client
        .send(new GetObjectCommand({ Bucket: bucket, Key: key }))
        .then((response): StreamedObject => ({
          stream: (
            response.Body as { transformToWebStream: () => ReadableStream<Uint8Array> }
          ).transformToWebStream(),
          contentType: response.ContentType ?? "application/octet-stream",
          size: response.ContentLength ?? 0,
        })),
      (cause): ObjectNotFound | StorageUnavailable =>
        isMissing(cause) ? new ObjectNotFound({ key }) : unavailable("getStream", key, cause),
    ),
  copy: (from, to, options) => {
    const validated = validateOptions(to, options);
    if (!validated.isOk()) return validated.toAsync();
    return fromPromise(
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
            Metadata: { ...options.metadata },
            ...(options.checksum === undefined ? {} : { ChecksumAlgorithm: "SHA256" as const }),
            ...encryption(options),
          }),
        ))(),
      (cause): ObjectNotFound | StorageUnavailable =>
        isMissing(cause) ? new ObjectNotFound({ key: from }) : unavailable("copy", from, cause),
    ).map(() => undefined);
  },
  head: (key) =>
    fromPromise(
      client
        .send(new HeadObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: "ENABLED" }))
        .then((response): ObjectHead => ({
          metadata: { ...response.Metadata },
          size: response.ContentLength ?? 0,
          contentType: response.ContentType ?? "application/octet-stream",
          // A multipart object's COMPOSITE checksum is a digest of part
          // digests, not of the bytes: it is not a sha256 of the object.
          ...(response.ChecksumSHA256 === undefined ||
          response.ChecksumType === "COMPOSITE" ||
          !/^[A-Za-z0-9+/]{43}=$/.test(response.ChecksumSHA256)
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
  presignedUpload: (key, options) => {
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: options.contentType,
      ContentLength: options.contentLength,
      ...encryption(options),
      ...(options.sha256 === undefined ? {} : { ChecksumSHA256: hexToBase64(options.sha256) }),
    });
    const expiresIn = Math.ceil(options.ttlMs / 1_000);
    return validateOptions(key, options)
      .toAsync()
      .flatMap(() =>
        fromPromise(
          getSignedUrl(client, command, {
            expiresIn,
            // The presigner leaves content-type unsigned unless explicitly named.
            signableHeaders: new Set(["content-type"]),
            // These headers must stay signed headers; hoisting would permit replacement.
            unhoistableHeaders: new Set([
              "x-amz-checksum-sha256",
              "x-amz-server-side-encryption",
              "x-amz-server-side-encryption-aws-kms-key-id",
            ]),
          }),
          (cause) => unavailable("presignedUpload", key, cause),
        ),
      );
  },
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
