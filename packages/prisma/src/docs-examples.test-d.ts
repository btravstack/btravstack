import { rawSql } from "@prisma/orm-postgres/migration";
import type { AsyncResult } from "unthrown";

import type { SqlError } from "./result.js";
import { tenantListing, type TenantListingInvalid, type TenantListingOptions } from "./rls.js";

const options: TenantListingOptions = {
  schema: "orders",
  table: "order",
  tenantColumn: "tenantId",
  name: "order_tenants",
  owner: "tenant_listing_owner",
  role: "orders_app",
};
const declaration = tenantListing(options);
const operation = declaration.map((listing) => rawSql(listing.migration));

declare const db: { readonly raw: { readonly sql: unknown }; readonly runtime: unknown };
const tenants: AsyncResult<readonly string[], TenantListingInvalid | SqlError> = declaration
  .toAsync()
  .flatMap((listing) => listing.list(db));
