# @btravstack/htmx-server

HTML fragments for the protocol-neutral
[`@btravstack/http-server`](../http-server) runtime. `html` escapes dynamic
values by default, `raw` marks trusted HTML, and `htmx()` contributes one
`HttpHandler` member. Its peers are explicit in [package.json](./package.json).

See [Serve htmx fragments](https://btravstack.github.io/btravstack/how-to/serve-htmx-fragments)
and the [order API example](../../examples/order-api).
