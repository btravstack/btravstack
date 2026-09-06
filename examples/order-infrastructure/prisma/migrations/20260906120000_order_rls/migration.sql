ALTER TABLE "Order" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Order" FORCE ROW LEVEL SECURITY;

-- `current_setting(…, true)` is NULL when nothing pinned the connection, so
-- USING hides every row from a read and WITH CHECK refuses a write with 42501.
CREATE POLICY tenant_isolation ON "Order"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
