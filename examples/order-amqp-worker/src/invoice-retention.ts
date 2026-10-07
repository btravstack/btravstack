import {
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
  type LifecycleRule,
} from "@aws-sdk/client-s3";
import { Config, type Environment } from "@btravstack/config";
import { TaggedError, fromPromise } from "unthrown";

/** How long an invoice is kept: the bucket's lifecycle rule and the notifier's patience are this one value. */
export const INVOICE_RETENTION_DAYS = 30;

const PREFIX = "invoices/";

/** Where an order's invoice lives: one key per life of the order, tenant included. */
export const invoiceKey = (tenantId: string, orderId: string, placementId: number): string =>
  `${PREFIX}${tenantId}/${orderId}/${placementId}.txt`;

/** The bucket would not take the invoice lifecycle rule. */
export class InvoiceRetentionNotEnsured extends TaggedError("InvoiceRetentionNotEnsured")<{
  readonly bucket: string;
  readonly reason: string;
}> {}

const s3Config = Config.object({
  endpoint: Config.string("STORAGE_S3_ENDPOINT"),
  region: Config.string("STORAGE_S3_REGION", { default: "us-east-1" }),
  bucket: Config.string("STORAGE_S3_BUCKET"),
  accessKeyId: Config.string("STORAGE_S3_ACCESS_KEY_ID"),
  secretAccessKey: Config.string("STORAGE_S3_SECRET_ACCESS_KEY"),
});

const RULE: LifecycleRule = {
  ID: "expire-invoices",
  Status: "Enabled",
  Filter: { Prefix: PREFIX },
  Expiration: { Days: INVOICE_RETENTION_DAYS },
};

/**
 * Install the rule that expires every invoice `INVOICE_RETENTION_DAYS` after
 * it was written, beside whatever other rules the bucket already has — a
 * lifecycle configuration is replaced whole, so the others are read first and
 * written back. Idempotent: the rule is matched by its id.
 *
 * Run where the bucket is set up — `pnpm deploy:invoice-retention` in a
 * release, ahead of `pnpm dev` locally — never from the worker's boot, which
 * would rewrite the bucket's configuration once per replica.
 */
export const ensureInvoiceRetention = (env: Environment) =>
  Config.parse(
    "InvoiceRetention",
    s3Config,
  )(env).flatMap((s3) =>
    fromPromise(
      async () => {
        const client = new S3Client({
          endpoint: s3.endpoint,
          region: s3.region,
          forcePathStyle: true,
          credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey },
        });
        try {
          const others = await client
            .send(new GetBucketLifecycleConfigurationCommand({ Bucket: s3.bucket }))
            .then(
              (current) => (current.Rules ?? []).filter((rule) => rule.ID !== RULE.ID),
              (cause: unknown) =>
                cause instanceof Error && cause.name === "NoSuchLifecycleConfiguration"
                  ? []
                  : Promise.reject(cause),
            );
          await client.send(
            new PutBucketLifecycleConfigurationCommand({
              Bucket: s3.bucket,
              LifecycleConfiguration: { Rules: [...others, RULE] },
            }),
          );
        } finally {
          client.destroy();
        }
      },
      (cause) =>
        new InvoiceRetentionNotEnsured({
          bucket: s3.bucket,
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
    ),
  );
