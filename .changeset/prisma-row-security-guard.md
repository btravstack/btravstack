---
"@btravstack/prisma": minor
---

`prismaDatabase` refuses to boot as a role row-level security does not apply
to. Where any table has row security enabled, a role that is a superuser, has
`BYPASSRLS`, or owns a row-secured table that is not `FORCE`d fails the scope
with the new `RowSecurityBypassed` (`{ database, role, bypass, tables }`),
exported with its `RowSecurityBypass` union and added to the module's error
channel. Run migrations with the owner's URL and the application with a
non-owner role's; a database with no row-secured table is unaffected.
