/**
 * The variables `kmsKeys()` reads are in its type: a root composing it owes
 * an `Env`, and `start`'s environment names exactly these.
 *
 * Type-checked by this package's `typecheck` script, never executed.
 */
import type { StartEnvironment } from "@btravstack/core";
import { Module } from "@btravstack/di";

import { EnvelopeKeys } from "./keys.js";
import { kmsKeys } from "./kms.js";

const Root = Module("Root")({ imports: [kmsKeys()], exports: [EnvelopeKeys] });

const _complete: StartEnvironment<typeof Root> = {
  KEYS_KMS_REGION: "eu-west-3",
  KEYS_KMS_ALIAS_PREFIX: "alias/tenant-",
  KEYS_KMS_ENDPOINT: "http://127.0.0.1:4566",
  KEYS_CACHE_TTL_MS: "300000",
  KEYS_KMS_PENDING_WINDOW_DAYS: "30",
};

// @ts-expect-error — `KEYS_KMS_ALIAS_PREFIX` is required: no owner's key can be named without it.
const _missing: StartEnvironment<typeof Root> = { KEYS_KMS_REGION: "eu-west-3" };

const _misspelt: StartEnvironment<typeof Root> = {
  KEYS_KMS_REGION: "eu-west-3",
  KEYS_KMS_ALIAS_PREFIX: "alias/tenant-",
  // @ts-expect-error — a variable nothing reads is refused rather than silently inert.
  KEYS_CACHE_TTL: "300000",
};

// @ts-expect-error — the region is the environment's, never an option.
const _pinnedRegion = kmsKeys({ region: "eu-west-3" });

void _complete;
void _missing;
void _misspelt;
void _pinnedRegion;
