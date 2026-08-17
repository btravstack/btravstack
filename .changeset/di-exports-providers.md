---
"@btravstack/di": minor
---

`Module(name)({ exports })` now accepts a provider as well as a port class,
normalising it to `provider.port` when the module is built:

```ts
export const OrdersSlice = Module("OrdersSlice")({
  provides: [ordersController],
  exports: [ordersController], // was: [ordersController.port]
});
```

Both forms mean the same thing and may be mixed in one array — the `Exports`
channel comes out identical, so `start`'s gate, the unmet-dependency gate and
`Context<X>` are unaffected. Purely additive: exporting a port class is
unchanged.

It matters most where there is no class to name: `HttpController(name,
fragment)`, `Config.provider(name)(schema)`, `HttpRouter(contract)(…)`,
`TemporalActivities` and `AmqpHandlers` all mint their own port and hand back a
provider carrying it.
