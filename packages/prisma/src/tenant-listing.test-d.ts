import { rawSql } from "@prisma/orm-postgres/migration";
import type { AsyncResult } from "unthrown";

import type { SqlError } from "./result.js";
import { tenantListing, type TenantListing } from "./rls.js";

declare const listing: TenantListing;
declare const db: { readonly raw: { readonly sql: unknown }; readonly runtime: unknown };

const ids: AsyncResult<readonly string[], SqlError> = listing.list(db);
const operation = rawSql(listing.migration);

// @ts-expect-error -- no raw query surface to construct the listing's typed call
listing.list({ runtime: {} });

// @ts-expect-error -- privileged owner and application caller must be declared separately
tenantListing({ schema: "orders", table: "Order", name: "order_tenants", role: "app" });
