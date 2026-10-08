# packages/htmx-server

Read the root `AGENTS.md` and [`../http-server/AGENTS.md`](../http-server/AGENTS.md)
for shared HTTP decisions. This package owns escaped `Html`, fragment route
builders and the `htmx()` answerer. It depends on the HTTP runtime and has no
oRPC or GraphQL peer. Keep dynamic content escaped unless the application
explicitly marks trusted markup with `raw`.
