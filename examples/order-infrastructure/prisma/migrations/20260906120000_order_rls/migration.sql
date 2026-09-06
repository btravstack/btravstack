ALTER TABLE "Order" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Order" FORCE ROW LEVEL SECURITY;

-- `current_setting(…, true)` returns NULL rather than erroring when nothing
-- pinned the connection, and `"tenantId" = NULL` is NULL — so an unpinned
-- statement matches no row and inserts nothing.
CREATE POLICY tenant_isolation ON "Order"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
